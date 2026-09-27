import type { Workplace } from '../../src/services/workplace.js';
import { createWorkplace } from '../../src/services/workplace.js';
import { loadConfig } from '../../src/config.js';
import { tmpWorkplace, type TmpWorkplace } from './tmp-workplace.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A full Workplace (config, org, in-memory store, requirements) in a temp dir.
 *
 * The seed names the owner's real checkouts as repos. A test must never cut a
 * worktree or a branch there, so every repo root and every employee's
 * workspace is pointed at a small temp git repo with the same base branches.
 */
export function testWorkplace(overrides: Partial<Record<string, string>> = {}): { wp: Workplace; tmp: TmpWorkplace } {
  const tmp = tmpWorkplace();
  const workDir = mkdtempSync(join(tmpdir(), 'iris-work-'));
  const argv = ['--no-open', '--no-seed', ...(overrides['WORKPLACE_TELEGRAM'] === '1' ? [] : ['--no-telegram'])];
  const config = loadConfig(argv, {
    IRIS_WORKPLACE_DIR: tmp.dir,
    IRIS_OPS_DIR: `${tmp.dir}/ops`,
    IRIS_WORK_DIR: workDir,
    WORKPLACE_CAP_INR: '1000',
    WORKPLACE_USD_INR: '88',
    ...overrides,
  });
  const extract = readFileSync(fileURLToPath(new URL('../../../../docs/product-definition-extract.md', import.meta.url)), 'utf8');
  const wp = createWorkplace(config, { db: tmp.db, extractMarkdown: extract });

  const repos = new Map<string, string>();
  for (const repo of wp.org.repos) {
    const root = tempRepo(repo.branch ?? 'main');
    repos.set(repo.root, root);
    repo.root = root;
  }
  for (const e of wp.org.employees) {
    const root = repos.get(e.workspace.repo);
    if (root) e.workspace = { ...e.workspace, repo: root };
  }
  const cleanup = tmp.cleanup;
  tmp.cleanup = () => {
    cleanup();
    rmSync(workDir, { recursive: true, force: true });
    for (const root of repos.values()) rmSync(root, { recursive: true, force: true });
  };
  return { wp, tmp };
}

function tempRepo(base: string): string {
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
