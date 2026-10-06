import type { Workplace } from './workplace.js';
import type { Reading } from './pace.js';
import * as floor from './floor.js';
import * as coo from './coo.js';
import { log } from '../util/logger.js';

/**
 * The usage line (owner). 5 Oct: "if the daily or weekly limit is at 98% you need to start
 * parking". Replaced 6 Oct: "Don't park at 98, just ping me at 99." So the plan's 5-hour or 7-day
 * utilization at or past 99% sends the owner ONE message per window and reset (never a pause, never
 * an interrupt); the owner decides. A pause this module set under the old rule is lifted on sight.
 */

export const CEILING = 0.99;
export const BY = 'usage-ceiling';

export interface CeilingVerdict { over: boolean; window?: '5h' | '7d'; utilization: number; resetsAtMs?: number }

/** Pure: the worst window at or past the line, if any. */
export function evaluate(r: Reading, line = CEILING): CeilingVerdict {
  const windows: { window: '5h' | '7d'; utilization: number; resetsAtMs: number }[] = [{ window: '7d', utilization: r.utilization, resetsAtMs: r.resetsAtMs }];
  if (r.fiveHour) windows.push({ window: '5h', ...r.fiveHour });
  const worst = windows.reduce((a, b) => (b.utilization > a.utilization ? b : a));
  return worst.utilization >= line ? { over: true, ...worst } : { over: false, utilization: worst.utilization };
}

const pingKey = (v: CeilingVerdict): string => `usage-ceiling:pinged:${v.window}:${v.resetsAtMs ?? 'none'}`;

export function apply(wp: Workplace, r: Reading): CeilingVerdict {
  const v = evaluate(r);
  // The old rule parked the floor; the owner withdrew it, so a pause it left behind is lifted.
  const st = floor.state(wp);
  if (st.paused && st.by === BY) {
    floor.setPaused(wp, false, 'usage line now pings the owner instead of parking (owner, 6 Oct)', BY);
    log.info('ceiling', 'lifted a usage-ceiling pause: the rule is now ping-only');
  }
  if (!v.over) return v;
  const key = pingKey(v);
  const seen = wp.db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined;
  if (seen) return v;
  const until = v.resetsAtMs ? new Date(v.resetsAtMs).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'the window resets';
  coo.messageOwner(wp, `Heads-up: the plan's ${v.window === '5h' ? '5-hour' : 'weekly'} usage is at ${Math.round(v.utilization * 100)}% (resets ${until}). Nothing is paused; say "park" if you want the team stopped.`);
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(key, new Date().toISOString());
  log.warn('ceiling', `${v.window} at ${Math.round(v.utilization * 100)}%: owner pinged (no pause)`);
  return v;
}
