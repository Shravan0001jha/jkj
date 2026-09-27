import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as releases from '../src/services/releases.js';
import * as inbox from '../src/services/inbox.js';
import * as work from '../src/services/work.js';
import * as employees from '../src/services/employees.js';
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
    assert.deepEqual(spawned, [{ command: '/Users/shravan0001jha/claude-dev/scripts/release-iris.sh', args: ['0.2.16'], cwd: '/Users/shravan0001jha/claude-dev' }]);
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
    assert.deepEqual(spawned, ['/Users/shravan0001jha/claude-dev-deploy /Users/shravan0001jha/claude-dev-deploy/scripts/deploy-api.sh']);
  } finally {
    releases.useSpawner(null);
    tmp.cleanup();
  }
});

test('a session idle for ten minutes is stalled once: interrupted, blocked, one question filed', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    const agent = employees.talk(wp, 'dev', 'go');
    await tick();
    const started = new Date(agent.startedAt).getTime();
    assert.deepEqual(health.detectStalls(started + 5 * 60 * 1000), []);
    const found = await health.handleStalls(wp, started + 11 * 60 * 1000);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.reason, 'idle');
    assert.equal(fake.last().interrupted, 1);
    // A question is filed, so the honest state on the Office is "needs you".
    assert.equal(employees.stateOf(wp, 'dev'), 'needs-owner');
    await health.handleStalls(wp, started + 12 * 60 * 1000);
    assert.equal(inbox.list(wp).filter(i => i.kind === 'question').length, 1);
    assert.equal(fake.last().interrupted, 1);
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
