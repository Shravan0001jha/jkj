import type { Workplace } from './workplace.js';
import * as coo from './coo.js';
import { now } from './store.js';
import { log } from '../util/logger.js';

/**
 * "Pause all" (owner, 4 Oct): one switch for the whole floor, the `floor:paused` setting.
 *
 * While it is on nothing unattended starts: no dispatcher assignments or resumes, no session for a
 * manager digest, no autonomous talk (employees.spawn and employees.assign refuse). The owner's and
 * the COO's own talk still starts or reaches a session, and turns already running are never
 * interrupted: they finish and the session waits. In the settings table, so a restart keeps it.
 */

const KEY = 'floor:paused';

export interface FloorState { paused: boolean; reason?: string; by?: string; at?: string }

export function state(wp: Workplace): FloorState {
  const row = wp.db.prepare('select value from settings where key = ?').get(KEY) as { value: string } | undefined;
  if (!row) return { paused: false };
  try { return JSON.parse(row.value) as FloorState; } catch { return { paused: false }; }
}

export const paused = (wp: Workplace): boolean => state(wp).paused === true;

/** For the refusals: "the floor is paused (reason)". */
export function describe(wp: Workplace): string {
  const s = state(wp);
  return `the floor is paused${s.reason ? ` (${s.reason})` : ''}`;
}

/** Turn it on or off. Only a change is recorded and told to the COO, once. */
export function setPaused(wp: Workplace, on: boolean, reason: string, by: string): FloorState {
  const prev = state(wp);
  if (prev.paused === on) return prev;
  const next: FloorState = { paused: on, ...(reason ? { reason } : {}), by, at: now() };
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(KEY, JSON.stringify(next));
  coo.notifyStall(wp, {
    itemId: 'floor', by,
    title: on ? 'The floor is paused' : 'The floor is resumed',
    body: on
      ? `Nothing unattended starts until it is resumed: no assignments, resumes or digest sessions. Talk from the owner or the COO still works; running turns finish.${reason ? ` Reason: ${reason}` : ''}`
      : `Unattended work starts again: the dispatcher picks up queued work on its next pass.${reason ? ` Reason: ${reason}` : ''}`,
  });
  log.warn('floor', `${on ? 'paused' : 'resumed'} by ${by}${reason ? `: ${reason}` : ''}`);
  return next;
}
