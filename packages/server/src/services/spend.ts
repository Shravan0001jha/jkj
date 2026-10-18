import type { RateLimitWindow, SpendBasis, SpendEntry, SpendSource, SpendSummary, SubscriptionUsage } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as inbox from './inbox.js';
import { now } from './store.js';
import { log } from '../util/logger.js';

/**
 * Budget is real money only (HLD D9b, owner 28 Sep).
 *
 * Two ledgers. `usage` is the subscription: free, tracked for visibility (turns, tokens, the
 * list-price equivalent, the plan's own limit windows). `spend` is money the organisation's work
 * actually costs: Anthropic API, AWS, paid third parties; each row says how it was measured
 * (metered, estimated, reported). Caps sum only real money. Rows from before 28 Sep carry
 * `source: 'subscription'` and count for nothing.
 */

const REAL: SpendSource[] = ['anthropic-api', 'aws', 'third-party'];

/** IST calendar day for a timestamp. */
export function dayOf(at: string | Date = new Date()): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/* ---------- the subscription ledger (free) ---------- */

export interface Usage {
  employeeId: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The SDK's list-price estimate for this delta, USD. Information only. */
  usd: number;
  at?: string;
  tag?: 'owner-talk';
}

export function recordUsage(wp: Workplace, u: Usage): void {
  const at = u.at ?? now();
  wp.db.prepare('insert into usage (at, day, employee_id, session_id, model, turns, input_tokens, output_tokens, cache_read, cache_write, equivalent_inr, tag) values (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)')
    .run(at, dayOf(at), u.employeeId, u.sessionId, u.model, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, round(u.usd * wp.config.usdInr), u.tag ?? null);
  wp.emit({ type: 'spend.updated', summary: summary(wp, dayOf(at)) });
}

/** The SDK's rate-limit event: the plan's own windows, kept as the latest per window. */
export function recordRateLimit(wp: Workplace, info: { rateLimitType?: string; status: string; utilization?: number; resetsAt?: number }): void {
  const window: RateLimitWindow = {
    window: (info.rateLimitType as RateLimitWindow['window']) ?? 'unknown',
    status: info.status as RateLimitWindow['status'],
    ...(info.utilization !== undefined ? { utilization: info.utilization } : {}),
    ...(info.resetsAt ? { resetsAt: new Date(info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1)).toISOString() } : {}),
    seenAt: now(),
  };
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`ratelimit:${window.window}`, JSON.stringify(window));
  // History too (QA B15): the settings row is only the latest report, which cannot explain last night.
  wp.db.prepare('insert into events (at, kind, subject, json) values (?, ?, ?, ?)').run(window.seenAt, 'rate-limit', window.window, JSON.stringify(window));
  if (window.status !== 'allowed') log.warn('usage', `subscription ${window.window}: ${window.status}${window.utilization !== undefined ? ` at ${Math.round(window.utilization * 100)}%` : ''}`);
}

export function subscription(wp: Workplace, day = dayOf()): SubscriptionUsage {
  const rows = wp.db.prepare('select employee_id as employeeId, sum(turns) as turns, sum(input_tokens) as i, sum(output_tokens) as o, sum(cache_read) as cr, sum(cache_write) as cw, sum(equivalent_inr) as inr from usage where day = ? group by employee_id').all(day) as { employeeId: string; turns: number; i: number; o: number; cr: number; cw: number; inr: number }[];
  // The pre-28-Sep ledger is subscription usage too.
  const old = wp.db.prepare("select employee_id as employeeId, count(*) as turns, sum(inr) as inr from spend where day = ? and source = 'subscription' group by employee_id").all(day) as { employeeId: string; turns: number; inr: number }[];
  const byEmployee: Record<string, { turns: number; equivalentInr: number }> = {};
  const total = { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, equivalentInr: 0 };
  for (const r of rows) {
    byEmployee[r.employeeId] = { turns: r.turns, equivalentInr: round(r.inr) };
    total.turns += r.turns; total.inputTokens += r.i; total.outputTokens += r.o; total.cacheReadTokens += r.cr; total.cacheWriteTokens += r.cw; total.equivalentInr += r.inr;
  }
  for (const r of old) {
    const e = (byEmployee[r.employeeId] ??= { turns: 0, equivalentInr: 0 });
    e.turns += r.turns; e.equivalentInr = round(e.equivalentInr + r.inr);
    total.turns += r.turns; total.equivalentInr += r.inr;
  }
  const windows = (wp.db.prepare("select value from settings where key like 'ratelimit:%'").all() as { value: string }[]).map(r => JSON.parse(r.value) as RateLimitWindow);
  return { ...total, equivalentInr: round(total.equivalentInr), byEmployee, windows };
}

/* ---------- the money ledger ---------- */

export interface Spend {
  employeeId: string;
  sessionId?: string;
  source: SpendSource;
  basis: SpendBasis;
  what: string;
  inr: number;
  detail?: Record<string, number | string>;
  at?: string;
  tag?: 'owner-talk';
}

export function record(wp: Workplace, s: Spend): SpendEntry {
  const at = s.at ?? now();
  const entry: SpendEntry = {
    at, employeeId: s.employeeId, sessionId: s.sessionId ?? '', source: s.source, basis: s.basis, what: s.what, inr: round(s.inr),
    ...(s.detail ? { detail: s.detail } : {}), ...(s.tag ? { tag: s.tag } : {}),
  };
  wp.db.prepare('insert into spend (at, day, employee_id, session_id, model, input_tokens, output_tokens, cache_read, cache_write, usd, inr, tag, source, basis, what, detail) values (?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?)')
    .run(at, dayOf(at), entry.employeeId, entry.sessionId, '', typeof s.detail?.['usd'] === 'number' ? s.detail['usd'] : 0, entry.inr, entry.tag ?? null, entry.source, entry.basis, entry.what, s.detail ? JSON.stringify(s.detail) : null);
  const summary = REAL.includes(s.source) ? check(wp, dayOf(at)) : summary_(wp, dayOf(at));
  wp.emit({ type: 'spend.updated', summary });
  for (const fn of recordListeners) { try { fn(wp, s.source); } catch (err) { log.warn('spend', `record listener: ${err instanceof Error ? err.message : err}`); } }
  return entry;
}

type RecordListener = (wp: Workplace, source: SpendSource) => void;
const recordListeners = new Set<RecordListener>();
/** Called after every ledger row (the daily spend caps, spend-caps.ts, check right away). */
export function onRecord(fn: RecordListener): () => void {
  recordListeners.add(fn);
  return () => void recordListeners.delete(fn);
}

/** The day's actual from a provider replaces that day's estimates for the same source in the total. */
export function reconcile(wp: Workplace, day: string, source: SpendSource, actualInr: number, what: string): SpendEntry {
  wp.db.prepare("update spend set basis = 'superseded' where day = ? and source = ? and basis = 'estimated'").run(day, source);
  return record(wp, { employeeId: 'workplace', source, basis: 'metered', what, inr: actualInr, at: `${day}T18:29:59.000Z` });
}

const summary_ = (wp: Workplace, day: string): SpendSummary => summary(wp, day);

export function summary(wp: Workplace, day = dayOf()): SpendSummary {
  const rows = wp.db.prepare("select employee_id as employeeId, source, basis, sum(inr) as inr from spend where day = ? and source in ('anthropic-api', 'aws', 'third-party') and basis != 'superseded' group by employee_id, source, basis").all(day) as { employeeId: string; source: string; basis: string; inr: number }[];
  const byEmployee: Record<string, number> = {};
  const byUnit: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byBasis: Record<string, number> = {};
  let companyInr = 0;
  for (const r of rows) {
    byEmployee[r.employeeId] = round((byEmployee[r.employeeId] ?? 0) + r.inr);
    bySource[r.source] = round((bySource[r.source] ?? 0) + r.inr);
    byBasis[r.basis] = round((byBasis[r.basis] ?? 0) + r.inr);
    companyInr += r.inr;
    const unit = wp.org.employees.find(e => e.id === r.employeeId)?.unitId;
    if (unit) byUnit[unit] = round((byUnit[unit] ?? 0) + r.inr);
  }
  const ownerTalk = (wp.db.prepare("select coalesce(sum(equivalent_inr), 0) as inr from usage where day = ? and tag = 'owner-talk'").get(day) as { inr: number }).inr
    + (wp.db.prepare("select coalesce(sum(inr), 0) as inr from spend where day = ? and tag = 'owner-talk' and source = 'subscription'").get(day) as { inr: number }).inr;
  return {
    day, companyInr: round(companyInr), capInr: capFor(wp, day), bySource, byBasis, byEmployee, byUnit,
    paused: pausedScopes(wp, day), subscription: subscription(wp, day), ownerTalkInr: round(ownerTalk),
  };
}

/** Today's company cap: the configured one, or the one the owner raised for today. */
export function capFor(wp: Workplace, day = dayOf()): number {
  const row = wp.db.prepare('select value from settings where key = ?').get(`cap:${day}`) as { value: string } | undefined;
  return row ? Number(row.value) : wp.config.capInr;
}

export function raiseCapForToday(wp: Workplace, day: string, inr: number): void {
  wp.db.prepare('insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(`cap:${day}`, String(inr));
  wp.db.prepare('delete from settings where key like ?').run(`paused:${day}:%`);
  wp.emit({ type: 'spend.updated', summary: summary(wp, day) });
}

export function scopesOf(wp: Workplace, employeeId: string): string[] {
  const e = wp.org.employees.find(x => x.id === employeeId);
  return ['company', 'weekly-pace', ...(e ? [`unit:${e.unitId}`, `employee:${e.id}`] : [])];
}

/** Compare every scope's real spend against its cap; pause the ones at it and file one Inbox item per scope. */
export function check(wp: Workplace, day = dayOf()): SpendSummary {
  const s = summary(wp, day);
  const overs: { scope: string; spent: number; cap: number }[] = [];
  if (s.companyInr >= s.capInr) overs.push({ scope: 'company', spent: s.companyInr, cap: s.capInr });
  for (const u of wp.org.units) {
    if (u.budget && (s.byUnit[u.id] ?? 0) >= u.budget.inrPerDay) overs.push({ scope: `unit:${u.id}`, spent: s.byUnit[u.id] ?? 0, cap: u.budget.inrPerDay });
  }
  for (const e of wp.org.employees) {
    // A virtual employee (the COO) is never spawned and never spends: its ₹0/day budget is not a
    // cap to reach, so it never joins a paused scope, a cap Inbox item, or a pause listener's list.
    if (e.virtual) continue;
    if ((s.byEmployee[e.id] ?? 0) >= e.budget.inrPerDay) overs.push({ scope: `employee:${e.id}`, spent: s.byEmployee[e.id] ?? 0, cap: e.budget.inrPerDay });
  }
  for (const over of overs) {
    if (isPaused(wp, day, over.scope) || isLifted(wp, day, over.scope)) continue;
    wp.db.prepare('insert or ignore into settings (key, value) values (?, ?)').run(`paused:${day}:${over.scope}`, now());
    inbox.raise(wp, {
      kind: 'cap',
      title: `Spend cap reached: ${over.scope}`,
      body: `${over.scope} has spent ₹${over.spent.toFixed(0)} of real money today against a cap of ₹${over.cap}. Paid actions and unattended work are paused; talking to the staff is not. Raise the cap for today (give the new number in ₹), or keep it and they resume tomorrow.`,
      context: { scope: over.scope, day, spent: over.spent, cap: over.cap },
      raisedBy: 'workplace',
      dedupeKey: `cap:${day}:${over.scope}`,
      onApprove: 'the cap for today is raised to the number in the note and paused work resumes',
      onDeny: 'the cap stays; paid actions wait for tomorrow',
    });
    wp.emit({ type: 'alert', level: 'cap', title: `Cap reached: ${over.scope}`, body: `₹${over.spent.toFixed(0)} of ₹${over.cap} real money` });
    for (const fn of pauseListeners) fn(wp, over.scope);
  }
  return { ...s, paused: pausedScopes(wp, day) };
}

/** The owner lifting a pause in a talk is his approval for that scope for the day. Recorded. */
export function liftPause(wp: Workplace, scope: string, day: string, by: string): void {
  wp.db.prepare('delete from settings where key = ?').run(`paused:${day}:${scope}`);
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`lifted:${day}:${scope}`, by);
  wp.db.prepare('insert into events (at, kind, subject, json) values (?, ?, ?, ?)').run(now(), 'cap-lifted', scope, JSON.stringify({ day, by }));
  wp.emit({ type: 'spend.updated', summary: summary(wp, day) });
}

export const isLifted = (wp: Workplace, day: string, scope: string): boolean =>
  !!wp.db.prepare('select 1 from settings where key = ?').get(`lifted:${day}:${scope}`);

export const isPaused = (wp: Workplace, day: string, scope: string): boolean =>
  !!wp.db.prepare('select 1 from settings where key = ?').get(`paused:${day}:${scope}`);

export function pausedScopes(wp: Workplace, day: string): string[] {
  const rows = wp.db.prepare('select key from settings where key like ?').all(`paused:${day}:%`) as { key: string }[];
  return rows.map(r => r.key.slice(`paused:${day}:`.length));
}

/** True when this employee may run paid actions or unattended work right now. */
export function canSpend(wp: Workplace, employeeId: string, day = dayOf()): { ok: boolean; scope?: string } {
  // The weekly pace hold (pace.ts) stops unattended work for everyone until the next pace day.
  const pace = wp.db.prepare("select value from settings where key = 'pace:until'").get() as { value: string } | undefined;
  if (pace && Date.parse(pace.value) > Date.now()) return { ok: false, scope: 'weekly-pace' };
  for (const scope of scopesOf(wp, employeeId)) if (isPaused(wp, day, scope)) return { ok: false, scope };
  return { ok: true };
}

/** Remaining real-money headroom for today, ₹. */
export function remainingInr(wp: Workplace, employeeId: string, day = dayOf()): number {
  const s = summary(wp, day);
  const e = wp.org.employees.find(x => x.id === employeeId);
  const employeeLeft = e ? e.budget.inrPerDay - (s.byEmployee[e.id] ?? 0) : 0;
  return Math.max(0, Math.min(employeeLeft, s.capInr - s.companyInr));
}

/** Kept for the SDK's maxBudgetUsd: subscription turns are free, so this is only a runaway guard. */
export function remainingUsd(wp: Workplace, employeeId: string, day = dayOf()): number {
  return remainingInr(wp, employeeId, day) / wp.config.usdInr;
}

type PauseListener = (wp: Workplace, scope: string) => void;
const pauseListeners = new Set<PauseListener>();
export function onPause(fn: PauseListener): () => void {
  pauseListeners.add(fn);
  return () => void pauseListeners.delete(fn);
}

inbox.onAnswer((wp, item) => {
  if (item.kind !== 'cap' || !item.answer) return;
  const day = String(item.context['day'] ?? dayOf());
  if (item.answer.optionId === 'raise-today') {
    const inr = Number(String(item.answer.note ?? '').replace(/[^\d.]/g, ''));
    if (Number.isFinite(inr) && inr > 0) raiseCapForToday(wp, day, inr);
  }
});

/** Real spend by employee over the last N days, for cost-per-item signals. */
export function totalsSince(wp: Workplace, sinceIso: string): Record<string, number> {
  const rows = wp.db.prepare("select employee_id as employeeId, sum(inr) as inr from spend where at >= ? and source in ('anthropic-api', 'aws', 'third-party') and basis != 'superseded' group by employee_id").all(sinceIso) as { employeeId: string; inr: number }[];
  return Object.fromEntries(rows.map(r => [r.employeeId, round(r.inr)]));
}

/**
 * The one-time migration to real money (28 Sep): every earlier row was subscription-equivalent.
 * Relabel it, lift every pause that was on free usage, and resolve those cap items with the note.
 */
export function migrateToRealMoney(wp: Workplace): { relabelled: number; lifted: string[] } {
  if (wp.db.prepare('select 1 from settings where key = ?').get('migrated:real-money')) return { relabelled: 0, lifted: [] };
  const relabelled = wp.db.prepare("update spend set source = 'subscription', basis = 'metered', what = coalesce(what, 'agent session (subscription)') where source is null or source = ''").run().changes;
  const lifted: string[] = [];
  for (const row of wp.db.prepare("select key from settings where key like 'paused:%'").all() as { key: string }[]) {
    const [, day, ...rest] = row.key.split(':');
    const scope = rest.join(':');
    wp.db.prepare('delete from settings where key = ?').run(row.key);
    wp.db.prepare('insert into events (at, kind, subject, json) values (?, ?, ?, ?)').run(now(), 'cap-lifted', scope, JSON.stringify({ day, by: 'migration: the pause was on free subscription usage' }));
    lifted.push(scope);
  }
  for (const item of inbox.list(wp, 'open').filter(i => i.kind === 'cap')) {
    try { inbox.answer(wp, item.id, 'keep', 'Resolved by the Workplace: this pause was on subscription usage, which is free under the 28 Sep budget rule. The pause is lifted; the cap now counts real money only.', 'workplace'); } catch { /* already answered */ }
  }
  wp.db.prepare('insert into settings (key, value) values (?, ?)').run('migrated:real-money', now());
  if (relabelled || lifted.length) log.info('spend', `migrated to real money: ${Number(relabelled)} rows relabelled as subscription, pauses lifted: ${lifted.join(', ') || 'none'}`);
  return { relabelled: Number(relabelled), lifted };
}

/**
 * Any open `cap` item dated before the real-money migration ran is stale under the old
 * equivalent-cost model (decision A): resolve it every boot, not just once, since a cap item for a
 * past day can outlive the one-time `migrateToRealMoney` sweep (it only resolved what was open at
 * that moment). Idempotent: resolved items are no longer open, so there is nothing left next boot.
 */
export function resolveStalePreMigrationCapItems(wp: Workplace): { resolved: string[] } {
  const migrated = wp.db.prepare('select value from settings where key = ?').get('migrated:real-money') as { value: string } | undefined;
  if (!migrated) return { resolved: [] };
  const cutoverDay = dayOf(migrated.value);
  const resolved: string[] = [];
  for (const item of inbox.list(wp, 'open').filter(i => i.kind === 'cap')) {
    const day = String(item.context['day'] ?? '');
    if (day && day < cutoverDay) {
      inbox.answer(wp, item.id, 'keep', 'Resolved by the Workplace: this pause is from the old equivalent-cost model, before caps counted real money only (decision A). No action needed.', 'workplace');
      resolved.push(item.id);
    }
  }
  if (resolved.length) log.info('spend', `resolved ${resolved.length} stale pre-migration cap item(s)`);
  return { resolved };
}

const round = (n: number): number => Math.round(n * 100) / 100;
