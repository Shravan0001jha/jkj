import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { Employee } from '@jkj/shared';
import type { Org } from './org.js';
import { BadRequest } from '../util/errors.js';
import { log } from '../util/logger.js';

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

  if (!existsSync(join(repo, '.git'))) throw new BadRequest(`${repo} is not a git repository`);
  let created = false;

  if (!existsSync(path)) {
    mkdirSync(join(workDir, employee.id), { recursive: true });
    const args = branchExists(repo, branch)
      ? ['worktree', 'add', path, branch]
      : ['worktree', 'add', path, '-b', branch, base];
    git(repo, args);
    created = true;
    log.info('worktrees', `${employee.id}: ${path} on ${branch} from ${base}`);
  } else {
    // git answers with the real path; /var is /private/var on macOS.
    const top = realpathSync(git(path, ['rev-parse', '--show-toplevel']).trim());
    if (top !== realpathSync(path)) throw new BadRequest(`${path} exists and is not a worktree`);
    const current = git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (current !== branch) {
      if (isClean(path)) {
        git(path, branchExists(repo, branch) ? ['checkout', '-q', branch] : ['checkout', '-q', '-b', branch, base]);
      } else {
        log.warn('worktrees', `${employee.id}: ${path} has uncommitted work on ${current}; staying there`);
      }
    }
  }

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

  return { path, branch: git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), base, repo, created };
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

export function isClean(worktree: string): boolean {
  return git(worktree, ['status', '--porcelain', '--untracked-files=no']).trim() === '';
}

export function commitsSince(worktree: string, base: string): string[] {
  return git(worktree, ['log', '--format=%h %s', `${base}..HEAD`]).split('\n').map(l => l.trim()).filter(Boolean);
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
