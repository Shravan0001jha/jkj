import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile, type ClaudeHome } from './claude-home.js';

/**
 * Sessions that are running right now.
 *
 * A live CLI process drops a descriptor in <configDir>/sessions. Its presence
 * is what separates "an agent working" from "a transcript of one that
 * finished". Fields vary by version, so everything here is optional.
 */

export interface LiveSession {
  sessionId: string;
  pid: number;
  cwd: string;
  /** 'busy' while the model is working, 'idle' while it waits for you. */
  status: string;
  /** A human-friendly name the CLI assigns itself, when it has one. */
  name?: string;
  kind?: string;
  startedAt?: number;
  updatedAt?: number;
}

/**
 * How long a descriptor may go untouched before it is treated as dead.
 *
 * Process ids are recycled, so a months-old descriptor can point at a pid
 * that now belongs to something else entirely. A session nobody has touched
 * in a day is not one you are watching.
 */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function readLiveSessions(home: ClaudeHome): Map<string, LiveSession> {
  const byId = new Map<string, LiveSession>();

  let files: string[];
  try {
    files = readdirSync(home.sessionsDir);
  } catch {
    return byId;   // no sessions directory: nothing is running
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const raw = readJsonFile<Partial<LiveSession>>(join(home.sessionsDir, file));
    if (!raw?.sessionId || isStale(raw.updatedAt) || !isRunning(raw.pid)) continue;

    byId.set(raw.sessionId, {
      sessionId: raw.sessionId,
      pid: raw.pid ?? 0,
      cwd: raw.cwd ?? '',
      status: raw.status ?? 'idle',
      name: raw.name,
      kind: raw.kind,
      startedAt: raw.startedAt,
      updatedAt: raw.updatedAt,
    });
  }
  return byId;
}

function isStale(updatedAt: number | undefined): boolean {
  if (!updatedAt) return false;   // older CLI versions do not write this
  return Date.now() - updatedAt > STALE_AFTER_MS;
}

/**
 * A descriptor can outlive the process that wrote it — a crash leaves the
 * file behind. Signal 0 asks the OS whether the pid is still there without
 * touching it.
 */
function isRunning(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
