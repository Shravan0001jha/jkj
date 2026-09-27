import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import type {
  Charter, CharterSummary, Employee, Level, MapEntry, OrgHistoryEntry, Role, Unit, OwnedThing,
} from '@jkj/shared';
import { BadRequest } from '../util/errors.js';
import { estimateTokens } from './context.js';

/**
 * The organisation, read from files (docs/HLD-workplace.md D1, D2).
 *
 * Everything here is plain files in the workplace directory so a charter can
 * be read by any session, edited by hand, diffed in a proposal and versioned
 * by git. This module loads them into typed objects, validates the references
 * between them, and writes them back. It never decides who does what.
 */

export interface Repo {
  id: string;
  root: string;
  branch?: string;
}

export interface Org {
  dir: string;
  repos: Repo[];
  units: Unit[];
  roles: Role[];
  employees: Employee[];
  charters: Map<string, Charter>;
  unitDocs: Map<string, string>;
  handbook: string;
  map: MapEntry[];
}

interface OrgFile {
  repos?: Repo[];
  units?: Unit[];
  employees?: EmployeeFile[];
}

type EmployeeFile = Omit<Employee, 'state' | 'level' | 'permanent'> & {
  level?: Level; permanent?: boolean; state?: Employee['state'];
};

const LEVEL_OF_ROLE_LEVEL = (role: Role | undefined): Level => role?.level ?? 2;

/* ---------- loading ---------- */

export function loadOrg(dir: string): Org {
  const orgFile = readYaml<OrgFile>(join(dir, 'org.yaml')) ?? {};
  const roles = (readYaml<{ roles?: Role[] }>(join(dir, 'roles.yaml'))?.roles ?? []).map(normaliseRole);
  const map = (readYaml<{ entries?: MapEntry[] }>(join(dir, 'map.yaml'))?.entries ?? []).map(normaliseEntry);
  const charters = loadCharters(join(dir, 'charters'));
  const employees = (orgFile.employees ?? []).map(e => normaliseEmployee(e, roles));

  // Holders are derived from employees, never stored on the charter, so the
  // two can never disagree.
  for (const charter of charters.values()) {
    charter.holderIds = employees.filter(e => e.charterIds.includes(charter.id)).map(e => e.id);
    charter.owns = map.filter(m => m.primary === charter.id).map(m => ({ kind: m.kind, key: m.key }));
  }

  const org: Org = {
    dir,
    repos: orgFile.repos ?? [],
    units: orgFile.units ?? [],
    roles,
    employees,
    charters,
    unitDocs: loadUnitDocs(join(dir, 'units')),
    handbook: readText(join(dir, 'handbook.md')) ?? '',
    map,
  };
  validate(org);
  return org;
}

/** Referential integrity. A broken org is refused with the path that is wrong. */
export function validate(org: Org): void {
  const unitIds = new Set(org.units.map(u => u.id));
  const roleIds = new Set(org.roles.map(r => r.id));
  const employeeIds = new Set(org.employees.map(e => e.id));

  for (const e of org.employees) {
    if (!roleIds.has(e.roleId)) throw new BadRequest(`org.yaml: employee ${e.id} has unknown role ${e.roleId}`);
    if (!unitIds.has(e.unitId)) throw new BadRequest(`org.yaml: employee ${e.id} has unknown unit ${e.unitId}`);
    for (const c of e.chapterIds) if (!unitIds.has(c)) throw new BadRequest(`org.yaml: employee ${e.id} has unknown chapter ${c}`);
    for (const c of e.charterIds) if (!org.charters.has(c)) throw new BadRequest(`org.yaml: employee ${e.id} holds unknown charter ${c}`);
    if (e.reportsTo !== null && !employeeIds.has(e.reportsTo)) throw new BadRequest(`org.yaml: employee ${e.id} reports to unknown ${e.reportsTo}`);
  }
  for (const u of org.units) {
    if (u.parentId !== null && !unitIds.has(u.parentId)) throw new BadRequest(`org.yaml: unit ${u.id} has unknown parent ${u.parentId}`);
  }
}

function loadCharters(dir: string): Map<string, Charter> {
  const charters = new Map<string, Charter>();
  if (!existsSync(dir)) return charters;
  for (const name of readdirSync(dir).filter(n => n.endsWith('.md')).sort()) {
    const path = join(dir, name);
    const charter = parseCharter(readFileSync(path, 'utf8'), path);
    if (charter.id !== name.replace(/\.md$/, '')) {
      throw new BadRequest(`${path}: front-matter id "${charter.id}" does not match the file name`);
    }
    charters.set(charter.id, charter);
  }
  return charters;
}

function loadUnitDocs(dir: string): Map<string, string> {
  const docs = new Map<string, string>();
  if (!existsSync(dir)) return docs;
  for (const name of readdirSync(dir).filter(n => n.endsWith('.md'))) {
    docs.set(name.replace(/\.md$/, ''), readFileSync(join(dir, name), 'utf8'));
  }
  return docs;
}

/* ---------- charters ---------- */

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseCharter(text: string, path = '<charter>'): Charter {
  const match = FRONT.exec(text);
  if (!match) throw new BadRequest(`${path}: a charter starts with YAML front-matter between --- lines`);
  const front = parseYaml(match[1]!) as Record<string, unknown>;
  const body = text.slice(match[0].length);

  const id = str(front['id']);
  const title = str(front['title']);
  const axis = str(front['axis']);
  if (!id) throw new BadRequest(`${path}: front-matter needs an id`);
  if (!title) throw new BadRequest(`${path}: front-matter needs a title`);
  if (!['capability', 'platform', 'function', 'project', 'segment'].includes(axis ?? '')) {
    throw new BadRequest(`${path}: axis must be capability, platform, function, project or segment`);
  }
  const sections = splitSections(body);

  return {
    id,
    title,
    axis: axis as Charter['axis'],
    version: Number(front['version'] ?? 1),
    mission: str(front['mission']) ?? firstLine(sections.get('mission and scope') ?? ''),
    holderIds: [],
    tokens: estimateTokens(body),
    scope: bullets(sections.get('mission and scope')),
    owns: [],
    interfaces: {
      publishes: bullets(sections.get('interfaces')).filter(b => /^publishes/i.test(b)),
      consumes: bullets(sections.get('interfaces')).filter(b => /^consumes/i.test(b)),
    },
    rules: bullets(sections.get('rules and traps')),
    definitionOfDone: bullets(sections.get('definition of done')),
    buildTestShip: bullets(sections.get('how to build, test and ship')),
    coordinateWith: bullets(sections.get('coordinate with')),
    needsOwnerApproval: bullets(sections.get('needs owner approval')),
    body,
    path,
  };
}

export function renderCharter(charter: Charter): string {
  const front = toYaml({
    id: charter.id, title: charter.title, axis: charter.axis, version: charter.version, mission: charter.mission,
  }).trimEnd();
  return `---\n${front}\n---\n${charter.body.replace(/^\n+/, '')}`;
}

function splitSections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let current = '';
  for (const line of body.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { current = h[1]!.toLowerCase(); out.set(current, ''); continue; }
    if (current) out.set(current, `${out.get(current)}${line}\n`);
  }
  return out;
}

function bullets(section: string | undefined): string[] {
  if (!section) return [];
  return section.split('\n')
    .map(l => l.trim())
    .filter(l => /^[-*]\s+/.test(l))
    .map(l => l.replace(/^[-*]\s+/, ''));
}

const firstLine = (s: string): string => s.split('\n').map(l => l.trim()).find(Boolean) ?? '';

export const summarise = (c: Charter): CharterSummary => ({
  id: c.id, title: c.title, axis: c.axis, version: c.version, mission: c.mission,
  holderIds: c.holderIds, tokens: c.tokens,
});

/* ---------- normalising ---------- */

function normaliseRole(r: Partial<Role> & { id: string }): Role {
  return {
    id: r.id,
    title: r.title ?? r.id,
    level: (r.level ?? 2) as Level,
    instructions: r.instructions ?? '',
    tools: r.tools ?? {},
    permissionMode: r.permissionMode ?? 'ask',
    model: r.model ?? 'sonnet',
    budgetClass: r.budgetClass ?? 'medium',
  };
}

function normaliseEmployee(e: EmployeeFile, roles: Role[]): Employee {
  const role = roles.find(r => r.id === e.roleId);
  return {
    id: e.id,
    name: e.name ?? e.id,
    roleId: e.roleId,
    level: e.level ?? LEVEL_OF_ROLE_LEVEL(role),
    permanent: e.permanent ?? (e.level ?? LEVEL_OF_ROLE_LEVEL(role)) < 2,
    charterIds: e.charterIds ?? [],
    unitId: e.unitId,
    chapterIds: e.chapterIds ?? [],
    reportsTo: e.reportsTo ?? null,
    workspace: e.workspace,
    budget: e.budget ?? { inrPerDay: 150, concurrentSessions: 1 },
    ...(e.githubApp ? { githubApp: e.githubApp } : {}),
    state: e.state ?? 'idle',
  };
}

function normaliseEntry(m: Partial<MapEntry> & { kind: MapEntry['kind']; key: string; primary: string }): MapEntry {
  return { kind: m.kind, key: m.key, primary: m.primary, contributors: m.contributors ?? [], consulted: m.consulted ?? [] };
}

/* ---------- writing ---------- */

/** Writes org.yaml and map.yaml from the in-memory org (charters are written one at a time). */
export function saveOrgFiles(org: Org): void {
  const employees = org.employees.map(e => {
    const { state: _state, ...rest } = e;
    return rest;
  });
  writeFileSync(join(org.dir, 'org.yaml'), toYaml({ repos: org.repos, units: org.units, employees }), 'utf8');
  writeFileSync(join(org.dir, 'map.yaml'), toYaml({ entries: org.map }), 'utf8');
}

export function writeCharter(org: Org, charter: Charter): void {
  const path = join(org.dir, 'charters', `${charter.id}.md`);
  mkdirSync(join(org.dir, 'charters'), { recursive: true });
  writeFileSync(path, renderCharter(charter), 'utf8');
}

export function employeeFile(org: Org, employeeId: string, name: 'status.md' | 'handoff.md'): string {
  return join(org.dir, 'employees', employeeId, name);
}

export function readEmployeeFile(org: Org, employeeId: string, name: 'status.md' | 'handoff.md'): string {
  return readText(employeeFile(org, employeeId, name)) ?? '';
}

export function writeEmployeeFile(org: Org, employeeId: string, name: 'status.md' | 'handoff.md', body: string): void {
  const path = employeeFile(org, employeeId, name);
  mkdirSync(join(org.dir, 'employees', employeeId), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

/* ---------- seeding and history ---------- */

/** Copies the seed into an empty directory and makes the first commit. */
export function ensureWorkplace(dir: string, seedDir: string): { seeded: boolean } {
  const empty = !existsSync(join(dir, 'org.yaml'));
  if (empty) {
    mkdirSync(dir, { recursive: true });
    cpSync(seedDir, dir, { recursive: true });
  }
  ensureGit(dir);
  if (empty) commitOrg(dir, 'Seed the first organisation');
  return { seeded: empty };
}

export function ensureGit(dir: string): void {
  if (existsSync(join(dir, '.git'))) return;
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'workplace@iris.local']);
  git(dir, ['config', 'user.name', 'Iris Workplace']);
  writeFileSync(join(dir, '.gitignore'), 'workplace.db\nworkplace.db-*\n', 'utf8');
}

/** One commit per approved change, so `git log` answers "why is it shaped like this". */
export function commitOrg(dir: string, message: string): string | null {
  git(dir, ['add', '-A']);
  try {
    git(dir, ['commit', '-q', '-m', message]);
  } catch {
    return null;   // nothing to commit
  }
  return git(dir, ['rev-parse', '--short', 'HEAD']).trim();
}

export function orgHistory(dir: string, limit = 50): OrgHistoryEntry[] {
  try {
    const out = git(dir, ['log', `-n${limit}`, '--format=%h%x1f%cI%x1f%s']);
    return out.split('\n').filter(Boolean).map(line => {
      const [commit = '', at = '', message = ''] = line.split('\x1f');
      return { commit, at, message };
    });
  } catch {
    return [];
  }
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/* ---------- tiny helpers ---------- */

function readYaml<T>(path: string): T | null {
  const text = readText(path);
  if (text === null) return null;
  try {
    return (parseYaml(text) ?? {}) as T;
  } catch (err) {
    throw new BadRequest(`${path}: ${err instanceof Error ? err.message : 'not valid YAML'}`);
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export type { OwnedThing };
