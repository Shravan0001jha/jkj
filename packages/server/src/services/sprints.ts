import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  BacklogView, BoardColumn, Carried, CreatePlanFeatureRequest, CreatePlannedEpicRequest, DateChange, EpicBlocker, EpicDetail, EpicRef,
  EpicState, Feature, FeatureDetail$, Item, ItemBlocker, PlannedEpic, PlanState, RankRequest, ReviewView, Sprint, SprintReport,
  SprintView, Team, TeamBoard, TodayView, TrackedDay, UpdatePlanFeatureRequest, UpdatePlannedEpicRequest, UpdateSprintRequest,
  WaitingOnYou, WorkItem,
} from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as items from './items.js';
import * as inbox from './inbox.js';
import { rowsJson } from './store.js';
import { chiefOfStaffId, levelOf, rawGet } from './v2-map.js';
import { BadRequest, NotFound } from '../util/errors.js';

/**
 * The owner's sprint board (docs/HLD-sprint-board.md, docs/LLD-sprint-board.md).
 *
 * Feature > Epic > Story. A feature is a planning record here; an epic is the ordinary `level: 'epic'`
 * work item (agents file stories under it as always) with its planning row beside it; stories are
 * untouched. Two-week sprints on IST calendar dates from Sat 7 Nov 2026. States are partly the
 * owner's (backlog / planned / parked) and otherwise derived on every read from the stories and the
 * date, so the board cannot drift from the work.
 */

/* ---------- calendar (LLD §3) ---------- */

export const SPRINT1_START = '2026-11-07';
const DAY = 86_400_000;
const IST_OFFSET = 5.5 * 3_600_000;

export function istDate(ms: number): string {
  return new Date(ms + IST_OFFSET).toISOString().slice(0, 10);
}

const dayNum = (date: string): number => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY);
const fromDayNum = (n: number): string => new Date(n * DAY).toISOString().slice(0, 10);
const addDays = (date: string, n: number): string => fromDayNum(dayNum(date) + n);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function checkDate(value: unknown, what = 'date'): string {
  if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || fromDayNum(dayNum(value)) !== value) {
    throw new BadRequest(`The ${what} must be a real date as YYYY-MM-DD, not "${String(value)}".`);
  }
  return value;
}

function sprintByNumber(n: number, today?: string): Sprint {
  const start = addDays(SPRINT1_START, 14 * (n - 1));
  const end = addDays(start, 13);
  return { id: `sp_${n}`, number: n, start, end, current: today !== undefined && today >= start && today <= end };
}

/** The sprint a date falls in; dates before Sprint 1 count as Sprint 1. */
export function sprintForDate(date: string): Sprint {
  const n = Math.max(1, Math.floor((dayNum(date) - dayNum(SPRINT1_START)) / 14) + 1);
  return sprintByNumber(n, date);
}

const sprintNumberOf = (id: string): number => {
  const m = /^sp_(\d+)$/.exec(id);
  if (!m) throw new BadRequest(`No sprint "${id}"; sprints are sp_1, sp_2, …`);
  return Number(m[1]);
};

/* ---------- schema and migration (LLD §2–3) ---------- */

const SCHEMA = `
create table if not exists plan_features (id text primary key, rank real not null, status text not null, due_date text, json text not null);
create table if not exists plan_epics (epic_id text primary key, feature_id text, sprint_id text, plan_state text not null, due_date text, rank real not null, json text not null);
create index if not exists plan_epics_feature on plan_epics(feature_id);
create index if not exists plan_epics_sprint on plan_epics(sprint_id);
create table if not exists plan_sprints (id text primary key, number integer not null, start text not null, end text not null, json text not null);
create table if not exists plan_dates (seq integer primary key autoincrement, subject_id text not null, kind text not null, from_date text, to_date text, by text not null, at text not null, reason text not null);
create index if not exists plan_dates_subject on plan_dates(subject_id);
create table if not exists plan_meta (key text primary key, value text not null);
`;

interface FeatureRow { id: string; title: string; body: string; dueDate?: string; status: Feature['status']; rank: number; containerEpicIds: string[]; createdAt: string; updatedAt: string }
interface EpicRow { epicId: string; featureId?: string; sprintId: string | null; planState: PlanState; dueDate?: string; rank: number; carried?: Carried[]; createdAt: string; updatedAt: string }
interface SprintRow { goal?: string; report?: SprintReport }

const ready = new WeakSet<object>();

/** Creates the tables and runs the one-time migration (open epics → features with themselves as containers). */
export function ensure(wp: Workplace, nowMs = Date.now()): void {
  if (ready.has(wp.db)) return;
  wp.db.exec(SCHEMA);
  const done = wp.db.prepare("select value from plan_meta where key = 'migrated:v1'").get() as { value: string } | undefined;
  if (!done) {
    const epics = rowsJson<WorkItem>(wp.db.prepare(
      "select json from work where coalesce(level, case kind when 'feature' then 'epic' else 'story' end) = 'epic' order by coalesce(rank, 0), created_at").all())
      .filter(e => e.status !== 'done');
    const at = new Date(nowMs).toISOString();
    let rank = 0;
    for (const e of epics) {
      rank += 1;
      const due = e.targetDate && ISO_DATE.test(e.targetDate) ? e.targetDate : undefined;
      putFeature(wp, { id: newId('fe'), title: e.title, body: e.body ?? '', ...(due ? { dueDate: due } : {}), status: 'active', rank, containerEpicIds: [e.id], createdAt: at, updatedAt: at });
    }
    wp.db.prepare("insert into plan_meta(key, value) values ('migrated:v1', ?)").run(at);
  }
  ready.add(wp.db);
}

const newId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;

function putFeature(wp: Workplace, f: FeatureRow): void {
  wp.db.prepare('insert into plan_features(id, rank, status, due_date, json) values (?, ?, ?, ?, ?) on conflict(id) do update set rank = excluded.rank, status = excluded.status, due_date = excluded.due_date, json = excluded.json')
    .run(f.id, f.rank, f.status, f.dueDate ?? null, JSON.stringify(f));
}

function putEpic(wp: Workplace, e: EpicRow): void {
  wp.db.prepare('insert into plan_epics(epic_id, feature_id, sprint_id, plan_state, due_date, rank, json) values (?, ?, ?, ?, ?, ?, ?) on conflict(epic_id) do update set feature_id = excluded.feature_id, sprint_id = excluded.sprint_id, plan_state = excluded.plan_state, due_date = excluded.due_date, rank = excluded.rank, json = excluded.json')
    .run(e.epicId, e.featureId ?? null, e.sprintId, e.planState, e.dueDate ?? null, e.rank, JSON.stringify(e));
}

const featureRows = (wp: Workplace): FeatureRow[] => rowsJson<FeatureRow>(wp.db.prepare('select json from plan_features order by rank, id').all());
const featureRow = (wp: Workplace, id: string): FeatureRow | undefined => rowsJson<FeatureRow>(wp.db.prepare('select json from plan_features where id = ?').all(id))[0];
const epicRows = (wp: Workplace): EpicRow[] => rowsJson<EpicRow>(wp.db.prepare('select json from plan_epics order by rank, epic_id').all());
const epicRow = (wp: Workplace, id: string): EpicRow | undefined => rowsJson<EpicRow>(wp.db.prepare('select json from plan_epics where epic_id = ?').all(id))[0];

function logDate(wp: Workplace, subjectId: string, kind: DateChange['kind'], from: string | undefined, to: string | undefined, by: string, at: string, reason: string): void {
  wp.db.prepare('insert into plan_dates(subject_id, kind, from_date, to_date, by, at, reason) values (?, ?, ?, ?, ?, ?, ?)')
    .run(subjectId, kind, from ?? null, to ?? null, by, at, reason);
}

export function dates(wp: Workplace, subjectId: string): DateChange[] {
  ensure(wp);
  const rows = wp.db.prepare('select subject_id, kind, from_date, to_date, by, at, reason from plan_dates where subject_id = ? order by seq').all(subjectId) as
    { subject_id: string; kind: DateChange['kind']; from_date: string | null; to_date: string | null; by: string; at: string; reason: string }[];
  return rows.map(r => ({ subjectId: r.subject_id, kind: r.kind, ...(r.from_date ? { from: r.from_date } : {}), ...(r.to_date ? { to: r.to_date } : {}), by: r.by, at: r.at, reason: r.reason }));
}

/** A date change on a subject that already had one needs a reason (owner, 1 Nov: dates move only with a why). */
function changeDate(wp: Workplace, subjectId: string, kind: DateChange['kind'], from: string | undefined, to: string, by: string, at: string, reason: string | undefined): void {
  if (from === to) return;
  const why = reason?.trim();
  if (from && !why) throw new BadRequest(`Changing the date from ${from} to ${to} needs a reason.`);
  logDate(wp, subjectId, kind, from, to, by, at, why || 'First date set');
}

function changed(wp: Workplace, nowMs: number): void {
  wp.emit({ type: 'sprint.changed', at: new Date(nowMs).toISOString() });
}

/* ---------- sprints and rollover (LLD §3) ---------- */

function sprintRow(wp: Workplace, n: number): SprintRow {
  const s = sprintByNumber(n);
  const got = wp.db.prepare('select json from plan_sprints where id = ?').get(s.id) as { json: string } | undefined;
  if (got) return JSON.parse(got.json) as SprintRow;
  wp.db.prepare('insert into plan_sprints(id, number, start, end, json) values (?, ?, ?, ?, ?)').run(s.id, n, s.start, s.end, '{}');
  return {};
}

function saveSprintRow(wp: Workplace, n: number, row: SprintRow): void {
  sprintRow(wp, n);
  wp.db.prepare('update plan_sprints set json = ? where id = ?').run(JSON.stringify(row), `sp_${n}`);
}

function sprintOf(wp: Workplace, n: number, today: string): Sprint {
  const row = sprintRow(wp, n);
  return { ...sprintByNumber(n, today), ...(row.goal ? { goal: row.goal } : {}) };
}

/** Freezes every ended sprint's report once and carries its unfinished epics into the current sprint. */
function roll(wp: Workplace, nowMs: number): Sprint {
  ensure(wp, nowMs);
  const today = istDate(nowMs);
  const current = sprintForDate(today);
  for (let n = 1; n < current.number; n++) {
    const row = sprintRow(wp, n);
    if (row.report) continue;
    const s = sprintByNumber(n);
    const inSprint = epicRows(wp).filter(e => e.sprintId === s.id);
    const done: EpicRef[] = [];
    const slipped: EpicRef[] = [];
    const at = new Date(nowMs).toISOString();
    for (const e of inSprint) {
      const pe = plannedEpic(wp, e, nowMs);
      if (!pe) continue;
      const ref: EpicRef = { id: pe.id, title: pe.title, ...(pe.featureTitle ? { featureTitle: pe.featureTitle } : {}), ...(pe.dueDate ? { dueDate: pe.dueDate } : {}) };
      if (pe.state === 'done') { done.push(ref); continue; }
      const reason = `Not done by the end of Sprint ${n}`;
      slipped.push({ ...ref, reason });
      putEpic(wp, { ...e, sprintId: current.id, carried: [...(e.carried ?? []), { fromSprint: s.id, reason, at }], updatedAt: at });
    }
    saveSprintRow(wp, n, { ...row, report: { sprintId: s.id, number: n, start: s.start, end: s.end, ...(row.goal ? { goal: row.goal } : {}), done, slipped, carried: slipped, frozenAt: at } });
  }
  return sprintOf(wp, current.number, today);
}

export function updateSprint(wp: Workplace, id: string, req: UpdateSprintRequest, _by: string, nowMs = Date.now()): Sprint {
  const current = roll(wp, nowMs);
  const n = sprintNumberOf(id);
  if (n < current.number) throw new BadRequest(`Sprint ${n} has ended; its goal is part of its report.`);
  const goal = typeof req.goal === 'string' ? req.goal.trim() : '';
  if (!goal) throw new BadRequest('A sprint goal is one line of text.');
  if (goal.length > 200) throw new BadRequest('Keep the sprint goal to one line (200 characters at most).');
  saveSprintRow(wp, n, { ...sprintRow(wp, n), goal });
  changed(wp, nowMs);
  return sprintOf(wp, n, istDate(nowMs));
}

/* ---------- reading an epic (derived state, LLD §3) ---------- */

function storiesOf(wp: Workplace, epicId: string, _nowMs: number): Item[] {
  return rowsJson<WorkItem>(wp.db.prepare('select json from work where parent_id = ? order by coalesce(rank, 0), created_at').all(epicId))
    .filter(s => levelOf(s) === 'story' && !(s.status === 'done' && s.resolution && s.resolution !== 'done'))
    // Stalls are a live notion (watch.ts): judged on the real clock, while dates use the board's clock.
    .map(s => items.toItem(wp, s));
}

const isOpen = (s: Item): boolean => s.status !== 'done';

function blockerOf(s: Item): ItemBlocker | undefined {
  if (s.status === 'blocked') return s.blocker ?? (s.blocked ? { kind: s.blocked.waitingOn === 'owner' ? 'owner' : s.blocked.waitingOn === 'coo' ? 'coo' : 'external', id: s.blocked.waitingOn, label: s.blocked.waitingOn === 'owner' ? 'you' : s.blocked.waitingOn, status: 'blocked', reason: s.blocked.reason, since: s.blocked.since } : undefined);
  if (s.status === 'waiting' && s.waiting && (s.waiting.on === 'owner' || s.waiting.on === 'external' || s.waiting.on === 'coo')) {
    return s.blocker ?? { kind: s.waiting.on === 'owner' ? 'owner' : s.waiting.on === 'coo' ? 'coo' : 'external', id: s.waiting.on, label: s.waiting.on === 'owner' ? 'you' : s.waiting.on, status: 'waiting', reason: s.waiting.reason, since: s.waiting.since };
  }
  return undefined;
}

const waitsOnOwner = (s: Pick<Item, 'status' | 'blocked' | 'waiting'>): boolean =>
  (s.status === 'blocked' && s.blocked?.waitingOn === 'owner') || (s.status === 'waiting' && s.waiting?.on === 'owner');

function plannedEpic(wp: Workplace, row: EpicRow, nowMs: number, stories?: Item[]): PlannedEpic | undefined {
  const w = rawGet(wp, row.epicId);
  if (!w || levelOf(w) !== 'epic') return undefined;
  const today = istDate(nowMs);
  const all = stories ?? storiesOf(wp, row.epicId, nowMs);
  const progress = items.progress(wp, row.epicId);
  const open = all.filter(isOpen);
  const blockers: EpicBlocker[] = [];
  for (const s of open) {
    const b = blockerOf(s);
    if (b) blockers.push({ storyId: s.id, title: s.title, blocker: b });
  }
  const epicItem = items.toItem(wp, w);
  const waitingOnOwner = open.some(waitsOnOwner) || waitsOnOwner(epicItem);
  const isDone = w.status === 'done' || (progress.storiesTotal > 0 && progress.storiesDone === progress.storiesTotal);
  const overdue = !isDone && row.planState !== 'parked' && !!row.dueDate && row.dueDate < today;
  let state: EpicState;
  if (row.planState === 'parked') state = 'parked';
  else if (isDone) state = 'done';
  else if (blockers.length > 0 || epicItem.status === 'blocked') state = 'blocked';
  else if (overdue) state = 'at-risk';
  else if ((row.dueDate && row.dueDate <= addDays(today, 1) && progress.pct < 50) || open.some(s => !!s.stall)) state = 'at-risk';
  else if (all.some(s => ['in-progress', 'in-review', 'qa', 'approved', 'merged', 'awaiting-mac', 'done'].includes(s.trueStatus ?? s.status))) state = 'in-progress';
  else state = row.sprintId ? 'planned' : 'backlog';
  const feature = row.featureId ? featureRow(wp, row.featureId) : undefined;
  const assignees = [...new Set(all.map(s => s.assigneeId).filter((a): a is string => !!a))];
  return {
    id: w.id, title: w.title,
    ...(feature ? { featureId: feature.id, featureTitle: feature.title } : {}),
    sprintId: row.sprintId, planState: row.planState, state, overdue,
    dueToday: !isDone && row.planState !== 'parked' && row.dueDate === today,
    ...(row.dueDate ? { dueDate: row.dueDate } : {}),
    rank: row.rank, progress, blockers, waitingOnOwner,
    ...(row.carried?.length ? { carried: row.carried } : {}),
    ...(w.ownerId ? { ownerId: w.ownerId } : {}),
    assignees,
  };
}

const byRankDue = (a: PlannedEpic, b: PlannedEpic): number => a.rank - b.rank || (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9') || a.id.localeCompare(b.id);
const byDue = (a: PlannedEpic, b: PlannedEpic): number => (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9') || a.rank - b.rank;

function allPlanned(wp: Workplace, nowMs: number): PlannedEpic[] {
  return epicRows(wp).map(r => plannedEpic(wp, r, nowMs)).filter((e): e is PlannedEpic => !!e);
}

const STORY_ORDER = (s: Item): number => (blockerOf(s) ? 0 : isOpen(s) ? 1 : 2);

export function epic(wp: Workplace, id: string, nowMs = Date.now()): EpicDetail {
  roll(wp, nowMs);
  const row = epicRow(wp, id);
  if (!row) throw new NotFound(`No planned epic ${id}`);
  const stories = storiesOf(wp, id, nowMs);
  const pe = plannedEpic(wp, row, nowMs, stories);
  if (!pe) throw new NotFound(`No planned epic ${id}`);
  const feature = row.featureId ? featureView(wp, row.featureId, nowMs) : undefined;
  const sorted = stories.map((s, i) => ({ s, i })).sort((a, b) => STORY_ORDER(a.s) - STORY_ORDER(b.s) || a.i - b.i).map(x => x.s);
  return { epic: pe, ...(feature ? { feature } : {}), stories: sorted, dates: dates(wp, id) };
}

/* ---------- features ---------- */

function featureView(wp: Workplace, id: string, nowMs: number, planned?: PlannedEpic[]): Feature | undefined {
  const f = featureRow(wp, id);
  if (!f) return undefined;
  const epics = (planned ?? allPlanned(wp, nowMs)).filter(e => e.featureId === id);
  let storiesDone = 0;
  let storiesTotal = 0;
  for (const e of epics) { storiesDone += e.progress.storiesDone; storiesTotal += e.progress.storiesTotal; }
  for (const c of f.containerEpicIds) { const p = items.progress(wp, c); storiesDone += p.storiesDone; storiesTotal += p.storiesTotal; }
  const counted = epics.filter(e => e.state !== 'parked');
  const epicsDone = counted.filter(e => e.state === 'done').length;
  const pct = counted.length > 0 ? Math.round((epicsDone / counted.length) * 100) : storiesTotal > 0 ? Math.round((storiesDone / storiesTotal) * 100) : 0;
  return { ...f, progress: { epicsDone, epicsTotal: counted.length, storiesDone, storiesTotal, pct } };
}

export function features(wp: Workplace, nowMs = Date.now()): Feature[] {
  roll(wp, nowMs);
  const planned = allPlanned(wp, nowMs);
  return featureRows(wp).map(f => featureView(wp, f.id, nowMs, planned)).filter((f): f is Feature => !!f);
}

export function featureDetail(wp: Workplace, id: string, nowMs = Date.now()): FeatureDetail$ {
  roll(wp, nowMs);
  const planned = allPlanned(wp, nowMs);
  const feature = featureView(wp, id, nowMs, planned);
  if (!feature) throw new NotFound(`No feature ${id}`);
  const container: Item[] = [];
  for (const c of feature.containerEpicIds) container.push(...storiesOf(wp, c, nowMs));
  const sorted = container.map((s, i) => ({ s, i })).sort((a, b) => STORY_ORDER(a.s) - STORY_ORDER(b.s) || a.i - b.i).map(x => x.s);
  return { feature, epics: planned.filter(e => e.featureId === id).sort(byDue), containerStories: sorted.slice(0, 200), containerStoriesTotal: sorted.length, dates: dates(wp, id) };
}

const cleanTitle = (t: unknown): string => {
  const s = typeof t === 'string' ? t.trim() : '';
  if (!s) throw new BadRequest('A title is required.');
  if (s.length > 200) throw new BadRequest('Keep the title under 200 characters.');
  return s;
};

export function createFeature(wp: Workplace, req: CreatePlanFeatureRequest, by: string, nowMs = Date.now()): Feature {
  roll(wp, nowMs);
  const title = cleanTitle(req.title);
  const due = req.dueDate !== undefined ? checkDate(req.dueDate, 'due date') : undefined;
  const at = new Date(nowMs).toISOString();
  const rank = (featureRows(wp).reduce((m, f) => Math.max(m, f.rank), 0)) + 1;
  const f: FeatureRow = { id: newId('fe'), title, body: typeof req.body === 'string' ? req.body : '', ...(due ? { dueDate: due } : {}), status: 'active', rank, containerEpicIds: [], createdAt: at, updatedAt: at };
  putFeature(wp, f);
  if (due) logDate(wp, f.id, 'feature', undefined, due, by, at, 'Set when the feature was created');
  changed(wp, nowMs);
  return featureView(wp, f.id, nowMs)!;
}

export function updateFeature(wp: Workplace, id: string, req: UpdatePlanFeatureRequest, by: string, nowMs = Date.now()): Feature {
  roll(wp, nowMs);
  const f = featureRow(wp, id);
  if (!f) throw new NotFound(`No feature ${id}`);
  const at = new Date(nowMs).toISOString();
  const next: FeatureRow = { ...f, updatedAt: at };
  if (req.title !== undefined) next.title = cleanTitle(req.title);
  if (req.body !== undefined) next.body = typeof req.body === 'string' ? req.body : '';
  if (req.status !== undefined) {
    if (!['active', 'parked', 'done'].includes(req.status)) throw new BadRequest('status must be active, parked or done');
    next.status = req.status;
  }
  if (req.dueDate !== undefined) {
    const due = checkDate(req.dueDate, 'due date');
    changeDate(wp, id, 'feature', f.dueDate, due, by, at, req.reason);
    next.dueDate = due;
  }
  putFeature(wp, next);
  changed(wp, nowMs);
  return featureView(wp, id, nowMs)!;
}

/* ---------- epics ---------- */

const nextRank = (wp: Workplace): number => epicRows(wp).reduce((m, e) => Math.max(m, e.rank), 0) + 1;

export function createEpic(wp: Workplace, req: CreatePlannedEpicRequest, by: string, nowMs = Date.now()): PlannedEpic {
  const current = roll(wp, nowMs);
  const title = cleanTitle(req.title);
  const f = typeof req.featureId === 'string' ? featureRow(wp, req.featureId) : undefined;
  if (!f) throw new BadRequest(`Every epic belongs to a feature; no feature "${String(req.featureId)}".`);
  const due = checkDate(req.dueDate, 'due date');
  if (req.sprint !== undefined && req.sprint !== 'current' && req.sprint !== 'backlog') throw new BadRequest('sprint must be current or backlog');
  const item = items.create(wp, {
    level: 'epic', title, ...(req.body ? { body: req.body } : {}), ...(req.areaId ? { areaId: req.areaId } : {}), ...(req.ownerId ? { ownerId: req.ownerId } : {}), targetDate: due,
  }, by, { reason: `Planned on the sprint board under "${f.title}"` });
  const at = new Date(nowMs).toISOString();
  const inSprint = req.sprint === 'current';
  putEpic(wp, { epicId: item.id, featureId: f.id, sprintId: inSprint ? current.id : null, planState: inSprint ? 'planned' : 'backlog', dueDate: due, rank: nextRank(wp), createdAt: at, updatedAt: at });
  logDate(wp, item.id, 'epic', undefined, due, by, at, 'Set when the epic was created');
  changed(wp, nowMs);
  return plannedEpic(wp, epicRow(wp, item.id)!, nowMs)!;
}

export function updateEpic(wp: Workplace, id: string, req: UpdatePlannedEpicRequest, by: string, nowMs = Date.now()): PlannedEpic {
  const current = roll(wp, nowMs);
  const at = new Date(nowMs).toISOString();
  let row = epicRow(wp, id);
  if (!row) {
    // Adopting an epic filed outside the board (an "unplanned" one): it needs a feature.
    const w = rawGet(wp, id);
    if (!w || levelOf(w) !== 'epic') throw new NotFound(`No epic ${id}`);
    if (featureRows(wp).some(f => f.containerEpicIds.includes(id))) throw new BadRequest(`${id} is a feature's container (its pre-sprint stories); plan new epics under that feature instead.`);
    if (!req.featureId) throw new BadRequest(`${id} is not on the board yet: give it a featureId to adopt it.`);
    row = { epicId: id, sprintId: null, planState: 'backlog', rank: nextRank(wp), createdAt: at, updatedAt: at };
  }
  const next: EpicRow = { ...row, updatedAt: at };
  if (req.featureId !== undefined) {
    if (!featureRow(wp, req.featureId)) throw new BadRequest(`No feature ${req.featureId}`);
    next.featureId = req.featureId;
  }
  if (req.dueDate !== undefined) {
    const due = checkDate(req.dueDate, 'due date');
    changeDate(wp, id, 'epic', row.dueDate, due, by, at, req.reason);
    next.dueDate = due;
  }
  if (req.planState !== undefined) {
    if (!['backlog', 'planned', 'parked'].includes(req.planState)) throw new BadRequest('planState must be backlog, planned or parked');
    next.planState = req.planState;
    if (req.planState !== 'planned') next.sprintId = null;
    else if (req.sprintId === undefined) next.sprintId = row.sprintId ?? current.id;
  }
  if (req.sprintId !== undefined) {
    const n = sprintNumberOf(req.sprintId);
    if (n < current.number) throw new BadRequest(`Sprint ${n} is in the past; plan into Sprint ${current.number} or later.`);
    next.sprintId = req.sprintId;
    next.planState = 'planned';
  }
  if (req.carryReason !== undefined) {
    const why = req.carryReason.trim();
    if (!why) throw new BadRequest('A carry-over reason is one line of text.');
    if (!next.carried?.length) throw new BadRequest(`${id} was never carried over.`);
    next.carried = [...next.carried.slice(0, -1), { ...next.carried[next.carried.length - 1]!, reason: why }];
  }
  if (!next.featureId) throw new BadRequest('Every epic belongs to a feature.');
  if (!next.dueDate) throw new BadRequest('Every epic carries a due date.');
  putEpic(wp, next);
  // The epic item carries the same date, so the agents' own views (plan, item detail) show it too.
  if (next.dueDate && rawGet(wp, id)?.targetDate !== next.dueDate) {
    items.update(wp, id, { targetDate: next.dueDate, reason: `Sprint board: due ${next.dueDate}${req.reason ? ` (${req.reason.trim()})` : ''}` }, by);
  }
  changed(wp, nowMs);
  return plannedEpic(wp, next, nowMs)!;
}

export function rank(wp: Workplace, req: RankRequest, _by: string, nowMs = Date.now()): PlannedEpic[] {
  roll(wp, nowMs);
  const ids = Array.isArray(req.epicIds) ? req.epicIds.filter((x): x is string => typeof x === 'string') : [];
  if (!ids.length) throw new BadRequest('epicIds is the list of epics in their new order.');
  const rows = ids.map(id => ({ id, row: epicRow(wp, id) }));
  const unknown = rows.filter(r => !r.row).map(r => r.id);
  if (unknown.length) throw new BadRequest(`Unknown epics (no planned epic): ${unknown.join(', ')}`);
  // The given epics take the lowest ranks among themselves, in the given order; others keep theirs.
  const slots = rows.map(r => r.row!.rank).sort((a, b) => a - b);
  const at = new Date(nowMs).toISOString();
  rows.forEach((r, i) => putEpic(wp, { ...r.row!, rank: slots[i]!, updatedAt: at }));
  changed(wp, nowMs);
  return rows.map(r => plannedEpic(wp, epicRow(wp, r.id)!, nowMs)).filter((e): e is PlannedEpic => !!e);
}

/* ---------- views ---------- */

export function backlog(wp: Workplace, nowMs = Date.now()): BacklogView {
  const sprint = roll(wp, nowMs);
  const all = allPlanned(wp, nowMs).sort(byRankDue);
  const containers = new Set(featureRows(wp).flatMap(f => f.containerEpicIds));
  const planned = new Set(epicRows(wp).map(e => e.epicId));
  const unplanned = rowsJson<WorkItem>(wp.db.prepare(
    "select json from work where coalesce(level, case kind when 'feature' then 'epic' else 'story' end) = 'epic' order by coalesce(rank, 0), created_at").all())
    .filter(e => e.status !== 'done' && !containers.has(e.id) && !planned.has(e.id))
    .map(e => ({ id: e.id, title: e.title, status: e.status ?? 'ready' }));
  return {
    sprint,
    next: sprintOf(wp, sprint.number + 1, istDate(nowMs)),
    planned: all.filter(e => e.sprintId === sprint.id),
    later: all.filter(e => e.sprintId !== null && e.sprintId !== sprint.id),
    backlog: all.filter(e => e.planState === 'backlog'),
    parked: all.filter(e => e.planState === 'parked'),
    unplanned,
    features: features(wp, nowMs),
  };
}

export function sprintView(wp: Workplace, sprintId?: string, nowMs = Date.now()): SprintView {
  const current = roll(wp, nowMs);
  const today = istDate(nowMs);
  const sprint = sprintId ? sprintOf(wp, sprintNumberOf(sprintId), today) : current;
  const planned = allPlanned(wp, nowMs);
  const inSprint = planned.filter(e => e.sprintId === sprint.id).sort(byDue);
  const groups = new Map<string, PlannedEpic[]>();
  for (const e of inSprint) {
    const k = e.featureId ?? '';
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const featureList = [...groups.entries()].map(([fid, epics]) => {
    const feature = fid ? featureView(wp, fid, nowMs, planned) : undefined;
    return { ...(feature ? { feature } : {}), epics };
  }).sort((a, b) => (a.feature?.rank ?? 1e9) - (b.feature?.rank ?? 1e9));
  const live = planned.filter(e => e.planState !== 'parked' && e.state !== 'done');
  const timeline = Array.from({ length: 14 }, (_, i) => addDays(today, i)).map(date => ({
    date,
    epics: [...planned.filter(e => e.dueDate === date && e.planState !== 'parked'), ...(date === today ? live.filter(e => e.overdue) : [])]
      .map(e => ({ id: e.id, title: e.title, state: e.state, overdue: e.overdue })),
  }));
  return {
    sprint, features: featureList, timeline,
    totals: { epics: inSprint.length, done: inSprint.filter(e => e.state === 'done').length, atRisk: inSprint.filter(e => e.state === 'at-risk').length, blocked: inSprint.filter(e => e.state === 'blocked').length },
  };
}

function waitingOnYou(wp: Workplace): WaitingOnYou[] {
  const open = inbox.ownerList(wp, 'open');
  const out: WaitingOnYou[] = open.map(i => ({ kind: 'inbox' as const, id: i.id, title: i.title, line: i.summary || i.title, since: i.createdAt }));
  // A story blocked on the owner usually raised its own Inbox item ("Blocked on you: …"): list it once.
  const raised = new Set(open.map(i => i.context['itemId']).filter((x): x is string => typeof x === 'string'));
  const rows = rowsJson<WorkItem>(wp.db.prepare("select json from work where status in ('waiting', 'blocked')").all());
  for (const w of rows) {
    if (raised.has(w.id)) continue;
    const onOwner = (w.status === 'blocked' && w.waitingOn === 'owner') || (w.status === 'waiting' && w.waiting?.on === 'owner');
    if (!onOwner) continue;
    const reason = w.status === 'blocked' ? w.blockedReason : w.waiting?.reason;
    const since = (w.status === 'blocked' ? w.blockedSince : w.waiting?.since) ?? w.updatedAt;
    out.push({ kind: 'item', id: w.id, title: w.title, line: reason ?? 'Waiting on you', since });
  }
  return out.sort((a, b) => a.since.localeCompare(b.since));
}

function doneAt(wp: Workplace, e: PlannedEpic, nowMs: number): string | undefined {
  if (e.state !== 'done') return undefined;
  const w = rawGet(wp, e.id);
  const stories = storiesOf(wp, e.id, nowMs);
  const times = [w?.status === 'done' ? w.statusSince : undefined, ...stories.map(s => s.statusSince)].filter((x): x is string => !!x);
  return times.sort().pop();
}

export function today(wp: Workplace, nowMs = Date.now()): TodayView {
  const sprint = roll(wp, nowMs);
  const date = istDate(nowMs);
  const planned = allPlanned(wp, nowMs);
  const live = planned.filter(e => e.planState !== 'parked' && e.state !== 'done');
  const dueToday = live.filter(e => e.dueDate === date).sort(byRankDue);
  const overdue = live.filter(e => e.overdue).sort(byDue);
  const taken = new Set([...dueToday, ...overdue].map(e => e.id));
  const blocked = live.filter(e => !taken.has(e.id) && e.state === 'blocked').sort(byDue);
  blocked.forEach(e => taken.add(e.id));
  const inSprint = live.filter(e => e.sprintId === sprint.id && !taken.has(e.id));
  const atRisk = inSprint.filter(e => e.state === 'at-risk').sort(byDue);
  const moving = inSprint.filter(e => e.state === 'in-progress').sort(byDue);
  const doneToday = planned.filter(e => { const at = doneAt(wp, e, nowMs); return !!at && istDate(Date.parse(at)) === date; });
  return { date, sprint, dueToday, overdue, atRisk, blocked, moving, doneToday, waitingOnYou: waitingOnYou(wp), empty: planned.length === 0 };
}

export function tracked(wp: Workplace, day: string | undefined, nowMs = Date.now()): TrackedDay {
  const date = day ? checkDate(day, 'day') : istDate(nowMs);
  const at = date === istDate(nowMs) ? nowMs : Date.parse(`${date}T12:00:00+05:30`);
  const sprint = roll(wp, at);
  const live = allPlanned(wp, at).filter(e => e.planState !== 'parked');
  const tracked$ = live.filter(e => (e.state !== 'done' && (e.dueDate === date || e.overdue)) || (e.sprintId === sprint.id && ['in-progress', 'at-risk', 'blocked'].includes(e.state)) || (e.state === 'done' && e.dueDate === date));
  return { date, sprint, tracked: tracked$.sort(byDue) };
}

export function review(wp: Workplace, nowMs = Date.now()): ReviewView {
  const current = roll(wp, nowMs);
  const archive: SprintReport[] = [];
  for (let n = current.number - 1; n >= 1; n--) {
    const r = sprintRow(wp, n).report;
    if (r) archive.push(r);
  }
  return { current, ...(archive[0] ? { last: archive[0] } : {}), archive };
}

/* ---------- teams (LLD §5) ---------- */

export function teams(wp: Workplace): Team[] {
  const org = wp.org;
  const people = org.employees.filter(e => !(e as { virtual?: boolean }).virtual);
  const reportsOf = (id: string): string[] => people.filter(e => e.reportsTo === id).map(e => e.id);
  const file = join(wp.config.workplaceDir, 'teams.yaml');
  if (existsSync(file)) {
    const raw = parseYaml(readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(raw)) throw new BadRequest('teams.yaml must be a list of {id, name, leads}');
    return raw.map((t: { id?: unknown; name?: unknown; leads?: unknown }) => {
      const id = String(t.id ?? '').trim();
      const leads = Array.isArray(t.leads) ? t.leads.map(String) : [];
      if (!id || !leads.length) throw new BadRequest('Each team in teams.yaml needs an id and leads');
      return { id, name: String(t.name ?? id), leadIds: leads, memberIds: [...new Set(leads.flatMap(l => [l, ...reportsOf(l)]))] };
    });
  }
  const cos = chiefOfStaffId(wp);
  if (!cos) return [];
  const under = reportsOf(cos);
  const out: Team[] = [];
  const small: string[] = [];
  for (const lead of under) {
    const reports = reportsOf(lead);
    if (reports.length >= 2) {
      const name = people.find(e => e.id === lead)?.name ?? lead;
      out.push({ id: lead, name: `${name}'s team`, leadIds: [lead], memberIds: [lead, ...reports] });
    } else small.push(lead);
  }
  if (small.length) out.push({ id: 'small', name: 'Experts & prompts', leadIds: small, memberIds: [...new Set(small.flatMap(l => [l, ...reportsOf(l)]))] });
  return out;
}

const COLUMN: Record<string, BoardColumn> = {
  backlog: 'todo', ready: 'todo', 'on-hold': 'todo',
  'in-progress': 'progress', waiting: 'progress', blocked: 'progress', parked: 'progress',
  'in-review': 'review', qa: 'qa', approved: 'qa', merged: 'done', 'awaiting-mac': 'done', done: 'done',
};

export function teamBoard(wp: Workplace, teamId: string, nowMs = Date.now()): TeamBoard {
  const sprint = roll(wp, nowMs);
  const team = teams(wp).find(t => t.id === teamId);
  if (!team) throw new NotFound(`No team ${teamId}`);
  const columns: TeamBoard['columns'] = { todo: [], progress: [], review: [], qa: [], done: [] };
  if (!team.memberIds.length) return { team, sprint, columns };
  const marks = team.memberIds.map(() => '?').join(', ');
  const rows = rowsJson<WorkItem>(wp.db.prepare(`select json from work where employee_id in (${marks}) order by coalesce(rank, 0), created_at`).all(...team.memberIds));
  const inWindow = (since: string | undefined): boolean => !!since && istDate(Date.parse(since)) >= sprint.start;
  for (const w of rows) {
    const level = levelOf(w);
    if (level === 'epic') continue;
    if (w.status === 'done' && (!inWindow(w.statusSince) || (w.resolution && w.resolution !== 'done'))) continue;
    if (w.status === 'parked' && !inWindow(w.statusSince)) continue;
    const item = items.toItem(wp, w);
    const col = COLUMN[item.trueStatus ?? item.status] ?? 'todo';
    columns[col].push(item);
  }
  return { team, sprint, columns };
}
