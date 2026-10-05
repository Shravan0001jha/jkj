import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Employee } from '@jkj/shared';
import { ensureWorktree, WorktreeSwitchError } from '../src/services/worktrees.js';
import * as employees from '../src/services/employees.js';
import * as work from '../src/services/work.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * Starting assignment X always ends with the worktree on emp/<emp>/<X>, or the
 * assignment is blocked with the reason (2 Oct: Dev's P0 ran on a parked item's
 * branch because the tree had that item's uncommitted change).
 */

const out = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

/** A repo with a base branch and a real (untracked, not .gitignored) virtualenv in the main checkout. */
function tempRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'repo-'));
  out(root, ['init', '-q', '-b', 'main']);
  out(root, ['config', 'user.email', 't@t']); out(root, ['config', 'user.name', 't']);
  mkdirSync(join(root, 'services', 'agent-svc'), { recursive: true });
  writeFileSync(join(root, 'services', 'agent-svc', 'speaker_gate.py'), 'base\n');
  writeFileSync(join(root, '.gitignore'), 'build/\n');
  out(root, ['add', '-A']); out(root, ['commit', '-q', '-m', 'base']);
  out(root, ['checkout', '-q', '-b', 'feat/x']);
  mkdirSync(join(root, '.venv')); writeFileSync(join(root, '.venv', 'marker'), 'venv');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function dev(repo: string): Employee {
  return { id: 'dev', name: 'Dev', roleId: 'engineer', level: 2, permanent: true, charterIds: ['experts'], unitId: 'platforms', chapterIds: [], reportsTo: null, workspace: { repo, branch: 'feat/x' }, budget: { inrPerDay: 1, concurrentSessions: 1 }, state: 'idle' } as Employee;
}

function setup(): { repo: string; workDir: string; emp: Employee; cleanup: () => void } {
  const r = tempRepo();
  const workDir = mkdtempSync(join(tmpdir(), 'work-'));
  return { repo: r.root, workDir, emp: dev(r.root), cleanup: () => { r.cleanup(); rmSync(workDir, { recursive: true, force: true }); } };
}

test('a dirty tree on another branch is auto-saved to that branch, then switched; venvs are never committed', () => {
  const { repo, workDir, emp, cleanup } = setup();
  try {
    const parked = ensureWorktree(workDir, emp, 'as_parked');
    assert.equal(parked.branch, 'emp/dev/as_parked');
    // The parked item's uncommitted work: a tracked change, a new file, and an untracked real venv dir.
    writeFileSync(join(parked.path, 'services', 'agent-svc', 'speaker_gate.py'), 'parked change\n');
    writeFileSync(join(parked.path, 'services', 'agent-svc', 'new_gate.py'), 'new\n');
    mkdirSync(join(parked.path, '.venv-x64', 'bin'), { recursive: true });
    writeFileSync(join(parked.path, '.venv-x64', 'bin', 'python'), '#!');
    // Rebuilt build output from a live check is restored, never auto-saved (5 Oct).
    mkdirSync(join(parked.path, 'services', 'agent-svc', 'dist-arm64', 'iris-agent'), { recursive: true });
    writeFileSync(join(parked.path, 'services', 'agent-svc', 'dist-arm64', 'iris-agent', 'iris-agent'), 'binary');

    const p0 = ensureWorktree(workDir, emp, 'as_p0');
    assert.equal(p0.branch, 'emp/dev/as_p0');
    assert.equal(out(p0.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'emp/dev/as_p0');
    assert.equal(out(p0.path, ['rev-parse', 'HEAD']), out(repo, ['rev-parse', 'feat/x']), 'the new branch is cut from the base, not from the parked branch');
    assert.equal(readFileSync(join(p0.path, 'services', 'agent-svc', 'speaker_gate.py'), 'utf8'), 'base\n', 'the parked change does not follow onto the P0');
    assert.ok(!existsSync(join(p0.path, 'services', 'agent-svc', 'new_gate.py')));
    assert.equal(out(p0.path, ['status', '--porcelain']), '', 'the P0 starts from a clean tree');

    // The parked work is safe on its own branch, as one WIP commit naming the switch.
    assert.equal(out(repo, ['log', '-1', '--format=%s', 'emp/dev/as_parked']), 'WIP (auto-saved by the Workplace before switching to as_p0)');
    const saved = out(repo, ['show', '--name-only', '--format=', 'emp/dev/as_parked']).split('\n').sort();
    assert.deepEqual(saved, ['services/agent-svc/new_gate.py', 'services/agent-svc/speaker_gate.py']);
    assert.equal(out(repo, ['show', 'emp/dev/as_parked:services/agent-svc/speaker_gate.py']), 'parked change');
    assert.equal(out(repo, ['stash', 'list']), '', 'no stash');

    // Venvs are excluded through info/exclude, not the repo's .gitignore.
    const exclude = readFileSync(join(out(repo, ['rev-parse', '--absolute-git-dir']), 'info', 'exclude'), 'utf8');
    assert.match(exclude, /^\.venv\*$/m);
    assert.equal(readFileSync(join(p0.path, '.gitignore'), 'utf8'), 'build/\n');
    assert.ok(existsSync(join(p0.path, '.venv-x64', 'bin', 'python')), 'the untracked venv is left in place, not discarded');
  } finally {
    cleanup();
  }
});

test('an existing target branch is checked out, with its own commits', () => {
  const { repo, workDir, emp, cleanup } = setup();
  try {
    const first = ensureWorktree(workDir, emp, 'as_a');
    writeFileSync(join(first.path, 'a.txt'), 'a\n');
    out(first.path, ['add', '-A']); out(first.path, ['commit', '-q', '-m', 'work on a']);
    const tip = out(first.path, ['rev-parse', 'HEAD']);
    ensureWorktree(workDir, emp, 'as_b');

    const back = ensureWorktree(workDir, emp, 'as_a');
    assert.equal(back.branch, 'emp/dev/as_a');
    assert.equal(out(back.path, ['rev-parse', 'HEAD']), tip, 'the existing branch, not a fresh one from the base');
    assert.equal(readFileSync(join(back.path, 'a.txt'), 'utf8'), 'a\n');
    assert.equal(out(repo, ['log', '-1', '--format=%s', 'emp/dev/as_b']), 'base', 'a clean tree gets no WIP commit');
  } finally {
    cleanup();
  }
});

test('a missing target branch is created from the base', () => {
  const { repo, workDir, emp, cleanup } = setup();
  try {
    const first = ensureWorktree(workDir, emp, 'as_a');
    writeFileSync(join(first.path, 'a.txt'), 'a\n');
    out(first.path, ['add', '-A']); out(first.path, ['commit', '-q', '-m', 'work on a']);
    out(repo, ['commit', '-q', '--allow-empty', '-m', 'base moved on']);

    const wt = ensureWorktree(workDir, emp, 'as_new');
    assert.equal(wt.branch, 'emp/dev/as_new');
    assert.equal(out(wt.path, ['rev-parse', 'HEAD']), out(repo, ['rev-parse', 'feat/x']), 'cut from the base tip');
    assert.ok(!existsSync(join(wt.path, 'a.txt')));
  } finally {
    cleanup();
  }
});

test('a switch that fails throws and leaves the worktree as it was', () => {
  const { repo, workDir, emp, cleanup } = setup();
  try {
    ensureWorktree(workDir, emp, 'as_a');
    // The target branch is checked out elsewhere: git refuses to check it out here.
    out(repo, ['branch', 'emp/dev/as_b', 'feat/x']);
    const other = join(workDir, 'elsewhere');
    out(repo, ['worktree', 'add', '-q', other, 'emp/dev/as_b']);
    assert.throws(() => ensureWorktree(workDir, emp, 'as_b'), (err: unknown) => err instanceof WorktreeSwitchError && /emp\/dev\/as_b/.test(err.message));
    assert.equal(out(join(workDir, 'dev', repo.split('/').pop()!), ['rev-parse', '--abbrev-ref', 'HEAD']), 'emp/dev/as_a');
  } finally {
    cleanup();
  }
});

test('starting an assignment whose branch cannot be checked out blocks it with the reason and runs nothing', async () => {
  const { repo, workDir, cleanup } = setup();
  const { wp, tmp } = testWorkplace({ IRIS_WORK_DIR: workDir });
  const fake = installFakeRuntime();
  try {
    const tara = wp.org.employees.find(e => e.id === 'tara')!;
    tara.workspace = { repo, branch: 'feat/x' };
    // Tara's worktree exists, parked on another item with uncommitted work.
    const parked = ensureWorktree(workDir, tara, 'as_parked');
    writeFileSync(join(parked.path, 'services', 'agent-svc', 'speaker_gate.py'), 'parked change\n');

    const a = work.create(wp, { kind: 'assignment', title: 'P0', body: 'x', charterId: 'mobile' });
    assert.equal(a.employeeId, 'tara');
    // Its branch is checked out in another worktree, so the switch must fail.
    out(repo, ['branch', `emp/tara/${a.id}`, 'feat/x']);
    out(repo, ['worktree', 'add', '-q', join(workDir, 'elsewhere'), `emp/tara/${a.id}`]);

    assert.throws(() => employees.assign(wp, a.id), WorktreeSwitchError);
    await new Promise(r => setTimeout(r, 5));
    assert.equal(fake.sessions.length, 0, 'no session runs on the wrong branch');
    const after = work.get(wp, a.id)!;
    assert.equal(after.state, 'blocked');
    assert.match(after.history.at(-1)!.note!, new RegExp(`emp/tara/${a.id}`));
    // The parked work was still saved to its own branch before the failed checkout.
    assert.equal(out(repo, ['show', 'emp/tara/as_parked:services/agent-svc/speaker_gate.py']), 'parked change');
  } finally {
    fake.restore();
    tmp.cleanup();
    cleanup();
  }
});

/* ---------- an open session taking a new assignment (live 2 Oct) ---------- */

/**
 * Live, 2 Oct: Dev was started on a new story while his talk session was open; assign only messaged
 * that session, so he built the story on emp/dev/general, cut before the day's merge. Now the open
 * session is moved onto the item's branch (cut from the base tip) before the assignment is sent, or,
 * mid-turn, at the end of that turn.
 */

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

function withOauth(dir: string): void {
  mkdirSync(join(dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token-value\n');
}

async function taraTalking(opts: { finishTurn: boolean }) {
  const { repo, workDir, cleanup } = setup();
  const { wp, tmp } = testWorkplace({ IRIS_WORK_DIR: workDir });
  const fake = installFakeRuntime();
  withOauth(tmp.dir);
  const tara = wp.org.employees.find(e => e.id === 'tara')!;
  tara.workspace = { repo, branch: 'feat/x' };
  employees.talk(wp, 'tara', 'Hello', [], { autonomous: true });
  await tick();
  const session = employees.openSession('tara')!;
  const path = session.worktree!.path;
  assert.equal(out(path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'emp/tara/general');
  // The talk left uncommitted work behind; and the base moves on (today's merge) after general was cut.
  writeFileSync(join(path, 'services', 'agent-svc', 'speaker_gate.py'), 'talk change\n');
  out(repo, ['commit', '-q', '--allow-empty', '-m', 'P0 merged']);
  if (opts.finishTurn) { fake.sessions[0]!.result(); await tick(); }
  const a = work.create(wp, { kind: 'assignment', title: 'Mic stays live', body: 'x', charterId: 'mobile' });
  assert.equal(a.employeeId, 'tara');
  return { wp, tmp, fake, repo, path, session, a, done: () => { fake.restore(); tmp.cleanup(); cleanup(); } };
}

const sessionRow = (wp: ReturnType<typeof testWorkplace>['wp'], id: string) => {
  const r = wp.db.prepare('select assignment_id, json from sessions where id = ?').get(id) as { assignment_id: string | null; json: string };
  return { assignmentId: r.assignment_id, ...(JSON.parse(r.json) as { branch?: string }) };
};

test('assign with an open session between turns: the worktree moves to the item branch (cut from the base tip, work auto-saved) before the message', async () => {
  const t = await taraTalking({ finishTurn: true });
  try {
    employees.assign(t.wp, t.a.id);
    assert.equal(t.fake.sessions.length, 1, 'the open session takes it; no new session');
    assert.equal(out(t.path, ['rev-parse', '--abbrev-ref', 'HEAD']), `emp/tara/${t.a.id}`);
    assert.equal(out(t.path, ['rev-parse', 'HEAD']), out(t.repo, ['rev-parse', 'feat/x']), 'cut from the current base tip, not from general');
    assert.equal(out(t.repo, ['show', 'emp/tara/general:services/agent-svc/speaker_gate.py']), 'talk change', 'the talk\'s work is saved on general');
    assert.match(t.fake.sessions[0]!.sent.at(-1)!.text, new RegExp(`New assignment ${t.a.id}`));
    assert.equal(t.session.assignmentId, t.a.id);
    assert.equal(t.session.worktree!.branch, `emp/tara/${t.a.id}`);
    const row = sessionRow(t.wp, t.session.agentId);
    assert.equal(row.assignmentId, t.a.id);
    assert.equal(row.branch, `emp/tara/${t.a.id}`, 'the session row records the new branch');
  } finally {
    t.done();
  }
});

test('assign with an open session mid-turn: nothing moves and nothing is sent until the turn ends; then switch, then the message', async () => {
  const t = await taraTalking({ finishTurn: false });
  try {
    employees.assign(t.wp, t.a.id);
    await tick();
    assert.equal(out(t.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'emp/tara/general', 'never moved under a running turn');
    assert.equal(t.fake.sessions[0]!.sent.filter(m => m.text.includes(t.a.id)).length, 0, 'not sent yet');

    t.fake.sessions[0]!.result();
    await tick(30);
    assert.equal(out(t.path, ['rev-parse', '--abbrev-ref', 'HEAD']), `emp/tara/${t.a.id}`);
    assert.equal(out(t.path, ['rev-parse', 'HEAD']), out(t.repo, ['rev-parse', 'feat/x']));
    assert.equal(t.fake.sessions[0]!.sent.filter(m => m.text.includes(`New assignment ${t.a.id}`)).length, 1);
    assert.equal(sessionRow(t.wp, t.session.agentId).branch, `emp/tara/${t.a.id}`);
    assert.equal(t.fake.sessions.length, 1);
  } finally {
    t.done();
  }
});

test('an existing item branch with no commits of its own is recut at the base tip', () => {
  const { repo, workDir, emp, cleanup } = setup();
  try {
    ensureWorktree(workDir, emp, 'as_a');
    ensureWorktree(workDir, emp, 'as_b');
    const old = out(repo, ['rev-parse', 'emp/dev/as_a']);
    out(repo, ['commit', '-q', '--allow-empty', '-m', 'base moved on']);
    const back = ensureWorktree(workDir, emp, 'as_a');
    assert.notEqual(out(back.path, ['rev-parse', 'HEAD']), old);
    assert.equal(out(back.path, ['rev-parse', 'HEAD']), out(repo, ['rev-parse', 'feat/x']), 'a stale, unworked branch starts at the base tip');
  } finally {
    cleanup();
  }
});
