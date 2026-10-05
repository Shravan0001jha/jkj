import type { WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as items from './items.js';
import * as work from './work.js';
import * as trail from './trail.js';
import * as manager from './manager.js';
import { tell } from './blocks.js';
import { dependentsOf, finished, label, trueStatus } from './lifecycle.js';
import { levelOf, nameOf, rawGet, stateFromStatus } from './v2-map.js';
import { now } from './store.js';
import { log } from '../util/logger.js';

/**
 * The lifecycle's automatic moves (docs/HLD-jira-lifecycle.md §2–3):
 *
 * - A story's PR merged: the story is Done (resolution done) if it was not, so the board shows Merged,
 *   and Asha is told to close it (Merged → Done). Called by the merge itself, and by the hygiene sweep
 *   for a merge that happened elsewhere.
 * - An item finished (Merged, or Done when it has no PR): each item that starts after it, or is
 *   Blocked waiting on it, flips to Ready (a held Backlog stays held) and its assignee is told. Once
 *   per dependent and blocker (`dep-ready:<dependent>:<blocker>`).
 */

const noun = (w: WorkItem): string => (levelOf(w) === 'task' ? 'task' : w.type === 'bug' ? 'bug' : 'story');
const DEP_KEY = (dep: string, blocker: string): string => `dep-ready:${dep}:${blocker}`;

export function onMerged(wp: Workplace, id: string, by = 'workplace'): 'moved' | 'told' | null {
  const prev = rawGet(wp, id);
  if (!prev?.pr?.merged || prev.closedAt) return null;
  let moved = false;
  if (prev.status !== 'done') {
    const at = now();
    const next: WorkItem = { ...prev, status: 'done', statusSince: at, resolution: 'done', updatedAt: at };
    delete next.blockedReason; delete next.waitingOn; delete next.blockedSince; delete next.blockedRecommendation; delete next.handoff; delete next.hold; delete next.queuedFor;
    const state = stateFromStatus(prev, 'done', 'done');
    if (state !== prev.state) { next.state = state; next.history = [...prev.history, { at, from: prev.state, to: state, by, note: `PR #${prev.pr.number} merged` }]; }
    work.put(wp, prev, next, by, `PR #${prev.pr.number} merged`);
    moved = true;
  }
  const w = rawGet(wp, id)!;
  manager.alert(wp, {
    key: `merged:${id}:${w.pr!.merged!.at}`, itemId: id, by: 'workplace',
    title: `Merged: ${w.title}`,
    body: `PR #${w.pr!.number} is merged; the story shows Merged. Close it (item_update ${id} status done) so it shows Done.`,
    text: `Merged: "${w.title}" [${id}], PR #${w.pr!.number} by ${nameOf(wp, w.employeeId)}. Close it: item_update ${id} status done.`,
  });
  onFinished(wp, id);
  return moved ? 'moved' : 'told';
}

/** The blocker finished: its dependents flip to Ready and their assignees hear. Returns the ids flipped or told. */
export function onFinished(wp: Workplace, blockerId: string): string[] {
  const blocker = rawGet(wp, blockerId);
  if (!finished(blocker)) return [];
  const state = label(trueStatus(wp, blocker!));
  const out: string[] = [];
  for (const d of dependentsOf(wp, blockerId)) {
    const key = DEP_KEY(d.id, blockerId);
    if (wp.db.prepare('select 1 from settings where key = ?').get(key)) continue;
    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(key, now());
    const flip = d.status === 'blocked' || (d.status === 'backlog' && !d.hold && d.startsAfter === blockerId);
    if (flip) {
      try {
        items.update(wp, d.id, { status: 'ready', note: `"${blocker!.title}" is ${state}: ready to start` }, 'workplace');
      } catch (err) {
        log.warn('lifecycle', `${d.id}: could not flip to Ready: ${err instanceof Error ? err.message : err}`);
        continue;
      }
    }
    const now$ = rawGet(wp, d.id)!;
    const how = d.employeeId ? tell(wp, d.employeeId,
      `"${blocker!.title}" [${blockerId}] is ${state}. Your ${noun(d)} ${d.id} "${d.title}" starts after it: it is ${label(trueStatus(wp, now$))} now. ` +
      'Start it when it is the top of your queue.') : null;
    trail.record(wp, { itemId: d.id, by: 'workplace', kind: 'note', text: `"${blocker!.title}" is ${state}${flip ? ': moved to Ready' : ''}${d.employeeId ? `; ${how ? 'told' : 'could not reach'} ${nameOf(wp, d.employeeId)}` : ''}` });
    out.push(d.id);
  }
  return out;
}

/** One item changed: a merge to record, or a finish to pass on. */
export function onItem(wp: Workplace, id: string): void {
  const w = rawGet(wp, id);
  if (!w) return;
  if (w.pr?.merged && w.status !== 'done') { onMerged(wp, id); return; }
  if (finished(w)) onFinished(wp, id);
}

/** Wire it to item changes. Returns stop(). */
export function startLifecycleWatch(wp: Workplace): () => void {
  let stopped = false;
  const off = wp.on(event => {
    if (event.type !== 'work.updated') return;
    const id = event.item.id;
    setImmediate(() => {
      if (stopped) return;
      try { onItem(wp, id); } catch (err) { log.warn('lifecycle', `${id}: ${err instanceof Error ? err.message : err}`); }
    });
  });
  return () => { stopped = true; off(); };
}
