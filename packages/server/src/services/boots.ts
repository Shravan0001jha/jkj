import type { Db } from './store.js';

/**
 * Boot history (docs/RESILIENCE-workplace.md §5). launchd restarts the Workplace whenever it dies;
 * the phone's health check shows how often that happened, and the watchdog turns "three starts in
 * ten minutes" into one Telegram ping. Kept in the settings table, next to everything else the
 * organisation remembers, so it survives the process and never needs its own file.
 */

export interface BootHistory {
  /** Every start since the organisation was created. */
  total: number;
  /** ISO times of the most recent starts, oldest first. */
  recent: string[];
}

export const RECENT_BOOTS = 50;
const KEY_TOTAL = 'boots-total';
const KEY_RECENT = 'boots-recent';
const KEY_CRASH_LOOP = 'crashloop-alerted-at';

export function recordBoot(db: Db, at = new Date()): BootHistory {
  const before = bootHistory(db);
  const history: BootHistory = { total: before.total + 1, recent: [...before.recent, at.toISOString()].slice(-RECENT_BOOTS) };
  put(db, KEY_TOTAL, String(history.total));
  put(db, KEY_RECENT, JSON.stringify(history.recent));
  return history;
}

export function bootHistory(db: Db): BootHistory {
  const total = Number.parseInt(get(db, KEY_TOTAL) ?? '0', 10);
  let recent: string[] = [];
  try { const parsed = JSON.parse(get(db, KEY_RECENT) ?? '[]') as unknown; if (Array.isArray(parsed)) recent = parsed.filter((x): x is string => typeof x === 'string'); } catch { /* unreadable → empty */ }
  return { total: Number.isFinite(total) ? total : 0, recent };
}

export function bootsWithin(history: BootHistory, now: number, windowMs: number): number {
  return history.recent.filter(t => { const ms = Date.parse(t); return Number.isFinite(ms) && ms <= now && now - ms <= windowMs; }).length;
}

/** Three or more starts in ten minutes: launchd is restarting something that cannot stay up. */
export function isCrashLoop(history: BootHistory, now: number, opts: { windowMs?: number; threshold?: number } = {}): boolean {
  return bootsWithin(history, now, opts.windowMs ?? 10 * 60_000) >= (opts.threshold ?? 3);
}

/** What the watchdog needs to remember across processes about a crash loop. */
export interface BootMarks {
  history(): BootHistory;
  crashLoopAlertedAt(): string | null;
  markCrashLoop(at: string | null): void;
}

export function marks(db: Db): BootMarks {
  return {
    history: () => bootHistory(db),
    crashLoopAlertedAt: () => get(db, KEY_CRASH_LOOP) ?? null,
    markCrashLoop: at => { if (at) put(db, KEY_CRASH_LOOP, at); else db.prepare('delete from settings where key = ?').run(KEY_CRASH_LOOP); },
  };
}

function get(db: Db, key: string): string | undefined {
  return (db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined)?.value;
}

function put(db: Db, key: string, value: string): void {
  db.prepare('insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, value);
}
