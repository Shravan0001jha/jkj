import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import type { Coverage, CoverageCounts, MapEntry, Requirement, RequirementStatus } from '@jkj/shared';
import { CHECKLIST, type ChecklistItem } from '../seed-data/checklist.js';
import { resolve } from './ownership.js';

/**
 * Requirements: every line of the product definition, with a stable id, its
 * status with evidence, and the charter that owns it (HLD D6).
 *
 * Two sources: the 110-feature checklist (data) and the non-checklist
 * candidates parsed from the product-definition extract (§F), so the numbers
 * the owner sees are the numbers the definition has, not a summary of them.
 */

const STATUS_RANK: Record<RequirementStatus, number> = { missing: 0, partial: 1, built: 2, verified: 3, released: 4 };

/** Group names for the extract's §F headings, and the section each comes from. */
const EXTRACT_GROUPS: { match: RegExp; group: string; section: string }[] = [
  { match: /^principles/i, group: 'Theme', section: '§1 Theme' },
  { match: /^platforms/i, group: 'Platforms', section: '§2 Where she lives' },
  { match: /^segments/i, group: 'Segments', section: '§4–5 Segments' },
  { match: /^pricing/i, group: 'Pricing', section: '§6 Pricing and cost' },
  { match: /^architecture/i, group: 'Architecture', section: 'Gaps and Road: foundations' },
  { match: /^legal/i, group: 'Legal', section: 'Legal, privacy and safety' },
  { match: /^observability/i, group: 'Observability', section: 'Watching Iris in Beta' },
];

export interface ImportedRequirement {
  group: string;
  section: string;
  title: string;
  note?: string;
  segments: string[];
  status: RequirementStatus;
  evidence: string[];
}

export function fromChecklist(items: ChecklistItem[] = CHECKLIST): ImportedRequirement[] {
  return items.map(item => ({
    group: item.group,
    section: '§3 Features',
    title: item.title,
    ...(item.note ? { note: item.note } : {}),
    segments: item.segments ?? [],
    status: item.status,
    evidence: item.status === 'verified'
      ? ['Iris Against Its Definition, 27 Sep: tried on the Mac']
      : item.status === 'missing' ? [] : ['Iris Against Its Definition, 27 Sep: checked against feat/iris-character'],
  }));
}

/**
 * Parse §F of the extract: numbered lines "N. Title — Source — statement"
 * under "### <heading>" sub-sections.
 */
export function fromExtract(markdown: string): ImportedRequirement[] {
  const start = markdown.indexOf('## F.');
  if (start < 0) return [];
  const lines = markdown.slice(start).split('\n');
  const out: ImportedRequirement[] = [];
  let current: { group: string; section: string } | null = null;

  for (const raw of lines) {
    const heading = /^###\s+(.+)$/.exec(raw);
    if (heading) {
      const found = EXTRACT_GROUPS.find(g => g.match.test(heading[1]!.trim()));
      current = found ? { group: found.group, section: found.section } : null;
      continue;
    }
    if (/^## /.test(raw) && !raw.startsWith('## F.')) break;
    const item = /^\d+\.\s+(.+?)\s+—\s+(.+?)\s+—\s+(.+)$/.exec(raw.trim());
    if (!item || !current) continue;
    out.push({
      group: current.group,
      section: `${current.section} (${item[2]!.trim()})`,
      title: item[1]!.trim(),
      note: item[3]!.trim(),
      segments: [],
      // Non-code requirements start as "missing" until a document or decision exists.
      status: 'missing',
      evidence: [],
    });
  }
  return out;
}

/** Stable id: group slug + a number by first appearance within the group. */
export function assignIds(items: ImportedRequirement[], existing: Requirement[] = []): Requirement[] {
  const byKey = new Map(existing.map(r => [`${r.group}\u0000${r.title}`, r]));
  const counters = new Map<string, number>();
  for (const r of existing) {
    const n = Number(r.id.split('-').pop());
    const slug = groupSlug(r.group);
    if (Number.isFinite(n)) counters.set(slug, Math.max(counters.get(slug) ?? 0, n));
  }

  return items.map(item => {
    const key = `${item.group}\u0000${item.title}`;
    const prev = byKey.get(key);
    if (prev) {
      // Status only ever rises on import; a lowered status is a human decision.
      const status = STATUS_RANK[item.status] > STATUS_RANK[prev.status] ? item.status : prev.status;
      return { ...prev, note: item.note ?? prev.note, segments: item.segments.length ? item.segments : prev.segments, status,
        evidence: [...new Set([...prev.evidence, ...item.evidence])] };
    }
    const slug = groupSlug(item.group);
    const n = (counters.get(slug) ?? 0) + 1;
    counters.set(slug, n);
    return {
      id: `REQ-${slug}-${String(n).padStart(2, '0')}`,
      group: item.group,
      section: item.section,
      title: item.title,
      ...(item.note ? { note: item.note } : {}),
      segments: item.segments,
      status: item.status,
      evidence: item.evidence,
      charterId: null,
      featureIds: [],
    };
  });
}

export const groupSlug = (group: string): string =>
  group.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 12);

/** Owners come from the map at read time, so a reorg re-owns every requirement with no edit here. */
export function withOwners(requirements: Requirement[], map: MapEntry[]): Requirement[] {
  return requirements.map(r => ({
    ...r,
    charterId: resolve(map, { kind: 'requirement', key: r.id }, requirements)?.primary ?? null,
  }));
}

export function coverage(requirements: Requirement[]): Coverage {
  const count = (list: Requirement[]): CoverageCounts => ({
    total: list.length,
    owned: list.filter(r => r.charterId).length,
    planned: list.filter(r => r.featureIds.length > 0).length,
    built: list.filter(r => STATUS_RANK[r.status] >= STATUS_RANK.built).length,
    verified: list.filter(r => STATUS_RANK[r.status] >= STATUS_RANK.verified).length,
    released: list.filter(r => r.status === 'released').length,
  });
  const groups = [...new Set(requirements.map(r => r.group))];
  const charters = [...new Set(requirements.map(r => r.charterId).filter((c): c is string => !!c))];
  return {
    ...count(requirements),
    byGroup: Object.fromEntries(groups.map(g => [g, count(requirements.filter(r => r.group === g))])),
    byCharter: Object.fromEntries(charters.map(c => [c, count(requirements.filter(r => r.charterId === c))])),
  };
}

/* ---------- file ---------- */

export function readRequirements(dir: string): Requirement[] {
  try {
    const parsed = parseYaml(readFileSync(join(dir, 'requirements.yaml'), 'utf8')) as { requirements?: Requirement[] };
    return (parsed?.requirements ?? []).map(r => ({ ...r, segments: r.segments ?? [], evidence: r.evidence ?? [], featureIds: r.featureIds ?? [], charterId: r.charterId ?? null }));
  } catch {
    return [];
  }
}

export function writeRequirements(dir: string, requirements: Requirement[]): void {
  const stored = requirements.map(({ charterId: _c, ...rest }) => rest);   // owner is derived, not stored
  writeFileSync(join(dir, 'requirements.yaml'), toYaml({ requirements: stored }), 'utf8');
}

/** Import (or re-import) both sources into the workplace directory. */
export function importRequirements(dir: string, extractMarkdown: string): Requirement[] {
  const existing = readRequirements(dir);
  const next = assignIds([...fromChecklist(), ...fromExtract(extractMarkdown)], existing);
  writeRequirements(dir, next);
  return next;
}

export function updateRequirement(dir: string, id: string, patch: Partial<Pick<Requirement, 'status' | 'evidence' | 'featureIds'>>): Requirement {
  const all = readRequirements(dir);
  const i = all.findIndex(r => r.id === id);
  if (i < 0) throw new Error(`No requirement ${id}`);
  const updated = { ...all[i]!, ...patch };
  all[i] = updated;
  writeRequirements(dir, all);
  return updated;
}
