import type { Workplace } from './workplace.js';
import * as floor from './floor.js';
import * as pace from './pace.js';

/**
 * ONE definition of "the floor cannot run work right now" (owner/COO, 23 Oct: hygiene, Asha's 10-minute board
 * check and the stall alerts each flagged every In-progress story as "no session" through a pace-cap hold, a
 * floor pause and a Claude auth outage, when no session could have run). Shared by hygiene (rules a and b), the
 * Chief of Staff's board check, the stall chain and the watcher, so they agree.
 *
 *   floor  — "Pause all" is on (floor.paused)
 *   pace   — the weekly pace cap holds unattended work (pace.holdUntil)
 *   auth   — the Claude usage probe has failed PROBE_FAIL_NOTIFY times in a row (token/network): sessions cannot start
 */
export interface Halt { kind: 'floor' | 'pace' | 'auth'; reason: string; /** ISO time it ends, when known. */ until?: string }

export function cannotRun(wp: Workplace, nowMs = Date.now()): Halt | null {
  const st = floor.state(wp);
  if (st.paused === true) return { kind: 'floor', reason: `floor paused${st.reason ? ` (${st.reason})` : ''}` };
  const until = pace.holdUntil(wp, nowMs);
  if (until) return { kind: 'pace', reason: 'weekly pace cap hold', until };
  const p = pace.status(wp, nowMs);
  if (p.failures >= pace.PROBE_FAIL_NOTIFY) return { kind: 'auth', reason: `Claude auth outage (usage probe failing ${p.failures} in a row${p.lastError ? `: ${p.lastError.slice(0, 80)}` : ''})` };
  return null;
}

/** The one line that replaces the per-story flags. */
export function line(h: Halt): string {
  const when = h.until ? new Date(h.until).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : h.kind === 'floor' ? 'resumed' : 'it recovers';
  return `Paused: ${h.reason} until ${when} — no per-story flags.`;
}
