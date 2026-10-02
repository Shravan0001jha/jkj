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
