import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pace from '../src/services/pace.js';
import * as spend from '../src/services/spend.js';
import * as employees from '../src/services/employees.js';
import * as inbox from '../src/services/inbox.js';
import * as coo from '../src/services/coo.js';
import * as dispatch from '../src/services/dispatch.js';
import * as runs from '../src/services/runs.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';
import { boot, call } from './fakes/boot.js';

/**
 * Weekly pacing, 17 Oct (owner, restating 3 Oct): park, not kill; one owner decision to bypass until
 * the next pace day; a failing probe is never silent.
 */

const DAY = 86_400_000;
const paceItems = (wp: Parameters<typeof inbox.list>[0]) => inbox.list(wp).filter(i => i.context['pace'] === true);

test('park, not kill: a trip lets the running turn finish and starts nothing new', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    const agent = employees.talk(wp, 'mira', 'work', [], { autonomous: true });
    await new Promise(r => setTimeout(r, 5));
    const nowMs = Date.now();
    const v = pace.apply(wp, { utilization: 0.30, resetsAtMs: nowMs - 1.5 * DAY + 7 * DAY }, nowMs);
    assert.equal(v.over, true);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(fake.last().interrupted, 0, 'the running turn is not interrupted');
    assert.equal(fake.last().closed, false, 'the session is not ended');
    assert.ok(employees.openSession('mira'), 'the session stays open');
    assert.equal(runs.getRunAgent(agent.id)?.status, 'running');
    assert.equal(employees.stateWithReason(wp, 'mira').state, 'working', 'the card shows the turn still running');
    // Nothing new: no autonomous talk, no assignment start, no dispatch.
    assert.throws(() => employees.talk(wp, 'mira', 'more', [], { autonomous: true }), /weekly-pace/);
    const before = fake.sessions.length;
    for (const e of wp.org.employees) { try { dispatch.dispatch(wp, e.id, nowMs); } catch { /* not an agent */ } }
    assert.equal(fake.sessions.length, before, 'the dispatcher starts no session while parked');
    assert.deepEqual(spend.canSpend(wp, 'rohan'), { ok: false, scope: 'weekly-pace' });
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('a trip tells the COO and raises ONE owner decision with the bypass options', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const nowMs = Date.now();
    const resetsAtMs = nowMs - 1.5 * DAY + 7 * DAY;
    pace.apply(wp, { utilization: 0.30, resetsAtMs }, nowMs);
    pace.apply(wp, { utilization: 0.31, resetsAtMs }, nowMs + 60_000);
    pace.apply(wp, { utilization: 0.32, resetsAtMs }, nowMs + 120_000);
    const items = paceItems(wp);
    assert.equal(items.length, 1, 'one decision per trip, not one per reading');
    const item = items[0]!;
    assert.equal(item.kind, 'decision');
    assert.equal(item.title, 'Weekly pace cap reached (30% used, cap 28% today): bypass?');
    assert.deepEqual(item.options.map(o => o.label), ['Bypass until the next pace day', 'Keep parked']);
    const told = coo.listItems(wp).filter(i => /weekly pace cap/i.test(i.title));
    assert.equal(told.length, 1, 'the COO hears of it once');
  } finally {
    tmp.cleanup();
  }
});

test('"Bypass until the next pace day" lifts pacing for the day; the next pace day paces again', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const nowMs = Date.now();
    const resetsAtMs = nowMs - 1.5 * DAY + 7 * DAY;
    const v = pace.apply(wp, { utilization: 0.30, resetsAtMs }, nowMs);
    const item = paceItems(wp)[0]!;
    inbox.answer(wp, item.id, 'bypass', undefined, 'phone');
    assert.equal(pace.holdUntil(wp), null, 'the hold is lifted at once');
    assert.equal(spend.canSpend(wp, 'mira').ok, true);
    assert.equal(pace.bypassUntil(wp), new Date(v.nextDayMs).toISOString());
    // Later readings the same pace day never re-park.
    assert.equal(pace.apply(wp, { utilization: 0.50, resetsAtMs }, nowMs + 3_600_000).over, false);
    assert.equal(pace.holdUntil(wp, nowMs + 3_600_000), null);
    assert.equal(paceItems(wp).length, 1, 'no second decision while bypassed');
    // The next pace day: over its 42% allowance, pacing applies again with a fresh decision.
    const next = v.nextDayMs + 60_000;
    assert.equal(pace.apply(wp, { utilization: 0.50, resetsAtMs }, next).over, true);
    assert.notEqual(pace.holdUntil(wp, next), null);
    assert.equal(pace.bypassUntil(wp, next), null);
    assert.equal(paceItems(wp).length, 2);
  } finally {
    tmp.cleanup();
  }
});

test('"Keep parked" keeps the hold; an unanswered decision expires when the next pace day starts', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const nowMs = Date.now();
    const resetsAtMs = nowMs - 1.5 * DAY + 7 * DAY;
    const v = pace.apply(wp, { utilization: 0.30, resetsAtMs }, nowMs);
    inbox.answer(wp, paceItems(wp)[0]!.id, 'keep-parked', undefined, 'web');
    assert.notEqual(pace.holdUntil(wp, nowMs), null);
    assert.equal(spend.canSpend(wp, 'mira').ok, false);

    const { wp: wp2, tmp: tmp2 } = testWorkplace();
    try {
      const v2 = pace.apply(wp2, { utilization: 0.30, resetsAtMs }, nowMs);
      pace.apply(wp2, { utilization: 0.30, resetsAtMs }, v2.nextDayMs + 60_000);
      assert.equal(paceItems(wp2)[0]!.state, 'expired', 'a stale bypass question does not linger');
    } finally { tmp2.cleanup(); }
    assert.ok(v);
  } finally {
    tmp.cleanup();
  }
});

const writeToken = (dir: string) => {
  mkdirSync(join(dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test\n');
};
const okResponse = (u: number, resetS: number) => new Response('{}', { status: 200, headers: {
  'anthropic-ratelimit-unified-7d-utilization': String(u), 'anthropic-ratelimit-unified-7d-reset': String(resetS),
} });
const netError = () => { const e = new TypeError('fetch failed'); (e as { cause?: unknown }).cause = Object.assign(new Error('connect ECONNRESET 160.79.104.10:443'), { code: 'ECONNRESET' }); return e; };

test('the probe says why it failed (the cause, not just "fetch failed") and retries a network error once', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    writeToken(tmp.dir);
    let calls = 0;
    const flaky = (async () => { calls += 1; if (calls === 1) throw netError(); return okResponse(0.2, Math.floor(Date.now() / 1000) + 5 * 86400); }) as typeof fetch;
    const r = await pace.probe(wp, { fetch: flaky, retryDelayMs: 0 });
    assert.equal(calls, 2, 'one retry');
    assert.ok('reading' in r && r.reading.utilization === 0.2);

    const down = (async () => { throw netError(); }) as typeof fetch;
    const f = await pace.probe(wp, { fetch: down, retryDelayMs: 0 });
    assert.ok('error' in f);
    assert.match(f.error, /ECONNRESET/);

    const unauthorised = (async () => new Response('{"error":{"type":"authentication_error"}}', { status: 401 })) as typeof fetch;
    const u = await pace.probe(wp, { fetch: unauthorised, retryDelayMs: 0 });
    assert.ok('error' in u);
    assert.match(u.error, /HTTP 401/);
  } finally {
    tmp.cleanup();
  }
});

test('a missing token is an error, not a silent null', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const r = await pace.probe(wp, { fetch: (async () => okResponse(0.1, 1)) as typeof fetch, retryDelayMs: 0 });
    assert.ok('error' in r);
    assert.match(r.error, /token/i);
  } finally {
    tmp.cleanup();
  }
});

test('consecutive probe failures tell the COO once; a good reading resets the count', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    writeToken(tmp.dir);
    const down = (async () => { throw netError(); }) as typeof fetch;
    const blind = () => coo.listItems(wp).filter(i => /pace probe/i.test(i.title));
    for (let i = 0; i < pace.PROBE_FAIL_NOTIFY - 1; i++) await pace.tick(wp, { fetch: down, retryDelayMs: 0 });
    assert.equal(blind().length, 0, 'a blip is not news');
    await pace.tick(wp, { fetch: down, retryDelayMs: 0 });
    assert.equal(blind().length, 1, `after ${pace.PROBE_FAIL_NOTIFY} failures the COO is told`);
    assert.match(blind()[0]!.body, /ECONNRESET/);
    await pace.tick(wp, { fetch: down, retryDelayMs: 0 });
    assert.equal(blind().length, 1, 'not once per failure');
    const st = pace.status(wp);
    assert.match(st.lastError ?? '', /ECONNRESET/);
    assert.ok(st.lastProbeAt);

    const nowS = Math.floor(Date.now() / 1000);
    await pace.tick(wp, { fetch: (async () => okResponse(0.05, nowS + 5 * 86400)) as typeof fetch, retryDelayMs: 0 });
    assert.equal(pace.status(wp).lastError, null);
    for (let i = 0; i < pace.PROBE_FAIL_NOTIFY; i++) await pace.tick(wp, { fetch: down, retryDelayMs: 0 });
    assert.equal(blind().length, 2, 'a new failure streak is told again');
  } finally {
    tmp.cleanup();
  }
});

test('status: utilization, today\'s cap and pace day from the last reading', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const nowMs = Date.now();
    pace.apply(wp, { utilization: 0.15, resetsAtMs: nowMs - 1.5 * DAY + 7 * DAY }, nowMs);
    const st = pace.status(wp, nowMs);
    assert.equal(st.disabled, false);
    assert.equal(st.bypassUntil, null);
    assert.equal(st.utilization, 0.15);
    assert.equal(st.capToday, 0.28);
    assert.equal(st.paceDay, 2);
  } finally {
    tmp.cleanup();
  }
});

test('GET /api/coo/pace reports the state; POST {"disabled":true} stays the permanent off switch', async () => {
  const b = await boot();
  try {
    const got = await call<Record<string, unknown>>(b.base, 'GET', '/api/coo/pace');
    assert.equal(got.status, 200);
    for (const k of ['disabled', 'bypassUntil', 'utilization', 'capToday', 'paceDay', 'lastProbeAt', 'lastError']) assert.ok(k in got.body, `has ${k}`);
    assert.equal(got.body['disabled'], false);
    const off = await call<Record<string, unknown>>(b.base, 'POST', '/api/coo/pace', { disabled: true });
    assert.equal(off.body['disabled'], true);
    assert.equal((await call<Record<string, unknown>>(b.base, 'GET', '/api/coo/pace')).body['disabled'], true);
  } finally {
    await b.stop();
  }
});
