import type {
  CreateItemRequest, EpicCard, EpicProgress, Focus, Item, ItemDetail, ItemStatus, PlanFlag, PlanHandoff, PlanResponse, Points, UpdateItemRequest, WorkItem,
} from '@jkj/shared';
import { ITEM_STATUSES, POINTS } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as work from './work.js';
import * as trail from './trail.js';
import * as areas from './areas.js';
import * as room from './room.js';
import * as watch from './watch.js';
import { now, rowsJson } from './store.js';
import * as waits from './waits.js';
import { authorId, chiefOfStaffId, epicOf, humanDuration, isPerson, isWaitable, levelOf, nameOf, projectItem, rawGet, stateFromStatus } from './v2-map.js';
import { BadRequest, NotFound } from '../util/errors.js';

/**
 * Workplace v2 items (HLD D18–D20, LLD §19.2–19.3): epics, stories and tasks over the one `work`
 * store, with the six-state machine and its rules. Every write goes through `work.put`, so the
 * trail (activity, Updates, room lines) is recorded the same way as the old engine's moves.
 */

/* ---------- reading ---------- */

export function toItem(wp: Workplace, w: WorkItem, nowMs = Date.now()): Item {
  const item = projectItem(wp, w);
  const stall = watch.evaluate(wp, w, nowMs);
  if (stall?.stalled && stall.rule) item.stall = { rule: stall.rule, since: stall.since, minutes: Math.floor((nowMs - Date.parse(stall.since)) / 60_000) };
  return item;
}

export function get(wp: Workplace, id: string): Item | undefined {
  const w = rawGet(wp, id);
  return w ? toItem(wp, w) : undefined;
}

export function require$(wp: Workplace, id: string): Item {
  const item = get(wp, id);
  if (!item) throw new NotFound(`No item ${id}`);
  return item;
}

function requireRow(wp: Workplace, id: string): WorkItem {
  const w = rawGet(wp, id);
  if (!w) throw new NotFound(`No item ${id}`);
  return w;
}

export interface ItemQuery { level?: string; status?: string; assigneeId?: string; areaId?: string; parentId?: string }

/** Rank order. `areaId` matches through the epic. */
export function list(wp: Workplace, q: ItemQuery = {}): Item[] {
  const where: string[] = [];
  const args: string[] = [];
  if (q.level) { where.push("coalesce(level, case kind when 'feature' then 'epic' else 'story' end) = ?"); args.push(q.level); }
  if (q.status) { where.push('status = ?'); args.push(q.status); }
  if (q.assigneeId) { where.push('employee_id = ?'); args.push(q.assigneeId); }
  if (q.parentId) { where.push('parent_id = ?'); args.push(q.parentId); }
  const rows = rowsJson<WorkItem>(wp.db.prepare(`select json from work${where.length ? ` where ${where.join(' and ')}` : ''} order by coalesce(rank, 0), created_at`).all(...args));
  const all = rows.map(w => toItem(wp, w));
  return q.areaId ? all.filter(i => i.areaId === q.areaId) : all;
}

function childrenRows(wp: Workplace, id: string): WorkItem[] {
  return rowsJson<WorkItem>(wp.db.prepare('select json from work where parent_id = ? order by coalesce(rank, 0), created_at').all(id));
}

/** Stories of an epic, wont-do and duplicates excluded. Points done ÷ points total; stories when nothing is pointed. */
export function progress(wp: Workplace, epicId: string): EpicProgress {
  const stories = childrenRows(wp, epicId).filter(s => levelOf(s) === 'story' && !(s.status === 'done' && s.resolution && s.resolution !== 'done'));
  const done = stories.filter(s => s.status === 'done');
  const pointsTotal = stories.reduce((n, s) => n + (s.points ?? 0), 0);
  const pointsDone = done.reduce((n, s) => n + (s.points ?? 0), 0);
  const pct = pointsTotal > 0 ? Math.round((pointsDone / pointsTotal) * 100) : stories.length ? Math.round((done.length / stories.length) * 100) : 0;
  return { pointsDone, pointsTotal, storiesDone: done.length, storiesTotal: stories.length, pct };
}

export function detail(wp: Workplace, id: string): ItemDetail {
  const w = requireRow(wp, id);
  const item = toItem(wp, w);
  const parent = item.parentId ? get(wp, item.parentId) : undefined;
  const epicRow = levelOf(w) === 'epic' ? w : epicOf(wp, w);
  const area = epicRow?.areaId ? areas.get(wp, epicRow.areaId) : undefined;
  const thread = epicRow ? room.getThread(wp, room.epicThreadId(epicRow.id)) : undefined;
  return {
    item,
    ...(parent ? { parent } : {}),
    ...(epicRow && epicRow.id !== w.id ? { epic: toItem(wp, epicRow) } : {}),
    ...(area ? { area } : {}),
    children: childrenRows(wp, id).map(c => toItem(wp, c)),
    comments: trail.comments(wp, id),
    activity: trail.activityFor(wp, id),
    ...(levelOf(w) === 'epic' ? { progress: progress(wp, id) } : {}),
    ...(thread ? { threadId: thread.id } : {}),
  };
}

/* ---------- creating ---------- */

const normal = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** An open item with the same normalised title under the same parent (one story per outcome). */
export function duplicateOf(wp: Workplace, parentId: string | undefined, title: string): Item | undefined {
  if (!parentId) return undefined;
  const t = normal(title);
  const twin = childrenRows(wp, parentId).find(c => normal(c.title) === t && c.status !== 'done');
  return twin ? toItem(wp, twin) : undefined;
}

function checkPoints(p: unknown): Points | undefined {
  if (p === undefined || p === null) return undefined;
  if (!POINTS.includes(p as Points)) throw new BadRequest(`points must be one of ${POINTS.join(', ')}`);
  return p as Points;
}

function checkAssignee(wp: Workplace, id: string | undefined): void {
  if (id && !isPerson(wp, id)) throw new BadRequest(`No employee ${id}`);
}

export function create(wp: Workplace, req: CreateItemRequest, by: string): Item {
  const title = typeof req.title === 'string' ? req.title.trim() : '';
  if (req.acceptance !== undefined && (!Array.isArray(req.acceptance) || req.acceptance.some(a => typeof a !== 'string'))) throw new BadRequest('acceptance must be a list of strings');
  if (!title) throw new BadRequest('An item needs a title.');
  if (!['epic', 'story', 'task'].includes(req.level)) throw new BadRequest('level must be epic, story or task');
  const points = checkPoints(req.points);
  checkAssignee(wp, req.assigneeId);
  checkAssignee(wp, req.reviewerId);
  checkAssignee(wp, req.ownerId);
  if (req.status && req.status !== 'backlog' && req.status !== 'ready') throw new BadRequest('A new item starts in backlog or ready.');
  if (req.reviewerId && req.reviewerId === req.assigneeId) throw new BadRequest('The reviewer cannot be the assignee.');
  const common = {
    ...(points ? { points } : {}),
    ...(req.reviewerId ? { reviewerId: req.reviewerId } : {}),
    ...(req.targetDate ? { targetDate: req.targetDate } : {}),
    ...(req.acceptance?.length ? { acceptance: req.acceptance.map(a => a.trim()).filter(Boolean) } : {}),
    ...(typeof req.rank === 'number' ? { rank: req.rank } : {}),
    status: req.status ?? 'ready' as ItemStatus,
  };

  if (req.level === 'epic') {
    if (req.parentId) throw new BadRequest('An epic has no parent; it sits in an area.');
    if (req.areaId) areas.require$(wp, req.areaId);
    const w = work.create(wp, {
      kind: 'feature', title, body: req.body ?? '', by,
      v2: { ...common, level: 'epic', ...(req.areaId ? { areaId: req.areaId } : {}), ...(req.ownerId ? { ownerId: req.ownerId } : {}) },
    });
    if (w.areaId) room.epicThread(wp, w);
    return toItem(wp, w);
  }

  if (!req.parentId) throw new BadRequest(`A ${req.level} needs a parent (${req.level === 'story' ? 'an epic' : 'a story'}).`);
  const parent = rawGet(wp, req.parentId);
  if (!parent) throw new BadRequest(`No parent ${req.parentId}`);
  const want = req.level === 'story' ? 'epic' : 'story';
  if (levelOf(parent) !== want) throw new BadRequest(`A ${req.level}'s parent must be ${want === 'epic' ? 'an epic' : 'a story'}.`);
  const epic = req.level === 'story' ? parent : epicOf(wp, parent);
  const w = work.create(wp, {
    kind: 'assignment', title, body: req.body ?? '', by,
    ...(req.assigneeId ? { employeeId: req.assigneeId } : {}),
    ...(epic ? { featureId: epic.id } : {}),
    v2: { ...common, level: req.level, parentId: parent.id, ...(common.status === 'backlog' && holdOnEntry(authorId(wp, by), undefined) ? { hold: true } : {}) },
  });
  // work.create picks a least-loaded holder only when given a charter; an unassigned item stays unassigned.
  return toItem(wp, w);
}

/* ---------- the state machine (LLD §19.3) ---------- */

const TRANSITIONS: Record<ItemStatus, ItemStatus[]> = {
  backlog: ['ready', 'in-progress', 'done'],
  ready: ['backlog', 'in-progress', 'blocked', 'done'],
  'in-progress': ['backlog', 'ready', 'in-review', 'blocked', 'done'],
  'in-review': ['in-progress', 'done', 'blocked'],
  blocked: ['backlog', 'ready', 'in-progress', 'in-review'],
  done: ['in-progress'],
};

/**
 * `converted`: the move is the server's own rewrite of a block on a teammate (LLD §19.6c), so the
 * transition table is not consulted (ready → in-review is allowed there); the other rules still hold.
 */
function checkMove(wp: Workplace, w: WorkItem, from: ItemStatus, to: ItemStatus, req: UpdateItemRequest, by: string, next: WorkItem, converted = false): void {
  if (!converted && from !== to && !TRANSITIONS[from].includes(to)) throw new BadRequest(`${levelOf(w)} ${w.id} cannot go from ${from} to ${to}`);
  const level = levelOf(w);
  if (to === 'in-review') {
    if (!next.reviewerId) throw new BadRequest('Name a reviewer before review: nothing sits in review with nobody reviewing.');
    if (next.reviewerId === next.employeeId) throw new BadRequest('The reviewer cannot be the assignee.');
  }
  if (to === 'blocked') {
    if (!req.blockedReason?.trim()) throw new BadRequest('Blocked needs a reason.');
    if (!req.waitingOn || !isWaitable(wp, req.waitingOn)) throw new BadRequest('Blocked needs who it is waiting on: an employee, coo, owner or external.');
  }
  if (to === 'done') {
    if (from === 'backlog' || from === 'ready') {
      if (by !== 'owner') throw new BadRequest('Closing work that never started is the owner\'s call.');
    } else if (level === 'epic') {
      if (by !== 'owner' && by !== w.ownerId) throw new BadRequest('An epic is closed by the owner or its owner.');
    } else if (from === 'in-progress') {
      if (by !== 'owner') throw new BadRequest('Done goes through review: name a reviewer and move it to in-review.');
    } else if (by !== 'owner' && by !== next.reviewerId) {
      throw new BadRequest('Only the reviewer (or the owner) marks it done; an assignee never verifies its own work.');
    }
    if (by === next.employeeId && by !== 'owner') throw new BadRequest('An assignee never marks its own work done.');
  }
  if (from === 'done' && !req.note?.trim()) throw new BadRequest('A reopen needs a note: what was wrong with "done"?');
}

/** The assignee, and the charter that follows it (as any reassign does). */
function setAssignee(wp: Workplace, next: WorkItem, employeeId: string): void {
  next.employeeId = employeeId;
  const charter = wp.org.employees.find(e => e.id === employeeId)?.charterIds[0];
  if (charter) next.charterId = charter; else delete next.charterId;
}

const clause = (t: string): string => t.trim().replace(/[.\s]+$/, '');

/** A note that parks on purpose (LLD §19.6d). The watcher's "busy"/"not in focus" notes never match. */
export const HOLD_NOTE = /\b(on hold|hold|held|park|parked|parking)\b/i;

/** Whether a move into Backlog holds it: an explicit `hold` wins; else the owner/COO moving it, or a hold note. */
export function holdOnEntry(by: string, note: string | undefined, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return by === 'owner' || by === 'coo' || (!!note && HOLD_NOTE.test(note));
}

/** Set or clear `hold` on the next row; returns whether it is held. */
function applyHold(next: WorkItem, entering: boolean, explicit: boolean | undefined, by: string, note: string | undefined): boolean {
  let held: boolean;
  if (next.status !== 'backlog') held = false;
  else if (entering) held = holdOnEntry(by, note, explicit);
  else held = explicit ?? !!next.hold;
  if (held) next.hold = true; else delete next.hold;
  return held;
}

/** Back to whoever handed it (LLD §19.6c): the earlier handoff, if any, is open again. */
function applyHandback(wp: Workplace, prev: WorkItem, next: WorkItem, byId: string, note: string, at: string): string {
  const toId = prev.handoff!.fromId;
  setAssignee(wp, next, toId);
  if (prev.handoff!.prev) next.handoff = prev.handoff!.prev; else delete next.handoff;
  next.handedBack = { toId, byId, note: note.trim(), at };
  return `Handed back to ${nameOf(wp, toId)} by ${nameOf(wp, byId)}: ${clause(note)}`;
}

/**
 * `rewait` (the boot migration, LLD §19.6c): re-apply an existing Blocked item's wait through the
 * classification; a block that is still a block is left exactly as it is.
 */
export function update(wp: Workplace, id: string, req: UpdateItemRequest, given: string, opts: { rewait?: boolean } = {}): Item {
  const by = authorId(wp, given);
  const prev = requireRow(wp, id);
  const level = levelOf(prev);
  const next: WorkItem = { ...prev };
  const at = now();

  for (const k of ['title', 'body', 'assigneeId', 'reviewerId', 'ownerId', 'parentId', 'blockedReason', 'waitingOn', 'note', 'recommendation', 'status', 'resolution'] as const) {
    if (req[k] !== undefined && typeof req[k] !== 'string') throw new BadRequest(`${k} must be a string`);
  }
  if (req.acceptance !== undefined && (!Array.isArray(req.acceptance) || req.acceptance.some(a => typeof a !== 'string'))) throw new BadRequest('acceptance must be a list of strings');
  if (req.resolution !== undefined && !['done', 'wont-do', 'duplicate'].includes(req.resolution)) throw new BadRequest('resolution must be done, wont-do or duplicate');
  if (req.kind !== undefined && req.kind !== 'review' && req.kind !== 'work') throw new BadRequest('kind must be review or work');
  if (req.title !== undefined) { if (!req.title.trim()) throw new BadRequest('An item needs a title.'); next.title = req.title.trim(); }
  if (req.body !== undefined) next.body = req.body;
  if (req.assigneeId !== undefined && req.assigneeId !== prev.employeeId) {
    checkAssignee(wp, req.assigneeId);
    next.employeeId = req.assigneeId;
    const charter = wp.org.employees.find(e => e.id === req.assigneeId)?.charterIds[0];
    if (charter) next.charterId = charter; else delete next.charterId;
  }
  if (req.reviewerId !== undefined) { checkAssignee(wp, req.reviewerId); next.reviewerId = req.reviewerId; }
  if (req.ownerId !== undefined) { checkAssignee(wp, req.ownerId); next.ownerId = req.ownerId; }
  if (req.points !== undefined) { const p = checkPoints(req.points); if (p) next.points = p; else delete next.points; }
  if (typeof req.rank === 'number' && Number.isFinite(req.rank)) next.rank = req.rank;
  if (req.targetDate !== undefined) { if (req.targetDate) next.targetDate = req.targetDate; else delete next.targetDate; }
  if (req.acceptance !== undefined) next.acceptance = req.acceptance.map(a => a.trim()).filter(Boolean);
  if (req.areaId !== undefined) {
    if (level !== 'epic') throw new BadRequest('Only an epic sits in an area; its stories follow it.');
    if (req.areaId) { areas.require$(wp, req.areaId); next.areaId = req.areaId; } else delete next.areaId;
  }
  if (req.parentId !== undefined && req.parentId !== prev.parentId) {
    if (level === 'epic') throw new BadRequest('An epic has no parent.');
    const parent = rawGet(wp, req.parentId);
    const want = level === 'story' ? 'epic' : 'story';
    if (!parent || levelOf(parent) !== want) throw new BadRequest(`A ${level}'s parent must be ${want === 'epic' ? 'an epic' : 'a story'}.`);
    next.parentId = parent.id;
    const epic = level === 'story' ? parent : epicOf(wp, parent);
    if (epic) next.featureId = epic.id;
  }

  const from = prev.status ?? 'ready';
  if (req.hold !== undefined) {
    if (typeof req.hold !== 'boolean') throw new BadRequest('hold must be true or false');
    if (by !== 'owner' && by !== 'coo') throw new BadRequest('Only the owner or the COO holds an item (or lifts a hold).');
    if (req.hold && req.status && req.status !== 'backlog') throw new BadRequest('A hold parks an item in Backlog: move it to backlog with it, or leave the status out.');
  }
  // hold: true with no status parks it in Backlog (LLD §19.6d).
  const wanted = req.status ?? (req.hold === true && from !== 'backlog' ? 'backlog' : undefined);
  let to = wanted && (wanted !== from || (opts.rewait && from === 'blocked')) ? wanted : undefined;
  if (req.status && !ITEM_STATUSES.includes(req.status)) throw new BadRequest(`Unknown status ${req.status}`);

  // A wait on a teammate is never Blocked (owner, 2 Oct; LLD §19.6c): a review, or a handoff.
  let converted = false;
  let line: string | undefined;
  if (to === 'blocked') {
    checkMove(wp, prev, from, 'blocked', req, by, next);
    const waitingOn = req.waitingOn!;
    const reason = req.blockedReason!.trim();
    const wait = level === 'epic' ? 'block' : waits.classify(wp, { assigneeId: next.employeeId, waitingOn, reason, kind: req.kind });
    if (wait === 'block' && opts.rewait && from === 'blocked') return toItem(wp, prev);
    if (wait === 'review') {
      converted = true;
      next.reviewerId = waitingOn;
      to = from === 'in-review' ? undefined : 'in-review';
      line = `In review with ${nameOf(wp, waitingOn)}: ${clause(reason)} (a wait on a teammate's review is a review, not a block)`;
    } else if (wait === 'handoff') {
      converted = true;
      to = from === 'in-progress' ? undefined : 'in-progress';
      if (prev.handoff && prev.handoff.fromId === waitingOn) {
        line = applyHandback(wp, prev, next, next.employeeId ?? by, reason, at);
      } else {
        const fromId = next.employeeId ?? (isPerson(wp, by) ? by : undefined);
        setAssignee(wp, next, waitingOn);
        if (fromId) {
          next.handoff = { fromId, reason, at, ...(prev.handoff ? { prev: prev.handoff } : {}) };
          line = `Handed to ${nameOf(wp, waitingOn)}: ${clause(reason)}; returns to ${nameOf(wp, fromId)}`;
        } else {
          line = `Assigned to ${nameOf(wp, waitingOn)}: ${clause(reason)}`;
        }
      }
    }
  }
  if (to) {
    checkMove(wp, prev, from, to, req, by, next, converted);
    next.status = to;
    next.statusSince = at;
    if (to === 'done') next.resolution = req.resolution ?? (from === 'backlog' || from === 'ready' ? 'wont-do' : 'done');
    else delete next.resolution;
    if (to === 'blocked') {
      next.blockedReason = req.blockedReason!.trim();
      next.waitingOn = req.waitingOn!;
      next.blockedSince = at;
      if (req.recommendation?.trim()) next.blockedRecommendation = req.recommendation.trim();
    } else if (from === 'blocked') {
      delete next.blockedReason; delete next.waitingOn; delete next.blockedSince; delete next.blockedRecommendation;
    }
    const state = stateFromStatus(prev, to, next.resolution);
    if (state !== prev.state) {
      next.history = [...prev.history, { at, from: prev.state, to: state, by, ...(req.note ? { note: req.note } : {}) }];
      next.state = state;
      if (to === 'done' && prev.kind !== 'feature' && by !== prev.employeeId) next.verifiedBy = by;
    }
  } else if (from === 'in-review' && next.reviewerId === next.employeeId) {
    throw new BadRequest('The reviewer cannot be the assignee.');
  }
  if (next.status === 'done') delete next.handoff;
  // Queued for a busy assignee (LLD §19.6d) only while Ready with that assignee.
  if (to || next.employeeId !== prev.employeeId) delete next.queuedFor;
  // Held Backlog (LLD §19.6d): the owner/COO parking it, or a hold note; lifted by hold: false or leaving Backlog.
  const held = applyHold(next, to === 'backlog', req.hold, by, req.note);
  next.updatedAt = at;
  const saved = work.put(wp, prev, next, by, req.note);
  if (held && !prev.hold) trail.record(wp, { itemId: id, by, kind: 'note', text: `Held in Backlog by ${nameOf(wp, by)}: the dispatcher will not start it` });
  if (line) trail.record(wp, { itemId: id, by, kind: 'note', text: line });
  if (level === 'epic' && saved.areaId && saved.areaId !== prev.areaId) room.epicThread(wp, saved);
  // `start: true` (hand it to the assignee's session) is the route's to act on: POST /api/items/:id.
  return toItem(wp, saved);
}

/**
 * Hand an item back to whoever handed it over (LLD §19.6c; tool `item_handback`, POST
 * /api/items/:id/handback): by the one who has it, the owner, the COO or the Chief of Staff.
 */
export function handback(wp: Workplace, id: string, note: string, given: string): Item {
  const by = authorId(wp, given);
  const prev = requireRow(wp, id);
  if (!prev.handoff) throw new BadRequest(`${id} is not handed over: there is nothing to hand back.`);
  if (typeof note !== 'string' || !note.trim()) throw new BadRequest('A handback needs a note: what you did, and what is left.');
  if (by !== prev.employeeId && by !== 'owner' && by !== 'coo' && by !== chiefOfStaffId(wp)) {
    throw new BadRequest(`Only ${nameOf(wp, prev.employeeId)} (who has it), the owner, the COO or the Chief of Staff hands it back.`);
  }
  const at = now();
  const next: WorkItem = { ...prev };
  const line = applyHandback(wp, prev, next, by, note, at);
  const from = prev.status ?? 'ready';
  if (from !== 'in-progress' && from !== 'done') {
    next.status = 'in-progress';
    next.statusSince = at;
    delete next.resolution;
    if (from === 'blocked') { delete next.blockedReason; delete next.waitingOn; delete next.blockedSince; delete next.blockedRecommendation; }
    const state = stateFromStatus(prev, 'in-progress');
    if (state !== prev.state) { next.history = [...prev.history, { at, from: prev.state, to: state, by, note: 'Handed back' }]; next.state = state; }
  }
  next.updatedAt = at;
  work.put(wp, prev, next, by, 'Handed back');
  trail.record(wp, { itemId: id, by, kind: 'note', text: line });
  return require$(wp, id);
}

/** A session started on a Ready/Backlog item: it is in progress now (and that is a "Started" line). */
export function markStarted(wp: Workplace, id: string, by: string): void {
  const prev = rawGet(wp, id);
  if (!prev || levelOf(prev) === 'epic' || (prev.status !== 'ready' && prev.status !== 'backlog')) return;
  const at = now();
  const next: WorkItem = { ...prev, status: 'in-progress', statusSince: at, updatedAt: at };
  delete next.hold; delete next.queuedFor;
  work.put(wp, prev, next, by, 'A session started on it');
}

/**
 * Ready, and its assignee busy (the watcher's not-started rule, LLD §19.6d): it stays Ready, queued for
 * them, and the dispatcher starts it the moment they are free. Never Backlog, never held.
 */
export function markQueued(wp: Workplace, id: string, by: string): void {
  const prev = rawGet(wp, id);
  if (!prev || !prev.employeeId || prev.status !== 'ready' || prev.queuedFor === prev.employeeId) return;
  const next: WorkItem = { ...prev, queuedFor: prev.employeeId, updatedAt: now() };
  work.put(wp, prev, next, by);
}

/* ---------- merging duplicates ---------- */

export function merge(wp: Workplace, id: string, intoId: string, by: string): Item {
  if (id === intoId) throw new BadRequest('An item cannot be merged into itself.');
  const source = requireRow(wp, id);
  const target = requireRow(wp, intoId);
  if (levelOf(source) !== levelOf(target)) throw new BadRequest('Merge a story into a story, a task into a task, an epic into an epic.');
  const at = now();
  for (const child of childrenRows(wp, id)) {
    const moved: WorkItem = { ...child, parentId: intoId, ...(levelOf(target) === 'epic' ? { featureId: intoId } : {}), updatedAt: at };
    work.put(wp, child, moved, by, `Moved from merged ${id}`);
  }
  const history = trail.activityFor(wp, id).map(a => `- ${a.at.slice(0, 16).replace('T', ' ')} ${a.by}: ${a.kind === 'status' || a.kind === 'reopen' ? `${a.from} → ${a.to}` : a.text}`).join('\n');
  const comments = trail.comments(wp, id).map(c => `- ${c.at.slice(0, 16).replace('T', ' ')} ${c.by}: ${c.details ?? c.text}`).join('\n');
  trail.comment(wp, intoId, {
    by: 'workplace',
    text: `Merged ${id} "${source.title}" into this item.`,
    details: [`## History of ${id}`, history || '(none)', comments ? `## Its comments\n${comments}` : ''].filter(Boolean).join('\n\n'),
  });
  const closed: WorkItem = {
    ...source, status: 'done', statusSince: at, resolution: 'duplicate', mergedInto: intoId, updatedAt: at,
    ...(source.state !== stateFromStatus(source, 'done', 'duplicate') ? {
      state: stateFromStatus(source, 'done', 'duplicate'),
      history: [...source.history, { at, from: source.state, to: stateFromStatus(source, 'done', 'duplicate'), by, note: `merged into ${intoId}` }],
    } : {}),
  };
  delete closed.blockedReason; delete closed.waitingOn; delete closed.blockedSince;
  work.put(wp, source, closed, by, `Merged into ${intoId}`);
  trail.record(wp, { itemId: intoId, by, kind: 'merged', text: `Merged ${id} "${source.title}" into this` });
  return require$(wp, intoId);
}

/* ---------- focus (HLD D20) ---------- */

export function getFocus(wp: Workplace): Focus {
  const row = wp.db.prepare("select value from settings where key = 'focus'").get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) as Focus : { epicIds: [], setBy: 'nobody', at: '' };
}

export function setFocus(wp: Workplace, epicIds: string[], by: string): Focus {
  for (const id of epicIds) {
    const w = rawGet(wp, id);
    if (!w || levelOf(w) !== 'epic') throw new BadRequest(`${id} is not an epic; the focus is a list of epics.`);
  }
  const focus: Focus = { epicIds: [...new Set(epicIds)], setBy: by, at: now() };
  wp.db.prepare("insert or replace into settings (key, value) values ('focus', ?)").run(JSON.stringify(focus));
  trail.record(wp, { itemId: null, by, kind: 'note', text: `Focus: ${focus.epicIds.map(e => rawGet(wp, e)!.title).join(', ') || 'none'}` });
  return focus;
}

export function inFocus(wp: Workplace, w: WorkItem): boolean {
  const epic = levelOf(w) === 'epic' ? w : epicOf(wp, w);
  return !!epic && getFocus(wp).epicIds.includes(epic.id);
}

/* ---------- the Plan (LLD §19.8) ---------- */

function flagsFor(wp: Workplace, epicId: string, nowMs: number): PlanFlag[] {
  const flags: PlanFlag[] = [];
  const visit = (rows: WorkItem[]): void => {
    for (const r of rows) {
      const it = toItem(wp, r, nowMs);
      const handed = it.handoff && it.assigneeId ? { handoff: { withId: it.assigneeId, fromId: it.handoff.fromId } } : {};
      if (it.blocked) flags.push({ kind: 'blocked', itemId: it.id, title: it.title, reason: it.blocked.reason, waitingOn: it.blocked.waitingOn, since: it.blocked.since, ...handed });
      else if (it.stall) flags.push({ kind: 'stalled', itemId: it.id, title: it.title, reason: stallReason(it.stall.rule, nowMs - Date.parse(it.stall.since)), waitingOn: stallActor(wp, r, it.stall.since), since: it.stall.since, ...handed });
      if (levelOf(r) === 'story') visit(childrenRows(wp, r.id));
    }
  };
  visit(childrenRows(wp, epicId));
  return flags;
}

/** Items of an epic handed to a teammate (LLD §19.6c): "with <withId> (handed by <fromId>)". */
function handoffsFor(wp: Workplace, epicId: string): PlanHandoff[] {
  const out: PlanHandoff[] = [];
  const visit = (rows: WorkItem[]): void => {
    for (const r of rows) {
      if (r.handoff && r.employeeId && r.status !== 'done') out.push({ itemId: r.id, title: r.title, withId: r.employeeId, fromId: r.handoff.fromId, reason: r.handoff.reason, at: r.handoff.at });
      if (levelOf(r) === 'story') visit(childrenRows(wp, r.id));
    }
  };
  visit(childrenRows(wp, epicId));
  return out;
}

/** "In review 4 days, untouched" (QA 2 Oct: it read "In review for 5760 min, untouched"). */
export function stallReason(rule: 'not-started' | 'idle' | 'unreviewed', ms: number): string {
  const d = humanDuration(ms);
  return rule === 'not-started' ? `Ready ${d}, not started` : rule === 'idle' ? `In progress ${d}, no activity` : `In review ${d}, untouched`;
}

/**
 * Who acts on a stall (QA 2 Oct: stalled flags had no waitingOn): the COO, who hears of every stall
 * (LLD §19.6) — or the assignee once it flagged its own stall in this episode without naming anyone.
 */
function stallActor(wp: Workplace, w: WorkItem, since: string): string {
  const selfFlag = w.employeeId && trail.activityFor(wp, w.id).some(a => a.kind === 'stall' && a.by === w.employeeId && a.at >= since);
  // Asha owns stall handling (LLD §19.6e): she acts unless the assignee flagged it itself.
  return selfFlag ? w.employeeId! : chiefOfStaffId(wp) ?? 'coo';
}

function card(wp: Workplace, epic: WorkItem, focus: Focus, nowMs: number): EpicCard {
  const next = childrenRows(wp, epic.id).find(s => levelOf(s) === 'story' && s.status !== 'done');
  const handoffs = handoffsFor(wp, epic.id);
  return {
    epic: toItem(wp, epic, nowMs),
    progress: progress(wp, epic.id),
    ...(next ? { next: { id: next.id, title: next.title } } : {}),
    flags: flagsFor(wp, epic.id, nowMs),
    ...(handoffs.length ? { handoffs } : {}),
    inFocus: focus.epicIds.includes(epic.id),
  };
}

export function plan(wp: Workplace, view?: 'board', nowMs = Date.now()): PlanResponse {
  const focus = getFocus(wp);
  const epics = rowsJson<WorkItem>(wp.db.prepare("select json from work where coalesce(level, case kind when 'feature' then 'epic' else 'story' end) = 'epic' order by coalesce(rank, 0), created_at").all())
    .filter(e => !(e.status === 'done' && e.resolution && e.resolution !== 'done'));
  const active = areas.list(wp).filter(a => a.state === 'active');
  const activeIds = new Set(active.map(a => a.id));
  const work$ = rowsJson<WorkItem>(wp.db.prepare("select json from work where coalesce(level, case kind when 'feature' then 'epic' else 'story' end) != 'epic'").all());
  const counts = Object.fromEntries(ITEM_STATUSES.map(s => [s, 0])) as Record<ItemStatus, number>;
  for (const w of work$) counts[w.status ?? 'ready'] += 1;
  const response: PlanResponse = {
    areas: active.map(area => ({ area, epics: epics.filter(e => e.areaId === area.id).map(e => card(wp, e, focus, nowMs)) })),
    unfiled: epics.filter(e => !e.areaId || !activeIds.has(e.areaId)).map(e => card(wp, e, focus, nowMs)),
    mine: work$.filter(w => w.employeeId === 'owner' && w.status !== 'done').map(w => toItem(wp, w, nowMs)),
    focus,
    counts,
  };
  if (view === 'board') {
    const board = Object.fromEntries(ITEM_STATUSES.map(s => [s, [] as Item[]])) as Record<ItemStatus, Item[]>;
    for (const w of [...work$].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))) board[w.status ?? 'ready'].push(toItem(wp, w, nowMs));
    response.board = board;
  }
  return response;
}
