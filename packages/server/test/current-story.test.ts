import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentStory } from '../src/services/employees.js';

/** Tools default to the story whose branch is checked out, not the one the session started on (Mira, 5 Oct). */
test('the checked-out story branch wins over the session assignment; anything else falls back to it', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cur-'));
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  try {
    g('init', '-q', '-b', 'trunk'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
    const s = { employeeId: 'mira', assignmentId: 'as_first', worktree: { path: repo, branch: 'emp/mira/as_first', base: 'trunk', repo, created: true } };
    assert.equal(currentStory(s), 'as_first', 'on trunk: the assignment');
    g('checkout', '-q', '-b', 'emp/mira/as_second');
    assert.equal(currentStory(s), 'as_second', 'on another story branch: that story');
    g('checkout', '-q', '-b', 'emp/dev/as_third');
    assert.equal(currentStory(s), 'as_first', "someone else's branch never counts");
    assert.equal(currentStory({ employeeId: 'mira', assignmentId: 'as_x' }), 'as_x', 'no worktree: the assignment');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
