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

test('usage is recorded as deltas of the cumulative totals, and the cap pauses the employee', async () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_USD_INR: '100', WORKPLACE_CAP_INR: '100000' });
  const fake = installFakeRuntime();
  spend.onPause((w, scope) => employees.pauseScope(w, scope));
  try {
    withOauth(tmp.dir);
    employees.talk(wp, 'nikhil', 'hi');   // nikhil: ₹120/day
    await tick();
    const s = fake.last();
    s.result({ costUsd: 0.5 });   // cumulative 0.5 → ₹50
    s.result({ costUsd: 0.4 });   // cumulative 0.9 → delta ₹40
    const day = spend.dayOf();
    assert.equal(spend.summary(wp, day).byEmployee['nikhil'], 90);
    s.result({ costUsd: 0.4 });   // cumulative 1.3 → ₹130 ≥ 120: paused
    assert.equal(spend.summary(wp, day).byEmployee['nikhil'], 130);
    assert.equal(employees.stateOf(wp, 'nikhil'), 'paused');
    assert.equal(s.interrupted, 1);
    assert.throws(() => employees.talk(wp, 'nikhil', 'more'), /paused/);
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
    // A second assignment goes into the open session instead of a second process.
    const agent = employees.assign(wp, a.id);
    assert.equal(fake.sessions.length, 1);
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
    assert.equal(employees.stateOf(wp, 'mira'), 'working', 'a session is open; nothing needs the owner');
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
    assert.equal(work.get(wp, a.id)!.state, 'blocked');
    assert.match(work.get(wp, a.id)!.history.at(-1)!.note!, /lost when the Workplace restarted while waiting for approval/);
    assert.deepEqual(employees.recoverAfterRestart(wp), [], 'rows are closed; a second recovery finds nothing');
    assert.equal((wp.db.prepare('select status from sessions where id = ?').get(building.id) as { status: string }).status, 'lost-on-restart');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});
