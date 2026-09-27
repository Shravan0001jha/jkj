import type {
  AssignmentState, Evidence, FeatureState, RouteResult, WorkItem, WorkKind, WorkState,
} from '@jkj/shared';
import type { Workplace } from './workplace.js';
import { newId, now, rowJson, rowsJson } from './store.js';
import { route } from './ownership.js';
import { BadRequest } from '../util/errors.js';

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
}

export function create(wp: Workplace, spec: CreateWork): WorkItem {
  if (!spec.title.trim()) throw new BadRequest('Work needs a title.');
  const initial: WorkState = spec.kind === 'feature' ? 'stated' : 'proposed';

  let charterId = spec.charterId;
  let employeeId = spec.employeeId;

  // An assignment to a charter goes to the least-loaded holder; one to an
  // employee takes that employee's first charter unless told otherwise.
  if (spec.kind !== 'feature') {
    if (employeeId && !charterId) charterId = wp.org.employees.find(e => e.id === employeeId)?.charterIds[0];
    if (charterId && !employeeId) employeeId = leastLoadedHolder(wp, charterId);
    if (charterId && !wp.org.charters.has(charterId)) throw new BadRequest(`No charter ${charterId}`);
    if (employeeId && !wp.org.employees.some(e => e.id === employeeId)) throw new BadRequest(`No employee ${employeeId}`);
  }

  const at = now();
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
    history: [{ at, from: null, to: initial, by: spec.by ?? 'owner' }],
  };
  save(wp, item, true);
  return item;
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
}

export function transition(wp: Workplace, id: string, opts: TransitionOptions): WorkItem {
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
      if (!plan?.trim()) throw new BadRequest('An assignment is planned only once a plan is attached.');
      patch.plan = plan;
    }
    if (opts.to === 'review') {
      const evidence = opts.evidence ?? item.evidence;
      if (!evidence) throw new BadRequest('Review needs evidence: tests, commits or notes for non-code work.');
      if (!evidence.tests) throw new BadRequest('Evidence needs test counts (0/0 is allowed for non-code work).');
      if (evidence.commits.length === 0 && !evidence.notes?.trim()) throw new BadRequest('Evidence needs commits, or notes for non-code work.');
      patch.evidence = evidence;
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
    history: [...item.history, { at, from: item.state, to: opts.to, by: opts.by, ...(opts.note ? { note: opts.note } : {}) }],
  };
  save(wp, updated);
  if (updated.featureId) rollUpFeature(wp, updated.featureId);
  return updated;
}

/**
 * The assignee's own "done" is a claim, so it lands in review. This is what
 * the session's report_done tool calls.
 */
export function reportDone(wp: Workplace, id: string, evidence: Evidence, by: string): WorkItem {
  const item = require$(wp, id);
  if (item.state === 'proposed') {
    // A build that skipped the plan still needs one on record.
    throw new BadRequest('Attach a plan before reporting work as done.');
  }
  if (item.state === 'planned') transition(wp, id, { to: 'building', by });
  return transition(wp, id, { to: 'review', by, evidence });
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
export function decompose(wp: Workplace, featureId: string, extra: FeatureThings = {}, by = 'chief-of-staff'): { feature: WorkItem; assignments: WorkItem[]; route: RouteResult } {
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
  wp.emit({ type: 'work.updated', item });
}

export function setSession(wp: Workplace, id: string, sessionId: string): WorkItem {
  const item = require$(wp, id);
  const updated = { ...item, sessionId, updatedAt: now() };
  save(wp, updated);
  return updated;
}

/** The first "## Plan" section of a reply, if the employee wrote one. */
export function parsePlan(text: string): string | null {
  const m = /^##\s+Plan\s*$([\s\S]*?)(?=^##\s|\Z)/mi.exec(text) ?? /##\s+Plan\s*\n([\s\S]*)/i.exec(text);
  const body = m?.[1]?.trim();
  return body ? body : null;
}
