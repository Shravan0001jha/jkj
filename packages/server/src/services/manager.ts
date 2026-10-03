import type { WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as runs from './runs.js';
import * as employees from './employees.js';
import * as spend from './spend.js';
import * as trail from './trail.js';
import * as coo from './coo.js';
import * as reviewWake from './review-wake.js';
import * as dispatch from './dispatch.js';
import { chiefOfStaffId, humanDuration, isAgent, nameOf, rawGet } from './v2-map.js';
import { oneLine } from './one-line.js';
import { rowsJson } from './store.js';
import { log } from '../util/logger.js';

/**
 * Asha first (owner, 2 Oct; LLD §19.6e). Asha, the Chief of Staff, manages every agent and owns stall
 * handling, so operational alerts (stalls, blocks outside the team, idle-with-queued-work, parked and
 * busy notices) go to her: a message into her open session between turns, else a short session; while
 * she is mid-turn they wait for the end of it. The COO gets a bridge item only when she has not acted
 * within 15 minutes, when the call is above her authority (spend, hiring, scope, release), or when she
 * herself is stuck (capped, or the alert is about her). Every 20 minutes while work is active she gets
 * one compact digest.
 *
 * Records in settings: `mgr-alert:<key>` (one per alert key; keys carry the episode), `manager-digest`
 * (when the last digest went).
 */

const MIN = 60_000;
const PREFIX = 'mgr-alert:';

export type Decision = 'spend' | 'hiring' | 'scope' | 'release';

export interface AlertSpec {
  /** One alert per key: put the episode in it (`idle:<itemId>:<since>`). */
  key: string;
  /** The item the alert is about (the COO bridge item points at it; "acted" is judged on it). */
  itemId: string;
  /** The headline, as the COO would see it: "Stalled: <title>". */
  title: string;
  /** One line of what is wrong. */
  body: string;
  /** What Asha is told, when it should say more than "<title>: <body>". */
  text?: string;
  by?: string;
  /** The employee the alert is about: Asha herself goes to the COO. */
  subjectId?: string;
  /** Above Asha's authority: straight to the COO. */
  decision?: Decision;
  /** Information, nothing to act on: never escalated, dropped rather than sent to the COO. */
  notice?: boolean;
}

interface AlertRecord extends AlertSpec {
  at: string;
  state: 'queued' | 'delivered' | 'coo';
  deliveredAt?: string;
  /** `<status>:<statusSince>` of the item when the alert was raised. */
  statusAt: string;
  assigneeAt?: string;
  escalated?: boolean;
  resolved?: boolean;
}

export type AlertResult = 'asha' | 'queued' | 'coo' | 'dropped' | 'duplicate';

const get = (wp: Workplace, key: string): string | undefined =>
  (wp.db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined)?.value;
const put = (wp: Workplace, key: string, value: string): void => void wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(key, value);

function read(wp: Workplace, key: string): AlertRecord | undefined {
  const v = get(wp, PREFIX + key);
  if (!v) return undefined;
  try { return JSON.parse(v) as AlertRecord; } catch { return undefined; }
}
const write = (wp: Workplace, rec: AlertRecord): void => put(wp, PREFIX + rec.key, JSON.stringify(rec));

function all(wp: Workplace): AlertRecord[] {
  const rows = wp.db.prepare('select value from settings where key like ?').all(`${PREFIX}%`) as { value: string }[];
  const out: AlertRecord[] = [];
  for (const r of rows) { try { out.push(JSON.parse(r.value) as AlertRecord); } catch { /* skip a bad row */ } }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
}

const escalateMs = (wp: Workplace): number => wp.config.managerEscalateMinutes * MIN;
const statusKey = (w: WorkItem | undefined): string => (w ? `${w.status ?? ''}:${w.statusSince ?? ''}` : '');

/** Asha's id, when she is an agent the Workplace can run. */
export function ashaId(wp: Workplace): string | undefined {
  const id = chiefOfStaffId(wp);
  return id && isAgent(wp, id) ? id : undefined;
}

/** Why Asha cannot take alerts now (she is capped or stuck), or null. Mid-turn is not stuck: it waits. */
export function ashaStuck(wp: Workplace, nowMs = Date.now()): string | null {
  const id = ashaId(wp);
  if (!id) return 'there is no Chief of Staff to take it';
  const budget = spend.canSpend(wp, id, spend.dayOf(new Date(nowMs)));
  if (!budget.ok) return `Asha is paused by the ${budget.scope} spend cap`;
  const open = employees.openSession(id);
  if (!open) {
    const cap = employees.employee(wp, id).budget.concurrentSessions;
    const live = employees.sessionsOf(id).filter(s => employees.isLive(s.agentId)).length;
    if (live >= cap) return `Asha is at her concurrency cap (${cap})`;
    return null;
  }
  const a = runs.getRunAgent(open.agentId);
  if (a?.approval) {
    const idle = runs.idleMs(open.agentId, nowMs);
    if (idle !== null && idle > escalateMs(wp)) return `Asha has waited on a tool approval for ${humanDuration(idle)}`;
  }
  return null;
}

/** Raise an operational alert: Asha first; the COO for decisions above her, or when she is stuck. */
export function alert(wp: Workplace, spec: AlertSpec, nowMs = Date.now()): AlertResult {
  if (read(wp, spec.key)) return 'duplicate';
  // A weekly-pace hold is a deliberate stop (pace.ts, owner 3 Oct): idle and stalled work under it is
  // expected, not news. Nothing is raised until the hold lifts; real decisions still go through.
  const pace = wp.db.prepare("select value from settings where key = 'pace:until'").get() as { value: string } | undefined;
  if (pace && Date.parse(pace.value) > nowMs && (!spec.decision || spec.decision === 'spend')) {
    log.info('manager', `${spec.key}: held (weekly-pace hold until ${pace.value})`);
    return 'dropped';
  }
  const w = rawGet(wp, spec.itemId);
  const asha = ashaId(wp);
  const rec: AlertRecord = {
    ...spec, at: new Date(nowMs).toISOString(), state: 'queued', statusAt: statusKey(w),
    ...(w?.employeeId ? { assigneeAt: w.employeeId } : {}),
  };
  const toCoo = spec.decision ? `a ${spec.decision} decision, above Asha's authority`
    : spec.subjectId && spec.subjectId === (asha ?? chiefOfStaffId(wp)) ? 'it is about Asha herself'
    : ashaStuck(wp, nowMs);
  if (toCoo) {
    write(wp, { ...rec, state: 'coo' });
    if (spec.notice && !spec.decision) { log.info('manager', `${spec.key}: notice dropped (${toCoo})`); return 'dropped'; }
    coo.notifyStall(wp, { itemId: spec.itemId, title: spec.title, body: `${spec.body} To the COO: ${toCoo}.`, by: spec.by ?? 'workplace' });
    log.info('manager', `${spec.key}: to the COO (${toCoo})`);
    return 'coo';
  }
  write(wp, rec);
  deliver(wp, nowMs);
  return read(wp, spec.key)?.state === 'delivered' ? 'asha' : 'queued';
}

/** Every alert record, oldest first (tests, the digest). */
export function list(wp: Workplace): Readonly<AlertRecord>[] {
  return all(wp);
}

/** Is there an alert raised for this item at or after `sinceIso` (a flag and a block in the same moment are told once)? */
export function raisedSince(wp: Workplace, itemId: string, sinceIso: string): boolean {
  const since = Date.parse(sinceIso) - 5_000;
  return all(wp).some(r => r.itemId === itemId && Date.parse(r.at) >= since);
}

/** The source says the condition is over (the dispatcher's idle episode ended): never escalated. */
export function resolve(wp: Workplace, key: string): void {
  const rec = read(wp, key);
  if (rec && !rec.resolved) write(wp, { ...rec, resolved: true });
}

const INTRO = 'Manager alerts: you own stall handling for the team. For each one act now (restart it, reassign it, unblock it, ' +
  'chase whoever it waits on, or escalate with a recommendation if it is above you) and say what you did with item_comment on the item. ' +
  'Unanswered alerts go to the COO after 15 minutes.';

function compose(list: AlertRecord[]): string {
  const lines = list.map(r => r.key.startsWith('digest:') ? r.text ?? r.body : `- ${r.notice ? '(FYI) ' : ''}${r.text ?? `${r.title}: ${r.body}`} [${r.itemId}]`);
  const alerts = list.some(r => !r.key.startsWith('digest:'));
  return [alerts ? INTRO : '', ...lines].filter(Boolean).join('\n');
}

/**
 * Hand Asha every queued alert in one go: a message into her open session between turns, else a short
 * session. Mid-turn (or an approval pending, or an assignment queued for her turn's end) they wait.
 * Returns how many were delivered.
 */
export function deliver(wp: Workplace, nowMs = Date.now()): number {
  const asha = ashaId(wp);
  if (!asha) return 0;
  const queued = all(wp).filter(r => r.state === 'queued');
  if (!queued.length) return 0;
  const text = compose(queued);
  const open = employees.openSession(asha);
  try {
    if (open) {
      const a = runs.getRunAgent(open.agentId);
      if (!a || a.status === 'running' || a.approval || employees.hasPendingSwitch(open.agentId)) return 0;
      runs.sendMessage(open.agentId, text, [], { from: 'workplace' });
    } else {
      // Notices never start a session of their own: they ride along with the next alert or digest.
      if (!queued.some(r => !r.notice || r.key.startsWith('digest:'))) return 0;
      if (ashaStuck(wp, nowMs)) return 0;
      employees.talk(wp, asha, text, [], { autonomous: true });
    }
  } catch (err) {
    log.warn('manager', `could not reach Asha: ${err instanceof Error ? err.message : err}`);
    return 0;
  }
  const at = new Date(nowMs).toISOString();
  for (const r of queued) {
    write(wp, { ...r, state: 'delivered', deliveredAt: at });
    if (rawGet(wp, r.itemId)) trail.record(wp, { itemId: r.itemId, by: 'workplace', kind: 'stall', text: `Told Asha: ${r.title}` });
  }
  log.info('manager', `told Asha ${queued.length} alert(s): ${queued.map(r => r.key).join(', ')}`);
  return queued.length;
}

/** Since the alert: the item moved (status or assignee), Asha did something on it, real work landed on it, someone commented, or the source resolved it. */
export function acted(wp: Workplace, rec: AlertRecord): boolean {
  if (rec.resolved) return true;
  const w = rawGet(wp, rec.itemId);
  if (!w) return true;
  if (statusKey(w) !== rec.statusAt || (w.employeeId ?? undefined) !== rec.assigneeAt) return true;
  // Asha doing anything on it, or real work on it by anyone (commits, tests, a move); a points or
  // field tweak is not acting on a stall.
  const asha = chiefOfStaffId(wp) ?? '';
  const act = wp.db.prepare("select 1 from activity where item_id = ? and at > ? and kind != 'stall' and (by = ? or kind in ('commit', 'test', 'status', 'assigned', 'reopen', 'merged')) limit 1").get(rec.itemId, rec.at, asha);
  if (act) return true;
  const said = wp.db.prepare("select 1 from comments where item_id = ? and at > ? and by != 'workplace' limit 1").get(rec.itemId, rec.at);
  return !!said;
}

/** Alerts Asha has not acted on within the window go to the COO, once each. Returns their keys. */
export function escalate(wp: Workplace, nowMs = Date.now()): string[] {
  const out: string[] = [];
  for (const rec of all(wp)) {
    if (rec.state === 'coo' || rec.notice || rec.escalated || rec.resolved) continue;
    if (nowMs - Date.parse(rec.at) <= escalateMs(wp)) continue;
    if (acted(wp, rec)) { write(wp, { ...rec, resolved: true }); continue; }
    const mins = wp.config.managerEscalateMinutes;
    coo.notifyStall(wp, {
      itemId: rec.itemId, title: rec.title,
      body: `${rec.body} Asha has not acted on it in ${mins} min${rec.state === 'queued' ? ' (she has not been free to take it)' : ''}.`,
      by: rec.by ?? 'workplace',
    });
    write(wp, { ...rec, escalated: true });
    if (rawGet(wp, rec.itemId)) trail.record(wp, { itemId: rec.itemId, by: 'workplace', kind: 'stall', text: `Escalated to the COO: Asha had not acted in ${mins} min` });
    log.warn('manager', `${rec.key}: escalated to the COO`);
    out.push(rec.key);
  }
  return out;
}

/* ---------- the digest ---------- */

const quote = (t: string): string => `"${t}"`;

/** The digest's text from the current state, or null when there is nothing to act on. */
export function digestText(wp: Workplace, nowMs = Date.now()): string | null {
  const idle: string[] = [];
  for (const e of wp.org.employees) {
    if (e.virtual) continue;
    const reviews = reviewWake.queued(wp, e.id);
    const stories = dispatch.queue(wp, e.id);
    const n = reviews.length + stories.length;
    if (!n) continue;
    const open = employees.openSession(e.id);
    const a = open ? runs.getRunAgent(open.agentId) : undefined;
    if (a && (a.status === 'running' || a.approval)) continue;
    const titles = [...reviews.map(id => `review ${quote(rawGet(wp, id)?.title ?? id)}`), ...stories.map(w => quote(w.title))].slice(0, 3).join(', ');
    const why = dispatch.lastReason(wp, e.id) ?? dispatch.busyReason(wp, e.id, nowMs);
    idle.push(`${e.name} (${n} queued: ${titles})${why ? `: ${why}` : ''}`);
  }
  const reviewMs = wp.config.stallReviewMinutes * MIN;
  const stale = rowsJson<WorkItem>(wp.db.prepare("select json from work where status = 'in-review'").all())
    .filter(w => !w.mergedInto && nowMs - Date.parse(w.statusSince ?? w.updatedAt) > reviewMs)
    .map(w => `${quote(w.title)} In review ${humanDuration(nowMs - Date.parse(w.statusSince ?? w.updatedAt))} with ${nameOf(wp, w.reviewerId)}`);
  const blocked = rowsJson<WorkItem>(wp.db.prepare("select json from work where status = 'blocked'").all())
    .filter(w => !w.mergedInto)
    .map(w => `${quote(w.title)} (${nameOf(wp, w.employeeId)}) waiting on ${nameOf(wp, w.waitingOn)}: ${oneLine(w.blockedReason ?? 'no reason given', 100).summary}`);
  if (!idle.length && !stale.length && !blocked.length) return null;
  const section = (head: string, lines: string[]): string => (lines.length ? `${head}\n${lines.map(l => `- ${l}`).join('\n')}` : '');
  return [
    `Manager digest (every ${wp.config.managerDigestMinutes} min while work is active): act on what needs you, and say what you did with item_comment on the item.`,
    section('Idle with queued focus work:', idle),
    section('Stale reviews:', stale),
    section('Blocked:', blocked),
  ].filter(Boolean).join('\n');
}

/** Any work moving or waiting: In progress, In review, Blocked, or focus work queued for someone. */
function workActive(wp: Workplace): boolean {
  if (wp.db.prepare("select 1 from work where status in ('in-progress', 'in-review', 'blocked') limit 1").get()) return true;
  return wp.org.employees.some(e => !e.virtual && dispatch.queue(wp, e.id).length > 0);
}

/** At most every 20 minutes while work is active, one digest to Asha. Returns its text, or null. */
export function digest(wp: Workplace, nowMs = Date.now()): string | null {
  const last = get(wp, 'manager-digest');
  if (last && nowMs - Date.parse(last) < wp.config.managerDigestMinutes * MIN) return null;
  if (!workActive(wp)) return null;
  const stuck = ashaStuck(wp, nowMs);
  if (stuck) { log.info('manager', `no digest: ${stuck}`); return null; }
  const text = digestText(wp, nowMs);
  if (!text) return null;
  const at = new Date(nowMs).toISOString();
  put(wp, 'manager-digest', at);
  write(wp, { key: `digest:${at}`, itemId: '', title: 'Manager digest', body: text, text, notice: true, at, state: 'queued', statusAt: '' });
  deliver(wp, nowMs);
  return text;
}

/** Drop records older than two days (keys carry the episode; old ones only dedupe what can no longer recur). */
function prune(wp: Workplace, nowMs: number): void {
  const cutoff = nowMs - 2 * 24 * 60 * MIN;
  for (const r of all(wp)) {
    if (Date.parse(r.at) < cutoff && (r.state !== 'queued' || r.notice)) wp.db.prepare('delete from settings where key = ?').run(PREFIX + r.key);
  }
}

/** One minute's work: deliver what waits, escalate what Asha left, the digest when due. */
export function tick(wp: Workplace, nowMs = Date.now()): void {
  deliver(wp, nowMs);
  escalate(wp, nowMs);
  digest(wp, nowMs);
  prune(wp, nowMs);
}

/** Wire it: Asha's turn ends and session closes deliver what waits; a tick every minute. Returns stop(). */
export function startManager(wp: Workplace): () => void {
  let stopped = false;
  let scheduled = false;
  const soon = (): void => {
    if (stopped || scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (stopped) return;
      try { deliver(wp); } catch (err) { log.warn('manager', err instanceof Error ? err.message : String(err)); }
    });
  };
  const offRuns = runs.onRunEvent(({ agent }) => {
    if (agent?.employeeId && agent.employeeId === ashaId(wp) && agent.status === 'waiting' && !agent.approval) soon();
  });
  const offClosed = employees.onSessionClosed((_wp, session, reason) => {
    if (reason !== 'shutdown' && session.employeeId === ashaId(wp)) soon();
  });
  const timer = setInterval(() => {
    if (stopped) return;
    try { tick(wp); } catch (err) { log.warn('manager', `tick: ${err instanceof Error ? err.message : err}`); }
  }, MIN);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
    offRuns();
    offClosed();
  };
}
