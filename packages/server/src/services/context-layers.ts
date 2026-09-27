import type { ContextLayer, Employee, WorkItem } from '@jkj/shared';
import type { Org } from './org.js';
import { readEmployeeFile } from './org.js';
import { estimateTokens } from './context.js';

/**
 * Knowledge as layers, like the org (HLD D4).
 *
 *   1. company handbook
 *   2. the unit chain, outermost first
 *   3. each charter the employee holds
 *   4. the employee's status and handoff
 *   5. the assignment
 *
 * Assembled at spawn into the text appended to Claude Code's own system
 * prompt. Reorganising moves a charter between units and the next spawn
 * inherits differently; nothing is rewritten.
 */

export interface AssembledContext {
  layers: ContextLayer[];
  append: string;
  tokens: number;
  truncated: boolean;
}

export const PLAN_FIRST =
  'Reply with a plan first, under a heading "## Plan": what you will change, how you will test it, ' +
  'and what needs someone else. Do not build until the plan is written. When done, report with ' +
  'evidence: tests passed/failed with the command, commits, what was live-verified and what was not.';

export function assembleContext(
  org: Org,
  employee: Employee,
  options: { assignment?: WorkItem; maxTokens?: number; role?: string } = {},
): AssembledContext {
  const layers: ContextLayer[] = [];
  const push = (id: string, kind: ContextLayer['kind'], label: string, summary: string, path: string, body: string): void => {
    layers.push({ id, kind, label, summary, path, exists: body.length > 0, inherited: false, body, tokens: estimateTokens(body), counted: true });
  };

  push('handbook', 'user', 'Company handbook', 'Rules every employee inherits.', `${org.dir}/handbook.md`, org.handbook);

  for (const unit of unitChain(org, employee.unitId)) {
    const doc = org.unitDocs.get(unit.id) ?? '';
    push(`unit:${unit.id}`, 'project', `Unit: ${unit.title}`, unit.parentId ? 'Inherited from the unit above.' : 'The unit this employee belongs to.', `${org.dir}/units/${unit.id}.md`, doc);
  }
  for (const chapterId of employee.chapterIds) {
    const unit = org.units.find(u => u.id === chapterId);
    const doc = org.unitDocs.get(chapterId) ?? '';
    if (unit && doc) push(`chapter:${chapterId}`, 'project', `Chapter: ${unit.title}`, 'A chapter this employee also sits in.', `${org.dir}/units/${chapterId}.md`, doc);
  }

  for (const charterId of employee.charterIds) {
    const charter = org.charters.get(charterId);
    if (!charter) continue;
    push(`charter:${charterId}`, 'project', `Charter: ${charter.title}`, `Version ${charter.version}. ${charter.mission}`, charter.path, charter.body);
  }

  const role = org.roles.find(r => r.id === employee.roleId);
  if (role?.instructions) push(`role:${role.id}`, 'project', `Role: ${role.title}`, 'The role template.', `${org.dir}/roles.yaml`, role.instructions);

  push('status', 'memory', 'Status', 'Three lines: doing, done, blocked. Written before every session ends.', `${org.dir}/employees/${employee.id}/status.md`, readEmployeeFile(org, employee.id, 'status.md'));
  push('handoff', 'memory', 'Handoff', 'What the next session needs to know.', `${org.dir}/employees/${employee.id}/handoff.md`, readEmployeeFile(org, employee.id, 'handoff.md'));

  if (options.assignment) {
    push('assignment', 'local', `Assignment: ${options.assignment.title}`, 'The work this session is for.', '', renderAssignment(options.assignment));
  }

  return render(employee, layers, options.maxTokens ?? 24_000);
}

/** Outermost first: a unit's parent chain, then the unit. */
export function unitChain(org: Org, unitId: string) {
  const chain = [];
  let current = org.units.find(u => u.id === unitId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentId ? org.units.find(u => u.id === current!.parentId) : undefined;
  }
  return chain;
}

export function renderAssignment(item: WorkItem): string {
  const lines = [
    `Id: ${item.id}`,
    `Kind: ${item.kind}`,
    item.featureId ? `Feature: ${item.featureId}` : '',
    item.requirementIds.length ? `Requirements: ${item.requirementIds.join(', ')}` : '',
    item.platformIds.length ? `Platforms: ${item.platformIds.join(', ')}` : '',
    '',
    item.body,
    item.spec ? `\n### Spec\n${item.spec}` : '',
    item.plan ? `\n### Your plan so far\n${item.plan}` : '',
    '',
    PLAN_FIRST,
  ];
  return lines.filter(l => l !== '').join('\n');
}

function render(employee: Employee, layers: ContextLayer[], maxTokens: number): AssembledContext {
  const head = `You are ${employee.name}, an employee of the Iris Workplace (id: ${employee.id}). ` +
    'Your context is layered: the company handbook, your unit, your charters, your own status and handoff, and the assignment. ' +
    'Stay inside your charters; route anything else through its owner.';

  let truncated = false;
  const budget = maxTokens - estimateTokens(head);
  let used = 0;
  const parts: string[] = [];

  for (const layer of layers) {
    if (!layer.body.trim()) continue;
    let body = layer.body;
    if (used + layer.tokens > budget && layer.id.startsWith('charter:')) {
      // Charter detail after "Rules and traps" lives in linked docs; drop it first.
      body = trimCharter(body);
      truncated = true;
    }
    const tokens = estimateTokens(body);
    if (used + tokens > budget) { truncated = true; continue; }
    used += tokens;
    parts.push(`## ${layer.label}\n${body.trim()}`);
  }

  const append = [head, ...parts].join('\n\n');
  return { layers, append, tokens: estimateTokens(append), truncated };
}

function trimCharter(body: string): string {
  const i = body.search(/^## Definition of done/m);
  return i > 0 ? `${body.slice(0, i).trimEnd()}\n\n(Definition of done, build/test/ship and coordination sections omitted for context size; read the charter file.)\n` : body;
}
