import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureGit, loadOrg, type Org } from '../../src/services/org.js';
import { openStore, type Db } from '../../src/services/store.js';

/**
 * A fresh, real organisation in a temp directory for every test that needs
 * one. Nothing a test does can reach ~/iris-workplace or ~/iris-ops.
 */

export const SEED_DIR = fileURLToPath(new URL('../../seed/', import.meta.url));

export interface TmpWorkplace {
  dir: string;
  org: Org;
  db: Db;
  reload(): Org;
  cleanup(): void;
}

export function tmpWorkplace(): TmpWorkplace {
  const dir = mkdtempSync(join(tmpdir(), 'iris-workplace-'));
  cpSync(SEED_DIR, dir, { recursive: true });
  ensureGit(dir);
  const db = openStore(':memory:');
  const state = { org: loadOrg(dir) };
  return {
    dir,
    get org() { return state.org; },
    db,
    reload: () => { state.org = loadOrg(dir); return state.org; },
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
