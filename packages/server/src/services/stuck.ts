import type { WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as employees from './employees.js';
import * as manager from './manager.js';
import * as reviewWake from './review-wake.js';
import * as floor from './floor.js';
import { stage } from './review-policy.js';
import { chiefOfStaffId, humanDuration, isAgent, levelOf, nameOf } from './v2-map.js';
import { rowsJson } from './store.js';
import { log } from '../util/logger.js';

/**
 * The stuck-story watchdog (dry run, 4 Oct). Every two minutes, and never while the floor is paused,
 * each open story or task is checked against three rules:
 *
 * - In progress: the assignee has no running or waiting session on it (nor one queued for a turn's end).
 * - In review: the expected reviewer (the developer approver or QA, per the stage) has no running or
 *   waiting session that has seen this review request (review-wake's record for this episode).
 * - Assigned to the Chief of Staff (Ready or In progress): not routed to a developer.
 *
 * A rule that holds for 10 minutes raises one manager alert to Asha (the story, the status, who is
 * expected, for how long, a suggested action); the manager escalates it to the COO when she has not
 * acted within 15 minutes. One alert per item and state (`stuck:<itemId>:<state>`); the condition
 * clearing resolves it, so it is never escalated after the fact.
 *
 * Settings: `stuck:<itemId>` = { state, since } (when the sweep first saw the condition). While the
 * floor is paused these are dropped, so the clock starts again after the resume.
 */

const MIN = 60_000;
export const STUCK_MS = 10 * MIN;
export const SWEEP_MS = 2 * MIN;
const PREFIX = 'stuck:';

interface Stuck {
  /** Identifies the condition: rule + who + the status episode. */
  state: string;
  /** What Asha reads. */
  status: string;
  expected: string;
  expectedId: string;
  why: string;
  action: string;
  subject: boolean;
}

interface Rec { state: string; since: string }

const get = (wp: Workplace, itemId: string): Rec | undefined => {
  const row = wp.db.prepare('select value from settings where key = ?').get(PREFIX + itemId) as { value: string } | undefined;
  if (!row) return undefined;
  try { return JSON.parse(row.value) as Rec; } catch { return undefined; }
};
const put = (wp: Workplace, itemId: string, r: Rec): void => void wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(PREFIX + itemId, JSON.stringify(r));
const drop = (wp: Workplace, itemId: string): void => void wp.db.prepare('delete from settings where key = ?').run(PREFIX + itemId);
const alertKey = (itemId: string, state: string): string => `stuck:${itemId}:${state}`;

function records(wp: Workplace): { itemId: string; rec: Rec }[] {
  const rows = wp.db.prepare('select key, value from settings where key like ?').all(`${PREFIX}%`) as { key: string; value: string }[];
  const out: { itemId: string; rec: Rec }[] = [];
  for (const r of rows) { try { out.push({ itemId: r.key.slice(PREFIX.length), rec: JSON.parse(r.value) as Rec }); } catch { /* skip */ } }
  return out;
}

/** Is an open PR waiting on review with no send-back since the last push (it belongs In review)? */
const prAwaitsReview = (w: WorkItem): boolean => !!w.pr && !w.pr.merged && (!w.pr.sendBack || w.pr.sendBack.at < w.pr.pushedAt);

/** The rule an item breaks now, or null. */
export function condition(wp: Workplace, w: WorkItem): Stuck | null {
  const level = levelOf(w);
  if (level === 'epic' || w.mergedInto) return null;
  const episode = w.statusSince ?? w.updatedAt;
  const cos = chiefOfStaffId(wp);
  const who = w.employeeId;

  if (who && who === cos && (w.status === 'ready' || w.status === 'in-progress')) {
    const name = nameOf(wp, who);
    const assigned = (wp.db.prepare("select max(at) as at from activity where item_id = ? and kind = 'assigned'").get(w.id) as { at: string | null } | undefined)?.at ?? w.createdAt;
    return {
      state: `routing:${who}:${assigned}`, status: w.status === 'ready' ? 'Ready' : 'In progress', expected: `${name} (Chief of Staff, to route it)`, expectedId: who,
      why: `assigned to ${name} for routing and not routed to a developer`,
      action: `reassign it to the owning developer by the ownership map (${name} routes it with item_update assigneeId)`, subject: false,
    };
  }
  if (w.status === 'in-progress' && who && isAgent(wp, who)) {
    if (employees.sessionOn(who, w.id)) return null;
    const name = nameOf(wp, who);
    return {
      state: `in-progress:${who}:${episode}`, status: 'In progress', expected: `${name} (assignee)`, expectedId: who,
      why: `${name} has no running or waiting session on it`,
      action: prAwaitsReview(w) ? `put back in review (its PR #${w.pr!.number} is still waiting on review)` : `wake ${name} (start them on it), or reassign`,
      subject: true,
    };
  }
  if (w.status === 'in-review' && w.reviewerId && isAgent(wp, w.reviewerId) && w.reviewerId !== who) {
    const reviewer = w.reviewerId;
    const wake = reviewWake.wakeOf(wp, w.id);
    const seen = !!wake && wake.reviewerId === reviewer && wake.episode === reviewWake.episodeNow(w) && wake.state !== 'queued' && !!wake.agentId && employees.isLive(wake.agentId);
    if (seen) return null;
    const name = nameOf(wp, reviewer);
    const role = w.pr && !w.pr.merged ? (stage(w) === 'dev' ? 'developer approver' : 'QA') : 'reviewer';
    return {
      state: `in-review:${reviewer}:${episode}`, status: 'In review', expected: `${name} (${role})`, expectedId: reviewer,
      why: `${name} has no running or waiting session that has seen the review request`,
      action: `wake ${name} for the review, or reassign the review`, subject: true,
    };
  }
  return null;
}

function clear(wp: Workplace, itemId: string, rec: Rec): void {
  drop(wp, itemId);
  manager.resolve(wp, alertKey(itemId, rec.state));
}

/** One sweep. Returns the alert keys raised (new or not) this pass. */
export function sweep(wp: Workplace, nowMs = Date.now()): string[] {
  if (floor.paused(wp)) {
    for (const { itemId, rec } of records(wp)) clear(wp, itemId, rec);
    return [];
  }
  const open = rowsJson<WorkItem>(wp.db.prepare("select json from work where status in ('ready', 'in-progress', 'in-review')").all());
  const live = new Set<string>();
  const raised: string[] = [];
  for (const w of open) {
    const c = condition(wp, w);
    const rec = get(wp, w.id);
    if (!c) { if (rec) clear(wp, w.id, rec); continue; }
    live.add(w.id);
    if (!rec || rec.state !== c.state) {
      if (rec) clear(wp, w.id, rec);
      put(wp, w.id, { state: c.state, since: new Date(nowMs).toISOString() });
      continue;
    }
    const lasted = nowMs - Date.parse(rec.since);
    if (lasted < STUCK_MS) continue;
    const key = alertKey(w.id, c.state);
    const text = `Stuck: "${w.title}" [${w.id}] is ${c.status}; expected: ${c.expected}; ${c.why}, for ${humanDuration(lasted)}. Suggested: ${c.action}.`;
    const result = manager.alert(wp, {
      key, itemId: w.id, by: 'workplace',
      title: `Stuck: ${w.title}`,
      body: `${c.status} for ${humanDuration(lasted)}: ${c.why}. Suggested: ${c.action}.`,
      text,
      ...(c.subject ? { subjectId: c.expectedId } : {}),
    }, nowMs);
    if (result !== 'duplicate') log.info('stuck', `${w.id}: ${c.state} for ${humanDuration(lasted)} (${result})`);
    raised.push(key);
  }
  for (const { itemId, rec } of records(wp)) if (!live.has(itemId)) clear(wp, itemId, rec);
  return raised;
}

/** Every two minutes. Returns stop(). */
export function startStuckWatch(wp: Workplace): () => void {
  const timer = setInterval(() => {
    try { sweep(wp); } catch (err) { log.warn('stuck', err instanceof Error ? err.message : String(err)); }
  }, SWEEP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
