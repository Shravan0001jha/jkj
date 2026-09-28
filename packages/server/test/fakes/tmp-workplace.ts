import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureGit, loadOrg, type Org } from '../../src/services/org.js';
import { openStore, type Db } from '../../src/services/store.js';

/**
 * A fresh, real organisation in a temp directory for every test that needs
 * one. Nothing a test does can reach ~/iris-workplace, ~/iris-ops, ~/iris-work
 * or the owner's checkouts: the seed names his real repositories, so every
 * repo root in org.yaml is rewritten to a small temp git repo with the same
 * base branch before the org is loaded, and `workDir` is a temp directory
 * for the worktrees (QA B5, 29 Sep). The server refuses real paths under a
 * test anyway (src/services/test-guard.ts); this is what makes tests pass it.
 */

export const SEED_DIR = fileURLToPath(new URL('../../seed/', import.meta.url));

export interface TmpWorkplace {
  dir: string;
  /** Where worktrees go (IRIS_WORK_DIR for a booted server). */
  workDir: string;
  /** Temp git repositories standing in for the seed's real ones, by the seed's root path. */
  repos: Map<string, string>;
  org: Org;
  db: Db;
  reload(): Org;
  cleanup(): void;
}

export function tmpWorkplace(): TmpWorkplace {
  const dir = mkdtempSync(join(tmpdir(), 'iris-workplace-'));
  cpSync(SEED_DIR, dir, { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), 'iris-work-'));
  const repos = replaceRealRepos(dir);
  ensureGit(dir);
  const db = openStore(':memory:');
  const state = { org: loadOrg(dir) };
  return {
    dir, workDir, repos,
    get org() { return state.org; },
    db,
    reload: () => { state.org = loadOrg(dir); return state.org; },
    cleanup: () => {
      try { db.close(); } catch { /* already closed by the server */ }
      rmSync(dir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
      for (const root of repos.values()) rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Rewrite every repo root named in the copied org.yaml to a temp repo on the same base branch. */
function replaceRealRepos(dir: string): Map<string, string> {
  const seed = loadOrg(dir);
  const repos = new Map<string, string>();
  const branches = new Map<string, string>();
  for (const r of seed.repos) branches.set(r.root, r.branch ?? 'main');
  for (const e of seed.employees) if (!branches.has(e.workspace.repo)) branches.set(e.workspace.repo, e.workspace.branch ?? 'main');
  let text = readFileSync(join(dir, 'org.yaml'), 'utf8');
  // Longest roots first: one real path can be a prefix of another (claude-dev, claude-dev-mobile).
  for (const root of [...branches.keys()].sort((a, b) => b.length - a.length)) {
    const temp = tempRepo(branches.get(root)!);
    repos.set(root, temp);
    text = text.split(root).join(temp);
  }
  writeFileSync(join(dir, 'org.yaml'), text);
  return repos;
}

/** A small git repository with the layout the ownership map keys on, on `base`. */
export function tempRepo(base: string): string {
  const root = mkdtempSync(join(tmpdir(), 'iris-repo-'));
  const g = (args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 'test@iris.local']); g(['config', 'user.name', 'test']);
  mkdirSync(join(root, 'services', 'agent-svc'), { recursive: true });
  mkdirSync(join(root, 'mobile', 'ios'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# temp\n');
  writeFileSync(join(root, 'services', 'agent-svc', 'phone.py'), '# phone\n');
  writeFileSync(join(root, 'mobile', 'ios', 'App.swift'), '// app\n');
  g(['add', '-A']); g(['commit', '-q', '-m', 'base']);
  if (base !== 'main') g(['checkout', '-q', '-b', base]);
  return root;
}
