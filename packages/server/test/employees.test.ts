import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as employees from '../src/services/employees.js';
import * as work from '../src/services/work.js';
import * as spend from '../src/services/spend.js';
import * as runs from '../src/services/runs.js';
import { readEmployeeFile, writeEmployeeFile } from '../src/services/org.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

const tick = () => new Promise(r => setTimeout(r, 5));

function withOauth(dir: string): void {
  mkdirSync(join(dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token-value\n');
}

test('a session gets the layered context, the subscription token, and no API key', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  process.env['ANTHROPIC_API_KEY'] = 'sk-should-not-leak';
  try {
    withOauth(tmp.dir);
    writeEmployeeFile(wp.org, 'mira', 'handoff.md', 'Next: the info expert card.\n');
    const agent = employees.talk(wp, 'mira', 'What are you on?');
    await tick();
    const s = fake.last();
    assert.equal(agent.employeeId, 'mira');
    assert.ok(s.options.cwd.includes('/mira/') && !s.options.cwd.startsWith('/Users/shravan0001jha/claude-dev'), `own worktree: ${s.options.cwd}`);
    assert.equal(s.options.model, 'sonnet');
    assert.equal(s.options.permissionMode, 'auto');
    assert.ok(s.options.allowedTools!.includes('mcp__travsr__*') && s.options.allowedTools!.includes('Bash(npm test:*)'), 'reads and tests never prompt');
    assert.ok(s.options.systemPromptAppend!.startsWith('You are Mira'));
    assert.ok(s.options.systemPromptAppend!.includes('## Charter: Experts'));
    assert.ok(s.options.systemPromptAppend!.includes('Next: the info expert card.'));
    assert.deepEqual(s.options.settingSources, ['user', 'project']);
    assert.equal(s.options.env!['CLAUDE_CODE_OAUTH_TOKEN'], 'sk-ant-oat-test-token-value');
    assert.equal('ANTHROPIC_API_KEY' in s.options.env!, false, 'the key is absent, not blank');
    assert.ok(s.options.maxBudgetUsd! > 0);
    assert.ok(s.options.mcpServers && 'workplace' in s.options.mcpServers);
    assert.ok(s.options.allowedTools!.includes('mcp__workplace__write_handoff'), 'Workplace tools never prompt');
    assert.ok((agent.contextTokens ?? 0) > 500);

    // Talking again continues the same session.
    const again = employees.talk(wp, 'mira', 'and then?');
    assert.equal(again.id, agent.id);
    assert.equal(fake.sessions.length, 1);
    assert.deepEqual(s.sent.map(x => x.text), ['and then?']);
    assert.equal(employees.stateOf(wp, 'mira'), 'working');
  } finally {
    delete process.env['ANTHROPIC_API_KEY'];
    fake.restore();
    tmp.cleanup();
  }
});

test('usage is recorded as free subscription deltas; only real money pauses the employee', async () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_USD_INR: '100', WORKPLACE_CAP_INR: '100000' });
  const fake = installFakeRuntime();
  spend.onPause((w, scope) => employees.pauseScope(w, scope));
  try {
    withOauth(tmp.dir);
    employees.talk(wp, 'nikhil', 'hi', [], { autonomous: true });   // nikhil: ₹120/day of real money
    await tick();
    const s = fake.last();
    s.result({ costUsd: 0.5 });   // cumulative 0.5 → ₹50 equivalent
    s.result({ costUsd: 0.4 });   // cumulative 0.9 → delta ₹40
    const day = spend.dayOf();
    assert.equal(spend.summary(wp, day).subscription.byEmployee['nikhil']!.equivalentInr, 90, 'deltas, not the running total');
    assert.equal(spend.summary(wp, day).subscription.byEmployee['nikhil']!.turns, 2);
    s.result({ costUsd: 0.4 });   // ₹130 equivalent: far past ₹120, and nothing happens
    assert.equal(spend.canSpend(wp, 'nikhil', day).ok, true, 'subscription usage never pauses');
    assert.equal(s.interrupted, 0);

    // Real money does.
    spend.record(wp, { employeeId: 'nikhil', source: 'third-party', basis: 'reported', what: 'ElevenLabs test', inr: 130 });
    assert.equal(s.interrupted, 1);
    employees.closeAll(wp, 'test');
    assert.equal(employees.stateOf(wp, 'nikhil'), 'blocked');
    assert.match(employees.stateWithReason(wp, 'nikhil').reason!, /Paused — daily budget reached \(₹130\/₹120\)\. You can still talk to Nikhil\./);
    assert.throws(() => employees.talk(wp, 'nikhil', 'more', [], { autonomous: true }), /paused/, 'the Workplace itself stays under the cap');
    assert.ok(employees.talk(wp, 'nikhil', 'more'), 'the owner can still talk');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('an assignment session captures the first "## Plan" reply and moves the assignment to planned', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    withOauth(tmp.dir);
    const a = work.create(wp, { kind: 'assignment', title: 'Composer', body: 'Build it', charterId: 'mobile' });
    fake.onStart = s => { s.say('Sure.'); s.say('## Plan\n1. Read the screen code\n2. Add the composer\n3. Test on the iPhone'); };
    const agent = employees.assign(wp, a.id);
    await tick();
    assert.equal(agent.assignmentId, a.id);
    assert.ok(fake.last().options.systemPromptAppend!.includes('## Assignment: Composer'));
    const planned = work.get(wp, a.id)!;
    assert.equal(planned.state, 'planned');
    assert.equal(planned.plan, '1. Read the screen code\n2. Add the composer\n3. Test on the iPhone');
    assert.equal(planned.sessionId, 'fake-1');
    assert.equal(employees.card(wp, 'tara').currentWork?.id, a.id);
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('a planned assignment starts a build session and moves to building', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    withOauth(tmp.dir);
    const a = work.create(wp, { kind: 'assignment', title: 'Doze', body: 'Build the doze', charterId: 'character' });
    work.attachPlan(wp, a.id, '1. add the doze state 2. test', 'dev');
    const agent = employees.assign(wp, a.id);
    await tick();
    assert.equal(work.get(wp, a.id)!.state, 'building');
    assert.ok(fake.last().options.prompt.startsWith(`Build assignment ${a.id}`));
    assert.ok(fake.last().options.systemPromptAppend!.includes('### Your plan so far'));
    assert.ok(agent.assignmentId === a.id);
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('ending a session asks for the handoff and the next session starts from it', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    withOauth(tmp.dir);
    const agent = employees.talk(wp, 'rohan', 'start');
    await tick();
    const first = fake.last();
    const ending = employees.endSession(wp, agent.id, 2000);
    await tick();
    assert.ok(first.sent.some(m => m.text.includes('write_handoff')));
    // The model "writes" the handoff through the tool; simulate the effect.
    writeEmployeeFile(wp.org, 'rohan', 'handoff.md', 'Next: notarise 0.2.16.\n');
    await ending;
    assert.equal(first.closed, true);
    assert.equal(employees.openSession('rohan'), undefined);
    assert.equal(employees.stateOf(wp, 'rohan'), 'idle');

    employees.talk(wp, 'rohan', 'continue');
    await tick();
    assert.equal(fake.sessions.length, 2);
    assert.ok(fake.last().options.systemPromptAppend!.includes('Next: notarise 0.2.16.'));
    assert.equal(readEmployeeFile(wp.org, 'rohan', 'handoff.md'), 'Next: notarise 0.2.16.\n');
    assert.equal(runs.getRunAgent(agent.id), undefined);
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('concurrent sessions are capped per employee', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    withOauth(tmp.dir);
    const a = work.create(wp, { kind: 'assignment', title: 'A', body: 'x', charterId: 'memory' });
    employees.talk(wp, 'kabir', 'x');
    await tick();
    // A second assignment goes into the open session instead of a second process: mid-turn it waits
    // for the turn to end (the worktree is switched to its branch first; worktree-switch.test.ts).
    const agent = employees.assign(wp, a.id);
    assert.equal(fake.sessions.length, 1);
    assert.ok(!fake.last().sent.some(m => m.text.includes(`New assignment ${a.id}`)), 'not pushed into a running turn');
    fake.last().result();
    await tick();
    await tick();
    assert.ok(fake.last().sent.some(m => m.text.includes(`New assignment ${a.id}`)));
    assert.ok(agent);
    employees.close(wp, agent.id, 'test');
    assert.equal(fake.sessions.length, 1);
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('an interrupt leaves the session idle with nothing pending, not "waiting for you"', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    withOauth(tmp.dir);
    const agent = employees.talk(wp, 'mira', 'go');
    await tick();
    const decided: string[] = [];
    void fake.last().events.onPermission({ tool: 'Bash', input: { command: 'x' }, title: 't', suggestions: [] }).then(d => decided.push(d));
    await tick();
    assert.equal(runs.getRunAgent(agent.id)!.status, 'waiting');
    assert.ok(runs.getRunAgent(agent.id)!.approval);
    await runs.interruptRun(agent.id);
    const after = runs.getRunAgent(agent.id)!;
    assert.equal(after.status, 'idle');
    assert.equal(after.approval, undefined);
    // An interrupted run is not live work (QA B4): the session is kept for the owner to continue, but the
    // card says idle, and the next assignment gets a fresh session rather than this dead one.
    assert.equal(employees.stateOf(wp, 'mira'), 'idle', 'nothing needs the owner, and nothing is running');
    assert.equal(employees.openSession('mira'), undefined);
    assert.equal(employees.allSessions().some(s => s.agentId === agent.id), true, 'still held until it goes stale');
    assert.throws(() => runs.resolveApproval(agent.id, 'once'), /already been answered/);
    employees.talk(wp, 'mira', 'carry on');
    assert.equal(runs.getRunAgent(agent.id)!.status, 'running');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('a restart reports every open session and re-raises a pending approval as an Inbox question', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    withOauth(tmp.dir);
    const a = work.create(wp, { kind: 'assignment', title: 'Doze', body: 'x', charterId: 'character' });
    work.attachPlan(wp, a.id, 'p', 'dev');
    const building = employees.assign(wp, a.id);
    await tick();
    void fake.last().events.onPermission({ tool: 'mcp__travsr__get_context', input: { query: 'presence' }, title: 't', suggestions: [] });
    await tick();
    const row = wp.db.prepare('select sdk_session_id, status, json from sessions where id = ?').get(building.id) as { sdk_session_id: string; status: string; json: string };
    assert.equal(row.sdk_session_id, fake.last().sessionId);
    assert.equal(row.status, 'waiting');
    assert.equal((JSON.parse(row.json) as { pending: { tool: string } }).pending.tool, 'mcp__travsr__get_context');

    // The process dies: the in-memory register is empty, the rows are still open.
    const inbox = await import('../src/services/inbox.js');
    const before = inbox.list(wp, 'open').length;
    const lost = employees.recoverAfterRestart(wp);
    assert.equal(lost.length, 1);
    assert.equal(lost[0]!.pending?.tool, 'mcp__travsr__get_context');
    assert.equal(lost[0]!.sdkSessionId, fake.last().sessionId);
    const items = inbox.list(wp, 'open');
    assert.equal(items.length, before + 1);
    assert.match(items[0]!.title, /Dev lost a pending approval on restart: mcp__travsr__get_context/);
    assert.equal(items[0]!.context['sdkSessionId'], fake.last().sessionId);
    // A restart is not a block (QA 2 Oct): the status stays; the interruption is a note, and the boot resumes it.
    assert.equal(work.get(wp, a.id)!.state, 'building');
    const trail = await import('../src/services/trail.js');
    assert.match(trail.activityFor(wp, a.id).at(-1)!.text, /lost when the Workplace restarted while waiting for approval/);
    assert.ok(wp.db.prepare('select 1 from settings where key = ?').get(`resume:${a.id}`), 'marked for the boot to resume');
    assert.deepEqual(employees.recoverAfterRestart(wp), [], 'rows are closed; a second recovery finds nothing');
    assert.equal((wp.db.prepare('select status from sessions where id = ?').get(building.id) as { status: string }).status, 'lost-on-restart');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('an orderly shutdown with a pending approval files the same question and leaves the build in progress for the boot', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    withOauth(tmp.dir);
    const a = work.create(wp, { kind: 'assignment', title: 'Doze', body: 'x', charterId: 'character' });
    work.attachPlan(wp, a.id, 'p', 'dev');
    employees.assign(wp, a.id);
    await tick();
    void fake.last().events.onPermission({ tool: 'Bash', input: { command: 'npm test' }, title: 't', suggestions: [] });
    await tick();
    const inbox = await import('../src/services/inbox.js');
    const before = inbox.list(wp, 'open').length;
    employees.closeAll(wp, 'shutdown');
    const items = inbox.list(wp, 'open');
    assert.equal(items.length, before + 1);
    assert.match(items[0]!.title, /Dev lost a pending approval \(shut down\): Bash/);
    assert.equal(work.get(wp, a.id)!.state, 'building', 'a shutdown is not a block; the boot resumes it');
    assert.equal(employees.allSessions().length, 0);
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('a shutdown-then-boot cycle resumes work blocked only by the Workplace\'s own restart; owner-stopped and capped work does not', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    withOauth(tmp.dir);

    // Dev and Mira are mid-build when the Workplace shuts down.
    const dev = work.create(wp, { kind: 'assignment', title: 'Dev work', body: 'x', employeeId: 'dev', charterId: 'character' });
    work.attachPlan(wp, dev.id, 'p', 'dev');
    employees.assign(wp, dev.id);
    const mira = work.create(wp, { kind: 'assignment', title: 'Mira work', body: 'x', employeeId: 'mira', charterId: 'experts' });
    work.attachPlan(wp, mira.id, 'p', 'mira');
    employees.assign(wp, mira.id);
    // Kabir too, but Kabir is capped for today.
    const kabir = work.create(wp, { kind: 'assignment', title: 'Kabir work', body: 'x', employeeId: 'kabir', charterId: 'memory' });
    work.attachPlan(wp, kabir.id, 'p', 'kabir');
    employees.assign(wp, kabir.id);
    await tick();

    employees.closeAll(wp, 'shutdown');
    assert.equal(work.get(wp, dev.id)!.state, 'building', 'a shutdown never blocks the work (QA 2 Oct)');
    assert.ok(wp.db.prepare('select 1 from settings where key = ?').get(`resume:${dev.id}`), 'marked so a boot can tell it from an owner stop or a failure');
    const day = spend.dayOf();
    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`paused:${day}:employee:kabir`, new Date().toISOString());

    // Tara's work was blocked by the owner, by hand: it never carries the shutdown cause.
    const stopped = work.create(wp, { kind: 'assignment', title: 'Owner stopped', body: 'x', employeeId: 'tara', charterId: 'mobile' });
    work.attachPlan(wp, stopped.id, 'p', 'tara');
    work.transition(wp, stopped.id, { to: 'building', by: 'tara' });
    work.transition(wp, stopped.id, { to: 'blocked', by: 'owner', note: 'owner paused this for now' });

    // Nikhil's start genuinely failed (a guard denial, a missing worktree, ...): also by the
    // Workplace, but not a shutdown — resumeAfterShutdown must tell these apart.
    const failed = work.create(wp, { kind: 'assignment', title: 'Failed start', body: 'x', employeeId: 'nikhil', charterId: 'qa-release' });
    work.attachPlan(wp, failed.id, 'p', 'nikhil');
    work.transition(wp, failed.id, { to: 'building', by: 'nikhil' });
    work.transition(wp, failed.id, { to: 'blocked', by: 'workplace', note: 'no handoff file found' });

    const result = await employees.resumeAfterShutdown(wp, 5);
    await tick();

    assert.deepEqual(result.resumed.slice().sort(), [dev.id, mira.id].sort());
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0]!.id, kabir.id);
    assert.match(result.skipped[0]!.reason, /spend cap/);

    assert.equal(work.get(wp, dev.id)!.state, 'building', 'resumed from the branch and the handoff');
    assert.equal(work.get(wp, mira.id)!.state, 'building');
    assert.ok(employees.openSession('dev'));
    assert.ok(employees.openSession('mira'));

    assert.equal(work.get(wp, kabir.id)!.state, 'building', 'capped work keeps its status');
    assert.equal(employees.openSession('kabir'), undefined, 'but stays stopped');
    assert.equal(work.get(wp, stopped.id)!.state, 'blocked', 'owner-stopped work stays stopped');
    assert.equal(work.get(wp, failed.id)!.state, 'blocked', 'a genuine failure is not auto-resumed');

    // Idempotent: once resumed, a second boot finds nothing new to do for Dev and Mira.
    const again = await employees.resumeAfterShutdown(wp, 5);
    assert.deepEqual(again.resumed, []);
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});
