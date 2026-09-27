import type { WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as work from './work.js';
import * as employees from './employees.js';
import { SEED_FEATURE } from '../seed-data/features.js';
import { updateRequirement } from './requirements.js';
import { log } from '../util/logger.js';

/**
 * The feature flow (HLD D7): stated once → a spec by the Chief of Staff →
 * decomposed by the map → each assignee plans, then builds.
 */

/** The employee who writes specs: whoever holds the chief-of-staff charter. */
export function chiefOfStaff(wp: Workplace): string | undefined {
  return wp.org.employees.find(e => e.charterIds.includes('chief-of-staff'))?.id
    ?? wp.org.employees.find(e => e.level === 0)?.id;
}

/**
 * A feature stated without a spec is handed to the Chief of Staff, whose
 * session writes it through the `write_spec` tool. Returns the session's
 * agent id when one was started.
 */
export function requestSpec(wp: Workplace, feature: WorkItem): string | null {
  const cos = chiefOfStaff(wp);
  if (!cos) return null;
  const prompt =
    `Write the spec for feature ${feature.id}: "${feature.title}".\n\n${feature.body}\n\n` +
    (feature.requirementIds.length ? `Requirements it advances: ${feature.requirementIds.join(', ')}.\n` : '') +
    (feature.platformIds.length ? `Platforms: ${feature.platformIds.join(', ')}.\n` : '') +
    'Produce numbered acceptance criteria (AC1..ACn), each testable, plus the evidence expected. ' +
    'Then call the Workplace tool write_spec with featureId and the spec text. Do not build anything.';
  try {
    const agent = employees.talk(wp, cos, prompt, [], { autonomous: true });
    return agent.id;
  } catch (err) {
    log.warn('features', `could not ask ${cos} for a spec: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Seed the first real feature with Iris's real statuses, once. */
export function seedFeature(wp: Workplace): WorkItem | null {
  const done = wp.db.prepare('select value from settings where key = ?').get(`feature-seeded:${SEED_FEATURE.key}`) as { value: string } | undefined;
  if (done) return null;
  const requirementIds = wp.requirements()
    .filter(r => SEED_FEATURE.requirementTitles.includes(r.title))
    .map(r => r.id);
  const feature = work.create(wp, {
    kind: 'feature', title: SEED_FEATURE.title, body: SEED_FEATURE.body,
    requirementIds, platformIds: SEED_FEATURE.platformIds, spec: SEED_FEATURE.spec, by: 'owner',
  });
  work.transition(wp, feature.id, { to: 'specced', by: 'asha', spec: SEED_FEATURE.spec, note: 'spec from the Road doc and the Gaps doc, 27 Sep' });
  const { assignments } = work.decompose(wp, feature.id, { paths: SEED_FEATURE.paths }, 'asha');

  for (const a of assignments) {
    const status = SEED_FEATURE.statuses[a.charterId ?? ''];
    if (!status || !a.employeeId) continue;
    const by = a.employeeId;
    const note = 'status as of 27 Sep, from the definition checklist and the docs; not yet verified by the Workplace';
    if (status.plan) work.attachPlan(wp, a.id, status.plan, by);
    if (['building', 'review', 'done'].includes(status.state)) work.transition(wp, a.id, { to: 'building', by, note });
    if (['review', 'done'].includes(status.state) && status.evidence) work.transition(wp, a.id, { to: 'review', by, evidence: status.evidence, note });
  }
  for (const r of requirementIds) updateRequirement(wp.config.workplaceDir, r, { featureIds: [feature.id] });
  wp.db.prepare('insert into settings (key, value) values (?, ?)').run(`feature-seeded:${SEED_FEATURE.key}`, feature.id);
  log.info('features', `seeded "${SEED_FEATURE.title}" as ${feature.id} with ${assignments.length} assignments`);
  return work.get(wp, feature.id) ?? null;
}

