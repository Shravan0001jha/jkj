import type {
  AuditEntry, CreateItemRequest, EpicCard, EpicProgress, Focus, Item, ItemDetail, ItemStatus, PlanFlag, PlanHandoff, PlanResponse, Points, StoryChain, UpdateItemRequest, WorkItem,
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
import * as lifecycle from './lifecycle.js';
import { doneProblem, earlyQaMoveProblem, githubMode } from './review-policy.js';
import { unlandedPatches } from './landing.js';
import { authorId, chiefOfStaffId, epicOf, humanDuration, isAgent, isPerson, isWaitable, levelOf, nameOf, projectItem, qaLead, rawGet, stateFromStatus } from './v2-map.js';
import { ctoId, isAbove, isTeamLead, leadOfCharter, managerOf, subtree, teamMembers, teamOf } from './org.js';
import { BadRequest, Forbidden, NotFound } from '../util/errors.js';

/**
 * Workplace v2 items (HLD D18–D20, LLD §19.2–19.3): epics, stories and tasks over the one `work`
 * store, with the six-state machine and its rules. Every write goes through `work.put`, so the
 * trail (activity, Updates, room lines) is recorded the same way as the old engine's moves.
 */

/* ---------- reading ---------- */

export function toItem(wp: Workplace, w: WorkItem, nowMs = Date.now()): Item {
  const item = lifecycle.decorate(wp, w, projectItem(wp, w));
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

export interface ItemQuery {
  level?: string;
  /** One status, or several comma-separated ("in-progress,in-review"). */
  status?: string;
  assigneeId?: string;
  /** Alias of assigneeId (docs/LLD-app-fixes.md §9); 'owner' = the owner's own items. */
  ownerId?: string;
  areaId?: string;
  parentId?: string;
  /** Case-insensitive text search over id, title and body. */
  q?: string;
  sort?: 'rank' | 'updated' | 'created' | 'title';
  order?: 'asc' | 'desc';
  /** Done items after open ones, the chosen order kept within each group. */
  finishedLast?: boolean;
}

export const ITEM_SORTS = ['rank', 'updated', 'created', 'title'] as const;

/** Rank order unless `sort` says otherwise. `areaId` matches through the epic. */
export function list(wp: Workplace, q: ItemQuery = {}): Item[] {
  const where: string[] = [];
  const args: string[] = [];
  if (q.level) { where.push("coalesce(level, case kind when 'feature' then 'epic' else 'story' end) = ?"); args.push(q.level); }
  const statuses = (q.status ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (statuses.length) { where.push(`status in (${statuses.map(() => '?').join(', ')})`); args.push(...statuses); }
  const owner = q.assigneeId ?? q.ownerId;
  if (owner) { where.push('employee_id = ?'); args.push(owner); }
  if (q.parentId) { where.push('parent_id = ?'); args.push(q.parentId); }
  const rows = rowsJson<WorkItem>(wp.db.prepare(`select json from work${where.length ? ` where ${where.join(' and ')}` : ''} order by coalesce(rank, 0), created_at`).all(...args));
  let all = rows.map(w => toItem(wp, w));
  if (q.areaId) all = all.filter(i => i.areaId === q.areaId);
  const needle = q.q?.trim().toLowerCase();
  if (needle) all = all.filter(i => i.id.toLowerCase().includes(needle) || i.title.toLowerCase().includes(needle) || (i.body ?? '').toLowerCase().includes(needle));
  const sort = q.sort ?? 'rank';
  const dir = q.order === 'desc' ? -1 : 1;
  const key: Record<NonNullable<ItemQuery['sort']>, (a: Item, b: Item) => number> = {
    rank: () => 0,   // already in rank order
    updated: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
    created: (a, b) => a.createdAt.localeCompare(b.createdAt),
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
  };
  const indexed = all.map((item, i) => ({ item, i }));
  indexed.sort((a, b) =>
    (q.finishedLast ? Number(a.item.status === 'done') - Number(b.item.status === 'done') : 0)
    || dir * (key[sort](a.item, b.item) || (sort === 'rank' ? a.i - b.i : 0))
    || a.i - b.i);
  return indexed.map(x => x.item);
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
    audit: audit(wp, id),
    chain: chain(wp, w),
  };
}

/* ---------- the audit and the chain (rework, Oct 2026: stories explain themselves) ---------- */

/** Auto-generated activity texts: not reasons. A row whose text matches reads "not recorded". */
const AUTO_TEXT: Partial<Record<string, RegExp>> = {
  created: /^(epic|story|task) created(, assigned to [^:]+)?$/,
  assigned: /^Assigned to [^:;]+$/,
  status: /^\S+ → \S+$/,
  reopen: /^Reopened$/,
  reviewer: /^Reviewer: [^:;]+$/,
};

/** A note that says the item was parked or held, and one that links its doc (W7 writes `Doc: …`). */
const PARK_NOTE = /^(Held in Backlog|Parked)\b/;
export const DOC_NOTE_PREFIX = 'Doc: ';

/**
 * Every change to an item and why, oldest first, built from its activity rows: created, assigned,
 * status, reopen and reviewer rows, plus the notes written for a hold, a park or a doc. A row whose
 * text is the auto-generated one ("a → b") has no recorded reason, so old stories read
 * "created by X / assigned to Y" and "reason: not recorded" with nothing backfilled.
 */
export function audit(wp: Workplace, itemId: string): AuditEntry[] {
  const rows = trail.activityFor(wp, itemId);
  const firstAssign = rows.find(a => a.kind === 'assigned');
  const current = rawGet(wp, itemId)?.employeeId;
  const reasonOf = (kind: string, text: string): string | undefined => {
    const t = text.trim();
    return !t || AUTO_TEXT[kind]?.test(t) ? undefined : t;
  };
  const out: AuditEntry[] = [];
  for (const a of rows) {
    const base = { at: a.at, by: a.by };
    switch (a.kind) {
      case 'created': {
        const to = firstAssign ? firstAssign.from || undefined : current;
        const reason = reasonOf('created', a.text);
        out.push({ ...base, kind: 'created', ...(to ? { to } : {}), ...(reason ? { reason } : {}) });
        break;
      }
      case 'assigned': case 'reviewer': {
        const reason = reasonOf(a.kind, a.text);
        out.push({ ...base, kind: a.kind, ...(a.from ? { from: a.from } : {}), ...(a.to ? { to: a.to } : {}), ...(reason ? { reason } : {}) });
        break;
      }
      case 'status': case 'reopen': {
        const reason = reasonOf(a.kind, a.text);
        const kind = a.kind === 'reopen' ? 'reopened' : a.to === 'parked' ? 'parked' : 'status';
        out.push({ ...base, kind, ...(a.from ? { from: a.from } : {}), ...(a.to ? { to: a.to } : {}), ...(reason ? { reason } : {}) });
        break;
      }
      case 'note': {
        if (PARK_NOTE.test(a.text)) out.push({ ...base, kind: 'parked', reason: a.text });
        else if (a.text.startsWith(DOC_NOTE_PREFIX)) out.push({ ...base, kind: 'doc', reason: a.text.slice(DOC_NOTE_PREFIX.length).trim() });
        break;
      }
      default: break;
    }
  }
  return out;
}

/** Whether someone reviews as QA: the QA lead or a member of the QA lead's team. */
function isQa(wp: Workplace, id: string | undefined): boolean {
  if (!id) return false;
  const team = teamOf(wp.org, id);
  return !!team && wp.org.employees.find(e => e.id === team)?.roleId === 'qa';
}

/**
 * The developer approver when the PR has not named one: an engineer's lead; for a lead (or anyone
 * whose manager is not a lead), another member of their team; else the CTO.
 */
function defaultDevReviewer(wp: Workplace, author: string | undefined): string | undefined {
  if (!author) return undefined;
  const manager = managerOf(wp.org, author);
  if (manager && isTeamLead(wp.org, manager)) return manager;
  const team = teamOf(wp.org, author);
  const mate = team ? teamMembers(wp.org, team).find(m => m !== author && isAgent(wp, m)) : undefined;
  return mate ?? ctoId(wp.org);
}

/** Everyone a story passes through: developer, reviewers, QA, charter, its lead, the Chief of Staff, the CTO. */
export function chain(wp: Workplace, w: WorkItem): StoryChain {
  const developer = w.employeeId && w.employeeId !== 'owner' ? w.employeeId : undefined;
  const pr = w.pr;
  const devReviewer = pr?.devReviewer ?? defaultDevReviewer(wp, developer);
  const extra = pr?.extraReviewers ?? w.extraReviewers ?? [];
  const qa = pr?.qaReviewer ?? (isQa(wp, w.reviewerId) ? w.reviewerId : undefined);
  const charterTitle = w.charterId ? wp.org.charters.get(w.charterId)?.title : undefined;
  const lead = leadOfCharter(wp.org, w.charterId) ?? (developer ? teamOf(wp.org, developer) : undefined);
  const cto = ctoId(wp.org);
  return {
    ...(developer ? { developer } : {}),
    ...(devReviewer ? { devReviewer } : {}),
    extraReviewers: extra.map(r => r.id),
    ...(qa ? { qa } : {}),
    ...(w.charterId ? { charterId: w.charterId } : {}),
    ...(charterTitle ? { charterTitle } : {}),
    ...(lead ? { lead } : {}),
    chiefOfStaff: chiefOfStaffId(wp) ?? 'coo',
    ...(cto ? { cto } : {}),
  };
}

/* ---------- who may change a story (rework, Oct 2026: the tree decides) ---------- */

/** Actors outside the tree check: the owner, the COO and the Workplace itself. */
const EXEMPT = new Set(['owner', 'coo', 'workplace']);

/** Whose story it is for the tree check: the assignee; an epic's owner; nobody's means the Chief of Staff's. */
function subjectOf(wp: Workplace, w: WorkItem): string | undefined {
  if (levelOf(w) === 'epic') return w.ownerId ?? w.employeeId ?? chiefOfStaffId(wp);
  return w.employeeId ?? chiefOfStaffId(wp);
}

/**
 * The tree check, for an employee actor (the owner, the COO and 'workplace' are exempt):
 * - any change: the actor is the assignee or above them, or is the current reviewer sending a story
 *   in review back, passing it on, or approving it;
 * - a reassignment: to someone below the actor, to the actor's manager, or to the actor; the Chief of
 *   Staff routes only to a lead or the QA lead ("route to the charter lead; the lead assigns within the team"),
 *   or moves a story between members of its current team (dry run #16).
 */
export function checkActor(wp: Workplace, actor: string, prev: WorkItem, patch: UpdateItemRequest): void {
  if (EXEMPT.has(actor) || !wp.org.employees.some(e => e.id === actor)) return;
  const from = prev.status ?? 'ready';
  const reassigning = patch.assigneeId !== undefined && patch.assigneeId !== prev.employeeId;
  const subject = subjectOf(wp, prev);
  const owns = !!subject && (subject === actor || isAbove(wp.org, actor, subject));
  const reviewing = actor === prev.reviewerId && from === 'in-review' && !reassigning
    && (patch.status === undefined || patch.status === 'in-review' || patch.status === 'in-progress' || patch.status === 'done');
  if (!owns && !reviewing) throw new Forbidden(`Forbidden: only ${nameOf(wp, subject)} or someone above them can change this story`);
  if (!reassigning) return;
  const to = patch.assigneeId!;
  if (actor === chiefOfStaffId(wp)) {
    // Dry run #16 (11 Oct): she may also move a story between members of one team below her (the lead
    // himself stalled); a new or unassigned story, or one changing teams, still goes to that team's lead.
    const from = prev.employeeId;
    const team = from ? teamOf(wp.org, from) : undefined;
    const sameTeam = !!team && team === teamOf(wp.org, to) && subtree(wp.org, actor).includes(to);
    if (to !== actor && !isTeamLead(wp.org, to) && !sameTeam) throw new Forbidden('Forbidden: route to the charter lead; the lead assigns within the team (you may move a story only between members of its own team)');
    return;
  }
  if (to === actor || to === managerOf(wp.org, actor) || subtree(wp.org, actor).includes(to)) return;
  throw new Forbidden(`Forbidden: reassign only to someone below you or to your manager (${nameOf(wp, managerOf(wp.org, actor))}); ${nameOf(wp, to)} is neither`);
}

/** The reason rule: a status or assignee change says why (at least 3 characters); 'workplace' is exempt. */
export const REASON_MIN = 3;
function reasonOf(req: UpdateItemRequest): string | undefined {
  const r = (req.reason ?? req.note ?? (req.status === 'blocked' || req.status === 'waiting' ? req.blockedReason : undefined))?.trim();
  return r && r.length >= REASON_MIN ? r : undefined;
}

/** The Chief of Staff giving a story to a lead (or the QA lead) other than herself: it is routed, for the lead to assign within the team. */
function routesToLead(wp: Workplace, by: string, to: string): boolean {
  const cos = chiefOfStaffId(wp);
  return !!cos && by === cos && to !== cos && isTeamLead(wp.org, to);
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

/**
 * `opts.reason`: why it is created this way ("filed by Arjun"), recorded as the created row's text.
 * A bug with no assignee goes to the QA lead first (rework, Oct 2026: QA posts the RCA, then routes it).
 * A bug filed with its complete five-part "## RCA" in the body skips that step (owner, 11 Oct: the
 * security review's findings sat in QA's queue with their RCA already written): the RCA is recorded,
 * the bug stays unassigned for the Chief of Staff to route by charter, and the QA lead gets an RCA
 * ticket beside it for why QA missed it.
 */
export function create(wp: Workplace, req0: CreateItemRequest, by: string, opts: { reason?: string } = {}): Item {
  let req = req0;
  let reason = opts.reason?.trim() || undefined;
  const filedRca = req.type === 'bug' && req.level === 'story' && !req.assigneeId && req.body ? work.parseRca(req.body) : null;
  if (filedRca && !filedRca.missing.length) {
    const item = createOne(wp, req, by, reason ?? `Filed by ${nameOf(wp, authorId(wp, by))} with its RCA: the Chief of Staff routes it by charter`);
    work.attachRca(wp, item.id, req.body!, by);
    const qa = qaLead(wp);
    if (qa) {
      createOne(wp, {
        level: 'story', parentId: req.parentId, type: 'rca', assigneeId: qa,
        title: `QA escape review: why QA missed "${item.title}"`,
        body: `The bug ${item.id} was filed with its RCA, so its fix goes straight to the owning developer. This ticket is QA's part: post a five-part "## RCA" on why our tests and QA passes did not catch it, and what QA now checks so it cannot escape again. No code.`,
      }, by, `QA's escape review for ${item.id}`);
    }
    return toItem(wp, rawGet(wp, item.id)!);
  }
  return createOne(wp, req, by, reason);
}

function createOne(wp: Workplace, req0: CreateItemRequest, by: string, reason0: string | undefined): Item {
  let req = req0;
  let reason = reason0;
  if (req.type === 'bug' && req.level === 'story' && !req.assigneeId && !(req.body && work.parseRca(req.body)?.missing.length === 0)) {
    const qa = qaLead(wp);
    if (qa) { req = { ...req, assigneeId: qa }; reason ??= `Filed by ${nameOf(wp, authorId(wp, by))}: a bug goes to QA first for its RCA`; }
  }
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
  if (req.type !== undefined && ((req.type !== 'bug' && req.type !== 'rca') || req.level !== 'story')) throw new BadRequest('type bug or rca is a story-level item: create it with level story under an epic.');
  if (req.startsAfter !== undefined) checkStartsAfter(wp, undefined, req.startsAfter);
  const common = {
    ...(req.level === 'story' && req.assigneeId && routesToLead(wp, authorId(wp, by), req.assigneeId) ? { routedAt: now() } : {}),
    ...(points ? { points } : {}),
    ...(req.reviewerId ? { reviewerId: req.reviewerId } : {}),
    ...(req.targetDate ? { targetDate: req.targetDate } : {}),
    ...(req.acceptance?.length ? { acceptance: req.acceptance.map(a => a.trim()).filter(Boolean) } : {}),
    ...(typeof req.rank === 'number' ? { rank: req.rank } : {}),
    ...(req.type === 'bug' || req.type === 'rca' ? { type: req.type } : {}),
    ...(req.startsAfter ? { startsAfter: req.startsAfter } : {}),
    status: req.status ?? 'ready' as ItemStatus,
  };

  if (req.level === 'epic') {
    if (req.parentId) throw new BadRequest('An epic has no parent; it sits in an area.');
    if (req.areaId) areas.require$(wp, req.areaId);
    const w = work.create(wp, {
      kind: 'feature', title, body: req.body ?? '', by, ...(reason ? { note: reason } : {}),
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
    kind: 'assignment', title, body: req.body ?? '', by, ...(reason ? { note: reason } : {}),
    ...(req.assigneeId ? { employeeId: req.assigneeId } : {}),
    ...(epic ? { featureId: epic.id } : {}),
    v2: { ...common, level: req.level, parentId: parent.id, ...(common.status === 'backlog' && holdOnEntry(authorId(wp, by), undefined) ? { hold: true } : {}) },
  });
  // work.create picks a least-loaded holder only when given a charter; an unassigned item stays unassigned.
  return toItem(wp, w);
}

/* ---------- the state machine (LLD §19.3) ---------- */

/**
 * Rework (Oct 2026): `waiting` and `parked` are entered from ready or in-progress (and parked from
 * Backlog too: a hold parks it), and leave to ready, in-progress or backlog. A Blocked story can be
 * parked as well (dry run #3, 10 Oct: a stall resolved elsewhere kept re-escalating because Blocked →
 * Parked was refused); parking still needs a reason and resumeWhen.
 */
const TRANSITIONS: Record<ItemStatus, ItemStatus[]> = {
  backlog: ['ready', 'in-progress', 'parked', 'done'],
  ready: ['backlog', 'in-progress', 'blocked', 'waiting', 'parked', 'done'],
  'in-progress': ['backlog', 'ready', 'in-review', 'blocked', 'waiting', 'parked', 'done'],
  'in-review': ['in-progress', 'done', 'blocked'],
  waiting: ['ready', 'in-progress', 'backlog'],
  parked: ['ready', 'in-progress', 'backlog'],
  blocked: ['backlog', 'ready', 'in-progress', 'in-review', 'parked'],
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
    // docs/HLD-jira-lifecycle.md §3: a block always names its blocker (waitingOn + why, or startsAfter).
    if (!req.blockedReason?.trim() && !next.startsAfter) throw new BadRequest('Blocked needs a reason: add blockedReason saying what you wait for, or startsAfter with the item it waits on.');
    if (!req.waitingOn && !next.startsAfter) throw new BadRequest('Blocked needs who it is waiting on: set waitingOn to a person, an item id, owner, coo, release or external.');
    if (req.waitingOn && !isWaitable(wp, req.waitingOn)) throw new BadRequest(`Blocked needs who it is waiting on: "${req.waitingOn}" is not a person, an item id, owner, coo, release or external.`);
    if (req.waitingOn === w.id) throw new BadRequest('An item cannot wait on itself: name the item or person it waits on.');
  }
  if (to === 'waiting') {
    const on = next.waiting?.on;
    if (!on) throw new BadRequest('Waiting needs who it waits on: set waitingOn to an employee id, owner or coo.');
    if (!(on === 'owner' || on === 'coo' || isPerson(wp, on))) throw new BadRequest(`Waiting needs who it waits on: "${on}" is not an employee id, owner or coo (an item, the release or someone outside the team is Blocked).`);
    if (on === next.employeeId) throw new BadRequest('An item cannot wait on its own assignee: say who or what it waits on.');
    if (!next.waiting?.reason) throw new BadRequest('Waiting needs a reason: say what you are waiting for.');
    if (on === 'owner' && !next.waiting.recommendation) throw new BadRequest('Waiting on the owner raises a decision in his Inbox: give your recommendation.');
  }
  if (to === 'parked') {
    if (!next.parked?.reason) throw new BadRequest('Parked needs a reason: say why it is set aside.');
    if (!next.parked.resumeWhen) throw new BadRequest('Parked needs resumeWhen: say what has to happen for it to resume.');
  }
  // GitHub flow (shadow/on): QA does not move a story back before the developer approval (finding #3).
  const early = earlyQaMoveProblem(wp, w, by, from, to);
  if (early) throw new BadRequest(early);
  // Owner, 7 Oct: the COO decides on his behalf. Closing as won't-do / duplicate / can't-reproduce claims
  // nothing landed, so the owner or the COO may do it with a reason, whatever the status or the branch holds.
  const dropping = to === 'done' && (by === 'owner' || by === 'coo') && !!req.resolution && req.resolution !== 'done';
  if (dropping && !req.note?.trim()) throw new BadRequest(`Closing as ${req.resolution} needs a note: why.`);
  if (to === 'done' && !dropping) {
    // GitHub flow `on` (docs/LLD-github-flow.md §3): a story with a PR is done by its two approvals. Local/shadow: null.
    const github = doneProblem(wp, next, by);
    if (github) throw new BadRequest(github);
    // Done means on the trunk (landing.ts RCA). A story WITH a PR is done by its two approvals and
    // auto-merged right after (a failed merge reopens it: github-flow reopenForConflict), so the gap
    // was only the story with commits and no PR at all.
    if (by !== 'owner' && githubMode(wp) === 'on' && !next.pr) {
      const n = unlandedPatches(wp, next);
      if (n > 0) throw new BadRequest(`Not done yet: ${n} change${n === 1 ? '' : 's'} on this story's branch never reached the trunk. Land them through a pull request (report_done), or show they are already on the trunk, before closing.`);
    }
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

/** A dependency must be another existing story or task, and must not loop back to this item. */
function checkStartsAfter(wp: Workplace, id: string | undefined, depId: string): void {
  if (id && depId === id) throw new BadRequest('An item cannot start after itself: name the item it waits on.');
  const dep = rawGet(wp, depId);
  if (!dep) throw new BadRequest(`startsAfter: no item ${depId}; give the id of the item it waits on.`);
  if (levelOf(dep) === 'epic') throw new BadRequest('startsAfter names a story or task, not an epic: pick the story it waits on.');
  for (let cur: WorkItem | undefined = dep, i = 0; cur?.startsAfter && i < 20; i++) {
    if (cur.startsAfter === id) throw new BadRequest(`startsAfter ${depId} would make a loop: ${depId} already starts after this item.`);
    cur = rawGet(wp, cur.startsAfter);
  }
}

/**
 * The assignee. The charter stays with the item (rework, Oct 2026: a misroute leaves the charter
 * alone); only an item with no charter takes the new assignee's first one.
 */
function setAssignee(wp: Workplace, next: WorkItem, employeeId: string): void {
  next.employeeId = employeeId;
  if (next.charterId) return;
  const charter = wp.org.employees.find(e => e.id === employeeId)?.charterIds[0];
  if (charter) next.charterId = charter;
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
 * `checked`: the caller already decided who may act (the review flow's approve and send-back), so the
 * tree check is skipped; the reason rule and the transition rules still hold.
 */
export function update(wp: Workplace, id: string, given0: UpdateItemRequest, given: string, opts: { rewait?: boolean; checked?: boolean } = {}): Item {
  let req = given0;
  const by = authorId(wp, given);
  const prev = requireRow(wp, id);
  const level = levelOf(prev);
  const next: WorkItem = { ...prev };
  const at = now();

  for (const k of ['title', 'body', 'assigneeId', 'reviewerId', 'ownerId', 'parentId', 'blockedReason', 'waitingOn', 'note', 'reason', 'resumeWhen', 'recommendation', 'status', 'resolution', 'startsAfter'] as const) {
    if (req[k] !== undefined && typeof req[k] !== 'string') throw new BadRequest(`${k} must be a string`);
  }
  // `note` is the alias of `reason` (rework, Oct 2026); everything below reads `note`.
  if (req.note === undefined && req.reason !== undefined) req = { ...req, note: req.reason };
  if (req.status && !ITEM_STATUSES.includes(req.status)) throw new BadRequest(`Unknown status ${req.status}`);
  const start = prev.status ?? 'ready';
  // The tree decides who may change it, and every status or assignee change says why.
  if (!opts.checked) checkActor(wp, by, prev, req);
  const moving = (req.status !== undefined && req.status !== start) || (req.hold === true && start !== 'parked');
  const reassigning = req.assigneeId !== undefined && req.assigneeId !== prev.employeeId;
  if ((moving || reassigning) && by !== 'workplace' && !reasonOf(req)) {
    throw new BadRequest(`Bad request: give a reason for this change (reason, at least ${REASON_MIN} characters).`);
  }
  if (req.acceptance !== undefined && (!Array.isArray(req.acceptance) || req.acceptance.some(a => typeof a !== 'string'))) throw new BadRequest('acceptance must be a list of strings');
  if (req.resolution !== undefined && !['done', 'wont-do', 'duplicate', 'cant-reproduce'].includes(req.resolution)) throw new BadRequest('resolution must be done, wont-do, duplicate or cant-reproduce');
  if (req.kind !== undefined && req.kind !== 'review' && req.kind !== 'work') throw new BadRequest('kind must be review or work');
  if (req.title !== undefined) { if (!req.title.trim()) throw new BadRequest('An item needs a title.'); next.title = req.title.trim(); }
  if (req.body !== undefined) next.body = req.body;
  if (req.type !== undefined) {
    if (req.type !== null && req.type !== 'bug' && req.type !== 'rca') throw new BadRequest('type must be bug, rca or null');
    if (level !== 'story') throw new BadRequest('Only a story has a type (bug or rca).');
    const emp = wp.org.employees.find(e => e.id === by);
    const may = by === 'owner' || by === 'coo' || by === 'workplace' || (emp && (emp.roleId === 'qa' || emp.charterIds.includes('chief-of-staff')));
    if (!may) throw new Forbidden('Forbidden: only the owner, the COO, the Chief of Staff or QA can set a story\'s type.');
    if (req.type) next.type = req.type; else delete next.type;
  }
  if (req.assigneeId !== undefined && req.assigneeId !== prev.employeeId) {
    checkAssignee(wp, req.assigneeId);
    setAssignee(wp, next, req.assigneeId);
    // Routed to a lead by the Chief of Staff (LLD W2 §5): the lead assigns it within the team. Any other reassignment ends that.
    if (routesToLead(wp, by, req.assigneeId)) next.routedAt = at; else delete next.routedAt;
  }
  if (req.reviewerId !== undefined) { checkAssignee(wp, req.reviewerId); next.reviewerId = req.reviewerId; }
  if (req.ownerId !== undefined) { checkAssignee(wp, req.ownerId); next.ownerId = req.ownerId; }
  if (req.points !== undefined) { const p = checkPoints(req.points); if (p) next.points = p; else delete next.points; }
  if (typeof req.rank === 'number' && Number.isFinite(req.rank)) next.rank = req.rank;
  if (req.startsAfter !== undefined) {
    if (req.startsAfter) { checkStartsAfter(wp, id, req.startsAfter); next.startsAfter = req.startsAfter; } else delete next.startsAfter;
  }
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

  const from = start;
  // Keeping a block current (owner, 5 Oct): while it stays Blocked, its waitingOn, blockedReason and
  // startsAfter can be edited; the block keeps its since, and a teammate wait still converts.
  const blockEdit = from === 'blocked' && (req.status === undefined || req.status === 'blocked')
    && (req.blockedReason !== undefined || req.waitingOn !== undefined || req.startsAfter !== undefined);
  if (blockEdit) {
    const followsDep = !!prev.startsAfter && prev.waitingOn === prev.startsAfter && req.startsAfter !== undefined;
    const autoReason = !!prev.blockedReason && prev.blockedReason.startsWith('Starts after "') && req.startsAfter !== undefined;
    const waitingOn = req.waitingOn ?? (followsDep ? next.startsAfter : prev.waitingOn);
    const blockedReason = req.blockedReason ?? (autoReason ? undefined : prev.blockedReason);
    req = { ...req, status: 'blocked', ...(waitingOn ? { waitingOn } : {}), ...(blockedReason !== undefined ? { blockedReason } : {}) };
    if (!waitingOn) delete req.waitingOn;
    if (blockedReason === undefined) delete req.blockedReason;
  }
  if (req.hold !== undefined) {
    if (typeof req.hold !== 'boolean') throw new BadRequest('hold must be true or false');
    // The Chief of Staff parks work too (5 Oct: a story she parked for budget kept being auto-restarted).
    if (by !== 'owner' && by !== 'coo' && by !== chiefOfStaffId(wp)) throw new BadRequest('Only the owner, the COO or the Chief of Staff holds an item (or lifts a hold).');
    if (req.hold && req.status && req.status !== 'backlog' && req.status !== 'parked') throw new BadRequest('A hold parks an item: leave the status out (or say parked).');
    if (req.hold && !req.note?.trim()) throw new BadRequest('On hold needs a reason: add a note saying why it is parked and what restarts it.');
    // New holds park the item (rework, Oct 2026); a legacy held Backlog stays readable and is lifted as before.
    if (req.hold === true) {
      req = { ...req, status: 'parked', resumeWhen: req.resumeWhen?.trim() || `${nameOf(wp, by) === 'you' ? 'the owner' : nameOf(wp, by)} lifts the hold` };
      delete req.hold;
    } else if (from === 'parked') {
      req = { ...req, status: req.status ?? 'backlog' };
      delete req.hold;
    }
  }
  // An explicit kind on a wait on a teammate still rewrites it: a review, or a handoff (LLD §19.6c).
  if (req.status === 'waiting' && req.kind && req.waitingOn && level !== 'epic'
    && waits.classify(wp, { assigneeId: next.employeeId, waitingOn: req.waitingOn, kind: req.kind }) !== 'block') {
    req = { ...req, status: 'blocked', blockedReason: req.blockedReason ?? req.note ?? '' };
  }
  // Merged → Done (docs/HLD-jira-lifecycle.md §1): Asha (or the owner, the COO, the reviewer) closes a merged story.
  if (req.status === 'done' && from === 'done' && prev.pr?.merged && !prev.closedAt) {
    if (by !== 'owner' && by !== 'coo' && by !== chiefOfStaffId(wp) && by !== prev.reviewerId) throw new BadRequest('Closing a merged story is Asha\'s call (or the owner\'s, the COO\'s or its reviewer\'s): tell Asha it is merged.');
    next.closedAt = at;
    next.closedBy = by;
    next.statusSince = at;
    next.updatedAt = at;
    const saved = work.put(wp, prev, next, by, req.note ?? 'Closed: merged');
    trail.record(wp, { itemId: id, by, kind: 'note', text: `Closed by ${nameOf(wp, by)}: PR #${prev.pr.number} is merged` });
    return toItem(wp, saved);
  }
  const wanted = req.status;
  // Waiting stays editable while it waits (a new waitingOn or reason re-targets it).
  const waitEdit = from === 'waiting' && wanted === 'waiting' && (req.waitingOn !== undefined || req.note !== undefined);
  let to = wanted && (wanted !== from || (opts.rewait && from === 'blocked') || blockEdit || waitEdit) ? wanted : undefined;

  // A wait on a teammate is never Blocked (owner, 2 Oct; LLD §19.6c): with an explicit kind a review or a
  // handoff; without one (rework, Oct 2026) it is Waiting on them, nothing rewritten.
  let converted = false;
  let line: string | undefined;
  let waitOn: string | undefined = to === 'waiting' ? req.waitingOn ?? (from === 'waiting' ? prev.waiting?.on : undefined) : undefined;
  let waitWhy: string | undefined = to === 'waiting' ? (req.note ?? req.blockedReason)?.trim() || (from === 'waiting' ? prev.waiting?.reason : undefined) : undefined;
  if (to === 'blocked') {
    checkMove(wp, prev, from, 'blocked', req, by, next);
    if (req.blockedReason !== undefined && !req.blockedReason.trim() && !next.startsAfter) throw new BadRequest('Blocked needs a reason: add blockedReason saying what you wait for, or startsAfter with the item it waits on.');
    const waitingOn = req.waitingOn ?? next.startsAfter!;
    const reason = req.blockedReason?.trim() ?? '';
    const wait = level === 'epic' ? 'block' : waits.classify(wp, { assigneeId: next.employeeId, waitingOn, reason, kind: req.kind });
    if (wait === 'block' && opts.rewait && from === 'blocked') return toItem(wp, prev);
    if (wait === 'wait') {
      converted = true;
      to = 'waiting';
      waitOn = waitingOn;
      waitWhy = reason || req.note?.trim() || undefined;
      line = `Waiting on ${nameOf(wp, waitingOn)}: ${clause(reason || req.note || 'no reason given')} (a wait on a person is Waiting on, not Blocked)`;
    } else if (wait === 'review') {
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
    if (to === 'waiting') {
      const recommendation = req.recommendation?.trim() || (from === 'waiting' && prev.waiting?.on === waitOn ? prev.waiting?.recommendation : undefined);
      next.waiting = {
        on: waitOn ?? '', reason: waitWhy ?? '',
        since: from === 'waiting' && prev.waiting?.on === waitOn ? prev.waiting!.since : at,
        ...(recommendation ? { recommendation } : {}),
      };
    } else delete next.waiting;
    if (to === 'parked') {
      next.parked = { reason: req.note?.trim() ?? '', resumeWhen: req.resumeWhen?.trim() ?? '', by, since: at };
    } else delete next.parked;
    checkMove(wp, prev, from, to, req, by, next, converted);
    next.status = to;
    if (to !== from) next.statusSince = at;
    if (to === 'done') next.resolution = req.resolution ?? (from === 'backlog' || from === 'ready' ? 'wont-do' : 'done');
    else delete next.resolution;
    if (to === 'blocked') {
      const dep = next.startsAfter ? rawGet(wp, next.startsAfter) : undefined;
      next.blockedReason = req.blockedReason?.trim() || `Starts after "${dep?.title ?? next.startsAfter}"`;
      next.waitingOn = req.waitingOn ?? next.startsAfter!;
      if (from !== 'blocked' || !prev.blockedSince) next.blockedSince = at;
      if (from === 'blocked') line = `Blocker updated: waiting on ${nameOf(wp, next.waitingOn)}: ${clause(next.blockedReason)}`;
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
  if (held && (!prev.hold || req.hold === true)) next.holdReason = req.note?.trim() || prev.holdReason || `Parked by ${nameOf(wp, by)}`;
  if (!held) delete next.holdReason;
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
  work.put(wp, prev, next, by, 'system: a session started on it');
}

/**
 * Ready, and its assignee busy (the watcher's not-started rule, LLD §19.6d): it stays Ready, queued for
 * them, and the dispatcher starts it the moment they are free. Never Backlog, never held.
 */
export function markQueued(wp: Workplace, id: string, by: string): void {
  const prev = rawGet(wp, id);
  if (!prev || !prev.employeeId || prev.status !== 'ready' || prev.queuedFor === prev.employeeId) return;
  const next: WorkItem = { ...prev, queuedFor: prev.employeeId, updatedAt: now() };
  work.put(wp, prev, next, by, 'system: queued for its busy assignee');
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
  const c: EpicCard = {
    epic: toItem(wp, epic, nowMs),
    progress: progress(wp, epic.id),
    ...(next ? { next: { id: next.id, title: next.title } } : {}),
    flags: flagsFor(wp, epic.id, nowMs),
    ...(handoffs.length ? { handoffs } : {}),
    inFocus: focus.epicIds.includes(epic.id),
    finished: false,
  };
  // The shared contract's `finished` (W4 owns the Plan's use of it): planTier 4.
  c.finished = planTier(wp, c) === 4;
  return c;
}

/**
 * Plan order (owner, 3 Oct: "things which need me or things which are in progress at the top"):
 * needs the owner, then live work (in progress / in review / blocked / stalled), then focus epics
 * not yet started, then the rest, and finished epics last. Rank order holds within a tier.
 */
export function planTier(wp: Workplace, c: Omit<EpicCard, 'finished'>): number {
  // Finished first: a done epic never rises above unfinished work, whatever stale flag it carries (owner, 4 Oct).
  const finished = c.epic.status === 'done' || (c.progress.storiesTotal > 0 && c.progress.storiesDone === c.progress.storiesTotal);
  if (finished) return 4;
  if (c.flags.some(f => f.waitingOn === 'owner')) return 0;
  const live = c.flags.length > 0 || childrenRows(wp, c.epic.id).some(s => s.status === 'in-progress' || s.status === 'in-review');
  if (live) return 1;
  return c.inFocus ? 2 : 3;
}

function sortCards(wp: Workplace, cards: EpicCard[]): EpicCard[] {
  return cards.map((c, i) => ({ c, i, t: planTier(wp, c) })).sort((a, b) => a.t - b.t || a.i - b.i).map(x => x.c);
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
    areas: active.map(area => ({ area, epics: sortCards(wp, epics.filter(e => e.areaId === area.id).map(e => card(wp, e, focus, nowMs))) })),
    unfiled: sortCards(wp, epics.filter(e => !e.areaId || !activeIds.has(e.areaId)).map(e => card(wp, e, focus, nowMs))),
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
