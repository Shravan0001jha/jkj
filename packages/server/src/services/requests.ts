import type { AssignmentState, RequestResponse, RequestStatus, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as work from './work.js';
import * as stall from './stall.js';
import * as features from './features.js';
import { oneLine } from './one-line.js';
import { BadRequest } from '../util/errors.js';

/**
 * The owner's requests (29 Sep, phone): free text in, a feature out, with Asha asked for the spec,
 * and a status the owner can read at every stage. The status is derived from the feature and its
 * assignments; nothing here is stored beyond the feature itself and the agent id that was asked.
 */

export function create(wp: Workplace, spec: { text: string; platformIds?: string[]; by?: string }): RequestResponse {
  const text = spec.text.trim();
  if (!text) throw new BadRequest('A request needs some text.');
  const title = oneLine(text).summary;
  const feature = work.create(wp, { kind: 'feature', title, body: text, platformIds: spec.platformIds ?? [], requirementIds: [], by: spec.by ?? 'owner' });
  const agentId = features.requestSpec(wp, feature);
  if (agentId) wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`spec-asked:${feature.id}`, agentId);
  return { feature: work.get(wp, feature.id)!, status: status(wp, work.get(wp, feature.id)!) };
}

export function list(wp: Workplace): RequestResponse[] {
  return work.list(wp, { kind: 'feature' })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .map(feature => ({ feature, status: status(wp, feature) }));
}

export function status(wp: Workplace, feature: WorkItem, nowMs = Date.now()): RequestStatus {
  const parts = stall.annotate(wp, work.list(wp, { kind: 'assignment', featureId: feature.id }), nowMs).filter(a => a.state !== 'rejected');
  const assignments: RequestStatus['assignments'] = parts.map(a => ({
    id: a.id, title: a.title, state: a.state as AssignmentState,
    ...(a.employeeId ? { employeeId: a.employeeId } : {}), ...(a.charterId ? { charterId: a.charterId } : {}),
    ...(a.stalledSince ? { stalledSince: a.stalledSince } : {}),
  }));
  const asked = wp.db.prepare('select value from settings where key = ?').get(`spec-asked:${feature.id}`) as { value: string } | undefined;
  const cos = features.chiefOfStaff(wp);
  const name = cos ? (wp.org.employees.find(e => e.id === cos)?.name ?? cos) : 'the Chief of Staff';
  const base = { assignments, ...(asked ? { askedAgentId: asked.value } : {}) };

  if (feature.state === 'released') return { ...base, stage: 'released', line: 'Released.' };
  if (feature.state === 'built') return { ...base, stage: 'built', line: `Built: ${parts.length} assignment${parts.length === 1 ? '' : 's'} done and verified; ready for a release.` };
  if (feature.state === 'stated') return { ...base, stage: 'with-asha', line: asked ? `${name} is writing the spec.` : `Waiting for ${name} to write the spec.` };
  if (feature.state === 'specced' || parts.length === 0) return { ...base, stage: 'specced', line: `Spec written by ${name}; ready to route to the teams.` };

  const count = (s: AssignmentState) => parts.filter(a => a.state === s).length;
  const n = parts.length;
  const blocked = count('blocked');
  const building = count('building') + count('planned');
  const review = count('review');
  const done = count('done');
  const bits: string[] = [];
  if (building) bits.push(`${building} of ${n} building`);
  if (review) bits.push(`${review} in review`);
  if (done) bits.push(`${done} done`);
  if (blocked) bits.push(`${blocked} blocked`);
  const stalled = parts.filter(a => a.stalledSince).length;
  if (stalled) bits.push(`${stalled} stalled`);
  const line = bits.length ? `${bits.join(', ')}.` : `Routed to ${n} team${n === 1 ? '' : 's'}; waiting to start.`;
  const stage: RequestStatus['stage'] = blocked ? 'blocked' : review && !building ? 'review' : building || review ? 'building' : 'routed';
  return { ...base, stage, line };
}
