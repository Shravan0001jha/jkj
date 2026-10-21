import type { WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as items from './items.js';
import { levelOf } from './v2-map.js';
import { rowsJson } from './store.js';

/**
 * ONE definition of "unrouted", shared by the Chief of Staff's board check, the hygiene rule (f) and the
 * dispatcher's routing queue (21 Oct, as_mve7w38dtitne: a P0 sat unassigned 2.5 days because each of the three
 * had its own filter, and all three dropped a story that "starts after" an item that never finished).
 *
 * A story is unrouted when it is open (not Done, not Parked), is not an epic, is not merged into another or held,
 * and has no assignee, or an assignee who is not in the org. Epic focus, type, priority, RCA, legacy state and
 * startsAfter do not matter: someone must still say who owns it. The one exception is Backlog outside the
 * focus, which is parked on purpose and never auto-started.
 */
export const OPEN_STATUSES = ['ready', 'backlog', 'in-progress', 'blocked', 'waiting', 'in-review'] as const;

/** Who an assignee may be: anyone in the org, or the owner. */
export const knownAssignee = (wp: Workplace, id: string | undefined): boolean =>
  !!id && (id === 'owner' || wp.org.employees.some(e => e.id === id));

export function isUnrouted(wp: Workplace, w: WorkItem, focus = items.getFocus(wp).epicIds): boolean {
  if (levelOf(w) === 'epic' || w.mergedInto || w.hold) return false;
  if (!(OPEN_STATUSES as readonly string[]).includes(w.status ?? 'ready')) return false;
  if (knownAssignee(wp, w.employeeId)) return false;
  return w.status !== 'backlog' || (!!w.featureId && focus.includes(w.featureId));
}

export function unrouted(wp: Workplace): WorkItem[] {
  const focus = items.getFocus(wp).epicIds;
  const marks = OPEN_STATUSES.map(() => '?').join(',');
  return rowsJson<WorkItem>(wp.db.prepare(`select json from work where status in (${marks})`).all(...OPEN_STATUSES))
    .filter(w => isUnrouted(wp, w, focus))
    .sort((a, b) => (a.statusSince ?? a.createdAt).localeCompare(b.statusSince ?? b.createdAt));
}
