import type { AssignmentState, FeatureState, Item, ItemLevel, ItemStatus, WorkItem, WorkState } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import { rowJson } from './store.js';

/**
 * The two views of one work row (LLD §19.3): the old engine's `state` and v2's `status`. Pure
 * mappings plus the small lookups both `work.ts` and `items.ts` need, kept here so neither imports
 * the other's internals.
 */

export const levelOf = (w: Pick<WorkItem, 'kind' | 'level'>): ItemLevel => w.level ?? (w.kind === 'feature' ? 'epic' : 'story');

/** Old → v2, applied whenever the old engine moves `state`. `current` keeps Backlog parked. */
export function statusFromState(w: Pick<WorkItem, 'kind'>, state: WorkState, current?: ItemStatus): { status: ItemStatus; resolution?: 'done' | 'wont-do' } {
  if (w.kind === 'feature') {
    switch (state as FeatureState) {
      case 'stated': case 'specced': return { status: current === 'backlog' ? 'backlog' : 'ready' };
      case 'decomposed': case 'in-progress': return { status: 'in-progress' };
      case 'built': case 'released': return { status: 'done', resolution: 'done' };
    }
  }
  switch (state as AssignmentState) {
    case 'proposed': return { status: current === 'backlog' ? 'backlog' : current === 'in-progress' ? 'in-progress' : 'ready' };
    case 'planned': case 'building': return { status: 'in-progress' };
    case 'review': return { status: 'in-review' };
    case 'done': return { status: 'done', resolution: 'done' };
    case 'blocked': return { status: 'blocked' };
    case 'rejected': return { status: 'done', resolution: 'wont-do' };
  }
  return { status: 'ready' };
}

/** v2 → old, applied by v2 writes (written directly; the old table is the old engine's rule). */
export function stateFromStatus(w: WorkItem, status: ItemStatus, resolution?: string): WorkState {
  if (w.kind === 'feature') {
    const s = w.state as FeatureState;
    if (status === 'in-progress') return s === 'decomposed' ? 'in-progress' : s;
    if (status === 'done') return s === 'built' || s === 'released' ? s : 'built';
    return s;
  }
  switch (status) {
    case 'backlog': case 'ready': return 'proposed';
    case 'in-progress': return w.state === 'planned' || w.state === 'building' ? w.state : w.plan ? 'building' : 'proposed';
    case 'in-review': return 'review';
    case 'done': return resolution && resolution !== 'done' ? 'rejected' : 'done';
    case 'blocked': return 'blocked';
  }
}

/** Read a row without going through work.ts (no cycle). */
export const rawGet = (wp: Workplace, id: string): WorkItem | undefined =>
  rowJson<WorkItem>(wp.db.prepare('select json from work where id = ?').get(id));

/** The epic an item rolls up to: itself, its parent, or its parent's parent. */
export function epicOf(wp: Workplace, w: WorkItem): WorkItem | undefined {
  let cur: WorkItem | undefined = w;
  for (let i = 0; i < 4 && cur; i++) {
    if (levelOf(cur) === 'epic') return cur;
    const next: string | undefined = cur.parentId ?? (cur.kind !== 'feature' ? cur.featureId : undefined);
    cur = next ? rawGet(wp, next) : undefined;
  }
  return undefined;
}

/** The QA lead (holder of `qa-release`) and the Chief of Staff, by charter. */
export const qaLead = (wp: Workplace): string | undefined => wp.org.employees.find(e => e.charterIds.includes('qa-release'))?.id;
export const chiefOfStaffId = (wp: Workplace): string | undefined =>
  wp.org.employees.find(e => e.charterIds.includes('chief-of-staff'))?.id ?? wp.org.employees.find(e => e.level === 0 && !e.virtual)?.id;

/**
 * Who reviews when nobody was named (LLD §19.3): a task's story assignee, else QA, else the Chief
 * of Staff — never the assignee itself.
 */
export function defaultReviewer(wp: Workplace, w: WorkItem): string | undefined {
  const candidates: (string | undefined)[] = [];
  if (levelOf(w) === 'task' && w.parentId) candidates.push(rawGet(wp, w.parentId)?.employeeId);
  candidates.push(qaLead(wp), chiefOfStaffId(wp));
  return candidates.find(c => c && c !== 'owner' && c !== w.employeeId);
}

/** People's names for one-liners: 'owner' → "you", an employee → its name, 'coo' → "the COO". */
export function nameOf(wp: Workplace, id: string | undefined): string {
  if (!id) return 'nobody';
  if (id === 'owner') return 'you';
  if (id === 'workplace') return 'the Workplace';
  if (id === 'external') return 'someone outside the team';
  if (id === 'release') return 'the release';
  const person = wp.org.employees.find(e => e.id === id)?.name;
  if (person) return person;
  // A wait on another item (docs/HLD-jira-lifecycle.md §2) reads as its title.
  const item = /^[a-z]{2,3}_/.test(id) ? rawGet(wp, id) : undefined;
  return item ? `"${item.title}"` : id;
}

export const isAgent = (wp: Workplace, id: string | undefined): boolean =>
  !!id && wp.org.employees.some(e => e.id === id && !e.virtual);

/** Who may be waited on: an employee (the COO included), or the owner. */
export const isPerson = (wp: Workplace, id: string | undefined): boolean =>
  !!id && (id === 'owner' || wp.org.employees.some(e => e.id === id));

/**
 * Who or what a Blocked item may wait on: a person, someone outside the team (`external`, LLD §19.6c),
 * the release, or another item by id (docs/HLD-jira-lifecycle.md §2).
 */
export const isWaitable = (wp: Workplace, id: string | undefined): boolean =>
  id === 'external' || id === 'release' || isPerson(wp, id) || (!!id && !!rawGet(wp, id));

export const STATUS_LABEL: Record<ItemStatus, string> = {
  backlog: 'Backlog', ready: 'Ready', 'in-progress': 'In progress', 'in-review': 'In review', done: 'Done', blocked: 'Blocked',
};

/** The client shape (LLD §19.8), without the derived stall (items.ts adds it). */
export function projectItem(wp: Workplace, w: WorkItem): Item {
  const level = levelOf(w);
  const status = w.status ?? statusFromState(w, w.state).status;
  const epic = level === 'epic' ? w : epicOf(wp, w);
  const parentId = w.parentId ?? (level !== 'epic' ? w.featureId : undefined);
  const blocked = status === 'blocked' && w.blockedReason
    ? { reason: w.blockedReason, waitingOn: w.waitingOn ?? 'coo', since: w.blockedSince ?? w.statusSince ?? w.updatedAt }
    : undefined;
  return {
    id: w.id, level, title: w.title, body: w.body, status,
    statusSince: w.statusSince ?? w.updatedAt,
    ...(w.resolution && status === 'done' ? { resolution: w.resolution } : status === 'done' ? { resolution: 'done' as const } : {}),
    ...(parentId ? { parentId } : {}),
    ...(epic ? { epicId: epic.id } : {}),
    ...(epic?.areaId ? { areaId: epic.areaId } : {}),
    ...(w.employeeId ? { assigneeId: w.employeeId } : {}),
    ...(w.reviewerId ? { reviewerId: w.reviewerId } : {}),
    ...(w.ownerId ? { ownerId: w.ownerId } : {}),
    ...(w.points ? { points: w.points } : {}),
    rank: w.rank ?? 0,
    ...(w.targetDate ? { targetDate: w.targetDate } : {}),
    acceptance: w.acceptance ?? [],
    ...(blocked ? { blocked } : {}),
    ...(w.handoff && status !== 'done' ? { handoff: { fromId: w.handoff.fromId, reason: w.handoff.reason, at: w.handoff.at } } : {}),
    ...(w.hold && status === 'backlog' ? { hold: true as const } : {}),
    ...(w.queuedFor && status === 'ready' ? { queuedFor: w.queuedFor } : {}),
    ...(w.mergedInto ? { mergedInto: w.mergedInto } : {}),
    ...(w.releasedIn ? { releasedIn: w.releasedIn } : {}),
    ...(w.docUrl ? { docUrl: w.docUrl } : {}),
    legacy: { kind: w.kind, state: w.state, ...(w.charterId ? { charterId: w.charterId } : {}), ...(w.featureId ? { featureId: w.featureId } : {}) },
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

/** Elapsed time the way a person says it (QA 2 Oct): "45 min", "3 hours", "4 days" — never raw minutes. */
export function humanDuration(ms: number): string {
  const min = Math.max(1, Math.floor(ms / 60_000));
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

/**
 * Authors are people (QA 2 Oct): an id that is a charter (`chief-of-staff`) rather than an employee
 * becomes the employee who holds it, so the apps can show a name. `owner`, `coo`, `workplace` and
 * employee ids are kept; anything else unknown is kept as given.
 */
export function authorId(wp: Workplace, by: string): string {
  if (!by || by === 'owner' || by === 'workplace' || wp.org.employees.some(e => e.id === by)) return by;
  const holder = wp.org.employees.find(e => !e.virtual && e.charterIds.includes(by)) ?? wp.org.employees.find(e => e.charterIds.includes(by));
  return holder?.id ?? by;
}
