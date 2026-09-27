import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as spend from '../src/services/spend.js';
import * as inbox from '../src/services/inbox.js';
import * as employees from '../src/services/employees.js';
import * as releases from '../src/services/releases.js';
import { reconcileYesterday } from '../src/services/aws-cost.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/** Budget is real money only (HLD D9b). */

const tick = () => new Promise(r => setTimeout(r, 5));
const day = '2026-09-28';
const at = `${day}T05:00:00.000Z`;

test('subscription usage is free: tracked, shown, never paused, never against the cap', async () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_USD_INR: '100', WORKPLACE_CAP_INR: '100' });
  const fake = installFakeRuntime();
  try {
    mkdirSync(join(tmp.dir, 'ops', 'workplace'), { recursive: true });
    writeFileSync(join(tmp.dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=x\n');
    employees.talk(wp, 'mira', 'work', [], { autonomous: true });
    await tick();
    fake.last().result({ costUsd: 3 });      // ₹300 equivalent, far past every cap
    fake.last().result({ costUsd: 2 });
    fake.last().events.onRateLimit?.({ rateLimitType: 'five_hour', status: 'allowed_warning', utilization: 0.8, resetsAt: 1_790_600_000 });
    const s = spend.summary(wp);
    assert.equal(s.companyInr, 0, 'no real money');
    assert.deepEqual(s.paused, []);
    assert.equal(s.subscription.turns, 2);
    assert.equal(s.subscription.equivalentInr, 500);
    assert.equal(s.subscription.byEmployee['mira']!.turns, 2);
    assert.equal(s.subscription.windows[0]!.window, 'five_hour');
    assert.equal(s.subscription.windows[0]!.status, 'allowed_warning');
    assert.equal(s.subscription.windows[0]!.utilization, 0.8);
    assert.equal(inbox.list(wp).filter(i => i.kind === 'cap').length, 0);
    assert.equal(spend.canSpend(wp, 'mira').ok, true);
    assert.equal(employees.stateOf(wp, 'mira'), 'working');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('real money is recorded by source and basis, and only that reaches the caps', () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_USD_INR: '100', WORKPLACE_CAP_INR: '100000' });
  try {
    spend.record(wp, { employeeId: 'kabir', source: 'anthropic-api', basis: 'metered', what: 'llm-gateway test run', inr: 40, detail: { usd: 0.4, input_tokens: 12000 }, at });
    spend.record(wp, { employeeId: 'kabir', source: 'third-party', basis: 'reported', what: 'Deepgram transcription', inr: 20, at });
    spend.record(wp, { employeeId: 'kabir', source: 'aws', basis: 'estimated', what: 'deploy server-api', inr: 1, at });
    const s = spend.summary(wp, day);
    assert.equal(s.companyInr, 61);
    assert.deepEqual(s.bySource, { 'anthropic-api': 40, 'third-party': 20, aws: 1 });
    assert.deepEqual(s.byBasis, { metered: 40, reported: 20, estimated: 1 });
    assert.equal(s.byEmployee['kabir'], 61);
    assert.equal(s.byUnit['capabilities'], 61);
    assert.deepEqual(s.paused, []);
    // Kabir's cap is ₹150 of real money.
    spend.record(wp, { employeeId: 'kabir', source: 'anthropic-api', basis: 'metered', what: 'more tests', inr: 90, at });
    const after = spend.summary(wp, day);
    assert.deepEqual(after.paused, ['employee:kabir']);
    const item = inbox.list(wp, 'open').find(i => i.kind === 'cap')!;
    assert.match(item.body, /real money/);
    assert.ok(item.affects.includes('kabir') && item.affects.includes('asha'));
    assert.equal(employees.stateWithReason(wp, 'kabir').reason, 'Paused — daily budget reached (₹151/₹150). You can still talk to Kabir.');
  } finally {
    tmp.cleanup();
  }
});

test('a release records an estimated AWS row; the daily actual supersedes the estimates and records its own cost', async () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_USD_INR: '100', WORKPLACE_CAP_INR: '100000' });
  releases.useSpawner(async () => ({ code: 0 }));
  try {
    const rel = releases.propose(wp, 'desktop-mac', '0.2.16');
    inbox.answer(wp, rel.inboxId, 'approve', undefined, 'web');
    await releases.run(wp, rel.id);
    const today = spend.dayOf();
    let s = spend.summary(wp, today);
    assert.equal(s.bySource['aws'], 2);
    assert.equal(s.byBasis['estimated'], 2);

    const calls: string[] = [];
    const tomorrow = spend.dayOf(new Date(Date.now() + 24 * 3600 * 1000));
    const inr = await reconcileYesterday(wp, async (start, end) => { calls.push(`${start}..${end}`); return 0.5; }, tomorrow);
    assert.equal(inr, 50);
    assert.deepEqual(calls, [`${today}..${tomorrow}`]);
    s = spend.summary(wp, today);
    assert.equal(s.byBasis['estimated'], undefined, 'the estimate is superseded');
    assert.equal(s.bySource['aws'], 51, 'the actual replaces the estimate, plus the ₹1 Cost Explorer request made today');
    assert.equal(s.byBasis['metered'], 51);
    const again = await reconcileYesterday(wp, async () => 999, tomorrow);
    assert.equal(again, null, 'once a day');
  } finally {
    releases.useSpawner(null);
    tmp.cleanup();
  }
});

test('the migration relabels the old ledger as free and lifts pauses that were on it, resolving the cap item', () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_USD_INR: '100', WORKPLACE_CAP_INR: '100000' });
  try {
    // Two rows as the old code wrote them: no source, ₹ from the SDK's estimate.
    wp.db.prepare("insert into spend (at, day, employee_id, session_id, model, input_tokens, output_tokens, cache_read, cache_write, usd, inr) values (?, ?, 'mira', 's', 'claude-sonnet-5', 1, 1, 0, 0, 1.51, 151)").run(at, day);
    wp.db.prepare("insert into settings (key, value) values (?, ?)").run(`paused:${day}:employee:mira`, at);
    const item = inbox.raise(wp, { kind: 'cap', title: 'Spend cap reached: employee:mira', body: 'x', raisedBy: 'workplace', context: { scope: 'employee:mira', day } });
    assert.equal(spend.canSpend(wp, 'mira', day).ok, false);

    const r = spend.migrateToRealMoney(wp);
    assert.equal(r.relabelled, 1);
    assert.deepEqual(r.lifted, ['employee:mira']);
    assert.equal(spend.canSpend(wp, 'mira', day).ok, true);
    const s = spend.summary(wp, day);
    assert.equal(s.companyInr, 0);
    assert.equal(s.subscription.equivalentInr, 151, 'the old figure is free usage now');
    const resolved = inbox.get(wp, item.id)!;
    assert.equal(resolved.state, 'answered');
    assert.equal(resolved.answer?.via, 'workplace');
    assert.match(resolved.answer!.note!, /free under the 28 Sep budget rule/);
    assert.deepEqual(spend.migrateToRealMoney(wp), { relabelled: 0, lifted: [] }, 'once');
    const audit = wp.db.prepare("select subject from events where kind = 'cap-lifted'").all() as { subject: string }[];
    assert.deepEqual(audit.map(a => a.subject), ['employee:mira']);
  } finally {
    tmp.cleanup();
  }
});
