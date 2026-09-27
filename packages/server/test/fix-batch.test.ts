import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as employees from '../src/services/employees.js';
import * as work from '../src/services/work.js';
import * as spend from '../src/services/spend.js';
import * as inbox from '../src/services/inbox.js';
import * as views from '../src/services/views.js';
import * as stall from '../src/services/stall.js';
import * as cos from '../src/services/cos.js';
import * as proposals from '../src/services/proposals.js';
import { readEmployeeFile, writeEmployeeFile } from '../src/services/org.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/** The fix batch from the owner's first day on the iPhone app (27 Sep). */

const tick = () => new Promise(r => setTimeout(r, 5));
function withOauth(dir: string): void {
  mkdirSync(join(dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=x\n');
}
const usage = (employeeId: string, usd: number) => ({ employeeId, sessionId: 's', source: 'anthropic-api' as const, basis: 'metered' as const, what: 'test', inr: usd * 100, detail: { usd } });

test('1. the employee page lists the Inbox items the card counts', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const a = work.create(wp, { kind: 'assignment', title: 'A', body: 'x', charterId: 'mobile' });
    inbox.raise(wp, { kind: 'decision', title: 'Quiet by default?', body: 'x', raisedBy: 'asha' });
    inbox.raise(wp, { kind: 'question', title: 'Review requested: A', body: 'x', raisedBy: 'nikhil', context: { assignmentId: a.id } });
    inbox.raise(wp, { kind: 'cap', title: 'Cap', body: 'x', raisedBy: 'workplace', context: { scope: 'employee:tara' } });
    inbox.raise(wp, { kind: 'question', title: 'Unrelated', body: 'x', raisedBy: 'workplace' });
    const asha = views.employeeDetail(wp, 'asha');
    assert.equal(asha.needsYou.length, 4, 'the Chief of Staff sees every open item');
    assert.equal(employees.card(wp, 'asha').needsYou, asha.needsYou.length, 'the card count equals the page list');
    const tara = views.employeeDetail(wp, 'tara');
    assert.deepEqual(tara.needsYou.map(i => i.title).sort(), ['Cap', 'Review requested: A'], 'addressed to her: her assignment and her cap');
    assert.equal(employees.card(wp, 'tara').needsYou, 2);
  } finally {
    tmp.cleanup();
  }
});

test('2. a probe session never writes status or handoff, and a shutdown leaves a note instead of nothing', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    withOauth(tmp.dir);
    writeEmployeeFile(wp.org, 'asha', 'status.md', 'doing: the daily-greeting spec\ndone: 8 decisions raised\nblocked: -\n');
    writeEmployeeFile(wp.org, 'asha', 'handoff.md', 'Real work: spec written, decomposed to 7 charters.\n');
    const agent = employees.talk(wp, 'asha', 'pwd?', [], { probe: true });
    await tick();
    const s = fake.last();
    // The model tries to write anyway: the tools refuse.
    const { workplaceTools } = await import('../src/services/employees.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const server = workplaceTools(wp, 'asha', () => ({ agentId: agent.id, employeeId: 'asha', startedAt: '', seen: {}, planCaptured: false, probe: true }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(st);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(ct);
    const r = await client.callTool({ name: 'write_handoff', arguments: { handoff: 'this session did no substantive work' } });
    assert.match(JSON.stringify(r.content), /probe session/);
    await client.callTool({ name: 'report_status', arguments: { doing: 'nothing', done: 'nothing', blocked: '-' } });
    await client.close();
    // Ending a probe asks for no handoff.
    await employees.endSession(wp, agent.id, 1000);
    assert.ok(!s.sent.some(m => m.text.includes('write_handoff')), 'no handoff prompt for a probe');
    assert.equal(readEmployeeFile(wp.org, 'asha', 'handoff.md'), 'Real work: spec written, decomposed to 7 charters.\n');
    assert.match(readEmployeeFile(wp.org, 'asha', 'status.md'), /daily-greeting spec/);

    // A real session shut down mid-work leaves a machine note appended, never a blank.
    const real = employees.talk(wp, 'asha', 'write the spec');
    await tick();
    fake.last().say('Spec written and attached.');
    fake.last().tool('Write', { file_path: '/x/spec.md' });
    employees.closeAll(wp, 'shutdown');
    const handoff = readEmployeeFile(wp.org, 'asha', 'handoff.md');
    assert.ok(handoff.startsWith('Real work: spec written'), 'the real handoff is kept');
    assert.match(handoff, new RegExp(`Shut down by the Workplace .*session ${real.id}`));
    assert.match(handoff, /last reply: Spec written and attached/);
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('3. a cap-paused employee shows blocked with the plain reason, and the Office counts it', () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_USD_INR: '100', WORKPLACE_CAP_INR: '100000' });
  try {
    spend.record(wp, usage('mira', 1.51));   // ₹151 of her ₹150
    const { state, reason } = employees.stateWithReason(wp, 'mira');
    assert.equal(state, 'blocked');
    assert.equal(reason, 'Paused — daily budget reached (₹151/₹150). You can still talk to Mira.');
    const office = views.office(wp);
    assert.equal(office.counts.blocked, 1);
    assert.equal(office.counts.total, 7);
    const card = office.units.flatMap(u => u.employees).find(c => c.employee.id === 'mira')!;
    assert.equal(card.employee.stateReason, reason);
    assert.equal(views.employeeDetail(wp, 'mira').employee.stateReason, reason);
  } finally {
    tmp.cleanup();
  }
});

test('4. stalled work is derived, counted, and the Chief of Staff resumes it once or explains why it waits', async () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_STALL_MINUTES: '30', WORKPLACE_USD_INR: '100', WORKPLACE_CAP_INR: '100000' });
  const fake = installFakeRuntime();
  try {
    withOauth(tmp.dir);
    const a = work.create(wp, { kind: 'assignment', title: 'Composer', body: 'x', charterId: 'mobile' });
    work.attachPlan(wp, a.id, 'p', 'tara');
    const now = Date.now();
    assert.equal(stall.stalledSince(wp, work.get(wp, a.id)!, now + 10 * 60_000), undefined, 'ten minutes is not a stall');
    const later = now + 31 * 60_000;
    assert.ok(stall.stalledSince(wp, work.get(wp, a.id)!, later), 'thirty-one minutes with no session is');
    assert.equal(stall.stalledAssignments(wp, later).length, 1);

    // First tick: resumed within budget (a session starts), recorded for today. A second stalled
    // item queues for the next tick without a note.
    const q = work.create(wp, { kind: 'assignment', title: 'Queued', body: 'x', charterId: 'memory' });
    work.attachPlan(wp, q.id, 'p', 'kabir');
    const first = cos.tick(wp, later);
    assert.deepEqual([...first.resumed, ...first.queued].sort(), [a.id, q.id].sort(), JSON.stringify(first));
    assert.equal(first.resumed.length, 1, 'one resume per tick');
    assert.deepEqual(first.noted, [], 'queued items are not silent stalls; the routine takes them next');
    assert.equal(inbox.list(wp, 'open').filter(i => i.title.startsWith('Waiting:')).length, 0);
    await tick();
    assert.equal(fake.sessions.length, 1);
    const resumedId = first.resumed[0]!;
    assert.equal(work.get(wp, resumedId)!.state, 'building');
    employees.closeAll(wp, 'test');

    // Stalled again the same day: not resumed twice; one Inbox note with the reason, deduped.
    const evenLater = later + 40 * 60_000;
    const second = cos.tick(wp, evenLater);
    assert.ok(!second.resumed.includes(resumedId), 'not resumed twice in a day');
    assert.equal(second.noted.length, 1);
    assert.match(second.noted[0]!.reason, /resumed once today already/);
    const notes = inbox.list(wp, 'open').filter(i => i.title.startsWith('Waiting:'));
    assert.equal(notes.length, 1);
    const third = cos.tick(wp, evenLater + 60_000);
    assert.deepEqual(third.noted, [], `one note per item per day: ${JSON.stringify(third)} open=${JSON.stringify(inbox.list(wp, 'open').map(i => [i.title, i.context['dedupeKey']]))}`);

    // A cap-paused assignee: the reason is the cap, nothing is resumed.
    const b = work.create(wp, { kind: 'assignment', title: 'Doze', body: 'x', charterId: 'character' });
    work.attachPlan(wp, b.id, 'p', 'dev');
    spend.record(wp, usage('dev', 1.5));
    const r = cos.tick(wp, Date.now() + 31 * 60_000);
    assert.equal(r.resumed.length, 0, JSON.stringify(r));
    assert.ok(r.noted.some(n => n.id === b.id && /spend cap reached \(employee:dev\)/.test(n.reason)), JSON.stringify(r));

    // Waiting on a pending org change that touches the charter.
    const c = work.create(wp, { kind: 'assignment', title: 'Bubble', body: 'x', charterId: 'mobile' });
    work.attachPlan(wp, c.id, 'p', 'tara');
    proposals.propose(wp, { kind: 'split', reason: 'r', proposedBy: 'asha', params: { charterId: 'mobile', into: [{ id: 'mobile-ios', keys: ['ios'] }, { id: 'mobile-android', keys: ['android'] }] } });
    const r2 = cos.tick(wp, Date.now() + 31 * 60_000);
    assert.ok(r2.noted.some(n => n.id === c.id && /org-change proposal: split mobile/.test(n.reason)));
    // "Resume it now" from the Inbox starts it regardless.
    const note = inbox.list(wp, 'open').find(i => i.context['assignmentId'] === c.id)!;
    employees.closeAll(wp, 'test'); // Tara's session from the queued resume would otherwise hold the slot
    inbox.answer(wp, note.id, 'resume', undefined, 'phone');
    await tick();
    assert.equal(work.get(wp, c.id)!.state, 'building');
    // The Office counts stalls against the real clock; in this test everything happened seconds ago.
    assert.equal(typeof views.office(wp).counts.stalled, 'number');
    assert.ok(stall.stalledAssignments(wp, Date.now() + 31 * 60_000).length >= 1);
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('5. the owner can always talk to a cap-paused employee; "continue" lifts the pause and is audited', async () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_USD_INR: '100', WORKPLACE_CAP_INR: '100000' });
  const fake = installFakeRuntime();
  try {
    withOauth(tmp.dir);
    const a = work.create(wp, { kind: 'assignment', title: 'Doze', body: 'x', charterId: 'character' });
    work.attachPlan(wp, a.id, 'p', 'dev');
    spend.record(wp, usage('dev', 1.5));    // ₹150: at his cap
    assert.equal(spend.canSpend(wp, 'dev').ok, false);
    assert.throws(() => employees.assign(wp, a.id), /paused/, 'autonomous work stays paused');

    const agent = employees.talk(wp, 'dev', 'Where are you with the doze?');
    await tick();
    const s = fake.last();
    assert.ok(s.options.maxBudgetUsd! >= 1.0, 'an owner turn gets room to answer');
    // Read-only on the paused work: edits and commands are denied, reads are not.
    const hook = s.options.hooks!.PreToolUse![0]!.hooks[0]!;
    const run = (tool: string, input: Record<string, unknown>) => hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: s.options.cwd } as never, 't', { signal: new AbortController().signal });
    const denied = await run('Edit', { file_path: join(s.options.cwd, 'x.py') }) as { hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string } };
    assert.equal(denied.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(denied.hookSpecificOutput!.permissionDecisionReason, /paused by the employee:dev spend cap/);
    const read = await run('Read', { file_path: join(s.options.cwd, 'x.py') }) as typeof denied;
    assert.equal(read.hookSpecificOutput, undefined);

    // Its usage is recorded (free) and tagged; the real-money pause stays.
    s.result({ costUsd: 0.3 });
    const sum = spend.summary(wp);
    assert.equal(sum.ownerTalkInr, 30, 'equivalent ₹ of the owner talk, for the record');
    assert.equal(sum.byEmployee['dev'], 150, 'real money unchanged: the talk was on the subscription');
    assert.deepEqual(sum.paused, ['employee:dev'], 'still paused for autonomous work');
    assert.equal(inbox.list(wp, 'open').filter(i => i.kind === 'cap').length, 1, 'no second cap item');
    assert.equal(employees.stateOf(wp, 'dev'), 'working');

    // "Go ahead and continue": the pause is lifted for today, audited, the session unlocked and told to resume.
    employees.talk(wp, 'dev', 'Looks right. Go ahead and continue.');
    assert.equal(spend.canSpend(wp, 'dev').ok, true);
    assert.equal(spend.isLifted(wp, spend.dayOf(), 'employee:dev'), true);
    const audit = wp.db.prepare("select subject, json from events where kind = 'cap-lifted'").all() as { subject: string; json: string }[];
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.subject, 'employee:dev');
    assert.equal(JSON.parse(audit[0]!.json).by, 'owner-talk');
    const allowed = await run('Edit', { file_path: join(s.options.cwd, 'desktop', 'character', 'x.js') }) as typeof denied;
    assert.equal(allowed.hookSpecificOutput, undefined, 'edits allowed after the lift');
    assert.ok(s.sent.some(m => m.text.includes(`Resume assignment ${a.id}`)));
    assert.equal(agent.id, employees.openSession('dev')!.agentId);
    // Further autonomous spend today does not re-pause him.
    spend.record(wp, usage('dev', 0.5));
    assert.deepEqual(spend.summary(wp).paused, []);
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});
