import type { Workplace } from './workplace.js';
import { readOauthToken } from './employees.js';
import * as employees from './employees.js';
import { now } from './store.js';
import { log } from '../util/logger.js';

/**
 * Weekly pacing (owner, 3 Oct): the subscription's weekly limit is spread evenly over the week.
 * On day N since the weekly reset the team may have used at most N × 14% of it; once the
 * plan's own 7-day utilization reaches that, unattended work stops until the next pace day
 * (the reset time + N days). Talking to the staff is never stopped, same as a spend cap.
 *
 * The utilization is read from the plan's own rate-limit headers on a one-token request,
 * the same numbers Claude Code's /usage shows. A failed probe changes nothing.
 */

export const PER_DAY = 0.14;
const DAY_MS = 86_400_000;
const KEY = 'pace:until';

export interface Reading { utilization: number; resetsAtMs: number }
export interface Verdict { dayIndex: number; allowance: number; over: boolean; nextDayMs: number }

/** Pure: day N of the week (1-based), its allowance, and whether the reading is past it. */
export function evaluate(r: Reading, nowMs: number, perDay = PER_DAY): Verdict {
  const startMs = r.resetsAtMs - 7 * DAY_MS;
  const dayIndex = Math.min(7, Math.max(1, Math.floor((nowMs - startMs) / DAY_MS) + 1));
  const allowance = Math.min(1, Math.round(perDay * dayIndex * 1000) / 1000);
  return { dayIndex, allowance, over: r.utilization >= allowance, nextDayMs: startMs + dayIndex * DAY_MS };
}

/** The ISO time unattended work may resume, while a pace hold is on; null otherwise. */
export function holdUntil(wp: Workplace, nowMs = Date.now()): string | null {
  const row = wp.db.prepare('select value from settings where key = ?').get(KEY) as { value: string } | undefined;
  return row && Date.parse(row.value) > nowMs ? row.value : null;
}

/** Apply a reading: start a hold when over today's allowance, end an expired one. */
export function apply(wp: Workplace, r: Reading, nowMs = Date.now()): Verdict {
  const v = evaluate(r, nowMs);
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run('pace:last', JSON.stringify({ ...r, ...v, at: new Date(nowMs).toISOString() }));
  if (disabled(wp)) { lift(wp, v); return { ...v, over: false }; }
  const held = holdUntil(wp, nowMs);
  if (v.over && !held) {
    const until = new Date(v.nextDayMs).toISOString();
    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(KEY, until);
    wp.db.prepare('insert into events (at, kind, subject, json) values (?, ?, ?, ?)').run(now(), 'pace-hold', 'weekly-pace', JSON.stringify({ ...v, utilization: r.utilization, until }));
    log.warn('pace', `weekly ${Math.round(r.utilization * 100)}% ≥ day ${v.dayIndex} allowance ${Math.round(v.allowance * 100)}%: unattended work stops until ${until}`);
    employees.pauseScope(wp, 'weekly-pace');
  } else if (!held && wp.db.prepare('select 1 from settings where key = ?').get(KEY)) {
    wp.db.prepare('delete from settings where key = ?').run(KEY);
    wp.db.prepare('insert into events (at, kind, subject, json) values (?, ?, ?, ?)').run(now(), 'pace-lifted', 'weekly-pace', JSON.stringify(v));
    log.info('pace', `new pace day ${v.dayIndex} (allowance ${Math.round(v.allowance * 100)}%): work resumes`);
    employees.unpauseAll(wp);
  }
  return v;
}

/** Owner switch (`pace:disabled` setting): pacing off, any hold lifted at once. */
export function disabled(wp: Workplace): boolean {
  return Boolean(wp.db.prepare('select 1 from settings where key = ?').get('pace:disabled'));
}

export function setDisabled(wp: Workplace, off: boolean): void {
  if (off) {
    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run('pace:disabled', new Date().toISOString());
    lift(wp, null);
  } else wp.db.prepare('delete from settings where key = ?').run('pace:disabled');
}

function lift(wp: Workplace, v: Verdict | null): void {
  if (!wp.db.prepare('select 1 from settings where key = ?').get(KEY)) return;
  wp.db.prepare('delete from settings where key = ?').run(KEY);
  wp.db.prepare('insert into events (at, kind, subject, json) values (?, ?, ?, ?)').run(now(), 'pace-lifted', 'weekly-pace', JSON.stringify(v ?? { disabled: true }));
  log.info('pace', 'pacing disabled by the owner: work resumes');
  employees.unpauseAll(wp);
}

/** Read the plan's 7-day utilization from its rate-limit headers. Null on any failure. */
export async function probe(wp: Workplace): Promise<Reading | null> {
  const token = readOauthToken(wp);
  if (!token) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01', 'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 1,
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const u = Number(res.headers.get('anthropic-ratelimit-unified-7d-utilization'));
    const reset = Number(res.headers.get('anthropic-ratelimit-unified-7d-reset'));
    if (!res.headers.has('anthropic-ratelimit-unified-7d-utilization') || !Number.isFinite(u) || !reset) return null;
    return { utilization: u, resetsAtMs: reset * 1000 };
  } catch (err) {
    log.warn('pace', `probe failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Probe now and then every `minutes`; returns the stop function. */
export function start(wp: Workplace, minutes = 15): () => void {
  const run = async () => {
    const r = await probe(wp);
    if (r) { try { apply(wp, r); } catch (err) { log.warn('pace', String(err)); } }
    else if (!holdUntil(wp) && wp.db.prepare('select 1 from settings where key = ?').get(KEY)) {
      // No reading, but the hold expired: the next day has begun regardless.
      wp.db.prepare('delete from settings where key = ?').run(KEY);
      employees.unpauseAll(wp);
    }
  };
  void run();
  const timer = setInterval(() => void run(), minutes * 60_000);
  return () => clearInterval(timer);
}
