import type { Activity, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as runs from './runs.js';
import * as employees from './employees.js';
import * as items from './items.js';
import * as spend from './spend.js';
import * as trail from './trail.js';
import * as manager from './manager.js';
import * as reviewWake from './review-wake.js';
import { epicOf, isAgent, levelOf, nameOf, rawGet } from './v2-map.js';
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
 *   in a focus epic (focus order, rank, age), started with `employees.assign` on its own branch;
 * - spend and concurrency caps are respected; held Backlog and Backlog outside the focus never start;
 * - In review items nobody is reviewing (from before review-wake, or a review session that died)
 *   are woken once per episode;
 * - an employee idle 10+ minutes with queued focus work is reported once per episode: to Asha first,
 *   to the COO when the reason is a cap (LLD §19.6e).
 *
 * Settings: `stale-review:<itemId>` = the episode requeued, `dispatch-idle:<employeeId>` = the idle
 * episode, `hold-migration` = the boot migration ran.
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
  if (wip) return `${name} has "${wip.title}" In progress`;
  return null;
}

/**
 * Their queued story work, in the order it is taken: Ready or Backlog stories and tasks assigned to
 * them, not held, in a focus epic; by the epic's place in the focus, then rank, then age.
 */
export function queue(wp: Workplace, employeeId: string): WorkItem[] {
  const focus = items.getFocus(wp).epicIds;
  if (!focus.length) return [];
  const rows = rowsJson<WorkItem>(wp.db.prepare("select json from work where employee_id = ? and status in ('ready', 'backlog')").all(employeeId));
  const out: { w: WorkItem; at: number }[] = [];
  for (const w of rows) {
    if (levelOf(w) === 'epic' || w.mergedInto) continue;
    if (w.status === 'backlog' && w.hold) continue;
    const epic = epicOf(wp, w);
    const at = epic ? focus.indexOf(epic.id) : -1;
    if (at < 0) continue; // never auto-start anything outside the focus
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

/** Give one employee their next work if they are free: a queued review first, else the next focus story. */
export function dispatch(wp: Workplace, employeeId: string, nowMs = Date.now()): DispatchResult {
  if (!isAgent(wp, employeeId)) return { action: 'none' };
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
    employees.assign(wp, next.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('dispatch', `${next.id}: could not start for ${name}: ${msg}`);
    return skipped(wp, employeeId, `could not start "${next.title}": ${msg}`);
  }
  reasonsOf(wp).delete(employeeId);
  trail.record(wp, { itemId: next.id, by: 'workplace', kind: 'note', text: `Started: ${name} was free; next in focus` });
  log.info('dispatch', `${next.id}: started for ${name} (next in focus)`);
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

interface IdleEpisode { since: string; alerted: boolean }

/** Idle with queued focus work past the threshold: Asha hears once per episode (the COO for a cap). Returns who was reported. */
export function idleAlerts(wp: Workplace, nowMs = Date.now()): string[] {
  const out: string[] = [];
  for (const id of agents(wp)) {
    const key = `dispatch-idle:${id}`;
    const reviews = reviewWake.queued(wp, id);
    const stories = queue(wp, id);
    const n = reviews.length + stories.length;
    const open = employees.openSession(id);
    const a = open ? runs.getRunAgent(open.agentId) : undefined;
    const idle = !a || (a.status !== 'running' && !a.approval);
    let ep: IdleEpisode | undefined;
    try { const raw = get(wp, key); ep = raw ? JSON.parse(raw) as IdleEpisode : undefined; } catch { ep = undefined; }
    if (!n || !idle) {
      // The episode is over: an alert still with Asha is resolved, so it never goes on to the COO.
      if (ep) { manager.resolve(wp, `idle-emp:${id}:${ep.since}`); del(wp, key); }
      continue;
    }
    if (!ep) { put(wp, key, JSON.stringify({ since: new Date(nowMs).toISOString(), alerted: false })); continue; }
    if (ep.alerted || nowMs - Date.parse(ep.since) <= wp.config.dispatchIdleMinutes * MIN) continue;
    const name = nameOf(wp, id);
    const reason = reasonsOf(wp).get(id) ?? busyReason(wp, id, nowMs) ?? 'no reason recorded';
    const title = `${name} idle with ${n} queued item${n === 1 ? '' : 's'}`;
    // Asha first (LLD §19.6e); a cap is a spend decision above her, so the COO hears of that at once.
    const capped = /spend cap|concurrency cap/.test(reason);
    manager.alert(wp, {
      key: `idle-emp:${id}:${ep.since}`, itemId: reviews[0] ?? stories[0]!.id, title, body: `${title}: ${reason}.`, by: 'workplace', subjectId: id,
      ...(capped ? { decision: 'spend' as const } : {}),
    }, nowMs);
    put(wp, key, JSON.stringify({ ...ep, alerted: true }));
    log.warn('dispatch', `${title}: ${reason}`);
    out.push(id);
  }
  return out;
}

/** One pass: stale reviews, every free employee, then the idle alerts. */
export function sweep(wp: Workplace, nowMs = Date.now()): { reviews: string[]; started: DispatchResult[]; alerts: string[] } {
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
