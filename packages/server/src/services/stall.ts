import type { WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as runs from './runs.js';
import * as work from './work.js';
import * as employees from './employees.js';

/**
 * Stalled work is visible work (lead, 27 Sep): an assignment in progress with no session
 * activity for longer than the threshold. Derived at read time, never stored, so it can never
 * be stale itself.
 */

const IN_PROGRESS = new Set<WorkItem['state']>(['proposed', 'planned', 'building']);

export function stallMs(wp: Workplace): number {
  return wp.config.stallMinutes * 60 * 1000;
}

/** When the assignment was last worked on: the newest of its updates, its sessions and live transcript. */
export function lastActivity(wp: Workplace, item: WorkItem): number {
  let last = new Date(item.updatedAt).getTime();
  const row = wp.db.prepare('select started_at, ended_at from sessions where assignment_id = ? order by started_at desc limit 1').get(item.id) as { started_at: string; ended_at: string | null } | undefined;
  if (row) last = Math.max(last, new Date(row.ended_at ?? row.started_at).getTime());
  const open = item.employeeId ? employees.openSession(item.employeeId) : undefined;
  if (open && open.assignmentId === item.id) {
    const idle = runs.idleMs(open.agentId);
    if (idle !== null) last = Math.max(last, Date.now() - idle);
  }
  return last;
}

export function stalledSince(wp: Workplace, item: WorkItem, nowMs = Date.now()): string | undefined {
  if (item.kind !== 'assignment' || !IN_PROGRESS.has(item.state)) return undefined;
  // Backlog is parked (HLD D19): never stalled, so nothing old resumes it either.
  if (item.status === 'backlog') return undefined;
  const open = item.employeeId ? employees.openSession(item.employeeId) : undefined;
  if (open && open.assignmentId === item.id && runs.getRunAgent(open.agentId)?.status === 'running') return undefined;
  const last = lastActivity(wp, item);
  return nowMs - last > stallMs(wp) ? new Date(last).toISOString() : undefined;
}

/** The same items, with `stalledSince` set where it applies. */
export function annotate(wp: Workplace, items: WorkItem[], nowMs = Date.now()): WorkItem[] {
  return items.map(item => {
    const since = stalledSince(wp, item, nowMs);
    return since ? { ...item, stalledSince: since } : item;
  });
}

export function stalledAssignments(wp: Workplace, nowMs = Date.now()): WorkItem[] {
  return annotate(wp, work.list(wp, { kind: 'assignment' }), nowMs)
    .filter(a => a.stalledSince)
    .sort((a, b) => a.stalledSince!.localeCompare(b.stalledSince!));
}
