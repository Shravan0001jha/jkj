import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { Employee } from '@jkj/shared';
import type { Org } from './org.js';
import { BadRequest } from '../util/errors.js';
import { log } from '../util/logger.js';
import { assertNotRealPath } from './test-guard.js';

/**
 * Every employee works in its own git worktree, never in the owner's or the
 * lead's main checkout (lead's rule, 27 Sep, until the repo split lands).
 *
 *   ~/iris-work/<employee>/<repo-name>   on branch emp/<employee>/<work-item>
 *
 * The worktree is cut from the base branch's current tip. Employees commit on
 * their own branch; merging into the base goes through the lead's review.
 */

export interface Worktree {
  path: string;
  branch: string;
  base: string;
  repo: string;
  created: boolean;
}

/** Untracked directories a checkout needs to build and test; linked, not copied. */
const LINKED = ['.venv', '.venv-x64', 'node_modules', 'desktop/node_modules', 'web/node_modules'];

export function worktreePath(workDir: string, employee: Employee): string {
  return join(workDir, employee.id, basename(employee.workspace.repo));
}

export function branchFor(employee: Employee, workItemId: string | null): string {
  return `emp/${employee.id}/${(workItemId ?? 'general').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

export function ensureWorktree(workDir: string, employee: Employee, workItemId: string | null): Worktree {
  const repo = employee.workspace.repo;
  const base = employee.workspace.branch ?? 'main';
  const path = worktreePath(workDir, employee);
  const branch = branchFor(employee, workItemId);

  // A test must never cut a branch or a worktree in a real repository (test-guard.ts).
  assertNotRealPath(`repository of ${employee.id}`, repo);
  assertNotRealPath('work directory', workDir);
  if (!existsSync(join(repo, '.git'))) throw new BadRequest(`${repo} is not a git repository`);
  let created = false;

  if (!existsSync(path)) {
    mkdirSync(join(workDir, employee.id), { recursive: true });
    // A missing branch, or one with no commits of its own (cut before the base moved on), starts at the base tip.
    const args = branchExists(repo, branch) && !behindOnly(repo, branch, base)
      ? ['worktree', 'add', path, branch]
      : ['worktree', 'add', '-B', branch, path, base];
    try {
      git(repo, args);
    } catch (err) {
      throw new WorktreeSwitchError(employee.id, path, branch, gitReason(err));
    }
    created = true;
    log.info('worktrees', `${employee.id}: ${path} on ${branch} from ${base}`);
  } else {
    // git answers with the real path; /var is /private/var on macOS.
    const top = realpathSync(git(path, ['rev-parse', '--show-toplevel']).trim());
    if (top !== realpathSync(path)) throw new BadRequest(`${path} exists and is not a worktree`);
  }

  excludeLinked(path);
  if (!created) switchTo(employee, path, branch, base, workItemId);

  linkUntracked(repo, path);

  // Never hand back a worktree on another branch: the session would build on the wrong item (2 Oct).
  const head = currentBranch(path);
  if (head !== branch) throw new WorktreeSwitchError(employee.id, path, branch, `the worktree is on ${head}`);
  return { path, branch: head, base, repo, created };
}

/** Link the untracked build/test dirs (venvs, node_modules) of the main checkout into a worktree. */
export function linkUntracked(repo: string, path: string): void {
  for (const rel of LINKED) {
    const source = join(repo, rel);
    const target = join(path, rel);
    try {
      if (existsSync(source) && !existsSync(target) && !isLink(target)) {
        mkdirSync(join(target, '..'), { recursive: true });
        symlinkSync(source, target);
      }
    } catch (err) {
      log.warn('worktrees', `could not link ${rel}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * The worktree could not be put on the assignment's branch. The assignment is
 * blocked with this message rather than run on whatever branch was checked out.
 */
export class WorktreeSwitchError extends BadRequest {
  constructor(employeeId: string, path: string, readonly branch: string, reason: string) {
    super(`Could not put ${employeeId}'s worktree ${path} on ${branch}: ${reason}`);
    this.name = 'WorktreeSwitchError';
  }
}

/** Untracked paths the auto-save never commits: the linked dirs and every virtualenv. */
const EXCLUDED = ['.venv*', ...LINKED.filter(l => !l.startsWith('.venv')).map(l => `/${l}`)];

/**
 * Keep the virtualenvs and linked dirs out of `git status` and out of any
 * auto-save, through the worktree's info/exclude (never the repo's .gitignore).
 * A pattern without a trailing slash also matches the symlinks we create.
 */
export function excludeLinked(path: string): void {
  const file = resolve(path, git(path, ['rev-parse', '--git-path', 'info/exclude']).trim());
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = new Set(existing.split('\n').map(l => l.trim()));
  const missing = EXCLUDED.filter(p => !lines.has(p));
  if (!missing.length) return;
  mkdirSync(dirname(file), { recursive: true });
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(file, `${prefix}# Added by the Iris Workplace: untracked build/test dirs, never committed\n${missing.join('\n')}\n`);
}

/**
 * Put an existing worktree on `branch`. Uncommitted work on the previous
 * branch (tracked changes and untracked files, minus the excluded dirs) is
 * committed to that branch first: no stash that can be lost, nothing discarded.
 */
function switchTo(employee: Employee, path: string, branch: string, base: string, workItemId: string | null): void {
  const current = currentBranch(path);
  if (current === branch) return;
  const fail = (reason: string): never => { throw new WorktreeSwitchError(employee.id, path, branch, reason); };
  try {
    if (!isClean(path, true)) {
      if (current === 'HEAD') fail('it has uncommitted work on a detached HEAD; commit or move it by hand');
      const busy = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply']
        .find(f => existsSync(resolve(path, git(path, ['rev-parse', '--git-path', f]).trim())));
      if (busy) fail(`${current} has an unfinished merge, rebase or cherry-pick (${busy}); finish or abort it by hand`);
      // info/exclude (excludeLinked) keeps the venvs and linked dirs out of this add.
      git(path, ['add', '-A']);
      git(path, ['commit', '-q', '--no-verify', '-m', `WIP (auto-saved by the Workplace before switching to ${workItemId ?? 'general'})`]);
      log.warn('worktrees', `${employee.id}: auto-saved uncommitted work on ${current} before switching to ${branch}`);
      if (!isClean(path, true)) fail(`uncommitted work on ${current} could not be auto-saved`);
    }
    // A branch with commits of its own is checked out as it is; a missing one, or one with nothing of its
    // own (only behind the base: cut before today's merge, never worked on), is (re)cut at the base tip.
    git(path, branchExists(path, branch) && !behindOnly(path, branch, base) ? ['checkout', '-q', branch] : ['checkout', '-q', '-B', branch, base]);
    log.info('worktrees', `${employee.id}: ${path} switched from ${current} to ${branch}`);
  } catch (err) {
    if (err instanceof WorktreeSwitchError) throw err;
    fail(gitReason(err));
  }
}

function gitReason(err: unknown): string {
  const e = err as { stderr?: string | Buffer; message?: string };
  return String(e?.stderr || e?.message || err).trim().split('\n').slice(0, 3).join(' ');
}

function currentBranch(path: string): string {
  return git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

/** True when a path is (inside) one of the organisation's main checkouts. */
export function isMainCheckout(org: Org, path: string): boolean {
  const abs = resolve(path);
  return org.repos.some(r => {
    const root = resolve(r.root);
    return abs === root || abs.startsWith(root + '/');
  });
}

/** Files changed on the employee's branch (committed since the base, plus uncommitted). */
export function changedFiles(worktree: string, base: string): string[] {
  const committed = git(worktree, ['diff', '--name-only', `${base}...HEAD`]).split('\n');
  const uncommitted = git(worktree, ['status', '--porcelain', '--untracked-files=all']).split('\n')
    .map(l => l.slice(3).trim()).filter(Boolean);
  return [...new Set([...committed, ...uncommitted].map(f => f.trim()).filter(f => f && !LINKED.includes(f) && !f.startsWith('.venv')))].sort();
}

/** Files changed in the worktree but not committed (untracked included). */
export function uncommittedFiles(worktree: string): string[] {
  return git(worktree, ['status', '--porcelain', '--untracked-files=all']).split('\n').map(l => l.slice(3).trim()).filter(Boolean);
}

export function isClean(worktree: string, includeUntracked = false): boolean {
  return git(worktree, ['status', '--porcelain', `--untracked-files=${includeUntracked ? 'all' : 'no'}`]).trim() === '';
}

export function commitsSince(worktree: string, base: string): string[] {
  return git(worktree, ['log', '--format=%h %s', `${base}..HEAD`]).split('\n').map(l => l.trim()).filter(Boolean);
}

/** `branch` has no commits the base lacks (it is an ancestor of the base): nothing of its own to keep. */
function behindOnly(cwd: string, branch: string, base: string): boolean {
  try { execFileSync('git', ['-C', cwd, 'merge-base', '--is-ancestor', branch, base], { stdio: 'ignore' }); return true; } catch { return false; }
}

function branchExists(repo: string, branch: string): boolean {
  try {
    git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function isLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export const relativeTo = (root: string, file: string): string => relative(resolve(root), resolve(file));
