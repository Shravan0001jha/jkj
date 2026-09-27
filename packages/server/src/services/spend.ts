import type { SpendEntry, SpendSummary } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as inbox from './inbox.js';
import { now } from './store.js';

/**
 * Budget (HLD D9): the equivalent API cost of every session, in rupees,
 * against three caps: employee, unit and the company's ₹1000/day.
 *
 * Agents run on the subscription token, so this is not a bill; it is the
 * number the owner stated as a hard contract, enforced on the estimate the
 * SDK reports (list price × tokens), which is the conservative side.
 */

/** IST calendar day for a timestamp. */
export function dayOf(at: string | Date = new Date()): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export interface Usage {
  employeeId: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usd: number;
  at?: string;
}

export function record(wp: Workplace, usage: Usage): SpendEntry {
  const at = usage.at ?? now();
  const entry: SpendEntry = {
    at,
    employeeId: usage.employeeId,
    sessionId: usage.sessionId,
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    usd: usage.usd,
    inr: round(usage.usd * wp.config.usdInr),
  };
  wp.db.prepare('insert into spend (at, day, employee_id, session_id, model, input_tokens, output_tokens, cache_read, cache_write, usd, inr) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(entry.at, dayOf(at), entry.employeeId, entry.sessionId, entry.model, entry.inputTokens, entry.outputTokens, entry.cacheReadTokens, entry.cacheWriteTokens, entry.usd, entry.inr);
  const summary = check(wp, dayOf(at));
  wp.emit({ type: 'spend.updated', summary });
  return entry;
}

export function summary(wp: Workplace, day = dayOf()): SpendSummary {
  const rows = wp.db.prepare('select employee_id as employeeId, sum(inr) as inr from spend where day = ? group by employee_id').all(day) as { employeeId: string; inr: number }[];
  const byEmployee: Record<string, number> = {};
  const byUnit: Record<string, number> = {};
  let companyInr = 0;
  for (const r of rows) {
    byEmployee[r.employeeId] = round(r.inr);
    companyInr += r.inr;
    const unit = wp.org.employees.find(e => e.id === r.employeeId)?.unitId;
    if (unit) byUnit[unit] = round((byUnit[unit] ?? 0) + r.inr);
  }
  return { day, companyInr: round(companyInr), capInr: capFor(wp, day), byEmployee, byUnit, paused: pausedScopes(wp, day) };
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

/** Which scopes an employee's next spend falls under. */
export function scopesOf(wp: Workplace, employeeId: string): string[] {
  const e = wp.org.employees.find(x => x.id === employeeId);
  return ['company', ...(e ? [`unit:${e.unitId}`, `employee:${e.id}`] : [])];
}

/**
 * Compare every scope against its cap; pause the ones at it and file one
 * Inbox item per scope. Returns the summary after the check.
 */
export function check(wp: Workplace, day = dayOf()): SpendSummary {
  const s = summary(wp, day);
  const overs: { scope: string; spent: number; cap: number }[] = [];
  if (s.companyInr >= s.capInr) overs.push({ scope: 'company', spent: s.companyInr, cap: s.capInr });
  for (const u of wp.org.units) {
    if (u.budget && (s.byUnit[u.id] ?? 0) >= u.budget.inrPerDay) overs.push({ scope: `unit:${u.id}`, spent: s.byUnit[u.id] ?? 0, cap: u.budget.inrPerDay });
  }
  for (const e of wp.org.employees) {
    if ((s.byEmployee[e.id] ?? 0) >= e.budget.inrPerDay) overs.push({ scope: `employee:${e.id}`, spent: s.byEmployee[e.id] ?? 0, cap: e.budget.inrPerDay });
  }
  for (const over of overs) {
    if (isPaused(wp, day, over.scope)) continue;
    wp.db.prepare('insert or ignore into settings (key, value) values (?, ?)').run(`paused:${day}:${over.scope}`, now());
    inbox.raise(wp, {
      kind: 'cap',
      title: `Spend cap reached: ${over.scope}`,
      body: `${over.scope} has spent ₹${over.spent.toFixed(0)} today against a cap of ₹${over.cap}. Its sessions are paused. Raise the cap for today (give the new number in ₹), or keep it and they resume tomorrow.`,
      context: { scope: over.scope, day, spent: over.spent, cap: over.cap },
      raisedBy: 'workplace',
      dedupeKey: `cap:${day}:${over.scope}`,
    });
    wp.emit({ type: 'alert', level: 'cap', title: `Cap reached: ${over.scope}`, body: `₹${over.spent.toFixed(0)} of ₹${over.cap}` });
    for (const fn of pauseListeners) fn(wp, over.scope);
  }
  return { ...s, paused: pausedScopes(wp, day) };
}

export function isPaused(wp: Workplace, day: string, scope: string): boolean {
  return !!wp.db.prepare('select 1 from settings where key = ?').get(`paused:${day}:${scope}`);
}

export function pausedScopes(wp: Workplace, day: string): string[] {
  const rows = wp.db.prepare('select key from settings where key like ?').all(`paused:${day}:%`) as { key: string }[];
  return rows.map(r => r.key.slice(`paused:${day}:`.length));
}

/** True when this employee may spawn or continue a session right now. */
export function canSpend(wp: Workplace, employeeId: string, day = dayOf()): { ok: boolean; scope?: string } {
  for (const scope of scopesOf(wp, employeeId)) if (isPaused(wp, day, scope)) return { ok: false, scope };
  return { ok: true };
}

/** Remaining employee budget for today, in USD, for the SDK's maxBudgetUsd. */
export function remainingUsd(wp: Workplace, employeeId: string, day = dayOf()): number {
  const s = summary(wp, day);
  const e = wp.org.employees.find(x => x.id === employeeId);
  const employeeLeft = e ? e.budget.inrPerDay - (s.byEmployee[e.id] ?? 0) : 0;
  const companyLeft = s.capInr - s.companyInr;
  return Math.max(0, Math.min(employeeLeft, companyLeft)) / wp.config.usdInr;
}

type PauseListener = (wp: Workplace, scope: string) => void;
const pauseListeners = new Set<PauseListener>();
export function onPause(fn: PauseListener): () => void {
  pauseListeners.add(fn);
  return () => void pauseListeners.delete(fn);
}

// The owner's answer to a cap item either raises today's cap or keeps it.
inbox.onAnswer((wp, item) => {
  if (item.kind !== 'cap' || !item.answer) return;
  const day = String(item.context['day'] ?? dayOf());
  if (item.answer.optionId === 'raise-today') {
    const inr = Number(String(item.answer.note ?? '').replace(/[^\d.]/g, ''));
    if (Number.isFinite(inr) && inr > 0) raiseCapForToday(wp, day, inr);
  }
});

/** Spend by employee over the last N days, for cost-per-item signals. */
export function totalsSince(wp: Workplace, sinceIso: string): Record<string, number> {
  const rows = wp.db.prepare('select employee_id as employeeId, sum(inr) as inr from spend where at >= ? group by employee_id').all(sinceIso) as { employeeId: string; inr: number }[];
  return Object.fromEntries(rows.map(r => [r.employeeId, round(r.inr)]));
}

const round = (n: number): number => Math.round(n * 100) / 100;
