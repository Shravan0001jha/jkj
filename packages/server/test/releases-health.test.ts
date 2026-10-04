import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as releases from '../src/services/releases.js';
import * as inbox from '../src/services/inbox.js';
import * as work from '../src/services/work.js';
import * as employees from '../src/services/employees.js';
import * as runs from '../src/services/runs.js';
import * as health from '../src/services/health.js';
import type { WorkplaceEvent } from '../src/services/workplace.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

const tick = () => new Promise(r => setTimeout(r, 5));

test('a release runs the real script only after the owner approves it, and never twice', async () => {
  const { wp, tmp } = testWorkplace();
  const spawned: { command: string; args: string[]; cwd: string }[] = [];
  releases.useSpawner(async (spec, onLine) => { spawned.push({ command: spec.command, args: spec.args, cwd: spec.cwd }); onLine('▶ releasing Iris 0.2.16'); onLine('done'); return { code: 0 }; });
  try {
    const events: WorkplaceEvent[] = [];
    wp.on(e => events.push(e));
    const done = work.create(wp, { kind: 'assignment', title: 'Fix the doze', body: 'x', charterId: 'character', platformIds: ['mac'] });
    work.attachPlan(wp, done.id, 'p', 'dev');
    work.transition(wp, done.id, { to: 'building', by: 'dev' });
    work.transition(wp, done.id, { to: 'review', by: 'dev', evidence: { tests: { passed: 1, failed: 0 }, commits: ['c1'], liveVerified: [], notVerified: [] } });
    work.transition(wp, done.id, { to: 'done', by: 'nikhil' });

    const rel = releases.propose(wp, 'desktop-mac', '0.2.16');
    assert.equal(rel.state, 'proposed');
    assert.deepEqual(rel.unreleased, [`${done.id} Fix the doze`]);
    await assert.rejects(releases.run(wp, rel.id), /Refused: waiting for the owner/);
    assert.equal(spawned.length, 0);

    inbox.answer(wp, rel.inboxId, 'approve', undefined, 'phone');
    assert.equal(releases.get(wp, rel.id)!.state, 'approved');
    const ran = await releases.run(wp, rel.id);
    assert.equal(ran.state, 'done');
    const iris = wp.org.repos.find(r => r.id === 'iris')!.root;
    assert.deepEqual(spawned, [{ command: `${iris}/scripts/release-iris.sh`, args: ['0.2.16'], cwd: iris }]);
    assert.ok(events.some(e => e.type === 'release.log' && e.line === '▶ releasing Iris 0.2.16'));
    assert.match(ran.log!, /releasing Iris 0.2.16/);
    await assert.rejects(releases.run(wp, rel.id), /already ran/);

    // After a done release the assignment is no longer "unreleased".
    assert.deepEqual(releases.unreleasedFor(wp, 'desktop-mac'), []);
  } finally {
    releases.useSpawner(null);
    tmp.cleanup();
  }
});

test('a server deploy runs from the deploy worktree and is refused when rejected', async () => {
  const { wp, tmp } = testWorkplace();
  const spawned: string[] = [];
  releases.useSpawner(async spec => { spawned.push(`${spec.cwd} ${spec.command}`); return { code: 1 }; });
  try {
    const rel = releases.propose(wp, 'server-api', 'api-2026-09-28');
    inbox.answer(wp, rel.inboxId, 'reject', undefined, 'web');
    await assert.rejects(releases.run(wp, rel.id), /rejected/);
    assert.equal(spawned.length, 0);

    const again = releases.propose(wp, 'server-api', 'api-2026-09-28b');
    inbox.answer(wp, again.inboxId, 'approve', undefined, 'web');
    const ran = await releases.run(wp, again.id);
    assert.equal(ran.state, 'failed');
    const deploy = wp.org.repos.find(r => r.id === 'iris-deploy')!.root;
    assert.deepEqual(spawned, [`${deploy} ${deploy}/scripts/deploy-api.sh`]);
  } finally {
    releases.useSpawner(null);
    tmp.cleanup();
  }
});

test('a session idle for ten minutes is stalled once: interrupted, ended, one question filed', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  health.setHandoffWait(100);
  try {
    const agent = employees.talk(wp, 'dev', 'go');
    await tick();
    const started = new Date(agent.startedAt).getTime();
    assert.deepEqual(health.detectStalls(started + 5 * 60 * 1000), []);
    const stalled = fake.last();
    const found = await health.handleStalls(wp, started + 11 * 60 * 1000);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.reason, 'idle');
    assert.equal(stalled.interrupted, 1);
    // The owner's "go" was never acted on: it is delivered again in a new session (4 Oct).
    assert.notEqual(fake.last(), stalled);
    assert.match(fake.last().options.prompt, /Delivered again[\s\S]*go/);
    // The session is ended (QA B4) and a routine note is filed for Asha (never the owner's Inbox, per
    // the owner's rule); the employee is working again, on the delivered-again message.
    assert.equal(employees.allSessions().some(s => s.agentId === agent.id), false);
    assert.equal(employees.stateOf(wp, 'dev'), 'working', 'on the delivered-again message, not blocked');
    await health.handleStalls(wp, started + 12 * 60 * 1000);
    assert.equal(inbox.list(wp).filter(i => i.kind === 'question').length, 1);
    assert.equal(stalled.interrupted, 1, 'stalled once');
  } finally {
    health.setHandoffWait(30_000);
    fake.restore();
    tmp.cleanup();
  }
});

test('a tool call parked for two minutes raises one needs-you alert', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    const agent = employees.talk(wp, 'asha', 'go');
    await tick();
    const alerts: string[] = [];
    wp.on(e => { if (e.type === 'alert') alerts.push(e.title); });
    const decided: string[] = [];
    void fake.last().events.onPermission({ tool: 'Bash', input: { command: 'rm -rf build' }, title: 'Run a command', suggestions: [] }).then(d => decided.push(d));
    await tick();
    const now = Date.now();
    assert.deepEqual(health.handleParkedApprovals(wp, now + 60_000), []);
    const first = health.handleParkedApprovals(wp, now + 3 * 60_000);
    assert.equal(first.length, 1);
    assert.deepEqual(health.handleParkedApprovals(wp, now + 4 * 60_000), [], 'once per prompt');
    assert.ok(alerts.some(t => t.startsWith('Asha is waiting for a tool approval')));
    assert.equal(employees.stateOf(wp, 'asha'), 'needs-owner');
    runs.resolveApproval(agent.id, 'deny');
    await tick();
    assert.deepEqual(decided, ['deny']);
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('five identical tool calls in a row are a loop', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    employees.talk(wp, 'kabir', 'go');
    await tick();
    const s = fake.last();
    for (let i = 0; i < 4; i++) s.tool('Bash', { command: 'pytest -q' });
    assert.deepEqual(health.detectStalls(), []);
    s.tool('Bash', { command: 'pytest -q' });
    assert.equal(health.detectStalls()[0]?.reason, 'loop');
    s.tool('Read', { file_path: '/x' });
    assert.deepEqual(health.detectStalls(), []);
    // Same tool, different arguments, is work, not a loop: Asha asking status_of about five people (4 Oct).
    for (const q of ['Kabir', 'Neel', 'Ira', 'Mira', 'Dev']) s.tool('mcp__workplace__status_of', { q });
    assert.deepEqual(health.detectStalls(), []);
    for (let i = 0; i < 5; i++) s.tool('mcp__workplace__status_of', { q: 'Kabir' });
    assert.equal(health.detectStalls()[0]?.reason, 'loop');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('signals count throughput, rework and false-done per employee, and queue triggers per charter', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const ev = { tests: { passed: 1, failed: 0 }, commits: ['c'], liveVerified: [], notVerified: [] };
    for (let i = 0; i < 6; i++) work.create(wp, { kind: 'assignment', title: `q${i}`, body: 'x', charterId: 'experts' });
    const a = work.create(wp, { kind: 'assignment', title: 'A', body: 'x', charterId: 'memory' });
    work.attachPlan(wp, a.id, 'p', 'kabir');
    work.transition(wp, a.id, { to: 'building', by: 'kabir' });
    work.transition(wp, a.id, { to: 'review', by: 'kabir', evidence: ev });
    work.sendBack(wp, a.id, 'nikhil', 'tests did not run');
    work.transition(wp, a.id, { to: 'review', by: 'kabir', evidence: ev });
    work.transition(wp, a.id, { to: 'done', by: 'nikhil' });
    const s = health.signals(wp);
    assert.deepEqual(s.employees['kabir'], { throughput7d: 1, rework7d: 1, falseDoneRate7d: 0.5, costPerDoneInr: 0 });
    assert.equal(s.charters['experts']!.queue, 6);
    assert.ok(s.proposalTriggers.some(t => t.code === 'queue' && t.subject === 'experts'));
    assert.deepEqual(s.blockingPairs, []);
  } finally {
    tmp.cleanup();
  }
});
