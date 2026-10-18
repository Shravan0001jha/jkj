import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFiles, realCodeChange } from '../src/services/github-flow.js';

const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
const put = (cwd: string, f: string, t: string) => { mkdirSync(join(cwd, f, '..'), { recursive: true }); writeFileSync(join(cwd, f), t); };

// Trunk moved on (other charters' files) and the branch caught up by merging origin/trunk, but the
// local trunk ref is stale: the author's diff must still be only the author's own files.
test('a catch-up merge does not make the trunk\'s files the author\'s', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xr-'));
  const origin = join(dir, 'origin.git'); const repo = join(dir, 'repo'); const other = join(dir, 'other');
  g(dir, 'init', '--bare', '-b', 'trunk', origin);
  g(dir, 'clone', origin, repo);
  g(repo, 'checkout', '-b', 'trunk'); put(repo, 'a.txt', '1\n'); g(repo, 'add', '.'); g(repo, 'commit', '-m', 'a'); g(repo, 'push', 'origin', 'trunk');
  g(repo, 'checkout', '-b', 'feat'); put(repo, 'wake/w.py', 'x = 1\n'); g(repo, 'add', '.'); g(repo, 'commit', '-m', 'own');
  g(dir, 'clone', origin, other); g(other, 'checkout', 'trunk'); put(other, 'kabir/k.py', 'k = 1\n'); g(other, 'add', '.'); g(other, 'commit', '-m', 'k'); g(other, 'push', 'origin', 'trunk');
  g(repo, 'fetch', 'origin'); g(repo, 'merge', '--no-edit', 'origin/trunk'); // catch-up; local `trunk` stays stale
  const head = g(repo, 'rev-parse', 'HEAD').trim();
  assert.deepEqual(changedFiles(repo, 'trunk', head), ['wake/w.py']);
  assert.equal(realCodeChange(repo, 'trunk', head, 'kabir/k.py'), false);
});
