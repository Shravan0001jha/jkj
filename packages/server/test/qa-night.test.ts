import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createWorkplace } from '../src/services/workplace.js';
import { assertNotRealPath, isTemp, underTest, RealPathInTest } from '../src/services/test-guard.js';
import { ensureWorktree } from '../src/services/worktrees.js';
import * as cos from '../src/services/cos.js';
import * as inbox from '../src/services/inbox.js';
import * as work from '../src/services/work.js';
import * as runs from '../src/services/runs.js';
import * as employees from '../src/services/employees.js';
import * as health from '../src/services/health.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';
import { tmpWorkplace } from './fakes/tmp-workplace.js';

/** QA's night bugs (29 Sep): B5 tests in real repos, B3 the routine's self-deadlock, B4 dead sessions left open. */

const tick = () => new Promise(r => setTimeout(r, 5));

test('B5: under the test runner, real paths are refused before anything is opened; the temp workplace is entirely under the temp dir', () => {
  assert.equal(underTest(), true, 'node --test marks its children with NODE_TEST_CONTEXT');
  assert.equal(isTemp(join(tmpdir(), 'x')), true);
  assert.equal(isTemp(join(homedir(), 'iris-workplace')), false);
  assert.throws(() => assertNotRealPath('organisation directory', join(homedir(), 'iris-workplace')), RealPathInTest);
  assert.doesNotThrow(() => assertNotRealPath('x', tmpdir()));
  assert.doesNotThrow(() => assertNotRealPath('x', join(homedir(), 'iris-workplace'), {}), 'outside a test nothing is refused');

  // The default config (no env) points at the real organisation and ~/iris-work: refused as a whole.
  assert.throws(() => createWorkplace(loadConfig(['--no-open', '--no-telegram', '--no-seed'], {})), /Refusing to touch the organisation directory/);

  // A temp organisation whose org.yaml still names a real repository is refused at the repo.
  const tmp = tmpWorkplace();
  try {
    for (const r of tmp.org.repos) assert.ok(isTemp(r.root), `${r.id} → ${r.root}`);
    for (const e of tmp.org.employees) assert.ok(isTemp(e.workspace.repo), `${e.id} → ${e.workspace.repo}`);
    assert.ok(isTemp(tmp.workDir));
    assert.equal(tmp.repos.size >= 2, true, 'the seed names more than one real checkout');

    const real = join(homedir(), 'claude-dev');
    const e = { ...tmp.org.employees[0]!, workspace: { repo: real, branch: 'main' } };
    assert.throws(() => ensureWorktree(tmp.workDir, e, 'as_x'), /Refusing to touch the repository of/);
    assert.throws(() => ensureWorktree(join(homedir(), 'iris-work'), tmp.org.employees[0]!, 'as_x'), /Refusing to touch the work directory/);
    // The real thing, in temp: allowed and working.
    const wt = ensureWorktree(tmp.workDir, tmp.org.employees.find(x => x.id === 'tara')!, 'as_ok');
    assert.ok(existsSync(wt.path));
    assert.ok(wt.path.startsWith(tmp.workDir));
  } finally {
    tmp.cleanup();
  }

  // A workplace dir under temp but a work dir at home: refused at the work dir.
  const dir = mkdtempSync(join(tmpdir(), 'wp-guard-'));
  try {
    assert.throws(() => createWorkplace(loadConfig(['--no-open', '--no-telegram'], { IRIS_WORKPLACE_DIR: dir, IRIS_WORK_DIR: join(homedir(), 'iris-work') })), /Refusing to touch the work directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B3: the routine never waits on its own notes or on the stall detector; one note per item per day; duplicates are withdrawn at boot', async () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_STALL_MINUTES: '30', WORKPLACE_USD_INR: '100', WORKPLACE_CAP_INR: '100000' });
  const fake = installFakeRuntime();
  try {
    mkdirSync(join(tmp.dir, 'ops', 'workplace'), { recursive: true });
    writeFileSync(join(tmp.dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=x\n');
    const a = work.create(wp, { kind: 'assignment', title: 'Composer', body: 'x', charterId: 'mobile' });
    work.attachPlan(wp, a.id, 'p', 'tara');
    const day1 = Date.now() + 31 * 60_000;

    // Yesterday's note (as the old build left it) and the stall detector's item about a dead session: neither blocks a resume.
    const old = inbox.raise(wp, { kind: 'question', title: `Waiting: ${a.title}`, body: 'old', raisedBy: 'asha', context: { assignmentId: a.id, employeeId: 'tara', stalledSince: null, reason: 'x' } });
    const older = inbox.raise(wp, { kind: 'question', title: `Waiting: ${a.title}`, body: 'older', raisedBy: 'asha', context: { assignmentId: a.id, employeeId: 'tara', stalledSince: null, reason: 'y' }, dedupeKey: 'other-day' });
    const detector = inbox.raise(wp, { kind: 'question', title: 'Tara is stalled', body: 'idle', raisedBy: 'tara', context: { agentId: 'run_dead', reason: 'idle' } });
    assert.equal(cos.whyWaiting(wp, work.get(wp, a.id)!, 'd'), null, 'nothing real to wait on');

    const first = cos.tick(wp, day1);
    assert.deepEqual(first.resumed, [a.id], JSON.stringify(first));
    await tick();
    assert.equal(inbox.get(wp, detector.id)!.state, 'answered', 'the detector item is answered by the Workplace when the work resumes');
    assert.equal(inbox.get(wp, detector.id)!.answer?.via, 'workplace');
    employees.closeAll(wp, 'test');

    // Stalled again the same day: one note, and the earlier open notes for the item are withdrawn.
    const later = day1 + 40 * 60_000;
    const second = cos.tick(wp, later);
    assert.equal(second.noted.length, 1, JSON.stringify(second));
    assert.equal(inbox.get(wp, old.id)!.state, 'expired');
    assert.equal(inbox.get(wp, older.id)!.state, 'expired');
    const notes = inbox.list(wp, 'open').filter(cos.isRoutineNote);
    assert.equal(notes.length, 1, 'exactly one open note for the item');
    // "Let it wait" is an answer for the day: no new note the same day, and the note never blocks the next day's resume.
    inbox.answer(wp, notes[0]!.id, 'wait', undefined, 'phone');
    assert.deepEqual(cos.tick(wp, later + 60_000).noted, []);
    assert.equal(inbox.list(wp, 'open').filter(cos.isRoutineNote).length, 0);

    // Boot dedupe: three generations of notes for one item → the newest stays open; a real decision is untouched.
    const decision = inbox.raise(wp, { kind: 'decision', title: 'Adopt tiers?', body: 'x', raisedBy: 'asha' });
    const g1 = inbox.raise(wp, { kind: 'question', title: 'Waiting: Composer', body: '1', raisedBy: 'asha', context: { assignmentId: a.id, stalledSince: null }, dedupeKey: 'g1' });
    await tick();
    const g2 = inbox.raise(wp, { kind: 'question', title: 'Waiting: Composer', body: '2', raisedBy: 'asha', context: { assignmentId: a.id, stalledSince: null }, dedupeKey: 'g2' });
    await tick();
    const g3 = inbox.raise(wp, { kind: 'question', title: 'Waiting: Composer', body: '3', raisedBy: 'asha', context: { assignmentId: a.id, stalledSince: null }, dedupeKey: 'g3' });
    const d = cos.dedupeNotes(wp);
    assert.deepEqual(d.expired.sort(), [g1.id, g2.id].sort());
    assert.equal(inbox.get(wp, g3.id)!.state, 'open');
    assert.equal(inbox.get(wp, decision.id)!.state, 'open');
    assert.deepEqual(cos.dedupeNotes(wp).expired, [], 'idempotent');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('B4: a dead run is closed, the state reads true, and the next assignment gets a fresh session; a stall ends the session', async () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_USD_INR: '100', WORKPLACE_CAP_INR: '100000' });
  const fake = installFakeRuntime();
  try {
    mkdirSync(join(tmp.dir, 'ops', 'workplace'), { recursive: true });
    writeFileSync(join(tmp.dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=x\n');
    const agent = employees.talk(wp, 'kabir', 'hello');
    await tick();
    assert.equal(employees.stateOf(wp, 'kabir'), 'working');
    await runs.interruptRun(agent.id);
    assert.equal(runs.getRunAgent(agent.id)?.status, 'idle');
    // Interrupted just now: still held (the owner may continue it), but it is not "working".
    assert.equal(employees.openSession('kabir'), undefined, 'a dead run is not an open session');
    assert.equal(employees.stateOf(wp, 'kabir'), 'idle');
    assert.deepEqual(employees.closeStale(wp, Date.now()), [], 'not stale yet');
    assert.equal(employees.allSessions().length, 1);
    // A new assignment does not go into the dead run: it is closed and a fresh session spawns.
    const a = work.create(wp, { kind: 'assignment', title: 'Memory tiers', body: 'x', employeeId: 'kabir' });
    const fresh = employees.assign(wp, a.id);
    await tick();
    assert.notEqual(fresh.id, agent.id);
    assert.equal(fake.sessions.length, 2);
    assert.equal(employees.allSessions().length, 1, 'the dead one is gone');
    assert.match(wp.db.prepare('select status from sessions where id = ?').get(agent.id) ? String((wp.db.prepare('select status from sessions where id = ?').get(agent.id) as { status: string }).status) : '', /replaced/);

    // Ten minutes dead with nothing new: the sweep closes it.
    await runs.interruptRun(fresh.id);
    assert.deepEqual(employees.closeStale(wp, Date.now() + employees.STALE_MS + 1), [fresh.id]);
    assert.equal(employees.allSessions().length, 0);
    assert.equal(employees.stateOf(wp, 'kabir'), 'idle');

    // The stall detector ends an idle session rather than leaving it open, and asks the owner once.
    const s = employees.talk(wp, 'mira', 'go');
    await tick();
    fake.last().result();                                             // turn over: waiting between turns
    const found = await health.handleStalls(wp, Date.now() + 11 * 60_000);
    assert.equal(found.length, 1);
    assert.ok(fake.sessions.at(-1)!.sent.some(m => /handoff/i.test(m.text)), 'asked for its handoff first');
    assert.equal(employees.allSessions().some(x => x.agentId === s.id), false, 'ended');
    assert.equal(employees.stateOf(wp, 'mira'), 'needs-owner');
    const item = inbox.list(wp, 'open').find(i => i.raisedBy === 'mira')!;
    assert.match(item.body, /was ended/);
    assert.ok(cos.isStallDetectorItem(item));
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});
