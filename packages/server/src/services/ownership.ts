import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LintFinding, MapEntry, OwnedThing, Requirement, RouteHit, RouteResult } from '@jkj/shared';
import type { Org } from './org.js';

/**
 * The ownership map: things → charters (docs/HLD-workplace.md D5).
 *
 * Work is routed by looking things up here, never by a hard-coded "which
 * device is this". Paths match by longest prefix, requirements by id then
 * group, keywords by whole-word presence in the text, everything else
 * exactly. Lint keeps the map honest as the organisation grows.
 */

export interface Owner {
  primary: string;
  contributors: string[];
  consulted: string[];
}

/** Path keys are "<repoId>:<relative path>"; trailing slashes never matter. */
export function normalisePath(key: string): string {
  return key.replace(/\/+$/, '');
}

export function resolve(
  map: MapEntry[],
  thing: OwnedThing,
  requirements: Requirement[] = [],
): Owner | null {
  if (thing.kind === 'path') {
    const path = normalisePath(thing.key);
    let best: MapEntry | null = null;
    for (const entry of map) {
      if (entry.kind !== 'path') continue;
      const key = normalisePath(entry.key);
      // "<repo>:" alone is the repo root and covers everything in it.
      const root = key.endsWith(':');
      if (path === key || path.startsWith(root ? key : `${key}/`)) {
        if (!best || key.length > normalisePath(best.key).length) best = entry;
      }
    }
    return best ? owner(best) : null;
  }

  if (thing.kind === 'requirement') {
    const direct = map.find(e => e.kind === 'requirement' && e.key === thing.key);
    if (direct) return owner(direct);
    const req = requirements.find(r => r.id === thing.key);
    if (!req) return null;
    const group = map.find(e => e.kind === 'requirement-group' && e.key === req.group);
    return group ? owner(group) : null;
  }

  const exact = map.find(e => e.kind === thing.kind && e.key === thing.key);
  return exact ? owner(exact) : null;
}

const owner = (e: MapEntry): Owner => ({ primary: e.primary, contributors: e.contributors, consulted: e.consulted });

export interface RouteInput {
  title?: string;
  body?: string;
  things?: OwnedThing[];
}

/**
 * Decompose a piece of work into the charters it touches. Every explicit
 * thing is resolved; keywords are found in the text. The result is one hit
 * per distinct primary, carrying the things that put it there, so the owner
 * can see why a charter was chosen.
 */
export function route(map: MapEntry[], input: RouteInput, requirements: Requirement[] = []): RouteResult {
  const hits = new Map<string, OwnedThing[]>();
  const consulted = new Set<string>();
  const unresolved: OwnedThing[] = [];

  const add = (o: Owner, thing: OwnedThing): void => {
    hits.set(o.primary, [...(hits.get(o.primary) ?? []), thing]);
    for (const c of o.consulted) consulted.add(c);
    for (const c of o.contributors) consulted.add(c);
  };

  for (const thing of input.things ?? []) {
    const o = resolve(map, thing, requirements);
    if (o) add(o, thing);
    else unresolved.push(thing);
  }

  const text = `${input.title ?? ''}\n${input.body ?? ''}`.toLowerCase();
  if (text.trim()) {
    for (const entry of map) {
      if (entry.kind !== 'keyword') continue;
      if (wholeWord(text, entry.key.toLowerCase())) add(owner(entry), { kind: 'keyword', key: entry.key });
    }
  }

  const primaries: RouteHit[] = [...hits.entries()]
    .map(([charterId, because]) => ({ charterId, because }))
    .sort((a, b) => b.because.length - a.because.length || a.charterId.localeCompare(b.charterId));

  for (const hit of primaries) consulted.delete(hit.charterId);

  return { primaries, consulted: [...consulted].sort(), unresolved };
}

function wholeWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(text);
}

/* ---------- lint ---------- */

export interface LintFs {
  exists(path: string): boolean;
  topLevelDirs(root: string): string[];
}

export const realFs: LintFs = {
  exists: p => existsSync(p),
  topLevelDirs: root => {
    try {
      return readdirSync(root).filter(n => !n.startsWith('.') && n !== 'node_modules' && statSync(join(root, n)).isDirectory());
    } catch {
      return [];
    }
  },
};

/** Directories at a repo root that are build products or tooling, not ownable things. */
const IGNORED_TOP_LEVEL = new Set([
  'node_modules', 'dist', 'build', 'logs', 'data', 'chroma_db', '__pycache__', 'eval-travsr', 'harness',
]);

export function lint(org: Org, requirements: Requirement[], fs: LintFs = realFs): LintFinding[] {
  const findings: LintFinding[] = [];
  const charterIds = new Set(org.charters.keys());

  // unknown-ref: an entry that names a charter that does not exist.
  for (const e of org.map) {
    for (const ref of [e.primary, ...e.contributors, ...e.consulted]) {
      if (!charterIds.has(ref)) {
        findings.push({ code: 'unknown-ref', severity: 'error', subject: `${e.kind}:${e.key}`,
          message: `names charter "${ref}", which does not exist` });
      }
    }
  }

  // overlap: two primaries for one thing.
  const seen = new Map<string, string>();
  for (const e of org.map) {
    const k = `${e.kind}:${e.kind === 'path' ? normalisePath(e.key) : e.key}`;
    const prev = seen.get(k);
    if (prev && prev !== e.primary) {
      findings.push({ code: 'overlap', severity: 'error', subject: k, message: `owned by both ${prev} and ${e.primary}` });
    }
    seen.set(k, e.primary);
  }

  // dead: a path that no longer exists.
  for (const e of org.map) {
    if (e.kind !== 'path') continue;
    const abs = absolutePath(org, e.key);
    if (abs === null) {
      findings.push({ code: 'dead', severity: 'warn', subject: e.key, message: 'names a repo the org does not list' });
    } else if (!fs.exists(abs)) {
      findings.push({ code: 'dead', severity: 'warn', subject: e.key, message: `${abs} does not exist` });
    }
  }

  // orphan: a top-level directory in a repo nobody owns.
  for (const repo of org.repos) {
    for (const name of fs.topLevelDirs(repo.root)) {
      if (IGNORED_TOP_LEVEL.has(name)) continue;
      const key = `${repo.id}:${name}`;
      if (!resolve(org.map, { kind: 'path', key })) {
        findings.push({ code: 'orphan', severity: 'warn', subject: key, message: 'no charter owns this directory' });
      }
    }
  }

  // unowned-requirement: the definition has a line nobody owns.
  for (const r of requirements) {
    if (!resolve(org.map, { kind: 'requirement', key: r.id }, requirements)) {
      findings.push({ code: 'unowned-requirement', severity: 'error', subject: r.id, message: `"${r.title}" (${r.group}) has no owning charter` });
    }
  }

  // unheld-charter: a charter no employee holds.
  for (const c of org.charters.values()) {
    if (c.holderIds.length === 0) {
      findings.push({ code: 'unheld-charter', severity: 'warn', subject: c.id, message: 'no employee holds this charter' });
    }
  }

  return findings;
}

/** "<repoId>:<rel>" → absolute path, or null when the repo is unknown. */
export function absolutePath(org: Org, key: string): string | null {
  const i = key.indexOf(':');
  if (i < 0) return null;
  const repo = org.repos.find(r => r.id === key.slice(0, i));
  return repo ? join(repo.root, normalisePath(key.slice(i + 1))) : null;
}
