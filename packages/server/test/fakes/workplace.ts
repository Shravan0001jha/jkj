import type { Workplace } from '../../src/services/workplace.js';
import { createWorkplace } from '../../src/services/workplace.js';
import { loadConfig } from '../../src/config.js';
import { closeAll } from '../../src/services/employees.js';
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
  const workDir = tmp.workDir;
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

  // tmpWorkplace already rewrote org.yaml to temp repos; nothing real is reachable from here.
  const repos = tmp.repos;
  for (const e of wp.org.employees) {
    const root = repos.get(e.workspace.repo);
    if (root) e.workspace = { ...e.workspace, repo: root };
  }
  const cleanup = tmp.cleanup;
  tmp.cleanup = () => {
    // Sessions are a module-level register; a test's sessions must not outlive its database.
    try { closeAll(wp, 'test cleanup'); } catch { /* db already closed */ }
    cleanup();
    rmSync(workDir, { recursive: true, force: true });
  };
  return { wp, tmp };
}


/**
 * The October 2026 org tree on top of the seed (opt-in; the seed itself has no CTO or engineers):
 * owner → coo → (asha, cto); asha → the leads and the QA lead (nikhil); engineers under their leads:
 * arjun and sameer under dev (conversation), ira under mira (experts); zoya and aditi are QA members
 * (role qa) under the QA lead nikhil, so their team is nikhil's.
 * In memory only, so other tests' org is untouched.
 */
export function withTree(wp: Workplace): Workplace {
  const org = wp.org;
  if (!org.roles.some(r => r.id === 'cto')) {
    org.roles.push({ id: 'cto', title: 'Chief Technology Officer', level: 0, instructions: '', tools: {}, permissionMode: 'dontAsk', model: 'opus', budgetClass: 'high' });
  }
  const template = org.employees.find(e => e.id === 'dev')!;
  const add = (id: string, name: string, roleId: string, reportsTo: string, charterIds: string[], level: 0 | 1 | 2): void => {
    if (org.employees.some(e => e.id === id)) return;
    org.employees.push({
      id, name, roleId, level, permanent: level < 2, charterIds, unitId: template.unitId, chapterIds: [], reportsTo,
      workspace: { ...template.workspace }, budget: { inrPerDay: 80, concurrentSessions: 1 }, state: 'idle',
    });
  };
  add('cto', 'Vikram', 'cto', 'coo', [], 0);
  add('arjun', 'Arjun', 'engineer', 'dev', ['conversation', 'character'], 2);
  add('sameer', 'Sameer', 'engineer', 'dev', ['conversation'], 2);
  add('ira', 'Ira', 'engineer', 'mira', ['experts'], 2);
  add('zoya', 'Zoya', 'qa', 'nikhil', ['qa-release'], 2);
  add('aditi', 'Aditi', 'qa', 'nikhil', ['qa-release'], 2);
  for (const c of org.charters.values()) c.holderIds = org.employees.filter(e => e.charterIds.includes(c.id)).map(e => e.id);
  return wp;
}
