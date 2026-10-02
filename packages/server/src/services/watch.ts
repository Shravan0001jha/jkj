import type { StallRule, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as runs from './runs.js';
import * as employees from './employees.js';
import * as trail from './trail.js';
import * as items from './items.js';
import * as coo from './coo.js';
import * as cos from './cos.js';
import * as spend from './spend.js';
import { chiefOfStaffId, isAgent, levelOf, nameOf, rawGet, statusFromState } from './v2-map.js';
import { log } from '../util/logger.js';

/**
 * The event-driven stall detector (HLD D21, LLD §19.6). No sweep: every item change, activity row,
 * comment and session event re-arms that item's deadline, and the deadline firing is the stall.
 * `evaluate` decides from the data alone (the timer is only a hint to look); `check` acts once per
 * episode; `startWatch` wires the timers.
 */

export interface Evaluation {
  rule: StallRule;
  /** When the clock for this rule started: entering Ready, or the last real activity. */
  since: string;
  dueAt: number;
  stalled: boolean;
}

const MIN = 60_000;

export function thresholds(wp: Workplace): Record<StallRule, number> {
  return { 'not-started': wp.config.stallReadyMinutes * MIN, idle: wp.config.stallIdleMinutes * MIN, unreviewed: wp.config.stallReviewMinutes * MIN };
}

/** The open session working on this item, if any. */
function sessionOn(w: WorkItem): employees.Session | undefined {
  const open = w.employeeId ? employees.openSession(w.employeeId) : undefined;
  return open && open.assignmentId === w.id ? open : undefined;
}

/** The last real activity: the item's own change, its activity and comments, its session's last event. */
export function lastActivity(wp: Workplace, w: WorkItem): number {
  let last = Math.max(Date.parse(w.updatedAt), trail.lastActivityAt(wp, w.id));
  const s = sessionOn(w);
  if (s) {
    const idle = runs.idleMs(s.agentId);
    if (idle !== null) last = Math.max(last, Date.now() - idle);
  }
  return last;
}

export function evaluate(wp: Workplace, w: WorkItem, nowMs = Date.now()): Evaluation | null {
  if (levelOf(w) === 'epic' || w.mergedInto || !isAgent(wp, w.employeeId)) return null;
  const t = thresholds(wp);
  const status = w.status ?? statusFromState(w, w.state).status;
  const at = (rule: StallRule, sinceMs: number): Evaluation => ({ rule, since: new Date(sinceMs).toISOString(), dueAt: sinceMs + t[rule], stalled: nowMs >= sinceMs + t[rule] });
  if (status === 'ready') {
    if (sessionOn(w)) return null;
    return at('not-started', Date.parse(w.statusSince ?? w.updatedAt));
  }
  if (status === 'in-progress') {
    const s = sessionOn(w);
    // A turn that is running is never idle; look again one idle window from now.
    if (s && runs.getRunAgent(s.agentId)?.status === 'running') return { rule: 'idle', since: new Date(nowMs).toISOString(), dueAt: nowMs + t.idle, stalled: false };
    return at('idle', lastActivity(wp, w));
  }
  if (status === 'in-review') return at('unreviewed', Math.max(Date.parse(w.statusSince ?? w.updatedAt), lastActivity(wp, w)));
  return null;
}

export type StallAction = 'started' | 'backlog' | 'coo-notified' | 'resumed';

const episodeKey = (id: string): string => `stall:${id}`;
const handled = (wp: Workplace, id: string, episode: string): boolean =>
  (wp.db.prepare('select value from settings where key = ?').get(episodeKey(id)) as { value: string } | undefined)?.value === episode;

/** Evaluate one item now and act once per episode. Null when it is not stalled (or already handled). */
export function check(wp: Workplace, id: string, nowMs = Date.now()): { rule: StallRule; action: StallAction } | null {
  const w = rawGet(wp, id);
  if (!w) return null;
  const ev = evaluate(wp, w, nowMs);
  if (!ev?.stalled) return null;
  const episode = `${ev.rule}:${ev.since}`;
  if (handled(wp, id, episode)) return null;
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(episodeKey(id), episode);
  const action = ev.rule === 'not-started' ? notStarted(wp, w, nowMs) : ev.rule === 'idle' ? idle(wp, w, ev, nowMs) : unreviewed(wp, w, ev, nowMs);
  log.info('watch', `${id} ${ev.rule}: ${action}`);
  return { rule: ev.rule, action };
}

const asha = (wp: Workplace): string => chiefOfStaffId(wp) ?? 'workplace';
const mins = (wp: Workplace, rule: StallRule): number => Math.round(thresholds(wp)[rule] / MIN);

/** Ready for 15 minutes: Asha starts it (in focus, assignee free, within budget) or parks it with the reason. */
function notStarted(wp: Workplace, w: WorkItem, nowMs: number): StallAction {
  const name = nameOf(wp, w.employeeId);
  const open = employees.openSession(w.employeeId!);
  let reason: string | null = null;
  if (!items.inFocus(wp, w)) reason = 'not in focus';
  else if (open) reason = `${name} is busy on ${open.assignmentId ? rawGet(wp, open.assignmentId)?.title ?? open.assignmentId : 'another session'}`;
  else if (!spend.canSpend(wp, w.employeeId!, spend.dayOf(new Date(nowMs))).ok) reason = `${name} is paused by the spend cap`;
  const ready = mins(wp, 'not-started');
  if (!reason) {
    try {
      employees.assign(wp, w.id);
      trail.record(wp, { itemId: w.id, by: asha(wp), kind: 'stall', text: `Started by Asha: Ready for ${ready} min and in focus` });
      coo.notifyStall(wp, { itemId: w.id, title: `Started: ${w.title}`, body: `Ready for ${ready} min; Asha started ${name} on it.`, by: asha(wp) });
      return 'started';
    } catch (err) {
      reason = `could not start: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  items.update(wp, w.id, { status: 'backlog', note: `Moved to Backlog by Asha: ${reason}` }, asha(wp));
  trail.record(wp, { itemId: w.id, by: asha(wp), kind: 'stall', text: `Moved to Backlog: ${reason} (Ready for ${ready} min)` });
  coo.notifyStall(wp, { itemId: w.id, title: `Parked: ${w.title}`, body: `Ready for ${ready} min and not started; moved to Backlog: ${reason}.`, by: asha(wp) });
  return 'backlog';
}

/** In progress with no activity: the COO now; the agent asked to flag itself; Asha's resume if the COO is away. */
function idle(wp: Workplace, w: WorkItem, ev: Evaluation, nowMs: number): StallAction {
  const name = nameOf(wp, w.employeeId);
  const m = Math.floor((nowMs - Date.parse(ev.since)) / MIN);
  trail.record(wp, { itemId: w.id, by: 'workplace', kind: 'stall', text: `No activity for ${mins(wp, 'idle')} min (last at ${ev.since.slice(11, 16)} UTC)` });
  coo.notifyStall(wp, { itemId: w.id, title: `Stalled: ${w.title}`, body: `${name}'s ${levelOf(w)} has had no activity for ${m} min (since ${ev.since.slice(11, 16)} UTC).`, by: 'workplace' });
  const s = sessionOn(w);
  if (s) {
    try {
      runs.sendMessage(s.agentId, `No activity on "${w.title}" for ${mins(wp, 'idle')} minutes. If you are stuck, call flag_stall with why (and who you are waiting on); otherwise carry on and post a one-line status.`, [], { from: 'workplace' });
    } catch (err) {
      log.warn('watch', `nudge ${w.id}: ${err instanceof Error ? err.message : err}`);
    }
    return 'coo-notified';
  }
  if (!coo.presence(wp).online) {
    const key = `stall-resume:${w.id}`;
    const last = (wp.db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined)?.value;
    const why = cos.whyWaiting(wp, w, spend.dayOf(new Date(nowMs)));
    if (!why && (!last || nowMs - Date.parse(last) > 60 * MIN)) {
      try {
        employees.assign(wp, w.id);
        wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(key, new Date(nowMs).toISOString());
        trail.record(wp, { itemId: w.id, by: asha(wp), kind: 'stall', text: 'Asha resumed it in a fresh session (the COO is offline)' });
        return 'resumed';
      } catch (err) {
        trail.record(wp, { itemId: w.id, by: asha(wp), kind: 'stall', text: `Asha could not resume it: ${err instanceof Error ? err.message : String(err)}` });
      }
    } else if (why) {
      trail.record(wp, { itemId: w.id, by: asha(wp), kind: 'stall', text: `Not resumed: ${why}` });
    }
  }
  return 'coo-notified';
}

function unreviewed(wp: Workplace, w: WorkItem, ev: Evaluation, nowMs: number): StallAction {
  const m = Math.floor((nowMs - Date.parse(ev.since)) / MIN);
  const reviewer = nameOf(wp, w.reviewerId);
  trail.record(wp, { itemId: w.id, by: 'workplace', kind: 'stall', text: `In review for ${m} min with nothing from ${reviewer}` });
  coo.notifyStall(wp, { itemId: w.id, title: `Unreviewed: ${w.title}`, body: `In review for ${m} min; the reviewer is ${reviewer}.`, by: 'workplace' });
  return 'coo-notified';
}

/** An agent flags its own stall (tool `flag_stall`): the COO hears at once; Blocked when it names who it waits on. */
export function flag(wp: Workplace, id: string, spec: { by: string; reason: string; waitingOn?: string; recommendation?: string }): void {
  const w = rawGet(wp, id);
  if (!w) throw new Error(`No item ${id}`);
  trail.record(wp, { itemId: id, by: spec.by, kind: 'stall', text: `Flagged by ${nameOf(wp, spec.by)}: ${spec.reason}` });
  coo.notifyStall(wp, { itemId: id, title: `Flagged: ${w.title}`, body: `${nameOf(wp, spec.by)} is stuck: ${spec.reason}${spec.waitingOn ? ` (waiting on ${nameOf(wp, spec.waitingOn)})` : ''}.`, by: spec.by });
  if (spec.waitingOn && w.status !== 'blocked') {
    const status = w.status ?? 'ready';
    if (status === 'ready' || status === 'in-progress' || status === 'in-review') {
      items.update(wp, id, { status: 'blocked', blockedReason: spec.reason, waitingOn: spec.waitingOn, ...(spec.recommendation ? { recommendation: spec.recommendation } : {}) }, spec.by);
    }
  }
}

/* ---------- the timers ---------- */


/** Arm a deadline per open item; re-arm on every event about it. Returns stop(). */
export function startWatch(wp: Workplace): () => void {
  const timers = new Map<string, NodeJS.Timeout>();
  const lastRun = new Map<string, number>();
  let stopped = false;

  const arm = (id: string): void => {
    if (stopped) return;
    const prev = timers.get(id);
    if (prev) { clearTimeout(prev); timers.delete(id); }
    const w = rawGet(wp, id);
    if (!w) return;
    const ev = evaluate(wp, w);
    if (!ev) return;
    if (ev.stalled && handled(wp, id, `${ev.rule}:${ev.since}`)) return; // acted on; the next event re-arms it
    const delay = Math.max(0, ev.dueAt - Date.now()) + 25;
    const timer = setTimeout(() => {
      timers.delete(id);
      try { check(wp, id); } catch (err) { log.warn('watch', `${id}: ${err instanceof Error ? err.message : err}`); }
      arm(id);
    }, Math.min(delay, 2 ** 31 - 1));
    timer.unref?.();
    timers.set(id, timer);
  };

  const off = wp.on(event => {
    if (event.type === 'work.updated') arm(event.item.id);
    else if (event.type === 'activity.recorded' && event.activity.itemId && event.activity.kind !== 'stall') arm(event.activity.itemId);
    else if (event.type === 'item.comment') arm(event.comment.itemId);
  });
  const offRuns = runs.onRunEvent(({ agent }) => {
    const id = agent?.assignmentId;
    if (!id) return;
    const now = Date.now();
    if (now - (lastRun.get(id) ?? 0) < 1000) return;
    lastRun.set(id, now);
    arm(id);
  });

  const rows = wp.db.prepare("select id from work where status in ('ready', 'in-progress', 'in-review')").all() as { id: string }[];
  for (const r of rows) arm(r.id);

  return () => {
    stopped = true;
    off();
    offRuns();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}
