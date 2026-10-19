import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Workplace } from './workplace.js';

/**
 * The Mac worker (owner, 19 Oct): the owner's laptop as a Workplace member. A launchd service on the Mac
 * (iris-ops/mac/worker/iris_mac_worker.py) drains the post-merge iPhone reviews (post-merge.ts): it claims
 * a parked review, builds and unit-tests the merged commit there, comments, and closes it done or won't-do.
 *
 * Like the COO it is virtual: the Workplace never spawns a session for it. Its card shows presence: the
 * worker touches `<workplaceDir>/mac/heartbeat` (over ssh) on every run, every 5 minutes while the laptop
 * is awake, so a heartbeat older than ONLINE_MS means the lid is closed or the Mac is off.
 */

export const MAC_WORKER_ID = 'mac';
export const ONLINE_MS = 12 * 60_000;
export const OFFLINE_REASON = "the owner's Mac is off or asleep: iPhone reviews wait in the queue";

export const heartbeatFile = (wp: Workplace): string => join(wp.config.workplaceDir, 'mac', 'heartbeat');

export function presence(wp: Workplace, thresholdMs = ONLINE_MS): { online: boolean; lastHeartbeat: string | null } {
  const file = heartbeatFile(wp);
  if (!existsSync(file)) return { online: false, lastHeartbeat: null };
  const at = statSync(file).mtime;
  return { online: Date.now() - at.getTime() < thresholdMs, lastHeartbeat: at.toISOString() };
}

/** Test helper and the same thing the worker does remotely: mark the Mac present now. */
export function beat(wp: Workplace): void {
  const file = heartbeatFile(wp);
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, '');
  const now = new Date();
  utimesSync(file, now, now);
}

/** The worker is in the org (config, not code): post-merge reviews go to it rather than the iOS lead. */
export const inOrg = (wp: Workplace): boolean => wp.org.employees.some(e => e.id === MAC_WORKER_ID);
