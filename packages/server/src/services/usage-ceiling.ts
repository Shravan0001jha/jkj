import type { Workplace } from './workplace.js';
import type { Reading } from './pace.js';
import * as floor from './floor.js';
import * as coo from './coo.js';
import { log } from '../util/logger.js';

/**
 * The usage line (owner). History: 5 Oct "park at 98%"; 6 Oct "don't park, just ping me at 99".
 * 8 Oct: "stop things at 90% weekly usage". So now:
 *  - 7-day utilization at or past 90%: the floor is paused (unattended work stops; talk still works)
 *    and the owner gets ONE message for that weekly window. When the window resets (or usage reads
 *    below the line), a pause this module set is lifted.
 *  - 5-hour utilization at or past 99%: one heads-up message per window, never a pause (unchanged).
 * A pause set by anyone else (owner, COO) is never touched.
 */

export const WEEKLY_STOP = 0.90;
export const CEILING = 0.99;
export const BY = 'usage-ceiling';

export interface CeilingVerdict { over: boolean; window?: '5h' | '7d'; utilization: number; resetsAtMs?: number; stop?: boolean }

/** Pure: the weekly window past the stop line wins; else the worst window past the ping line. */
export function evaluate(r: Reading, line = CEILING, weeklyStop = WEEKLY_STOP): CeilingVerdict {
  if (r.utilization >= weeklyStop) return { over: true, stop: true, window: '7d', utilization: r.utilization, resetsAtMs: r.resetsAtMs };
  if (r.fiveHour && r.fiveHour.utilization >= line) return { over: true, stop: false, window: '5h', ...r.fiveHour };
  return { over: false, utilization: Math.max(r.utilization, r.fiveHour?.utilization ?? 0) };
}

const pingKey = (v: CeilingVerdict): string => `usage-ceiling:pinged:${v.window}:${v.resetsAtMs ?? 'none'}`;

/** The owner lifted the 90% stop for this weekly window (29 Oct: "keep working till 98%"): the daily pace cap still holds. */
export const liftKey = (resetsAtMs: number | undefined): string => `usage-ceiling:lifted:${resetsAtMs ?? 'none'}`;
export function liftWeeklyStop(wp: Workplace, by: string): string | null {
  const last = wp.db.prepare("select value from settings where key = 'pace:last'").get() as { value: string } | undefined;
  const resetsAtMs = last ? (JSON.parse(last.value) as { resetsAtMs?: number }).resetsAtMs : undefined;
  if (!resetsAtMs) return null;
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(liftKey(resetsAtMs), JSON.stringify({ by, at: new Date().toISOString() }));
  return new Date(resetsAtMs).toISOString();
}

export function apply(wp: Workplace, r: Reading): CeilingVerdict {
  const lifted = !!wp.db.prepare('select value from settings where key = ?').get(liftKey(r.resetsAtMs));
  const v = lifted ? evaluate(r, CEILING, Number.POSITIVE_INFINITY) : evaluate(r);
  const st = floor.state(wp);
  if (v.stop) {
    if (!st.paused) {
      floor.setPaused(wp, true, `weekly usage at ${Math.round(v.utilization * 100)}% (owner's stop line is 90%)`, BY);
      log.warn('ceiling', `7d at ${Math.round(v.utilization * 100)}%: floor paused`);
    }
  } else if (st.paused && st.by === BY) {
    floor.setPaused(wp, false, `weekly usage back under 90% (${Math.round(r.utilization * 100)}%)`, BY);
    log.info('ceiling', 'weekly usage under the stop line: pause lifted');
  }
  if (!v.over) return v;
  const key = pingKey(v);
  const seen = wp.db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined;
  if (seen) return v;
  const until = v.resetsAtMs ? new Date(v.resetsAtMs).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'the window resets';
  coo.messageOwner(wp, v.stop
    ? `Weekly usage is at ${Math.round(v.utilization * 100)}%: the team is paused per your 90% rule until it resets (${until}). Say "resume" to override.`
    : `Heads-up: the plan's 5-hour usage is at ${Math.round(v.utilization * 100)}% (resets ${until}). Nothing is paused.`);
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(key, new Date().toISOString());
  return v;
}
