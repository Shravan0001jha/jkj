import type { Item, ItemBlocker, ItemPr, Release, TrueStatus, WorkItem } from '@jkj/shared';
import { TRUE_STATUS_LABEL } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import { approvalHolds, githubMode, stage } from './review-policy.js';
import { levelOf, nameOf, rawGet } from './v2-map.js';
import { rowsJson } from './store.js';

/**
 * The Jira-style lifecycle (docs/HLD-jira-lifecycle.md): the true status, the blocker and the PR as
 * the apps show them, all computed on read from the stored row so they are always current (a linked
 * blocker changing state changes what its dependents show, with nothing written).
 */

/** Waiting on the release (docs/HLD-jira-lifecycle.md §2). */
export const RELEASE = 'release';

/** An open PR the flow is tracking (shadow/on): its stage drives In review → QA → Approved. */
const openPr = (wp: Workplace, w: WorkItem): boolean => !!w.pr && !w.pr.merged && githubMode(wp) !== 'local';

/** Has this item finished, for whoever starts after it: Merged when it has a PR, else Done (resolution done). */
export function finished(w: WorkItem | undefined): boolean {
  if (!w || w.status !== 'done' || (w.resolution ?? 'done') !== 'done') return false;
  return !w.pr || !!w.pr.merged;
}

/** Closed in any way (Done, Won't do, Duplicate, Can't reproduce): nothing more will come of it. */
export const closed = (w: WorkItem | undefined): boolean => !!w && w.status === 'done';

/** Done with a PR that has not merged yet: the code has not landed, so whoever waits on it still waits. */
export const awaitingMerge = (w: WorkItem): boolean => !!w.pr && !w.pr.merged && (w.resolution ?? 'done') === 'done';

/**
 * ONE definition of a stale block (owner, 22 Oct: a story sat Blocked on a Done item, twice; the lifecycle
 * released only on the blocker's own "finished" event, once per pair, and hygiene (c) judged it by a looser test).
 * Shared by the release itself (lifecycle-watch), hygiene rule (c) and so the Chief of Staff's board check.
 * Returns the closed blocker when `w` is Blocked, points at items only (waitingOn an item id, and/or startsAfter),
 * and every one of them is closed with nothing left to wait for. A block that also waits on a person, the owner,
 * the COO, a release or an open item is not stale.
 */
export function staleBlock(wp: Workplace, w: WorkItem): WorkItem | undefined {
  if (w.status !== 'blocked') return undefined;
  if (w.waitingOn && !rawGet(wp, w.waitingOn)) return undefined;
  const ids = [...new Set([w.waitingOn, w.startsAfter].filter((x): x is string => !!x))];
  const deps = ids.map(id => rawGet(wp, id));
  if (!deps.length || deps.some(d => !d || !closed(d) || awaitingMerge(d))) return undefined;
  return deps[0];
}

/** The open dependency, or undefined when there is none or it has finished. */
export function openStartsAfter(wp: Workplace, w: WorkItem): WorkItem | undefined {
  if (!w.startsAfter) return undefined;
  const dep = rawGet(wp, w.startsAfter);
  return dep && !finished(dep) ? dep : undefined;
}

export function trueStatus(wp: Workplace, w: WorkItem): TrueStatus {
  const status = w.status ?? 'ready';
  switch (status) {
    case 'backlog': return w.hold ? 'on-hold' : 'backlog';
    case 'ready': return levelOf(w) !== 'epic' && openStartsAfter(wp, w) ? 'blocked' : 'ready';
    case 'in-progress': return 'in-progress';
    case 'blocked': return 'blocked';
    case 'waiting': return 'waiting';
    case 'parked': return 'parked';
    case 'in-review': {
      if (!openPr(wp, w)) return 'in-review';
      const s = stage(w);
      return s === 'dev' ? 'in-review' : s;
    }
    case 'done': {
      if (w.awaitingMac && !w.awaitingMac.closedAt && !w.closedAt && (w.resolution ?? 'done') === 'done') return 'awaiting-mac';
      if ((w.resolution ?? 'done') !== 'done' || !w.pr) return 'done';
      if (w.pr.merged) return w.closedAt ? 'done' : 'merged';
      return githubMode(wp) !== 'local' && approvalHolds(w, 'qa') ? 'approved' : 'done';
    }
  }
}

export const label = (s: TrueStatus): string => TRUE_STATUS_LABEL[s];

/** "release iris-mobile 1.4 approved", or "no release planned". */
export function releaseStatus(wp: Workplace): string {
  const open = rowsJson<Release>(wp.db.prepare("select json from releases where state in ('proposed', 'approved', 'running') order by created_at desc, rowid desc limit 1").all())[0];
  return open ? `release ${open.shippable} ${open.version} ${open.state}` : 'no release planned';
}

/** Where a person blocker stands: what they are on now, in a few words. */
function personStatus(wp: Workplace, id: string): string {
  const busy = rowsJson<WorkItem>(wp.db.prepare("select json from work where employee_id = ? and status in ('in-progress', 'in-review') order by updated_at desc limit 1").all(id))[0];
  return busy ? `on "${busy.title}" (${label(trueStatus(wp, busy))})` : 'nothing in progress';
}

/** What a Blocked or Waiting item (or a Ready one with an open startsAfter) waits on, and that blocker's status now. */
export function blockerOf(wp: Workplace, w: WorkItem): ItemBlocker | undefined {
  const status = w.status ?? 'ready';
  if (status === 'blocked') {
    const on = w.waitingOn ?? w.startsAfter;
    const base = { ...(w.blockedReason ? { reason: w.blockedReason } : {}), ...(w.blockedSince ?? w.statusSince ? { since: (w.blockedSince ?? w.statusSince)! } : {}) };
    if (!on) return undefined;
    return { ...describe(wp, on), ...base };
  }
  if (status === 'waiting' && w.waiting) {
    return { ...describe(wp, w.waiting.on), reason: w.waiting.reason, since: w.waiting.since };
  }
  if (status === 'ready') {
    const dep = openStartsAfter(wp, w);
    if (dep) return { ...describe(wp, dep.id), reason: `Starts after "${dep.title}"` };
  }
  return undefined;
}

function describe(wp: Workplace, on: string): Pick<ItemBlocker, 'kind' | 'id' | 'label' | 'status'> {
  if (on === RELEASE) return { kind: 'release', id: on, label: 'the release', status: releaseStatus(wp) };
  if (on === 'owner') return { kind: 'owner', id: on, label: 'you', status: 'waiting on your answer' };
  if (on === 'coo') return { kind: 'coo', id: on, label: 'the COO', status: 'waiting on the COO' };
  if (on === 'external') return { kind: 'external', id: on, label: 'someone outside the team', status: 'outside the team' };
  if (wp.org.employees.some(e => e.id === on)) return { kind: 'person', id: on, label: nameOf(wp, on), status: personStatus(wp, on) };
  const item = rawGet(wp, on);
  if (item) {
    const s = label(trueStatus(wp, item));
    const res = item.status === 'done' && item.resolution && item.resolution !== 'done' ? ` (${item.resolution})` : '';
    return { kind: 'item', id: on, label: item.title, status: `${s}${res}` };
  }
  return { kind: 'external', id: on, label: on, status: 'unknown' };
}

export function prOf(w: WorkItem): ItemPr | undefined {
  const pr = w.pr;
  if (!pr) return undefined;
  const tests = pr.tests && pr.tests.sha === pr.headSha ? pr.tests.state : pr.tests ? 'pending' as const : undefined;
  return {
    number: pr.number, url: pr.url, branch: pr.branch,
    stage: pr.merged ? 'merged' : stage(w),
    ...(tests ? { tests } : {}),
    evidence: pr.evidence,
    ...(pr.merged ? { merged: { at: pr.merged.at, by: pr.merged.by } } : {}),
  };
}

/** The lifecycle fields of the client shape (items.toItem adds them). */
export function decorate(wp: Workplace, w: WorkItem, item: Item): Item {
  const level = levelOf(w);
  item.type = (w.type === 'bug' || w.type === 'rca') && level === 'story' ? w.type : level;
  item.trueStatus = trueStatus(wp, w);
  const blocker = level === 'epic' ? undefined : blockerOf(wp, w);
  if (blocker) item.blocker = blocker;
  if (w.startsAfter) {
    const dep = rawGet(wp, w.startsAfter);
    item.startsAfter = { id: w.startsAfter, title: dep?.title ?? w.startsAfter, status: dep ? label(trueStatus(wp, dep)) : 'unknown', done: finished(dep) };
  }
  if (w.hold && w.status === 'backlog' && w.holdReason) item.holdReason = w.holdReason;
  if (w.closedAt) item.closedAt = w.closedAt;
  if (w.awaitingMac) item.awaitingMac = w.awaitingMac;
  const pr = prOf(w);
  if (pr) item.pr = pr;
  return item;
}

/** Items that start after (or are blocked waiting on) this one. */
export function dependentsOf(wp: Workplace, id: string): WorkItem[] {
  return rowsJson<WorkItem>(wp.db.prepare("select json from work where status in ('backlog', 'ready', 'blocked')").all())
    .filter(d => d.id !== id && (d.startsAfter === id || (d.status === 'blocked' && d.waitingOn === id)));
}
