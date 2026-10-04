import type { WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as runs from './runs.js';
import * as employees from './employees.js';
import * as items from './items.js';
import * as spend from './spend.js';
import * as trail from './trail.js';
import { epicOf, isAgent, levelOf, nameOf, rawGet } from './v2-map.js';
import { log } from '../util/logger.js';
import { githubMode } from './review-policy.js';

/**
 * Waking the reviewer (QA, 2 Oct; LLD §19.6a). An item entering In review used to wake nobody: the
 * reviewer heard of it only when the stall watcher told the COO 30 minutes later. Now, the moment an
 * item enters In review with an agent reviewer:
 *
 * - the reviewer's open session, between turns, gets the review request as a message;
 * - with no open session (and within budget and the concurrency cap), a short review session (an
 *   autonomous talk turn) starts with it;
 * - a reviewer mid-turn (or waiting on an approval, or capped) has it queued; the queue is drained one
 *   review at a time when that turn ends or that session closes (never on a shutdown), P0 / focus
 *   epics first, then oldest.
 *
 * One record per item (`review-wake:<itemId>`) keyed by the episode (reviewer + when it entered In
 * review): any number of events about the same episode wake the reviewer once, so an item never
 * gets two review sessions. Leaving In review drops the record; re-entering is a new episode.
 */

export interface Wake {
  reviewerId: string;
  /** `<reviewerId>:<statusSince>`: one wake per reviewer per time in review. */
  episode: string;
  state: 'queued' | 'sent' | 'started';
  queuedAt: string;
  agentId?: string;
}

const PREFIX = 'review-wake:';
const key = (itemId: string): string => `${PREFIX}${itemId}`;

function read(wp: Workplace, itemId: string): Wake | undefined {
  const row = wp.db.prepare('select value from settings where key = ?').get(key(itemId)) as { value: string } | undefined;
  if (!row) return undefined;
  try { return JSON.parse(row.value) as Wake; } catch { return undefined; }
}
const write = (wp: Workplace, itemId: string, wake: Wake): void =>
  void wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(key(itemId), JSON.stringify(wake));
const drop = (wp: Workplace, itemId: string): void => void wp.db.prepare('delete from settings where key = ?').run(key(itemId));

function all(wp: Workplace): { itemId: string; wake: Wake }[] {
  const rows = wp.db.prepare('select key, value from settings where key like ?').all(`${PREFIX}%`) as { key: string; value: string }[];
  const out: { itemId: string; wake: Wake }[] = [];
  for (const r of rows) { try { out.push({ itemId: r.key.slice(PREFIX.length), wake: JSON.parse(r.value) as Wake }); } catch { /* skip a bad row */ } }
  return out;
}

const statusOf = (w: WorkItem): string | undefined => w.status;
const episodeOf = (w: WorkItem): string => `${w.reviewerId}:${w.statusSince ?? w.updatedAt}`;

/** P0 (the item or its epic says so) or in a focus epic: reviewed first. */
function urgent(wp: Workplace, w: WorkItem): boolean {
  const p0 = (t: string | undefined) => !!t && /\bP0\b/.test(t);
  return p0(w.title) || p0(epicOf(wp, w)?.title) || items.inFocus(wp, w);
}

/** The reviewer's queue, in the order it is worked: P0/focus first, then oldest. Stale entries are dropped. */
export function queued(wp: Workplace, reviewerId: string): string[] {
  const list: { w: WorkItem; wake: Wake }[] = [];
  for (const { itemId, wake } of all(wp)) {
    if (wake.state !== 'queued' || wake.reviewerId !== reviewerId) continue;
    const w = rawGet(wp, itemId);
    if (!w || statusOf(w) !== 'in-review' || episodeOf(w) !== wake.episode) { drop(wp, itemId); continue; }
    list.push({ w, wake });
  }
  return list
    .sort((a, b) => Number(urgent(wp, b.w)) - Number(urgent(wp, a.w)) || a.wake.queuedAt.localeCompare(b.wake.queuedAt) || a.w.id.localeCompare(b.w.id))
    .map(x => x.w.id);
}

export function reviewPrompt(wp: Workplace, w: WorkItem): string {
  const noun = levelOf(w) === 'task' ? 'Task' : levelOf(w) === 'epic' ? 'Epic' : 'Story';
  const by = w.employeeId && w.employeeId !== 'owner' ? ` by ${nameOf(wp, w.employeeId)}` : '';
  const branch = isAgent(wp, w.employeeId) ? `, then its commits on branch emp/${w.employeeId}/${w.id}` : '';
  return `Review request: ${noun} ${w.id} "${w.title}"${by} is In review and you are its reviewer. ` +
    `Check it against its acceptance criteria and evidence (status_of ${w.id}${branch}). ` +
    (w.pr && !w.pr.merged && githubMode(wp) !== 'local'
      ? `It has pull request #${w.pr.number} (head ${w.pr.headSha.slice(0, 8)}). Then call review_approve on ${w.id} if it meets them (a lead who is not the author approves first, then QA), or review_send_back with a note saying what to fix. Keep it short.`
      : `Then call item_update on ${w.id}: status done if it meets them, or status in-progress with a note saying what to fix. Keep it short.`);
}

/** A turn is running, or parked on a tool approval: not the moment to push a review in. */
function midTurn(agentId: string): boolean {
  const a = runs.getRunAgent(agentId);
  return !a || a.status === 'running' || !!a.approval;
}

/**
 * Hand the reviewer the first review in its queue, if it can take one now. One at a time: the
 * message (or the new session) makes the reviewer busy, and the end of that turn drains the next.
 */
export function drain(wp: Workplace, reviewerId: string): string | null {
  const next = queued(wp, reviewerId)[0];
  if (!next) return null;
  const w = rawGet(wp, next)!;
  const wake = read(wp, next)!;
  const name = nameOf(wp, reviewerId);
  const open = employees.openSession(reviewerId);
  if (open) {
    if (midTurn(open.agentId)) return null;
    runs.sendMessage(open.agentId, reviewPrompt(wp, w), [], { from: 'workplace' });
    write(wp, next, { ...wake, state: 'sent', agentId: open.agentId });
    trail.record(wp, { itemId: next, by: 'workplace', kind: 'note', text: `Review requested from ${name} in the open session` });
    log.info('review', `${next}: review sent to ${name}'s open session ${open.agentId}`);
    return next;
  }
  if (!spend.canSpend(wp, reviewerId).ok) return null;
  try {
    const agent = employees.talk(wp, reviewerId, reviewPrompt(wp, w), [], { autonomous: true });
    write(wp, next, { ...wake, state: 'started', agentId: agent.id });
    trail.record(wp, { itemId: next, by: 'workplace', kind: 'note', text: `Review requested from ${name}: a review session started` });
    log.info('review', `${next}: review session ${agent.id} started for ${name}`);
    return next;
  } catch (err) {
    log.warn('review', `${next}: ${name} cannot take the review yet: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** The wake record of an item, if any (the dispatcher's stale-review check, LLD §19.6d). */
export function wakeOf(wp: Workplace, itemId: string): Readonly<Wake> | undefined {
  return read(wp, itemId);
}

/** The episode an item is in now (reviewer + when it entered In review). */
export const episodeNow = (w: WorkItem): string => episodeOf(w);

/**
 * Put a `sent`/`started` review whose session ended with no verdict back in the reviewer's queue and
 * drain it (LLD §19.6d). The caller dedupes per episode. Returns whether it was requeued.
 */
export function requeue(wp: Workplace, itemId: string): boolean {
  const w = rawGet(wp, itemId);
  const wake = read(wp, itemId);
  if (!w || !wake || statusOf(w) !== 'in-review' || wake.episode !== episodeOf(w) || wake.state === 'queued') return false;
  write(wp, itemId, { reviewerId: wake.reviewerId, episode: wake.episode, state: 'queued', queuedAt: new Date().toISOString() });
  drain(wp, wake.reviewerId);
  return true;
}

/** An item changed: wake its reviewer once per episode in review; forget it once it leaves review. */
export function onItem(wp: Workplace, itemId: string): void {
  const w = rawGet(wp, itemId);
  const existing = read(wp, itemId);
  if (!w || statusOf(w) !== 'in-review' || w.mergedInto) { if (existing) drop(wp, itemId); return; }
  const reviewerId = w.reviewerId;
  if (!reviewerId || !isAgent(wp, reviewerId) || reviewerId === w.employeeId) { if (existing) drop(wp, itemId); return; }
  const episode = episodeOf(w);
  if (existing?.episode === episode) return;
  write(wp, itemId, { reviewerId, episode, state: 'queued', queuedAt: new Date().toISOString() });
  if (drain(wp, reviewerId) !== itemId) log.info('review', `${itemId}: queued for ${nameOf(wp, reviewerId)} (busy)`);
}

/** Wire the wake: item changes, the end of a reviewer's turn, a session closing; and drain what a restart left queued. */
export function startReviewWake(wp: Workplace): () => void {
  let stopped = false;
  const later = (fn: () => void): void => {
    setImmediate(() => {
      if (stopped) return;
      try { fn(); } catch (err) { log.warn('review', err instanceof Error ? err.message : String(err)); }
    });
  };
  const hasQueued = (reviewerId: string): boolean => all(wp).some(x => x.wake.state === 'queued' && x.wake.reviewerId === reviewerId);

  const off = wp.on(event => {
    if (event.type === 'work.updated') { const id = event.item.id; later(() => onItem(wp, id)); }
  });
  const offRuns = runs.onRunEvent(({ agent }) => {
    const reviewerId = agent?.employeeId;
    if (!reviewerId || agent.status !== 'waiting' || agent.approval) return;
    later(() => { if (hasQueued(reviewerId)) drain(wp, reviewerId); });
  });
  const offClosed = employees.onSessionClosed((_wp, session, reason) => {
    if (reason === 'shutdown') return;
    later(() => { if (hasQueued(session.employeeId)) drain(wp, session.employeeId); });
  });
  // A restart keeps the queue (settings rows): hand out what is waiting.
  later(() => { for (const r of new Set(all(wp).filter(x => x.wake.state === 'queued').map(x => x.wake.reviewerId))) drain(wp, r); });

  return () => {
    stopped = true;
    off();
    offRuns();
    offClosed();
  };
}
