import { createHash } from 'node:crypto';
import type { EmployeeSignals, HealthSignals } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as runs from './runs.js';
import * as work from './work.js';
import * as spend from './spend.js';
import * as inbox from './inbox.js';
import * as employees from './employees.js';
import { lint } from './ownership.js';

/**
 * Capacity and health (HLD D14): cheap signals per employee and charter,
 * honest stall and loop detection, and the org signals that justify a
 * proposal. Nothing here changes the org by itself.
 */

export const STALL_MS = 10 * 60 * 1000;
export const LOOP_REPEATS = 5;

export interface StallCheck {
  agentId: string;
  employeeId: string;
  reason: 'idle' | 'loop';
}

/** Which running sessions are stalled or looping right now. Pure: no side effects. */
export function detectStalls(nowMs = Date.now()): StallCheck[] {
  const out: StallCheck[] = [];
  for (const s of employees.allSessions()) {
    const agent = runs.getRunAgent(s.agentId);
    if (!agent || agent.status !== 'running') continue;
    const idle = runs.idleMs(s.agentId, nowMs) ?? 0;
    if (idle > STALL_MS) { out.push({ agentId: s.agentId, employeeId: s.employeeId, reason: 'idle' }); continue; }
    const last = runs.lastTools(s.agentId, LOOP_REPEATS);
    if (last.length === LOOP_REPEATS && new Set(last.map(t => hash(`${t.label}\n${t.text}`))).size === 1) {
      out.push({ agentId: s.agentId, employeeId: s.employeeId, reason: 'loop' });
    }
  }
  return out;
}

const stalledOnce = new Set<string>();
/** How long a stalled session gets to write its handoff before it is closed. Tests shorten it. */
export let handoffWaitMs = 30_000;
export function setHandoffWait(ms: number): void { handoffWaitMs = ms; }
const parkedOnce = new Set<string>();
export const PARKED_MS = 2 * 60 * 1000;

/**
 * A tool call parked on a permission prompt is "needs you", and if nobody is
 * looking at the page the owner must hear about it: one alert per prompt.
 */
export function handleParkedApprovals(wp: Workplace, nowMs = Date.now()): string[] {
  const alerted: string[] = [];
  for (const s of employees.allSessions()) {
    const agent = runs.getRunAgent(s.agentId);
    const approval = agent?.approval;
    if (!approval || nowMs - new Date(approval.requestedAt).getTime() < PARKED_MS) continue;
    if (parkedOnce.has(approval.id)) continue;
    parkedOnce.add(approval.id);
    const emp = wp.org.employees.find(e => e.id === s.employeeId);
    wp.emit({ type: 'alert', level: 'needs-you', title: `${emp?.name ?? s.employeeId} is waiting for a tool approval`, body: `${approval.tool}: ${approval.input.slice(0, 120)} — open the employee page to allow or deny.` });
    alerted.push(approval.id);
  }
  return alerted;
}

/** Interrupt each stalled session once, mark the employee blocked, and ask the owner. */
export async function handleStalls(wp: Workplace, nowMs = Date.now()): Promise<StallCheck[]> {
  const found = detectStalls(nowMs);
  for (const s of found) {
    if (stalledOnce.has(s.agentId)) continue;
    stalledOnce.add(s.agentId);
    const emp = wp.org.employees.find(e => e.id === s.employeeId);
    runs.note(s.agentId, 'Stalled', s.reason === 'idle' ? 'No activity for 10 minutes; the session is ended.' : 'The same tool call repeated 5 times; interrupted and ended.');
    // The session is ended, not left open (QA B4): the silent or looping turn is interrupted, the run
    // is asked for its handoff (briefly; it may be as silent as before), then closed either way.
    await runs.interruptRun(s.agentId).catch(() => {});
    await employees.endSession(wp, s.agentId, handoffWaitMs, true).catch(() => {});
    employees.setState(wp, s.employeeId, 'blocked');
    inbox.raise(wp, {
      kind: 'question',
      title: `${emp?.name ?? s.employeeId} is ${s.reason === 'idle' ? 'stalled' : 'looping'}`,
      body: s.reason === 'idle'
        ? 'The session did nothing for 10 minutes and was ended; the next one starts from the handoff. Tell it how to proceed, or leave it to the Chief of Staff\'s routine.'
        : 'The session repeated the same tool call five times and was ended. Tell it what to try instead, or leave it to the Chief of Staff\'s routine.',
      raisedBy: s.employeeId,
      context: { agentId: s.agentId, reason: s.reason },
      dedupeKey: `stall:${s.agentId}`,
    });
    wp.emit({ type: 'alert', level: 'blocked', title: `${emp?.name ?? s.employeeId} ${s.reason === 'idle' ? 'stalled' : 'looping'}`, body: 'Interrupted; a question is in the Inbox.' });
  }
  return found;
}

/* ---------- signals ---------- */

export function signals(wp: Workplace, nowMs = Date.now()): HealthSignals {
  const since = new Date(nowMs - 7 * 24 * 3600 * 1000).toISOString();
  const all = work.list(wp, { kind: 'assignment' });
  const recent = all.filter(a => a.updatedAt >= since);
  const costs = spend.totalsSince(wp, since);

  const perEmployee: Record<string, EmployeeSignals> = {};
  for (const e of wp.org.employees) {
    const mine = recent.filter(a => a.employeeId === e.id);
    const done = mine.filter(a => a.state === 'done' && a.history.some(h => h.to === 'done' && h.at >= since)).length;
    const reviews = mine.reduce((n, a) => n + a.history.filter(h => h.to === 'review' && h.at >= since).length, 0);
    const sentBack = mine.reduce((n, a) => n + a.history.filter(h => h.from === 'review' && h.to === 'building' && h.at >= since).length, 0);
    perEmployee[e.id] = {
      throughput7d: done,
      rework7d: sentBack,
      falseDoneRate7d: reviews === 0 ? 0 : round(sentBack / reviews),
      costPerDoneInr: done === 0 ? 0 : round((costs[e.id] ?? 0) / done),
    };
  }

  const openStates = new Set(['proposed', 'planned', 'building', 'review', 'blocked']);
  const charters: HealthSignals['charters'] = {};
  for (const c of wp.org.charters.keys()) {
    charters[c] = {
      queue: all.filter(a => a.charterId === c && openStates.has(a.state)).length,
      contextLimitHits7d: Number((wp.db.prepare("select count(*) as n from sessions where status = 'context-limit' and started_at >= ? and employee_id in (select value from json_each(?))").get(since, JSON.stringify(wp.org.employees.filter(e => e.charterIds.includes(c)).map(e => e.id))) as { n: number }).n),
    };
  }

  // Two charters block each other when each has an assignment blocked by the other, by note.
  const blockedBy = new Map<string, Set<string>>();
  for (const a of all.filter(x => x.state === 'blocked')) {
    const note = a.history.at(-1)?.note ?? '';
    for (const other of wp.org.charters.keys()) {
      if (other !== a.charterId && a.charterId && new RegExp(`\\b${other}\\b`).test(note)) {
        blockedBy.set(a.charterId, new Set([...(blockedBy.get(a.charterId) ?? []), other]));
      }
    }
  }
  const blockingPairs: [string, string][] = [];
  for (const [a, others] of blockedBy) for (const b of others) if (blockedBy.get(b)?.has(a) && a < b) blockingPairs.push([a, b]);

  const triggers: HealthSignals['proposalTriggers'] = [];
  for (const [c, s] of Object.entries(charters)) {
    if (s.queue > 5) triggers.push({ code: 'queue', subject: c, message: `${s.queue} open assignments; consider a hire or a split` });
    if (s.contextLimitHits7d >= 3) triggers.push({ code: 'context', subject: c, message: `${s.contextLimitHits7d} context-limit hits this week; the charter may be too broad` });
  }
  for (const [a, b] of blockingPairs) triggers.push({ code: 'blocking', subject: `${a}+${b}`, message: 'these charters keep blocking each other; consider a merge or a clearer boundary' });
  for (const f of lint(wp.org, wp.requirements()).filter(f => f.code === 'orphan' || f.code === 'unowned-requirement')) {
    triggers.push({ code: f.code, subject: f.subject, message: f.message });
  }

  return {
    employees: perEmployee,
    charters,
    blockingPairs,
    proposalTriggers: triggers,
    stalled: detectStalls(nowMs).map(s => ({ sessionId: s.agentId, employeeId: s.employeeId, reason: s.reason, since: new Date(nowMs).toISOString() })),
  };
}

const hash = (s: string): string => createHash('sha1').update(s).digest('hex');
const round = (n: number): number => Math.round(n * 100) / 100;
