import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Charter, Employee, LintFinding, MapEntry, OrgProposal, OrgSnapshot, ProposalKind, Unit } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import { commitOrg, loadOrg, parseCharter, renderCharter, saveOrgFiles, summarise, writeCharter, type Org } from './org.js';
import { lint, realFs } from './ownership.js';
import * as inbox from './inbox.js';
import { oneLine } from './one-line.js';
import * as employees from './employees.js';
import { newId, now, rowJson, rowsJson } from './store.js';
import { BadRequest, Conflict } from '../util/errors.js';
import { log } from '../util/logger.js';

/**
 * Org changes are first-class, versioned and approved (HLD D13).
 *
 * A proposal is computed against the live org into a full "after" state,
 * shown as a diff of the org files, filed to the Inbox, and applied only
 * after the owner approves: files written, lint re-run, one git commit with
 * the reason. Signals may suggest one; nothing applies itself.
 */

export interface ProposeOptions {
  kind: ProposalKind;
  reason: string;
  params: Record<string, unknown>;
  proposedBy: string;
}

/** The change, as a function of the org files in a scratch copy. */
type Mutation = (org: Org) => void;

export function propose(wp: Workplace, opts: ProposeOptions): OrgProposal {
  if (!opts.reason.trim()) throw new BadRequest('A proposal needs a reason.');
  const proposer = wp.org.employees.find(e => e.id === opts.proposedBy);
  if (proposer && proposer.level === 2) throw new BadRequest('A hire cannot propose org changes (no level 3).');

  const scratch = scratchCopy(wp.org.dir);
  try {
    const org = loadOrg(scratch);
    const rendered = renderedCharters(org);
    mutationFor(opts.kind, opts.params, wp)(org);
    materialise(org, rendered);
    const after = loadOrg(scratch);
    const findings = lint(after, wp.requirements().map(r => ({ ...r, charterId: null })), { exists: realFs.exists, topLevelDirs: () => [] });
    const diff = diffDirs(wp.org.dir, scratch);

    const proposal: OrgProposal = {
      id: newId('op'),
      kind: opts.kind,
      reason: opts.reason,
      proposedBy: opts.proposedBy,
      state: 'pending',
      params: opts.params,
      before: snapshot(wp.org),
      after: snapshot(after),
      diff,
      inboxId: '',
      createdAt: now(),
      lint: findings,
    };
    const errors = findings.filter(f => f.severity === 'error');
    const stats = diffStats(diff);
    const item = inbox.raise(wp, {
      kind: 'org-change',
      title: `${titleOf(opts.kind)}: ${describe(opts.kind, opts.params)}`,
      // One line for the owner (QA B11): the reason and the diff's size; the diff itself is on the proposal (GET /api/proposals/:id) and behind expand.
      summary: `${oneLine(opts.reason).summary.replace(/[.…]$/, '')} — +${stats.added} −${stats.removed} lines in ${stats.files} file${stats.files === 1 ? '' : 's'}${errors.length ? ' (lint errors: cannot be approved)' : ''}`,
      body: `${opts.reason}\n\n${errors.length ? `Cannot be approved: ${errors.map(e => e.message).join('; ')}\n\n` : ''}Diff: +${stats.added} −${stats.removed} lines in ${stats.files} file(s): ${stats.names.join(', ')}. The full diff is on the proposal.`,
      context: { proposalId: proposal.id, kind: opts.kind, lintErrors: errors.length, params: opts.params },
      onApprove: 'the org files are written and committed; routing and every affected context change on the next session',
      onDeny: 'nothing changes; the proposal is kept with your reason',
      raisedBy: opts.proposedBy,
      options: errors.length
        ? [{ id: 'reject', label: 'Reject (lint errors)', danger: true }]
        : [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject', danger: true }],
    });
    proposal.inboxId = item.id;
    wp.db.prepare('insert into proposals (id, kind, state, created_at, json) values (?, ?, ?, ?, ?)').run(proposal.id, proposal.kind, proposal.state, proposal.createdAt, JSON.stringify(proposal));
    wp.emit({ type: 'proposal.updated', proposal });
    return proposal;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function list(wp: Workplace): OrgProposal[] {
  return rowsJson<OrgProposal>(wp.db.prepare('select json from proposals order by created_at desc, rowid desc').all());
}

export function get(wp: Workplace, id: string): OrgProposal | undefined {
  return rowJson<OrgProposal>(wp.db.prepare('select json from proposals where id = ?').get(id));
}

/** Apply an approved proposal to the real org: write, validate, commit, reload. */
export function apply(wp: Workplace, id: string): OrgProposal {
  const proposal = get(wp, id);
  if (!proposal) throw new BadRequest(`No proposal ${id}`);
  if (proposal.state === 'applied') throw new Conflict(`${id} was already applied`);
  const item = inbox.get(wp, proposal.inboxId);
  if (item?.state !== 'answered' || item.answer?.optionId !== 'approve') {
    throw new BadRequest(`${id} is not approved by the owner (${item?.state === 'answered' ? 'rejected' : 'waiting'})`);
  }
  if (proposal.lint.some(f => f.severity === 'error')) throw new BadRequest(`${id} has lint errors and cannot be applied`);

  const org = loadOrg(wp.org.dir);
  const rendered = renderedCharters(org);
  mutationFor(proposal.kind, proposal.params, wp)(org);
  materialise(org, rendered);
  const reloaded = wp.reloadOrg();
  const commit = commitOrg(wp.org.dir, `${titleOf(proposal.kind)}: ${describe(proposal.kind, proposal.params)}\n\n${proposal.reason}\n\nProposed by ${proposal.proposedBy}; approved in ${proposal.inboxId}.`);

  const applied: OrgProposal = { ...proposal, state: 'applied', ...(commit ? { appliedCommit: commit } : {}), after: snapshot(reloaded) };
  wp.db.prepare('update proposals set state = ?, json = ? where id = ?').run('applied', JSON.stringify(applied), id);
  wp.emit({ type: 'proposal.updated', proposal: applied });
  for (const e of reloaded.employees) wp.emit({ type: 'office.updated', card: employees.card(wp, e.id) });
  log.info('proposals', `applied ${id} (${proposal.kind}) as ${commit}`);
  return applied;
}

function setState(wp: Workplace, id: string, state: OrgProposal['state']): void {
  const p = get(wp, id);
  if (!p || p.state === 'applied') return;
  const next = { ...p, state };
  wp.db.prepare('update proposals set state = ?, json = ? where id = ?').run(state, JSON.stringify(next), id);
  wp.emit({ type: 'proposal.updated', proposal: next });
}

// An answered org-change item moves its proposal along; approval applies it.
inbox.onAnswer((wp, item) => {
  if (item.kind !== 'org-change') return;
  const id = String(item.context['proposalId'] ?? '');
  if (!id) return;
  if (item.answer?.optionId === 'approve') {
    setState(wp, id, 'approved');
    try { apply(wp, id); } catch (err) { log.warn('proposals', `apply ${id} failed: ${err instanceof Error ? err.message : err}`); }
  } else {
    setState(wp, id, 'rejected');
  }
});

/* ---------- the mutations ---------- */

function mutationFor(kind: ProposalKind, params: Record<string, unknown>, wp: Workplace): Mutation {
  switch (kind) {
    case 'hire': return hire(params, wp);
    case 'retire': return retire(params);
    case 'split': return split(params);
    case 'merge': return merge(params);
    case 'reassign': return reassign(params);
    case 'restructure': return restructure(params);
  }
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new BadRequest(`params.${name} is required`);
  return v.trim();
};
const strs = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Hire: a new employee from a role template, holding a charter (existing or
 * new). A contractor (level 2) gets a branch in its lead's repo; a permanent
 * hire is an owner decision (it is: every proposal is).
 */
function hire(params: Record<string, unknown>, wp: Workplace): Mutation {
  return org => {
    const id = slug(str(params['id'] ?? params['name'], 'name'));
    const name = str(params['name'], 'name');
    const roleId = str(params['roleId'], 'roleId');
    const role = org.roles.find(r => r.id === roleId);
    if (!role) throw new BadRequest(`No role ${roleId}`);
    if (org.employees.some(e => e.id === id)) throw new BadRequest(`Employee ${id} already exists`);
    const reportsTo = typeof params['reportsTo'] === 'string' ? params['reportsTo'] : (org.employees.find(e => e.level === 0)?.id ?? null);
    const lead = reportsTo ? org.employees.find(e => e.id === reportsTo) : undefined;
    if (reportsTo && !lead) throw new BadRequest(`No employee ${reportsTo} to report to`);
    if (lead && lead.level === 2) throw new BadRequest('A hire cannot report to a hire (no level 3).');
    const charterIds = strs(params['charterIds']);
    for (const c of charterIds) if (!org.charters.has(c)) throw new BadRequest(`No charter ${c}`);
    const unitId = typeof params['unitId'] === 'string' ? params['unitId'] : (lead?.unitId ?? org.units[0]?.id ?? 'product');
    if (!org.units.some(u => u.id === unitId)) throw new BadRequest(`No unit ${unitId}`);
    const permanent = role.level < 2;
    const repo = typeof params['repo'] === 'string' ? params['repo'] : (lead?.workspace.repo ?? org.repos[0]?.root ?? wp.org.repos[0]?.root ?? '');
    const employee: Employee = {
      id, name, roleId, level: role.level, permanent, charterIds, unitId, chapterIds: strs(params['chapterIds']), reportsTo,
      workspace: { repo, branch: permanent ? (lead?.workspace.branch ?? 'main') : `${id}/work` },
      budget: { inrPerDay: Number(params['inrPerDay'] ?? (role.budgetClass === 'high' ? 250 : role.budgetClass === 'medium' ? 150 : 80)), concurrentSessions: 1 },
      ...(permanent ? { githubApp: `iris-${charterIds[0] ?? id}-lead` } : {}),
      state: 'idle',
    };
    org.employees.push(employee);
  };
}

function retire(params: Record<string, unknown>): Mutation {
  return org => {
    const id = str(params['employeeId'], 'employeeId');
    const e = org.employees.find(x => x.id === id);
    if (!e) throw new BadRequest(`No employee ${id}`);
    const successor = typeof params['successorId'] === 'string' ? params['successorId'] : null;
    if (e.charterIds.length && !successor) throw new BadRequest(`${id} holds ${e.charterIds.join(', ')}; name a successorId`);
    if (successor) {
      const s = org.employees.find(x => x.id === successor);
      if (!s) throw new BadRequest(`No employee ${successor}`);
      s.charterIds = [...new Set([...s.charterIds, ...e.charterIds])];
    }
    for (const other of org.employees) if (other.reportsTo === id) other.reportsTo = e.reportsTo ?? successor;
    org.employees = org.employees.filter(x => x.id !== id);
  };
}

/**
 * Split a charter into two: the owned things are divided by an explicit
 * assignment of keys (everything not named goes to the first); holders are
 * kept on the first; the second waits for a hire or a reassign.
 */
function split(params: Record<string, unknown>): Mutation {
  return org => {
    const from = str(params['charterId'], 'charterId');
    const source = org.charters.get(from);
    if (!source) throw new BadRequest(`No charter ${from}`);
    const into = (params['into'] as { id?: string; title?: string; mission?: string; keys?: string[]; body?: string }[] | undefined) ?? [];
    if (into.length < 2) throw new BadRequest('A split needs at least two target charters in params.into');
    const targets = into.map(t => {
      const id = slug(str(t.id, 'into[].id'));
      if (org.charters.has(id) && id !== from) throw new BadRequest(`Charter ${id} already exists`);
      return { id, title: t.title ?? id, mission: t.mission ?? source.mission, keys: new Set(t.keys ?? []), body: t.body };
    });

    for (const t of targets) {
      const body = t.body ?? `## Mission and scope\n- ${t.mission}\n- Split from ${source.title} (${from}) on ${now().slice(0, 10)}.\n\n${sectionsAfterScope(source.body)}`;
      const charter: Charter = { ...source, id: t.id, title: t.title, mission: t.mission, version: 1, body, path: join(org.dir, 'charters', `${t.id}.md`), holderIds: [], owns: [] };
      org.charters.set(t.id, charter);
    }
    if (!targets.some(t => t.id === from)) org.charters.delete(from);

    org.map = org.map.map(entry => {
      const remap = (c: string): string => {
        if (c !== from) return c;
        const named = targets.find(t => t.keys.has(entry.key) || t.keys.has(`${entry.kind}:${entry.key}`));
        return (named ?? targets[0]!).id;
      };
      return { ...entry, primary: remap(entry.primary), contributors: entry.contributors.map(remap), consulted: entry.consulted.map(remap) };
    });
    const first = targets[0]!.id;
    for (const e of org.employees) e.charterIds = e.charterIds.map(c => c === from ? first : c);
    const holders = strs(params['holders']);   // optional: "employeeId:charterId" pairs for the other targets
    for (const pair of holders) {
      const [emp, ch] = pair.split(':');
      const e = org.employees.find(x => x.id === emp);
      if (e && ch && org.charters.has(ch) && !e.charterIds.includes(ch)) e.charterIds.push(ch);
    }
  };
}

function merge(params: Record<string, unknown>): Mutation {
  return org => {
    const ids = strs(params['charterIds']);
    if (ids.length < 2) throw new BadRequest('A merge needs at least two charterIds');
    const into = slug(str(params['into'], 'into'));
    const sources = ids.map(id => { const c = org.charters.get(id); if (!c) throw new BadRequest(`No charter ${id}`); return c; });
    const base = sources[0]!;
    const merged: Charter = {
      ...base,
      id: into,
      title: typeof params['title'] === 'string' ? params['title'] : sources.map(s => s.title).join(' + '),
      mission: typeof params['mission'] === 'string' ? params['mission'] : base.mission,
      version: 1,
      body: sources.map(s => `## Mission and scope\n- Merged from ${s.title} (${s.id}).\n\n${s.body.replace(/^## Mission and scope[\s\S]*?(?=^## )/m, '')}`).join('\n\n'),
      path: join(org.dir, 'charters', `${into}.md`), holderIds: [], owns: [],
    };
    for (const id of ids) org.charters.delete(id);
    org.charters.set(into, merged);
    const remap = (c: string) => ids.includes(c) ? into : c;
    org.map = org.map.map(e => ({ ...e, primary: remap(e.primary), contributors: [...new Set(e.contributors.map(remap))].filter(c => c !== remap(e.primary)), consulted: [...new Set(e.consulted.map(remap))].filter(c => c !== remap(e.primary)) }));
    for (const e of org.employees) e.charterIds = [...new Set(e.charterIds.map(remap))];
  };
}

function reassign(params: Record<string, unknown>): Mutation {
  return org => {
    const charterId = str(params['charterId'], 'charterId');
    const to = str(params['toEmployeeId'], 'toEmployeeId');
    if (!org.charters.has(charterId)) throw new BadRequest(`No charter ${charterId}`);
    const target = org.employees.find(e => e.id === to);
    if (!target) throw new BadRequest(`No employee ${to}`);
    const from = typeof params['fromEmployeeId'] === 'string' ? params['fromEmployeeId'] : undefined;
    for (const e of org.employees) {
      if ((from ? e.id === from : true) && e.id !== to) e.charterIds = e.charterIds.filter(c => c !== charterId);
    }
    if (!target.charterIds.includes(charterId)) target.charterIds.push(charterId);
  };
}

/** Create a unit or move an employee/charter holder between units. */
function restructure(params: Record<string, unknown>): Mutation {
  return org => {
    const units = (params['units'] as Partial<Unit>[] | undefined) ?? [];
    for (const u of units) {
      const id = slug(str(u.id, 'units[].id'));
      const existing = org.units.find(x => x.id === id);
      const next: Unit = { id, title: u.title ?? existing?.title ?? id, parentId: u.parentId ?? existing?.parentId ?? null, kind: u.kind ?? existing?.kind ?? 'unit', ...(u.budget ? { budget: u.budget } : existing?.budget ? { budget: existing.budget } : {}) };
      if (next.parentId && !org.units.some(x => x.id === next.parentId) && !units.some(x => x.id === next.parentId)) throw new BadRequest(`No unit ${next.parentId}`);
      if (existing) Object.assign(existing, next); else org.units.push(next);
    }
    const moves = (params['moves'] as { employeeId: string; unitId?: string; reportsTo?: string | null; chapterIds?: string[] }[] | undefined) ?? [];
    for (const m of moves) {
      const e = org.employees.find(x => x.id === m.employeeId);
      if (!e) throw new BadRequest(`No employee ${m.employeeId}`);
      if (m.unitId) { if (!org.units.some(u => u.id === m.unitId)) throw new BadRequest(`No unit ${m.unitId}`); e.unitId = m.unitId; }
      if (m.reportsTo !== undefined) e.reportsTo = m.reportsTo;
      if (m.chapterIds) e.chapterIds = m.chapterIds;
    }
  };
}

/* ---------- helpers ---------- */

/** What each charter renders to before the mutation, so only real changes are written. */
function renderedCharters(org: Org): Map<string, string> {
  return new Map([...org.charters.values()].map(c => [c.id, renderCharter(c)]));
}

/** Write org.yaml/map.yaml, the charters that changed or are new, and delete the removed ones. */
function materialise(org: Org, before: Map<string, string>): void {
  saveOrgFiles(org);
  for (const c of org.charters.values()) {
    if (before.get(c.id) !== renderCharter(c)) writeCharter(org, c);
  }
  for (const id of before.keys()) {
    if (!org.charters.has(id)) rmSync(join(org.dir, 'charters', `${id}.md`), { force: true });
  }
}

function snapshot(org: Org): OrgSnapshot {
  return {
    units: structuredClone(org.units),
    employees: structuredClone(org.employees),
    charters: [...org.charters.values()].map(summarise),
    map: structuredClone(org.map) as MapEntry[],
  };
}

function scratchCopy(dir: string): string {
  const scratch = join(dir, '..', `.${dir.split('/').pop()}-proposal-${process.pid}-${Date.now()}`);
  execFileSync('rsync', ['-a', '--exclude', '.git', '--exclude', 'workplace.db*', `${dir}/`, `${scratch}/`]);
  return scratch;
}

/** Lines added and removed, and the files touched, in a unified diff (`diff -ruN`). */
export function diffStats(diff: string): { added: number; removed: number; files: number; names: string[] } {
  let added = 0, removed = 0;
  const names: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { const p = line.slice(4).split('\t')[0] ?? ''; names.push(p.split('/').slice(-2).join('/')); continue; }
    if (line.startsWith('--- ')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed, files: names.length, names };
}

/** A unified diff of the org files between the live dir and the scratch copy. */
function diffDirs(before: string, after: string): string {
  try {
    execFileSync('diff', ['-ruN', '--exclude', '.git', '--exclude', 'workplace.db*', '--exclude', 'employees', before, after], { encoding: 'utf8' });
    return '';
  } catch (err) {
    const out = (err as { stdout?: string }).stdout ?? '';
    return out.replace(new RegExp(before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 'org').replace(new RegExp(after.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 'org');
  }
}

function sectionsAfterScope(body: string): string {
  const i = body.search(/^## Owned things/m);
  return i >= 0 ? body.slice(i) : '';
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const titleOf = (kind: ProposalKind): string =>
  ({ hire: 'Hire', retire: 'Retire', split: 'Split charter', merge: 'Merge charters', reassign: 'Reassign charter', restructure: 'Restructure' })[kind];

function describe(kind: ProposalKind, p: Record<string, unknown>): string {
  switch (kind) {
    case 'hire': return `${String(p['name'] ?? p['id'])} as ${String(p['roleId'])} holding ${strs(p['charterIds']).join(', ') || 'nothing yet'}`;
    case 'retire': return String(p['employeeId']);
    case 'split': return `${String(p['charterId'])} into ${((p['into'] as { id?: string }[]) ?? []).map(t => t.id).join(' + ')}`;
    case 'merge': return `${strs(p['charterIds']).join(' + ')} into ${String(p['into'])}`;
    case 'reassign': return `${String(p['charterId'])} to ${String(p['toEmployeeId'])}`;
    case 'restructure': return `${((p['units'] as unknown[]) ?? []).length} unit(s), ${((p['moves'] as unknown[]) ?? []).length} move(s)`;
  }
}

export { parseCharter, renderCharter, readFileSync, existsSync };
export type { LintFinding };
