import { join } from 'node:path';
import type { Workplace } from './workplace.js';
import { readOauthToken } from './employees.js';
import * as employees from './employees.js';
import * as inbox from './inbox.js';
import * as coo from './coo.js';
import { now } from './store.js';
import { log } from '../util/logger.js';
import * as ceiling from './usage-ceiling.js';

/**
 * Weekly pacing (owner, 3 Oct): the subscription's weekly limit is spread evenly over the week.
 * On day N since the weekly reset the team may have used at most N × 14% of it; once the
 * plan's own 7-day utilization reaches that, unattended work stops until the next pace day
 * (the reset time + N days). Talking to the staff is never stopped, same as a spend cap.
 *
 * The utilization is read from the plan's own rate-limit headers on a one-token request,
 * the same numbers Claude Code's /usage shows.
 *
 * 17 Oct (owner, restating 3 Oct):
 *  - Park, not kill: a trip stops new work (assignments, resumes, digests, autonomous talk; the gates
 *    read `pace:until` through spend.canSpend and floor.paceHeld) and lets running turns finish. It
 *    never interrupts a session (on 4 Oct a trip ended every live session mid-turn).
 *  - A trip tells the COO and raises ONE owner decision: "Bypass until the next pace day" lifts
 *    pacing until that day starts (`pace:bypass`), then pacing resumes by itself. `pace:disabled`
 *    stays the permanent off switch.
 *  - A failed probe is never silent: the reason (the network error's cause, the HTTP status, a
 *    missing token) is logged and kept, a network error is retried once, and after
 *    PROBE_FAIL_NOTIFY failures in a row the COO is told (again every RENOTIFY_EVERY more).
 */

export const PER_DAY = 0.14;
const DAY_MS = 86_400_000;
const KEY = 'pace:until';
const BYPASS = 'pace:bypass';
const PROBE = 'pace:probe';
/** Consecutive failed probes (5 min apart) before the COO is told pacing is blind. */
export const PROBE_FAIL_NOTIFY = 3;
const RENOTIFY_EVERY = 12;
const URL_MESSAGES = 'https://api.anthropic.com/v1/messages';

const getSetting = (wp: Workplace, key: string): string | null =>
  (wp.db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined)?.value ?? null;
const putSetting = (wp: Workplace, key: string, value: string): void =>
  void wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(key, value);
const delSetting = (wp: Workplace, key: string): void => void wp.db.prepare('delete from settings where key = ?').run(key);
const event = (wp: Workplace, kind: string, json: unknown): void =>
  void wp.db.prepare('insert into events (at, kind, subject, json) values (?, ?, ?, ?)').run(now(), kind, 'weekly-pace', JSON.stringify(json));
const pct = (x: number): number => Math.round(x * 100);
const ist = (iso: string): string =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) + ' IST';

export interface Reading { utilization: number; resetsAtMs: number; fiveHour?: { utilization: number; resetsAtMs: number } }
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

/** The ISO time the owner's bypass ends (the next pace day), while one is on; null otherwise. */
export function bypassUntil(wp: Workplace, nowMs = Date.now()): string | null {
  const v = getSetting(wp, BYPASS);
  return v && Date.parse(v) > nowMs ? v : null;
}

/** Apply a reading: start a hold (park) when over today's allowance, end an expired one. */
export function apply(wp: Workplace, r: Reading, nowMs = Date.now()): Verdict {
  const v = evaluate(r, nowMs);
  putSetting(wp, 'pace:last', JSON.stringify({ ...r, ...v, at: new Date(nowMs).toISOString() }));
  if (disabled(wp)) { lift(wp, v, 'pacing disabled by the owner'); return { ...v, over: false }; }
  const bypass = getSetting(wp, BYPASS);
  if (bypass && Date.parse(bypass) <= nowMs) {
    delSetting(wp, BYPASS);
    event(wp, 'pace-bypass-ended', { until: bypass });
    log.info('pace', `the owner's bypass ended (${bypass}): pacing applies again`);
  }
  if (bypassUntil(wp, nowMs)) { lift(wp, v, 'bypassed by the owner until the next pace day'); return { ...v, over: false }; }
  const held = holdUntil(wp, nowMs);
  if (v.over && !held) {
    const until = new Date(v.nextDayMs).toISOString();
    expireDecisions(wp, 'Superseded by a newer pace-cap decision.');
    putSetting(wp, KEY, until);
    event(wp, 'pace-hold', { ...v, utilization: r.utilization, until });
    log.warn('pace', `weekly ${pct(r.utilization)}% ≥ day ${v.dayIndex} allowance ${pct(v.allowance)}%: parked (no new work; running turns finish) until ${until}`);
    trip(wp, r, v, until);
  } else if (!held && getSetting(wp, KEY)) {
    delSetting(wp, KEY);
    event(wp, 'pace-lifted', v);
    log.info('pace', `new pace day ${v.dayIndex} (allowance ${pct(v.allowance)}%): work resumes`);
    expireDecisions(wp, 'The next pace day began: work resumed on its own.');
    employees.unpauseAll(wp);
  }
  return v;
}

/**
 * Tell the COO, and raise ONE owner decision for this trip (deduped by the pace day it ends). No
 * session is interrupted: the gates stop new work and running turns finish (park, not kill).
 */
function trip(wp: Workplace, r: Reading, v: Verdict, until: string): void {
  const used = `${pct(r.utilization)}% used, cap ${pct(v.allowance)}% today`;
  try {
    coo.notifyStall(wp, {
      itemId: 'weekly-pace', by: 'workplace',
      title: `Weekly pace cap reached (${used}): parked until ${ist(until)}`,
      body: `Pace day ${v.dayIndex}: the plan's 7-day usage is ${pct(r.utilization)}%, at or past today's ${pct(v.allowance)}% (14% × ${v.dayIndex}). No new work starts (assignments, resumes, digests); running turns finish. It lifts by itself at ${ist(until)}. The owner was asked in his Inbox whether to bypass until then. Off for good: POST /api/coo/pace {"disabled":true}.`,
    });
  } catch (err) { log.warn('pace', `could not tell the COO: ${err instanceof Error ? err.message : err}`); }
  try {
    inbox.raise(wp, {
      // Straight to the owner (COO, 17 Oct): the COO was told above and never answers it for him.
      kind: 'decision', raisedBy: 'workplace', urgency: 'high', skipCooHold: true,
      title: `Weekly pace cap reached (${used}): bypass?`,
      body: `Today is pace day ${v.dayIndex} of the week: the team may use ${pct(v.allowance)}% of the weekly limit and has used ${pct(r.utilization)}%. New work is parked until the next pace day (${ist(until)}); running turns finish and you can still talk to anyone.\n\nBypass: work starts again now and pacing resumes by itself at ${ist(until)}. Keep parked: nothing changes.`,
      options: [{ id: 'bypass', label: 'Bypass until the next pace day' }, { id: 'keep-parked', label: 'Keep parked' }],
      context: { pace: true, until, paceDay: v.dayIndex, utilization: r.utilization, allowance: v.allowance },
      dedupeKey: `pace:${until}`,
    });
  } catch (err) { log.warn('pace', `could not raise the owner's decision: ${err instanceof Error ? err.message : err}`); }
}

/** An open pace decision is moot once its day is over (or a newer one replaces it). */
function expireDecisions(wp: Workplace, why: string): void {
  for (const i of inbox.list(wp, 'open').filter(x => x.context['pace'] === true)) {
    try { inbox.expire(wp, i.id, why); } catch (err) { log.warn('pace', `expire ${i.id}: ${err instanceof Error ? err.message : err}`); }
  }
}

/** The owner's bypass: pacing off until `until` (the next pace day), any hold lifted at once. */
export function setBypass(wp: Workplace, until: string, by: string): void {
  putSetting(wp, BYPASS, until);
  event(wp, 'pace-bypass', { until, by });
  log.info('pace', `bypassed by ${by} until ${until}`);
  lift(wp, null, `bypassed by ${by} until the next pace day`);
}

// "Bypass until the next pace day" in the Inbox: lift pacing until the day the decision was about ends.
inbox.onAnswer((wp, item) => {
  if (item.context['pace'] !== true || item.answer?.optionId !== 'bypass') return;
  const until = String(item.context['until'] ?? '');
  if (!(Date.parse(until) > Date.now())) { log.info('pace', `bypass on ${item.id} came after its pace day ended (${until}): nothing to lift`); return; }
  setBypass(wp, until, item.answer.by === 'coo' ? 'coo (for the owner)' : 'owner');
});

/** Owner switch (`pace:disabled` setting): pacing off, any hold lifted at once. */
export function disabled(wp: Workplace): boolean {
  return Boolean(getSetting(wp, 'pace:disabled'));
}

export function setDisabled(wp: Workplace, off: boolean): void {
  if (off) {
    putSetting(wp, 'pace:disabled', new Date().toISOString());
    lift(wp, null, 'pacing disabled by the owner');
  } else delSetting(wp, 'pace:disabled');
}

function lift(wp: Workplace, v: Verdict | null, why: string): void {
  if (!getSetting(wp, KEY)) return;
  delSetting(wp, KEY);
  event(wp, 'pace-lifted', v ?? { why });
  log.info('pace', `${why}: work resumes`);
  expireDecisions(wp, `Pacing was lifted: ${why}.`);
  employees.unpauseAll(wp);
}

export interface PaceStatus {
  disabled: boolean; bypassUntil: string | null; holdUntil: string | null;
  utilization: number | null; capToday: number | null; paceDay: number | null;
  lastReadingAt: string | null; lastProbeAt: string | null; lastOkAt: string | null; lastError: string | null; failures: number;
}

interface ProbeState { lastProbeAt?: string; lastOkAt?: string; lastError?: string | null; failures?: number }
const probeState = (wp: Workplace): ProbeState => { try { return JSON.parse(getSetting(wp, PROBE) ?? '{}') as ProbeState; } catch { return {}; } };

/** GET /api/coo/pace: the switch, the bypass, today's numbers from the last reading, and the probe's health. */
export function status(wp: Workplace, nowMs = Date.now()): PaceStatus {
  const readLast = (): (Reading & { at?: string }) | null => {
    try { return JSON.parse(getSetting(wp, 'pace:last') ?? 'null') as (Reading & { at?: string }) | null; } catch { return null; }
  };
  const last = readLast();
  const v = last && Number.isFinite(last.resetsAtMs) ? evaluate(last, nowMs) : null;
  const p = probeState(wp);
  return {
    disabled: disabled(wp), bypassUntil: bypassUntil(wp, nowMs), holdUntil: holdUntil(wp, nowMs),
    utilization: last?.utilization ?? null, capToday: v?.allowance ?? null, paceDay: v?.dayIndex ?? null,
    lastReadingAt: last?.at ?? null, lastProbeAt: p.lastProbeAt ?? null, lastOkAt: p.lastOkAt ?? null,
    lastError: p.lastError ?? null, failures: p.failures ?? 0,
  };
}

/**
 * Why a fetch failed. Node's fetch throws TypeError "fetch failed" for every network error and puts
 * the real one (ECONNRESET, ETIMEDOUT, ENETUNREACH, EAI_AGAIN, an AggregateError of both address
 * families) in `cause`; logging only `message` is what left the 17 Oct boot failure unexplained.
 */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let depth = 0; e && depth < 4; depth++) {
    const x = e as { message?: string; code?: string; errors?: unknown[]; cause?: unknown; name?: string };
    const msg = x.message ?? String(e);
    parts.push(x.code && !msg.includes(x.code) ? `${x.code} ${msg}` : msg);
    if (Array.isArray(x.errors) && x.errors.length) {
      parts.push(x.errors.map(a => { const y = a as { code?: string; message?: string; address?: string }; return y.code ?? y.message ?? String(a); }).join(', '));
    }
    e = x.cause;
  }
  return parts.filter(Boolean).join(': ') || 'unknown error';
}

export type ProbeResult = { reading: Reading } | { error: string };
export interface ProbeOptions { fetch?: typeof fetch; retryDelayMs?: number; timeoutMs?: number }

/** Read the plan's 7-day utilization from its rate-limit headers; on failure, why. */
export async function probe(wp: Workplace, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const token = readOauthToken(wp);
  if (!token) return { error: `no CLAUDE_CODE_OAUTH_TOKEN in ${join(wp.config.opsDir, 'workplace', 'claude-oauth.env')}` };
  const doFetch = opts.fetch ?? fetch;
  for (let attempt = 1; ; attempt += 1) {
    let res: Response;
    try {
      res = await doFetch(URL_MESSAGES, {
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
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });
    } catch (err) {
      const why = describeError(err);
      // A network error is retried once: one blip (the 17 Oct boot) must not cost a 5-minute gap.
      if (attempt >= 2) return { error: why };
      log.warn('pace', `probe attempt failed (${why}); retrying`);
      await new Promise(r => setTimeout(r, opts.retryDelayMs ?? 5_000));
      continue;
    }
    const text = await res.text().catch(() => '');
    const u = Number(res.headers.get('anthropic-ratelimit-unified-7d-utilization'));
    const reset = Number(res.headers.get('anthropic-ratelimit-unified-7d-reset'));
    if (!res.headers.has('anthropic-ratelimit-unified-7d-utilization') || !Number.isFinite(u) || !reset) {
      return { error: `HTTP ${res.status} without the 7-day rate-limit headers${text ? `: ${text.replace(/\s+/g, ' ').slice(0, 200)}` : ''}` };
    }
    const u5 = Number(res.headers.get('anthropic-ratelimit-unified-5h-utilization'));
    const reset5 = Number(res.headers.get('anthropic-ratelimit-unified-5h-reset'));
    const fiveHour = res.headers.has('anthropic-ratelimit-unified-5h-utilization') && Number.isFinite(u5) && reset5 ? { utilization: u5, resetsAtMs: reset5 * 1000 } : undefined;
    return { reading: { utilization: u, resetsAtMs: reset * 1000, ...(fiveHour ? { fiveHour } : {}) } };
  }
}

/** Keep the probe's health; tell the COO when pacing has been blind for PROBE_FAIL_NOTIFY probes in a row. */
function recordProbe(wp: Workplace, r: ProbeResult, nowMs: number): void {
  const prev = probeState(wp);
  const at = new Date(nowMs).toISOString();
  if ('reading' in r) {
    if ((prev.failures ?? 0) >= PROBE_FAIL_NOTIFY) log.info('pace', `probe recovered after ${prev.failures} failures`);
    putSetting(wp, PROBE, JSON.stringify({ lastProbeAt: at, lastOkAt: at, lastError: null, failures: 0 }));
    return;
  }
  const failures = (prev.failures ?? 0) + 1;
  putSetting(wp, PROBE, JSON.stringify({ ...prev, lastProbeAt: at, lastError: r.error, failures }));
  log.warn('pace', `probe failed (${failures} in a row): ${r.error}`);
  if (failures === PROBE_FAIL_NOTIFY || (failures > PROBE_FAIL_NOTIFY && (failures - PROBE_FAIL_NOTIFY) % RENOTIFY_EVERY === 0)) {
    coo.notifyStall(wp, {
      itemId: 'weekly-pace', by: 'workplace',
      title: `Pace probe failing: weekly pacing is blind (${failures} in a row)`,
      body: `The usage probe to api.anthropic.com has failed ${failures} times in a row; last error: ${r.error}. Last good reading: ${prev.lastOkAt ?? 'never'}. While it fails no new hold starts (a hold already on still ends on time). Check the token in ~/iris-ops/workplace/claude-oauth.env and the network; GET /api/coo/pace shows the state.`,
    });
  }
}

/** One probe and what follows from it. Never throws (it runs on a timer, and in tests after close). */
export async function tick(wp: Workplace, opts: ProbeOptions = {}): Promise<void> {
  let r: ProbeResult;
  try { r = await probe(wp, opts); } catch (err) { r = { error: describeError(err) }; }
  try {
    const nowMs = Date.now();
    recordProbe(wp, r, nowMs);
    if ('reading' in r) {
      // The usage ceiling runs whether pacing is on or off (owner, 5 Oct).
      try { ceiling.apply(wp, r.reading); } catch (err) { log.warn('ceiling', String(err)); }
      apply(wp, r.reading, nowMs);
    } else if (!holdUntil(wp, nowMs) && getSetting(wp, KEY)) {
      // No reading, but the hold expired: the next day has begun regardless.
      delSetting(wp, KEY);
      expireDecisions(wp, 'The next pace day began: work resumed on its own.');
      employees.unpauseAll(wp);
    }
  } catch (err) {
    log.warn('pace', `tick: ${err instanceof Error ? err.message : err}`);
  }
}

/** Probe now and then every `minutes`; returns the stop function. */
export function start(wp: Workplace, minutes = 5): () => void {
  void tick(wp);
  const timer = setInterval(() => void tick(wp), minutes * 60_000);
  return () => clearInterval(timer);
}
