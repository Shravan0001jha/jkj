import type { Workplace } from './workplace.js';
import type { Reading } from './pace.js';
import * as floor from './floor.js';
import * as employees from './employees.js';
import { log } from '../util/logger.js';

/**
 * The usage ceiling (owner, 5 Oct): "if the daily or weekly limit is at 98% you need to start
 * parking, I don't want to be in a phase where I can't even talk." The plan's 5-hour or 7-day
 * utilization at or past 98% pauses the floor and interrupts running unattended turns, so the
 * last 2% stays for the owner and the COO. Pacing on or off makes no difference. It resumes on its
 * own once every window is back under the line, and only lifts a pause it set itself.
 */

export const CEILING = 0.98;
export const BY = 'usage-ceiling';

export interface CeilingVerdict { over: boolean; window?: '5h' | '7d'; utilization: number; resetsAtMs?: number }

/** Pure: the worst window at or past the ceiling, if any. */
export function evaluate(r: Reading, line = CEILING): CeilingVerdict {
  const windows: { window: '5h' | '7d'; utilization: number; resetsAtMs: number }[] = [{ window: '7d', utilization: r.utilization, resetsAtMs: r.resetsAtMs }];
  if (r.fiveHour) windows.push({ window: '5h', ...r.fiveHour });
  const worst = windows.reduce((a, b) => (b.utilization > a.utilization ? b : a));
  return worst.utilization >= line ? { over: true, ...worst } : { over: false, utilization: worst.utilization };
}

export function apply(wp: Workplace, r: Reading): CeilingVerdict {
  const v = evaluate(r);
  const st = floor.state(wp);
  if (v.over && !st.paused) {
    const until = v.resetsAtMs ? new Date(v.resetsAtMs).toISOString() : 'the window resets';
    floor.setPaused(wp, true, `usage ceiling: ${v.window} limit at ${Math.round(v.utilization * 100)}% (>= ${Math.round(CEILING * 100)}%), parked until ${until}`, BY);
    const n = employees.interruptUnattended(wp, `Parked: the plan's ${v.window} usage is at ${Math.round(v.utilization * 100)}%. Work resumes when it drops back under ${Math.round(CEILING * 100)}%.`);
    log.warn('ceiling', `${v.window} at ${Math.round(v.utilization * 100)}%: floor paused, ${n} running turn(s) interrupted`);
  } else if (!v.over && st.paused && st.by === BY) {
    floor.setPaused(wp, false, `usage back to ${Math.round(v.utilization * 100)}%`, BY);
    log.info('ceiling', `usage back to ${Math.round(v.utilization * 100)}%: floor resumed`);
  }
  return v;
}
