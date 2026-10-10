import type { SuperFocus } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import { BadRequest } from '../util/errors.js';

/**
 * Super focus (rework W4; owner, 10 Oct: "no night calls, except a super focus mode I switch on").
 * A setting, not config: `settings['super-focus'] = {"until": ISO | null}`. While it is active, push
 * quiet hours are off and the stall chain may ring the owner at night. Only the owner or the COO
 * turns it on; it ends by itself at `until`.
 *
 * Not to be confused with the epic focus (`items.getFocus`), which orders work.
 */

export const SUPER_FOCUS_KEY = 'super-focus';
/** A day and a half at most: super focus is a sprint, never a standing state. */
export const MAX_HOURS = 36;

export function getSuperFocus(wp: Workplace): SuperFocus {
  const row = wp.db.prepare('select value from settings where key = ?').get(SUPER_FOCUS_KEY) as { value: string } | undefined;
  if (!row) return { until: null };
  try {
    const v = JSON.parse(row.value) as Partial<SuperFocus>;
    return { until: typeof v.until === 'string' && Number.isFinite(Date.parse(v.until)) ? v.until : null };
  } catch { return { until: null }; }
}

/** True while super focus is on at `nowMs`. Read by push quiet hours and the stall chain. */
export function superFocusActive(wp: Workplace, nowMs = Date.now()): boolean {
  const { until } = getSuperFocus(wp);
  return until !== null && Date.parse(until) > nowMs;
}

/** POST /api/settings/super-focus {hours}: on for `hours` from now; 0 turns it off. */
export function setSuperFocus(wp: Workplace, spec: { hours: number; by: string }, nowMs = Date.now()): SuperFocus {
  if (spec.by !== 'owner' && spec.by !== 'coo') throw new BadRequest('Only the owner or the COO can set super focus.');
  const hours = spec.hours;
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0 || hours > MAX_HOURS) {
    throw new BadRequest(`hours must be a number from 0 (off) to ${MAX_HOURS}.`);
  }
  const value: SuperFocus = { until: hours === 0 ? null : new Date(nowMs + hours * 60 * 60_000).toISOString() };
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(SUPER_FOCUS_KEY, JSON.stringify(value));
  return value;
}
