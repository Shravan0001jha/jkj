import type { Activity, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as runs from './runs.js';
import * as employees from './employees.js';
import * as items from './items.js';
import { isUnrouted, unrouted as unroutedItems } from './unrouted.js';
import { openStartsAfter } from './lifecycle.js';
import * as spend from './spend.js';
import * as trail from './trail.js';
import * as manager from './manager.js';
import * as reviewWake from './review-wake.js';
import * as replyDelivery from './reply-delivery.js';
import * as floor from './floor.js';
import * as halt from './halt.js';
import { chiefOfStaffId, epicOf, isAgent, levelOf, nameOf, rawGet } from './v2-map.js';
import { rowJson, rowsJson } from './store.js';
import { log } from '../util/logger.js';

/**
 * The dispatcher (outage 2 Oct; LLD §19.6d). Work used to be pushed only by item events, so when an
 * employee became free nothing pulled their next item: the watcher parked Dev's story in Backlog
 * because he was busy, he finished 30 minutes later, and everyone sat in "waiting" for two hours.
 *
 * Now, when an employee becomes free (a turn ends, a session closes, an item of theirs leaves In
 * progress) and on a sweep every two minutes:
 * - their queued reviews go first (through review-wake), then their next Ready/Backlog story or task
 *   (routed-to-lead first, then focus order, then the rest; rank, age), started with `employees.assign`
 *   on its own branch;
 * - spend and concurrency caps are respected; held Backlog and Backlog outside the focus never start;
 * - In review items nobody is reviewing (from before review-wake, or a review session that died)
 *   are woken once per episode;
 * - an employee left idle is no longer reported from here: the stall chain (stall-chain.ts) tells the
 *   lead, Asha, the COO and the owner in turn (LLD-rework-2026-10 W2 §6).
 *
 * Settings: `stale-review:<itemId>` = the episode requeued, `hold-migration` = the boot migration ran.
 */

const MIN = 60_000;

export interface DispatchResult {
  action: 'review' | 'story' | 'none' | 'skipped';
  itemId?: string;
  reason?: string;
}

const get = (wp: Workplace, key: string): string | undefined =>
  (wp.db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined)?.value;
const put = (wp: Workplace, key: string, value: string): void => void wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(key, value);
const del = (wp: Workplace, key: string): void => void wp.db.prepare('delete from settings where key = ?').run(key);

/** The last reason each employee could not be given work: the idle alert says it. Per Workplace. */
const reasons = new WeakMap<Workplace, Map<string, string>>();
const reasonsOf = (wp: Workplace): Map<string, string> => {
  let m = reasons.get(wp);
  if (!m) { m = new Map(); reasons.set(wp, m); }
  return m;
};

const agents = (wp: Workplace): string[] => wp.org.employees.filter(e => !e.virtual).map(e => e.id);

/** Their own stories and tasks In progress. */
function inProgress(wp: Workplace, employeeId: string): WorkItem[] {
  return rowsJson<WorkItem>(wp.db.prepare("select json from work where employee_id = ? and status = 'in-progress' order by created_at").all(employeeId))
    .filter(w => levelOf(w) !== 'epic' && !w.mergedInto);
}

/**
 * Why this employee cannot take new work now, or null when free. Busy is not idle: a running turn, a
 * pending approval, an assignment queued for the turn's end, the owner talking, or work In progress.
 */
export function busyReason(wp: Workplace, employeeId: string, nowMs = Date.now()): string | null {
  const name = nameOf(wp, employeeId);
  const open = employees.openSession(employeeId);
  if (open) {
    const a = runs.getRunAgent(open.agentId);
    if (!a || a.status === 'running') return `${name} is mid-turn`;
    if (a.approval) return `${name} is waiting on a tool approval`;
    if (employees.hasPendingSwitch(open.agentId)) return `${name} has an assignment queued for the end of the turn`;
    if (open.ownerTalk) {
      const idle = runs.idleMs(open.agentId, nowMs);
      if (idle !== null && idle < wp.config.dispatchTalkGraceMinutes * MIN) return `${name} is talking with the owner`;
    }
  }
  const wip = inProgress(wp, employeeId)[0];
  if (wip) return `${name} has "${wip.title}" (${wip.id}) In progress`;
  return null;
}

/**
 * Their queued story work, in the order it is taken (LLD W2 §1: focus is priority, not a filter):
 * stories the Chief of Staff routed to them as a lead first, then Ready or Backlog stories and tasks
 * in a focus epic (by the epic's place in the focus), then Ready work outside the focus; within each,
 * by rank, then age. Held Backlog, Backlog outside the focus, and work that starts after an unfinished
 * item are never queued. An empty focus means: Ready work by rank.
 */
export function queue(wp: Workplace, employeeId: string): WorkItem[] {
  const focus = items.getFocus(wp).epicIds;
  // Board bug 5 (19 Oct): an unassigned story is the Chief of Staff's to route (the tree check already says
  // so: subjectOf), so it is in her queue; before, only stories assigned to her were, and a bug filed with
  // its RCA ("the Chief of Staff routes it") sat unassigned for 7 hours with nobody told.
  const routes = employeeId === chiefOfStaffId(wp);
  const rows = rowsJson<WorkItem>(wp.db.prepare(`select json from work where (employee_id = ?${routes ? " or (employee_id is null and level in ('story', 'task'))" : ''}) and status in ('ready', 'backlog')`).all(employeeId));
  // Same definition as the board check and hygiene (unrouted.ts): a story with an assignee outside the org is hers to route too.
  if (routes) for (const w of unroutedItems(wp)) if ((w.status === 'ready' || w.status === 'backlog') && !rows.some(r => r.id === w.id)) rows.push(w);
  const out: { w: WorkItem; at: number }[] = [];
  for (const w of rows) {
    if (levelOf(w) === 'epic' || w.mergedInto) continue;
    if (w.status === 'backlog' && w.hold) continue;
    // Starts after an item that has not finished: not started, but still ROUTED when it has no owner (21 Oct).
    if (openStartsAfter(wp, w) && !isUnrouted(wp, w, focus)) continue;
    const epic = epicOf(wp, w);
    const inFocus = epic ? focus.indexOf(epic.id) : -1;
    if (inFocus < 0 && w.status === 'backlog') continue; // Backlog outside the focus is parked: never auto-started
    const at = employees.routedToLead(wp, w) ? -1 : inFocus < 0 ? focus.length : inFocus;
    out.push({ w, at });
  }
  return out
    .sort((a, b) => a.at - b.at || (a.w.rank ?? 0) - (b.w.rank ?? 0) || a.w.createdAt.localeCompare(b.w.createdAt) || a.w.id.localeCompare(b.w.id))
    .map(x => x.w);
}

/** The last reason this employee could not be given work (the digest and the idle alert say it). */
export const lastReason = (wp: Workplace, employeeId: string): string | undefined => reasonsOf(wp).get(employeeId);

function skipped(wp: Workplace, employeeId: string, reason: string): DispatchResult {
  reasonsOf(wp).set(employeeId, reason);
  return { action: 'skipped', reason };
}

/**
 * In-progress work with no session behind it (3 Oct: every restart left 3-4 people idle on their
 * In-progress story, because only sessions bound to an assignment get a resume marker, and
 * busyReason then skips them forever). Start it again, at most once per item per ORPHAN_RESUME_H,
 * so a story that genuinely waits (and should have been put on hold) cannot loop a session.
 */
const ORPHAN_RESUME_H = 3;
/**
 * A story the person is still working: In progress, theirs, not merged into another. A session left on
 * a story that went to review, Done or someone else does not tie them to it (2 Oct orphan RCA).
 */
const working = (w: WorkItem | undefined, employeeId: string): boolean => !!w && w.status === 'in-progress' && w.employeeId === employeeId && !w.mergedInto;
function resumeOrphan(wp: Workplace, employeeId: string, nowMs: number): DispatchResult | null {
  const wip = inProgress(wp, employeeId).find(w => !w.hold && levelOf(w) !== 'epic');
  if (!wip) return null;
  // An open session counts only if it is actually doing something, or is already on this story.
  // 3 Oct: sessions sat idle ("waiting") on a finished or held story while the person's In-progress
  // story had nothing behind it; 10 people showed "working" with 3 stories In progress.
  // One story per person (LLD W2 §2): a live session bound to another story they are working is that
  // person's work; resuming the orphan would move the session off it.
  if (employees.sessionsOf(employeeId).some(s => s.assignmentId && s.assignmentId !== wip.id && employees.isLive(s.agentId) && working(rawGet(wp, s.assignmentId), employeeId))) return null;
  const open = employees.openSession(employeeId);
  if (open) {
    const a = runs.getRunAgent(open.agentId);
    if (!a || a.status === 'running' || a.approval || employees.hasPendingSwitch(open.agentId) || open.assignmentId === wip.id) return null;
    if (open.ownerTalk) {
      const idle = runs.idleMs(open.agentId, nowMs);
      if (idle !== null && idle < wp.config.dispatchTalkGraceMinutes * MIN) return null;
    }
  }
  // Per story AND person: a resume of the previous assignee (reassigned seconds later, 23 Oct: Tara, then Anika)
  // must not use up the new assignee's turn, or they sit "working" on an idle session for the full 3 h.
  const key = `orphan-resumed:${wip.id}:${employeeId}`;
  const last = wp.db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined;
  if (last && nowMs - Date.parse(last.value) < ORPHAN_RESUME_H * 3_600_000) return null;
  if (!spend.canSpend(wp, employeeId, spend.dayOf(new Date(nowMs))).ok) return null;
  try {
    employees.assign(wp, wip.id);
  } catch (err) {
    log.warn('dispatch', `${wip.id}: could not resume for ${nameOf(wp, employeeId)}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(key, new Date(nowMs).toISOString());
  trail.record(wp, { itemId: wip.id, by: 'workplace', kind: 'note', text: `Resumed: In progress with no session behind it` });
  log.info('dispatch', `${wip.id}: resumed for ${nameOf(wp, employeeId)} (in progress, no session)`);
  return { action: 'story', itemId: wip.id };
}

/** Give one employee their next work if they are free: a queued review first, else the next focus story. */
export function dispatch(wp: Workplace, employeeId: string, nowMs = Date.now()): DispatchResult {
  if (!isAgent(wp, employeeId)) return { action: 'none' };
  // "Pause all": nothing is started, new or resumed, until the floor is resumed.
  if (floor.paused(wp)) return { action: 'skipped', reason: floor.describe(wp) };
  // Weekly pace hold (park, not kill): nothing new starts, a review into an open session included.
  if (floor.paceHeld(wp, nowMs)) return { action: 'skipped', reason: 'parked by the weekly pace cap until the next pace day' };
  // An auth outage holds starts too (the shared predicate): a session would only fail to start.
  const halted = halt.cannotRun(wp, nowMs);
  if (halted) return { action: 'skipped', reason: halted.reason };
  const resumed = resumeOrphan(wp, employeeId, nowMs);
  if (resumed) return resumed;
  const busy = busyReason(wp, employeeId, nowMs);
  if (busy) return skipped(wp, employeeId, busy);
  const name = nameOf(wp, employeeId);

  // Reviews first: someone's finished work is waiting on this person.
  const reviews = reviewWake.queued(wp, employeeId);
  if (reviews.length) {
    const started = reviewWake.drain(wp, employeeId);
    if (started) { reasonsOf(wp).delete(employeeId); return { action: 'review', itemId: started }; }
    return skipped(wp, employeeId, `the review of "${rawGet(wp, reviews[0]!)?.title ?? reviews[0]}" could not start (a cap or the budget)`);
  }

  const next = queue(wp, employeeId)[0];
  if (!next) { reasonsOf(wp).delete(employeeId); return { action: 'none' }; }
  const budget = spend.canSpend(wp, employeeId, spend.dayOf(new Date(nowMs)));
  if (!budget.ok) return skipped(wp, employeeId, `paused by the ${budget.scope} spend cap`);
  if (!employees.openSession(employeeId)) {
    const cap = employees.employee(wp, employeeId).budget.concurrentSessions;
    const live = employees.sessionsOf(employeeId).filter(s => employees.isLive(s.agentId)).length;
    if (live >= cap) return skipped(wp, employeeId, `concurrency cap (${cap}) reached`);
  }
  try {
    // Unassigned (board bug 5): it becomes the Chief of Staff's, and her session routes it.
    if (!next.employeeId) items.update(wp, next.id, { assigneeId: employeeId, note: 'system: unassigned, so the Chief of Staff routes it' }, 'workplace');
    employees.assign(wp, next.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('dispatch', `${next.id}: could not start for ${name}: ${msg}`);
    return skipped(wp, employeeId, `could not start "${next.title}": ${msg}`);
  }
  reasonsOf(wp).delete(employeeId);
  const why = employees.routedToLead(wp, next) ? 'routed to their team' : items.inFocus(wp, next) ? 'next in focus' : 'next in their queue';
  trail.record(wp, { itemId: next.id, by: 'workplace', kind: 'note', text: `Started: ${name} was free; ${why}` });
  log.info('dispatch', `${next.id}: started for ${name} (${why})`);
  return { action: 'story', itemId: next.id };
}

/**
 * In review items with no open review (entered review before review-wake existed, or the review
 * session ended with no verdict): queued into review-wake, once per episode. Returns the ids woken.
 */
export function wakeStaleReviews(wp: Workplace): string[] {
  const out: string[] = [];
  for (const w of rowsJson<WorkItem>(wp.db.prepare("select json from work where status = 'in-review'").all())) {
    if (w.mergedInto) continue;
    const reviewerId = w.reviewerId;
    if (!reviewerId || !isAgent(wp, reviewerId) || reviewerId === w.employeeId) continue;
    const episode = reviewWake.episodeNow(w);
    const wake = reviewWake.wakeOf(wp, w.id);
    if (!wake || wake.episode !== episode) {
      reviewWake.onItem(wp, w.id);
      if (reviewWake.wakeOf(wp, w.id)) out.push(w.id);
      continue;
    }
    if (wake.state === 'queued') continue;
    const holding = wake.agentId && employees.allSessions().some(s => s.agentId === wake.agentId) && employees.isLive(wake.agentId);
    if (holding) continue;
    const key = `stale-review:${w.id}`;
    if (get(wp, key) === episode) continue;
    put(wp, key, episode);
    if (reviewWake.requeue(wp, w.id)) {
      trail.record(wp, { itemId: w.id, by: 'workplace', kind: 'note', text: `Review requested again from ${nameOf(wp, reviewerId)}: it was In review with no open review` });
      out.push(w.id);
    }
  }
  if (out.length) log.info('dispatch', `stale reviews woken: ${out.join(', ')}`);
  return out;
}

/**
 * Retired (LLD W2 §6): "idle with queued work" no longer alerts Asha or the COO; the stall chain
 * (stall-chain.ts) is the one place a stall is told. What is left is the cleanup of episodes recorded
 * before the rework, so none of them is escalated later. Returns who was reported: always nobody.
 */
export function idleAlerts(wp: Workplace, _nowMs = Date.now()): string[] {
  const rows = wp.db.prepare("select key, value from settings where key like 'dispatch-idle:%'").all() as { key: string; value: string }[];
  for (const r of rows) {
    try { manager.resolve(wp, `idle-emp:${r.key.slice('dispatch-idle:'.length)}:${(JSON.parse(r.value) as { since: string }).since}`); } catch { /* a bad row: just drop it */ }
    del(wp, r.key);
  }
  return [];
}

/**
 * One pass: stale reviews, every free employee, then the owner's unacknowledged Inbox replies
 * (re-delivered, escalated; LLD §19.14), then the idle alerts. The first pass after boot is the
 * replies' boot re-delivery: it runs after the staggered resumes and this pass's starts, so a reply
 * lands in the session on the person's work.
 */
export function sweep(wp: Workplace, nowMs = Date.now()): { reviews: string[]; started: DispatchResult[]; alerts: string[] } {
  // A run that claims to be running but is dead keeps its person "working" and the dispatcher away: close it
  // first (housekeeping, also while paused; it starts nothing), so the pass below sees them idle.
  try { for (const id of employees.closeDeadRuns(wp, nowMs)) log.info('dispatch', `closed dead run ${id}`); } catch (err) { log.warn('dispatch', `dead runs: ${err instanceof Error ? err.message : err}`); }
  const replies = (): void => {
    try { replyDelivery.sweep(wp, nowMs); } catch (err) { log.warn('dispatch', `inbox replies: ${err instanceof Error ? err.message : err}`); }
  };
  // Paused: no review wakes, no starts, and no "idle with queued work" alerts for an idleness that is the switch.
  if (halt.cannotRun(wp, nowMs)) { replies(); return { reviews: [], started: [], alerts: [] }; }
  const reviews = wakeStaleReviews(wp);
  const started: DispatchResult[] = [];
  for (const id of agents(wp)) {
    try {
      const r = dispatch(wp, id, nowMs);
      if (r.action === 'review' || r.action === 'story') started.push(r);
    } catch (err) {
      log.warn('dispatch', `${id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  // The replies go after the starts (dry run 10 Oct, #2): a reply to someone just started on their work
  // rides into that session instead of a talk session of its own.
  replies();
  return { reviews, started, alerts: idleAlerts(wp, nowMs) };
}

/**
 * Backlog parked before `hold` existed: held when its newest move into Backlog was by the owner or the
 * COO, or its note says hold/held/parked; the watcher's own parking stays unheld. Once (settings
 * `hold-migration`), so a hold lifted later is not put back. Returns the ids held.
 */
export function migrateHolds(wp: Workplace): string[] {
  if (get(wp, 'hold-migration')) return [];
  const out: string[] = [];
  for (const w of rowsJson<WorkItem>(wp.db.prepare("select json from work where status = 'backlog'").all())) {
    if (w.hold !== undefined || levelOf(w) === 'epic') continue;
    const act = rowsJson<Activity>(wp.db.prepare("select json from activity where item_id = ? and kind = 'status' order by seq desc").all(w.id)).find(a => a.to === 'backlog');
    const hist = [...(w.history ?? [])].reverse().find(h => h.to === 'proposed');
    const move = act ? { by: act.by, note: act.text } : hist ? { by: hist.by, note: hist.note } : undefined;
    if (!move || !items.holdOnEntry(move.by, move.note)) continue;
    const prev = rowJson<WorkItem>(wp.db.prepare('select json from work where id = ?').get(w.id))!;
    wp.db.prepare('update work set json = ? where id = ?').run(JSON.stringify({ ...prev, hold: true }), w.id);
    out.push(w.id);
  }
  put(wp, 'hold-migration', new Date().toISOString());
  if (out.length) log.info('dispatch', `held ${out.length} parked Backlog item(s): ${out.join(', ')}`);
  return out;
}

/**
 * Reassigning ends the old session (LLD W2 §3; owner 10 Oct). A live session bound to this item whose
 * employee is no longer its assignee is asked for its handoff and closed (reason `reassigned`), so two
 * people never work one story and the old assignee's next story starts. A person who reassigned the
 * story themselves (routing it on, handing it to their manager) is left alone: their session moves on
 * to their next story by itself. Returns the agent ids being ended.
 */
export function endReassigned(wp: Workplace, item: WorkItem): string[] {
  const stale = employees.allSessions().filter(s => s.assignmentId === item.id && s.employeeId !== item.employeeId && !s.probe && employees.isLive(s.agentId));
  if (!stale.length) return [];
  const row = wp.db.prepare("select by from activity where item_id = ? and kind = 'assigned' order by seq desc limit 1").get(item.id) as { by: string } | undefined;
  const out: string[] = [];
  for (const s of stale) {
    if (row?.by === s.employeeId) continue;
    out.push(s.agentId);
    log.info('dispatch', `${item.id}: reassigned from ${nameOf(wp, s.employeeId)} to ${nameOf(wp, item.employeeId)}: ending ${s.agentId}`);
    void employees.endSession(wp, s.agentId, employees.END_ON_ITEM_WAIT_MS, false, { reason: 'reassigned' })
      .catch(err => log.warn('dispatch', `${item.id}: could not end ${s.agentId}: ${err instanceof Error ? err.message : err}`));
  }
  return out;
}

/** Wire it: the moments someone becomes free, and the sweep. Returns stop(). */
export function startDispatch(wp: Workplace): () => void {
  let stopped = false;
  const pending = new Set<string>();
  let scheduled = false;
  // Deferred and coalesced per employee: review-wake and handoff listeners (registered earlier) act first.
  const schedule = (employeeId: string | undefined): void => {
    if (stopped || !employeeId || !isAgent(wp, employeeId)) return;
    pending.add(employeeId);
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (stopped) return;
      const list = [...pending];
      pending.clear();
      for (const id of list) {
        try { dispatch(wp, id); } catch (err) { log.warn('dispatch', `${id}: ${err instanceof Error ? err.message : err}`); }
      }
    });
  };

  // What was In progress, and whose: an item leaving In progress (or changing hands) frees that person.
  const seen = new Map<string, string | undefined>();
  for (const r of wp.db.prepare("select id, employee_id from work where status = 'in-progress'").all() as { id: string; employee_id: string | null }[]) seen.set(r.id, r.employee_id ?? undefined);

  const off = wp.on(event => {
    if (event.type !== 'work.updated') return;
    try { endReassigned(wp, event.item); } catch (err) { log.warn('dispatch', `${event.item.id}: ${err instanceof Error ? err.message : err}`); }
    const { id, status, employeeId } = event.item;
    const had = seen.has(id);
    const prevOwner = seen.get(id);
    if (status === 'in-progress') seen.set(id, employeeId); else seen.delete(id);
    if (had && (status !== 'in-progress' || employeeId !== prevOwner)) schedule(prevOwner);
  });
  const offRuns = runs.onRunEvent(({ agent }) => {
    if (!agent?.employeeId || agent.status !== 'waiting' || agent.approval) return;
    schedule(agent.employeeId);
  });
  const offClosed = employees.onSessionClosed((_wp, session, reason) => {
    if (reason !== 'shutdown') schedule(session.employeeId);
  });

  const run = (): void => {
    if (stopped) return;
    try { sweep(wp); } catch (err) { log.warn('dispatch', `sweep: ${err instanceof Error ? err.message : err}`); }
  };
  // The first sweep waits for the boot's staggered resumes (resumeAfterShutdown) to land, so it never races them.
  const first = setTimeout(run, Math.max(0, wp.config.dispatchBootDelaySeconds * 1000));
  first.unref?.();
  const timer = setInterval(run, Math.max(1, wp.config.dispatchSweepMinutes * MIN));
  timer.unref?.();

  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
    off();
    offRuns();
    offClosed();
  };
}
