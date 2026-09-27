import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One Workplace per organisation (28 Sep, after a second process from an earlier restart outlived
 * its listener). The lock is a file next to the database holding the pid; a live pid refuses the
 * start, a dead one is taken over. Released on stop, and by the next start if the process died
 * without releasing it.
 */

export interface Lock {
  path: string;
  pid: number;
  release(): void;
}

export class AlreadyRunning extends Error {
  constructor(readonly pid: number, readonly since: string, path: string) {
    super(`Another Workplace is already running (pid ${pid}, since ${since}, lock ${path}); refusing to start.`);
  }
}

export const LOCK_FILE = 'workplace.lock';

export function acquire(dir: string, pid = process.pid, alive: (pid: number) => boolean = isAlive): Lock {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, LOCK_FILE);
  if (existsSync(path)) {
    const held = read(path);
    if (held && held !== pid && alive(held)) throw new AlreadyRunning(held, statSync(path).mtime.toISOString(), path);
    // Our own pid already holds it (a second boot inside one process): the first handle keeps it.
    if (held === pid) return { path, pid, release: () => {} };
  }
  writeFileSync(path, `${pid}\n${new Date().toISOString()}\n`);
  return {
    path, pid,
    release: () => { try { if (read(path) === pid) unlinkSync(path); } catch { /* already gone */ } },
  };
}

export function holder(dir: string): number | undefined {
  const path = join(dir, LOCK_FILE);
  return existsSync(path) ? read(path) : undefined;
}

function read(path: string): number | undefined {
  try {
    const n = Number.parseInt(readFileSync(path, 'utf8').split('\n')[0] ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch { return undefined; }
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}
