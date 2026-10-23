import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceDeferred } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import { BadRequest } from '../util/errors.js';
import { now } from './store.js';
import { rawGet } from './v2-map.js';
import { trueStatus } from './lifecycle.js';

/**
 * Known infra gaps (23 Oct, as_mviqeldd3fnpd). A case the CI image can never exercise (the GitHub
 * emulator cannot receive real FCM) is BLOCKED on every run. When it is listed with the story that
 * will verify it for real, the run counts it as DEFERRED: the verdict can be PASS, and the report,
 * the summary, the item comment and the PR comment all name the case and the story. Two sources:
 * the Iris repo's e2e/DEFERRED.md at the story's commit (like plan.mjs), and a Workplace allowlist
 * the COO sets while the file does not exist yet. Only BLOCKED is deferrable; a FAIL always fails.
 */

export const DEFERRED_PATH = 'e2e/DEFERRED.md';
const KEY = 'evidence.deferred';

export interface DeferredEntry { case: string; platform?: string; storyId: string; reason?: string; by?: string; at?: string; source?: 'file' | 'allowlist' }

/** The table rows of DEFERRED.md: | android / `case` | as_story | why |. Rows without a story id (headers, rules) are skipped. */
export function parseDeferredFile(src: string): DeferredEntry[] {
  const out: DeferredEntry[] = [];
  for (const line of src.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const story = /\bas_[a-z0-9]+\b/.exec(cells[1] ?? '')?.[0];
    const raw = (cells[0] ?? '').replace(/`/g, '').trim();
    const split = /^(android|ios|desktop|windows)\s*[/ ]\s*(.+)$/.exec(raw);
    const name = split ? split[2]!.trim() : raw;
    if (!story || !name) continue;
    out.push({ case: name, ...(split ? { platform: split[1]! } : {}), storyId: story, ...(cells[2] ? { reason: cells[2] } : {}), source: 'file' });
  }
  return out;
}

/** Does this entry name that test? The id must equal the case (and the platform, when the entry names one). */
export function matches(entry: DeferredEntry, platform: string, id: string): boolean {
  const c = entry.case.trim();
  return (c === id || c === `${platform}.${id}` || c === `${platform} / ${id}`) && (!entry.platform || entry.platform === platform);
}

type Rows = Record<string, { status?: string; note?: string; deferredTo?: string }>;
interface ResultsJson { verdict?: string; counts?: Record<string, number>; platforms?: Record<string, { tests?: Rows }>; deferred?: EvidenceDeferred[] }

/**
 * Rewrites a run's results.json and summary.txt: each BLOCKED test that is listed (and whose story is
 * usable) becomes DEFERRED; the verdict turns PASS only when nothing else failed or is blocked and
 * something passed. Returns what it deferred (empty: nothing was touched).
 */
export function scoreRun(runDir: string, entries: DeferredEntry[], usable: (storyId: string) => boolean): EvidenceDeferred[] {
  const file = join(runDir, 'results.json');
  if (!entries.length || !existsSync(file)) return [];
  let res: ResultsJson;
  try { res = JSON.parse(readFileSync(file, 'utf8')) as ResultsJson; } catch { return []; }
  const applied: EvidenceDeferred[] = [];
  for (const [platform, v] of Object.entries(res.platforms ?? {})) {
    for (const [id, t] of Object.entries(v.tests ?? {})) {
      if (t.status !== 'BLOCKED') continue;
      const e = entries.find(x => matches(x, platform, id) && usable(x.storyId));
      if (!e) continue;
      t.status = 'DEFERRED'; t.deferredTo = e.storyId;
      applied.push({ case: id, platform, storyId: e.storyId, ...(e.reason ? { reason: e.reason } : {}), source: e.source ?? 'file', ...(e.by ? { by: e.by } : {}) });
    }
  }
  if (!applied.length) return [];
  const counts = res.counts ?? {};
  counts['BLOCKED'] = Math.max(0, (counts['BLOCKED'] ?? 0) - applied.length);
  counts['DEFERRED'] = (counts['DEFERRED'] ?? 0) + applied.length;
  for (const k of ['BLOCKED', 'DEFERRED']) if (!counts[k]) delete counts[k];
  res.counts = counts;
  const green = (counts['PASS'] ?? 0) + (counts['FLAKY'] ?? 0);
  if (res.verdict !== 'PASS' && !counts['FAIL'] && !counts['BLOCKED'] && green > 0) res.verdict = 'PASS';
  res.deferred = [...(res.deferred ?? []), ...applied];
  writeFileSync(file, JSON.stringify(res, null, 1));
  writeFileSync(join(runDir, 'summary.txt'), summaryOf(res));
  return applied;
}

const label = (d: EvidenceDeferred): string => `${d.case} → ${d.storyId}`;

/** summary.txt after deferral: the verdict line names what was deferred; remaining failures are listed; DEFERRED lists the rest. */
export function summaryOf(res: ResultsJson): string {
  const failures: string[] = [];
  for (const [p, v] of Object.entries(res.platforms ?? {})) {
    for (const [id, t] of Object.entries(v.tests ?? {})) if (t.status === 'FAIL' || t.status === 'BLOCKED') failures.push(`  ${p} ${id} ${t.status}: ${t.note ?? ''}`.trimEnd());
  }
  const def = res.deferred ?? [];
  return [
    `Iris robot suite (GitHub) verdict ${res.verdict ?? '?'}${def.length ? ` — deferred: ${def.map(label).join(', ')}` : ''}`, '',
    failures.length ? `FAILURES (${failures.length})` : 'FAILURES none', ...failures,
    ...(def.length ? ['', `DEFERRED (${def.length}): BLOCKED by a known infra gap, verified later by the named story`, ...def.map(d => `  ${d.platform} ${d.case} → ${d.storyId}${d.reason ? `: ${d.reason}` : ''}`)] : []), '',
  ].join('\n');
}

/** One line for comments and notes, or ''. */
export function deferredLine(def: EvidenceDeferred[] | undefined): string {
  return def?.length ? `Deferred (BLOCKED by a known infra gap, verified later): ${def.map(d => `${label(d)}${d.reason ? ` (${d.reason})` : ''}`).join('; ')}.` : '';
}

/* ---------- the Workplace allowlist ---------- */

export function allowlist(wp: Workplace): DeferredEntry[] {
  const row = wp.db.prepare('select value from settings where key = ?').get(KEY) as { value: string } | undefined;
  if (!row) return [];
  try { return (JSON.parse(row.value) as DeferredEntry[]).map(e => ({ ...e, source: 'allowlist' as const })); } catch { return []; }
}

/** A story can verify a deferred case while it is open (not done) or done on staging awaiting the real-device check. */
export function usable(wp: Workplace, storyId: string): boolean {
  const w = rawGet(wp, storyId);
  if (!w) return false;
  return (w.status ?? 'ready') !== 'done' || trueStatus(wp, w) === 'awaiting-mac';
}

export function allow(wp: Workplace, req: { case: string; storyId: string; reason?: string }, by: string): DeferredEntry {
  const name = (req.case ?? '').trim();
  if (!name) throw new BadRequest('case is required (the test id, e.g. timer.handoff_to_clock)');
  const storyId = (req.storyId ?? '').trim();
  if (!rawGet(wp, storyId)) throw new BadRequest(`no story ${storyId || '(none given)'}: a deferred case needs the story that will verify it`);
  if (!usable(wp, storyId)) throw new BadRequest(`${storyId} is closed: it must be open or awaiting-mac to verify a deferred case`);
  const entry: DeferredEntry = { case: name, storyId, ...(req.reason?.trim() ? { reason: req.reason.trim() } : {}), by, at: now() };
  const rest = allowlist(wp).filter(e => e.case !== name).map(({ source: _s, ...e }) => e);
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(KEY, JSON.stringify([...rest, entry]));
  return { ...entry, source: 'allowlist' };
}
