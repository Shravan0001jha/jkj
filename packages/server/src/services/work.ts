import type {
  AssignmentState, Evidence, FeatureState, RouteResult, WorkItem, WorkKind, WorkState,
} from '@jkj/shared';
import type { Workplace } from './workplace.js';
import { newId, now, rowJson, rowsJson } from './store.js';
import { route } from './ownership.js';
import { BadRequest } from '../util/errors.js';
import { authorId, chiefOfStaffId, defaultReviewer, levelOf, statusFromState } from './v2-map.js';
import * as trail from './trail.js';

/**
 * Work is independent of the org (HLD D7).
 *
 * Features are stated once, specced, and decomposed by the ownership map into
 * one assignment per charter touched. An assignment moves proposed → planned
 * → building → review → done; "done" is set by a verifier, never by the
 * assignee's own claim. That is the false-done guard.
 */

const ASSIGNMENT_TRANSITIONS: Record<AssignmentState, AssignmentState[]> = {
  proposed: ['planned', 'blocked', 'rejected'],
  planned: ['building', 'blocked', 'rejected'],
  building: ['review', 'blocked', 'rejected'],
  review: ['done', 'building', 'blocked', 'rejected'],
  blocked: ['proposed', 'planned', 'building', 'rejected'],
  done: [],
  rejected: [],
};

const FEATURE_TRANSITIONS: Record<FeatureState, FeatureState[]> = {
  stated: ['specced'],
  specced: ['decomposed'],
  decomposed: ['in-progress', 'built'],
  'in-progress': ['built'],
  built: ['released'],
  released: [],
};

export interface CreateWork {
  kind: WorkKind;
  title: string;
  body: string;
  charterId?: string;
  employeeId?: string;
  featureId?: string;
  requirementIds?: string[];
  platformIds?: string[];
  spec?: string;
  by?: string;
  /** v2 fields set at creation (items.ts): level, parentId, status, points, reviewer, owner, area, rank, … */
  v2?: Partial<Pick<WorkItem, 'level' | 'parentId' | 'status' | 'points' | 'reviewerId' | 'ownerId' | 'areaId' | 'rank' | 'targetDate' | 'acceptance' | 'hold'>>;
}

export function create(wp: Workplace, spec: CreateWork): WorkItem {
  if (!spec.title.trim()) throw new BadRequest('Work needs a title.');
  const initial: WorkState = spec.kind === 'feature' ? 'stated' : 'proposed';
  const by = authorId(wp, spec.by ?? 'workplace');

  let charterId = spec.charterId;
  let employeeId = spec.employeeId;

  // An assignment to a charter goes to the least-loaded holder; one to an
  // employee takes that employee's first charter unless told otherwise.
  // v2: the owner can be an assignee ("approve the release"); such an item never gets a session.
  if (spec.kind !== 'feature' && employeeId !== 'owner') {
    if (employeeId && !charterId) charterId = wp.org.employees.find(e => e.id === employeeId)?.charterIds[0];
    if (charterId && !employeeId) employeeId = leastLoadedHolder(wp, charterId);
    if (charterId && !wp.org.charters.has(charterId)) throw new BadRequest(`No charter ${charterId}`);
    if (employeeId && !wp.org.employees.some(e => e.id === employeeId)) throw new BadRequest(`No employee ${employeeId}`);
  }

  const at = now();
  const level = spec.v2?.level ?? (spec.kind === 'feature' ? 'epic' : 'story');
  const parentId = spec.v2?.parentId ?? (level === 'story' ? spec.featureId : undefined);
  const item: WorkItem = {
    id: newId(spec.kind === 'feature' ? 'ft' : 'as'),
    kind: spec.kind,
    title: spec.title.trim(),
    body: spec.body,
    state: initial,
    ...(charterId ? { charterId } : {}),
    ...(employeeId ? { employeeId } : {}),
    ...(spec.featureId ? { featureId: spec.featureId } : {}),
    requirementIds: spec.requirementIds ?? [],
    platformIds: spec.platformIds ?? [],
    ...(spec.spec ? { spec: spec.spec } : {}),
    createdAt: at,
    updatedAt: at,
    // Attributed to whoever asked; the Workplace's own creations never read as the owner's (HLD D22).
    history: [{ at, from: null, to: initial, by }],
    ...spec.v2,
    level,
    ...(parentId ? { parentId } : {}),
    status: spec.v2?.status ?? 'ready',
    statusSince: at,
    rank: spec.v2?.rank ?? nextRank(wp, level, parentId, spec.v2?.areaId),
  };
  save(wp, item, true);
  trail.afterChange(wp, null, item, by);
  return item;
}

/** Append after the last sibling: epics within their area, everything else within its parent. */
export function nextRank(wp: Workplace, level: string, parentId: string | undefined, areaId?: string): number {
  const row = level === 'epic'
    ? wp.db.prepare("select max(rank) as r from work where level = 'epic' and coalesce(area_id, '') = ?").get(areaId ?? '') as { r: number | null }
    : wp.db.prepare('select max(rank) as r from work where parent_id = ?').get(parentId ?? '') as { r: number | null };
  return (row?.r ?? 0) + 1;
}

export function get(wp: Workplace, id: string): WorkItem | undefined {
  return rowJson<WorkItem>(wp.db.prepare('select json from work where id = ?').get(id));
}

export function require$(wp: Workplace, id: string): WorkItem {
  const item = get(wp, id);
  if (!item) throw new BadRequest(`No work item ${id}`);
  return item;
}

export interface Query {
  kind?: WorkKind;
  state?: WorkState;
  charterId?: string;
  employeeId?: string;
  featureId?: string;
}

export function list(wp: Workplace, q: Query = {}): WorkItem[] {
  const where: string[] = [];
  const args: string[] = [];
  for (const [col, val] of [['kind', q.kind], ['state', q.state], ['charter_id', q.charterId], ['employee_id', q.employeeId], ['feature_id', q.featureId]] as const) {
    if (val) { where.push(`${col} = ?`); args.push(val); }
  }
  const sql = `select json from work${where.length ? ` where ${where.join(' and ')}` : ''} order by created_at desc, rowid desc`;
  return rowsJson<WorkItem>(wp.db.prepare(sql).all(...args));
}

export interface TransitionOptions {
  to: WorkState;
  by: string;
  note?: string;
  evidence?: Evidence;
  plan?: string;
  spec?: string;
  /** See WorkHistoryEntry.cause: only ever 'workplace-shutdown', only ever on a transition to 'blocked'. */
  cause?: 'workplace-shutdown';
  /** report_done only (owner, 2 Oct): a missing plan is a warning there, never a refusal. */
  allowNoPlan?: boolean;
}

/** The evidence a review needs (the hard gate): test counts, and commits or notes for non-code work. */
function checkEvidence(evidence: Evidence | undefined): Evidence {
  if (!evidence) throw new BadRequest('Review needs evidence: tests, commits or notes for non-code work.');
  if (!evidence.tests) throw new BadRequest('Evidence needs test counts (0/0 is allowed for non-code work).');
  if (evidence.commits.length === 0 && !evidence.notes?.trim()) throw new BadRequest('Evidence needs commits, or notes for non-code work ("no code needed" and why).');
  return evidence;
}

export function transition(wp: Workplace, id: string, given: TransitionOptions): WorkItem {
  const opts: TransitionOptions = { ...given, by: authorId(wp, given.by) };
  const item = require$(wp, id);
  const allowed = item.kind === 'feature'
    ? FEATURE_TRANSITIONS[item.state as FeatureState]
    : ASSIGNMENT_TRANSITIONS[item.state as AssignmentState];
  if (!allowed || !(allowed as WorkState[]).includes(opts.to)) {
    throw new BadRequest(`${item.kind} ${id} cannot go from ${item.state} to ${opts.to}`);
  }

  const patch: Partial<WorkItem> = {};
  if (item.kind !== 'feature') {
    if (opts.to === 'planned') {
      const plan = opts.plan ?? item.plan;
      if (!plan?.trim() && !opts.allowNoPlan) throw new BadRequest('An assignment is planned only once a plan is attached.');
      if (plan?.trim()) patch.plan = plan;
    }
    if (opts.to === 'review') {
      patch.evidence = checkEvidence(opts.evidence ?? item.evidence);
    }
    if (opts.to === 'done') {
      if (!item.evidence) throw new BadRequest('Nothing is done without evidence.');
      if (opts.by === item.employeeId) throw new BadRequest('An assignee cannot verify its own work; report it for review instead.');
      patch.verifiedBy = opts.by;
    }
  } else if (opts.to === 'specced') {
    const spec = opts.spec ?? item.spec;
    if (!spec?.trim()) throw new BadRequest('A feature is specced only once a spec with acceptance criteria is attached.');
    patch.spec = spec;
  }

  const at = now();
  const updated: WorkItem = {
    ...item,
    ...patch,
    state: opts.to,
    updatedAt: at,
    history: [...item.history, { at, from: item.state, to: opts.to, by: opts.by, ...(opts.note ? { note: opts.note } : {}), ...(opts.cause ? { cause: opts.cause } : {}) }],
  };
  // v2 keeps step (LLD §19.3): the old engine's move sets the v2 status, and its rules hold here too.
  const v2 = statusFromState(item, opts.to, item.status);
  if (v2.status !== item.status) { updated.status = v2.status; updated.statusSince = at; }
  if (v2.status === 'done') updated.resolution = v2.resolution ?? 'done'; else delete updated.resolution;
  if (v2.status === 'in-review' && (!updated.reviewerId || updated.reviewerId === updated.employeeId)) {
    delete updated.reviewerId;
    const reviewer = defaultReviewer(wp, updated);
    if (reviewer) updated.reviewerId = reviewer;
  }
  if (v2.status === 'blocked') {
    updated.blockedReason = opts.note?.trim() || item.blockedReason || 'No reason given';
    updated.waitingOn = item.waitingOn ?? 'coo';
    updated.blockedSince = at;
  } else if (item.status === 'blocked') {
    delete updated.blockedReason; delete updated.waitingOn; delete updated.blockedSince; delete updated.blockedRecommendation;
  }
  save(wp, updated);
  trail.afterChange(wp, item, updated, opts.by, opts.note);
  bumpEpic(wp, updated);
  if (updated.featureId) rollUpFeature(wp, updated.featureId);
  return updated;
}

/** An epic is in progress once any of its stories is (v2 status only; the feature state is the roll-up's). */
function bumpEpic(wp: Workplace, w: WorkItem): void {
  if (w.kind === 'feature' || w.status !== 'in-progress' || !w.featureId) return;
  const epic = get(wp, w.featureId);
  if (!epic || (epic.status !== 'ready' && epic.status !== 'backlog')) return;
  const at = now();
  const next: WorkItem = { ...epic, status: 'in-progress', statusSince: at, updatedAt: at };
  save(wp, next);
  trail.afterChange(wp, epic, next, 'workplace', `Started: ${w.title}`);
}

/** A v2 write (items.ts): the row as given, saved and its trail recorded. */
export function put(wp: Workplace, prev: WorkItem, next: WorkItem, given: string, note?: string): WorkItem {
  const by = authorId(wp, given);
  save(wp, next);
  trail.afterChange(wp, prev, next, by, note);
  bumpEpic(wp, next);
  if (next.featureId && next.kind !== 'feature') rollUpFeature(wp, next.featureId);
  return next;
}

/**
 * The assignee's own "done" is a claim, so it lands in review. This is what
 * the session's report_done tool calls.
 */
export function reportDone(wp: Workplace, id: string, evidence: Evidence, given: string): WorkItem {
  const by = authorId(wp, given);
  const item = require$(wp, id);
  // The hard gates (owner, 2 Oct): evidence (a commit, or notes saying no code was needed; test counts)
  // and a reviewer who is not the author. A missing or late plan never blocks: it is a warning on the item.
  checkEvidence(evidence);
  const reviewer = item.reviewerId && item.reviewerId !== item.employeeId && item.reviewerId !== by ? item.reviewerId : defaultReviewer(wp, item);
  if (!reviewer || reviewer === by) throw new BadRequest('No reviewer other than you: name one (item_update reviewerId) and report again.');
  const warning = planWarning(item);
  if (item.state === 'proposed') transition(wp, id, { to: 'planned', by, allowNoPlan: true, ...(warning ? { note: `Plan warning: ${warning}` } : {}) });
  if (require$(wp, id).state === 'planned') transition(wp, id, { to: 'building', by });
  const reported = transition(wp, id, { to: 'review', by, evidence });
  if (warning) trail.record(wp, { itemId: id, by: 'workplace', kind: 'note', text: `Warning: ${warning}. Reported done anyway (a plan is a habit, not a gate): next time reply "## Plan" before building.` });
  return reported;
}

/**
 * The plan habit (handbook: reply "## Plan" first, then build). Null when a plan was on record before
 * the build; otherwise what went wrong, for the warning and the nudge.
 */
export function planWarning(item: WorkItem): string | null {
  // Rework, 10 Oct: a plan on record is enough (a plan posted as an item_comment lands after the start
  // move, and that is not "late"); only no plan at all warns.
  if (item.kind === 'feature' || item.plan?.trim() || item.history.some(h => h.to === 'planned')) return null;
  return 'no plan was posted before the work';
}

export function attachPlan(wp: Workplace, id: string, plan: string, by: string): WorkItem {
  const item = require$(wp, id);
  if (item.state !== 'proposed') {
    const updated = { ...item, plan, updatedAt: now() };
    save(wp, updated);
    return updated;
  }
  return transition(wp, id, { to: 'planned', by, plan });
}

export function attachSpec(wp: Workplace, id: string, spec: string, ): WorkItem {
  const item = require$(wp, id);
  if (item.kind !== 'feature') throw new BadRequest(`${id} is not a feature`);
  const updated = { ...item, spec, updatedAt: now() };
  save(wp, updated);
  return updated;
}

/** Sent back from review: counted as rework, and as a false "done". */
export function sendBack(wp: Workplace, id: string, by: string, note: string): WorkItem {
  return transition(wp, id, { to: 'building', by, note: `sent back: ${note}` });
}

/* ---------- features ---------- */

export interface FeatureThings {
  paths?: string[];
  services?: string[];
  platformIds?: string[];
  requirementIds?: string[];
}

export function routeFeature(wp: Workplace, feature: WorkItem, extra: FeatureThings = {}): RouteResult {
  const things = [
    ...(extra.paths ?? []).map(key => ({ kind: 'path' as const, key })),
    ...(extra.services ?? []).map(key => ({ kind: 'service' as const, key })),
    ...(extra.platformIds ?? feature.platformIds).map(key => ({ kind: 'platform' as const, key })),
    ...(extra.requirementIds ?? feature.requirementIds).map(key => ({ kind: 'requirement' as const, key })),
  ];
  return route(wp.org.map, { title: feature.title, body: `${feature.body}\n${feature.spec ?? ''}`, things }, wp.requirements());
}

/** One assignment per charter the map says the feature touches. */
export function decompose(wp: Workplace, featureId: string, extra: FeatureThings = {}, by = chiefOfStaffId(wp) ?? 'workplace'): { feature: WorkItem; assignments: WorkItem[]; route: RouteResult } {
  let feature = require$(wp, featureId);
  if (feature.kind !== 'feature') throw new BadRequest(`${featureId} is not a feature`);
  if (feature.state === 'stated') throw new BadRequest('Write the spec before decomposing.');
  const result = routeFeature(wp, feature, extra);
  if (result.primaries.length === 0) throw new BadRequest('The map routed this feature to nobody. Add the things it touches, or fix the map.');

  const existing = list(wp, { kind: 'assignment', featureId });
  const assignments: WorkItem[] = [];
  for (const hit of result.primaries) {
    const already = existing.find(a => a.charterId === hit.charterId && a.state !== 'rejected');
    if (already) { assignments.push(already); continue; }
    const charter = wp.org.charters.get(hit.charterId);
    const because = hit.because.map(t => `${t.kind}:${t.key}`).join(', ');
    // A platform charter's piece is for the platforms it owns among the ones
    // the feature names, or its home platform (its first map entry) when the
    // feature named none of them; a capability charter's piece cuts across
    // every platform the feature names.
    const owned = wp.org.map.filter(m => m.kind === 'platform' && m.primary === hit.charterId).map(m => m.key);
    const shared = feature.platformIds.filter(p => owned.includes(p));
    const platformIds = owned.length ? (shared.length ? shared : [owned[0]!]) : feature.platformIds;
    assignments.push(create(wp, {
      kind: 'assignment',
      title: `${feature.title} — ${charter?.title ?? hit.charterId}`,
      body: `${feature.body}\n\nRouted to ${hit.charterId} because of: ${because}.` +
        (result.consulted.length ? `\nConsult: ${result.consulted.join(', ')}.` : ''),
      charterId: hit.charterId,
      featureId,
      requirementIds: feature.requirementIds,
      platformIds,
      ...(feature.spec ? { spec: feature.spec } : {}),
      by,
    }));
  }
  if (feature.state === 'specced') feature = transition(wp, featureId, { to: 'decomposed', by });
  return { feature, assignments, route: result };
}

/** A feature's state follows its assignments. */
function rollUpFeature(wp: Workplace, featureId: string): void {
  const feature = get(wp, featureId);
  if (!feature || feature.state === 'released' || feature.state === 'built') return;
  const parts = list(wp, { kind: 'assignment', featureId }).filter(a => a.state !== 'rejected');
  if (parts.length === 0) return;
  if (parts.every(a => a.state === 'done') && feature.state !== 'stated' && feature.state !== 'specced') {
    if (feature.state === 'decomposed') transition(wp, featureId, { to: 'in-progress', by: 'workplace' });
    transition(wp, featureId, { to: 'built', by: 'workplace' });
  } else if (feature.state === 'decomposed' && parts.some(a => a.state !== 'proposed')) {
    transition(wp, featureId, { to: 'in-progress', by: 'workplace' });
  }
}

/* ---------- helpers ---------- */

export function leastLoadedHolder(wp: Workplace, charterId: string): string | undefined {
  const holders = wp.org.employees.filter(e => e.charterIds.includes(charterId) && e.state !== 'paused');
  if (holders.length === 0) return undefined;
  const open = new Set<WorkState>(['proposed', 'planned', 'building', 'review']);
  const load = (id: string) => list(wp, { kind: 'assignment', employeeId: id }).filter(a => open.has(a.state)).length;
  return [...holders].sort((a, b) => load(a.id) - load(b.id))[0]!.id;
}

function save(wp: Workplace, item: WorkItem, insert = false): void {
  if (insert) {
    wp.db.prepare('insert into work (id, kind, state, charter_id, employee_id, feature_id, session_id, created_at, updated_at, json) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(item.id, item.kind, item.state, item.charterId ?? null, item.employeeId ?? null, item.featureId ?? null, item.sessionId ?? null, item.createdAt, item.updatedAt, JSON.stringify(item));
  } else {
    wp.db.prepare('update work set state = ?, charter_id = ?, employee_id = ?, feature_id = ?, session_id = ?, updated_at = ?, json = ? where id = ?')
      .run(item.state, item.charterId ?? null, item.employeeId ?? null, item.featureId ?? null, item.sessionId ?? null, item.updatedAt, JSON.stringify(item), item.id);
  }
  // The v2 index columns (LLD §19.1); the JSON stays the source of truth.
  wp.db.prepare('update work set level = ?, status = ?, parent_id = ?, area_id = ?, rank = ?, reviewer_id = ? where id = ?')
    .run(item.level ?? levelOf(item), item.status ?? null, item.parentId ?? null, item.areaId ?? null, item.rank ?? null, item.reviewerId ?? null, item.id);
  wp.emit({ type: 'work.updated', item });
}

/** Save without a trail (migration, field-only housekeeping). */
export function saveQuiet(wp: Workplace, item: WorkItem): void {
  save(wp, item);
}

export function setSession(wp: Workplace, id: string, sessionId: string): WorkItem {
  const item = require$(wp, id);
  const updated = { ...item, sessionId, updatedAt: now() };
  save(wp, updated);
  return updated;
}

/** The first "## Plan" (or "## Plan:") section of a reply or comment, if the employee wrote one. */
export function parsePlan(text: string): string | null {
  const m = /^##[ \t]*Plan\b[ \t]*:?[ \t]*(.*)$([\s\S]*?)(?=^##\s|(?![\s\S]))/mi.exec(text);
  if (m) {
    const body = [m[1] ?? '', m[2] ?? ''].join('\n').trim();
    return body || null;
  }
  const loose = /##[ \t]*Plan\b[ \t]*:?[ \t]*\n([\s\S]*)/i.exec(text);
  return loose?.[1]?.trim() || null;
}

/* ---------- the RCA (rework W3, owner 10 Oct: RCA before code) ---------- */

/** The five parts of an RCA, each matched case-insensitively at the start of a line of the "## RCA" section. */
export const RCA_PARTS: readonly { name: string; re: RegExp }[] = [
  { name: 'Symptom', re: /^symptoms?\b/i },
  { name: 'Root cause', re: /^root[ -]cause\b/i },
  { name: 'Why it escaped (or Why QA missed)', re: /^why\s+(it\s+escaped|qa\s+missed)\b/i },
  { name: 'Fix', re: /^fix(es)?\b/i },
  { name: 'Regression', re: /^regression\b/i },
];

/** A line's text with markdown furniture off its start: bullets, numbering, sub-headings, emphasis. */
const lineStart = (line: string): string => line.replace(/^[\s>]*(?:#{3,6}\s*|[-*+]\s+|\d+[.)]\s*)?(?:\*\*|__)?\s*/, '');

/** The "## RCA" section of a text and which of the five parts it lacks; null when there is no such section. */
export function parseRca(text: string): { text: string; missing: string[] } | null {
  const m = /^##[ \t]*RCA\b[ \t]*:?[^\n]*$([\s\S]*?)(?=^##\s|(?![\s\S]))/mi.exec(text);
  if (!m) return null;
  const section = `${m[0]}`.trim();
  const lines = (m[1] ?? '').split('\n').map(lineStart);
  const missing = RCA_PARTS.filter(p => !lines.some(l => p.re.test(l))).map(p => p.name);
  return { text: section, missing };
}

/** Record a complete RCA on the item (`item.rca`); throws when a part is missing. */
export function attachRca(wp: Workplace, id: string, text: string, by: string): WorkItem {
  const item = require$(wp, id);
  const rca = parseRca(text);
  if (!rca) throw new BadRequest('No "## RCA" section: start the comment with a "## RCA" heading.');
  if (rca.missing.length) throw new BadRequest(`The RCA is missing ${rca.missing.join(', ')}: an RCA has five parts (Symptom, Root cause, Why it escaped, Fix, Regression), each starting a line.`);
  const at = now();
  const updated: WorkItem = { ...item, rca: { text: rca.text, at, by: authorId(wp, by) }, updatedAt: at };
  save(wp, updated);
  trail.record(wp, { itemId: id, by, kind: 'note', text: `RCA recorded (five parts)${item.type === 'bug' ? ': code changes are unlocked' : ''}` });
  return updated;
}

export interface Captured { plan?: boolean; rca?: 'recorded' | { missing: string[] } }

/**
 * A comment from the item's assignee (item_comment) carries its plan or its RCA: a "## Plan" line
 * attaches the plan, a complete five-part "## RCA" records the RCA. Anyone else's comment is only a comment.
 */
export function captureFromComment(wp: Workplace, id: string, by: string, text: string): Captured {
  const item = get(wp, id);
  if (!item || !by || item.employeeId !== authorId(wp, by)) return {};
  const out: Captured = {};
  const plan = parsePlan(text);
  if (plan) { attachPlan(wp, id, plan, by); out.plan = true; }
  const rca = parseRca(text);
  if (rca) {
    if (rca.missing.length) out.rca = { missing: rca.missing };
    else { attachRca(wp, id, text, by); out.rca = 'recorded'; }
  }
  return out;
}

/**
 * An RCA ticket (type 'rca') is done when its RCA is posted (owner, 10 Oct): no code, no pull request,
 * no review. Throws unless the RCA is recorded.
 */
export function closeRca(wp: Workplace, id: string, given: string): WorkItem {
  const by = authorId(wp, given);
  const item = require$(wp, id);
  if (item.type !== 'rca') throw new BadRequest(`${id} is not an RCA ticket.`);
  if (!item.rca) throw new BadRequest('An RCA ticket is done when its RCA is posted: post the five-part "## RCA" with item_comment first.');
  if (item.status === 'done') return item;
  const at = now();
  const note = 'system: RCA posted; an RCA ticket is done without a pull request';
  const next: WorkItem = {
    ...item, status: 'done', statusSince: at, resolution: 'done', updatedAt: at,
    ...(item.state !== 'done' ? { state: 'done' as WorkState, history: [...item.history, { at, from: item.state, to: 'done' as WorkState, by, note }] } : {}),
  };
  delete next.queuedFor;
  return put(wp, item, next, by, note);
}
