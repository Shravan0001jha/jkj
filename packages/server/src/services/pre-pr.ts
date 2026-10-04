import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The pre-PR gate (owner, 4 Oct; docs/HLD-github-flow.md D9). The author runs `scripts/pre-pr.sh`
 * (Iris repo) in their worktree on their latest commit; it writes
 * `<worktree>/.workplace/pre-pr/<full head sha>.json`. A submit (report_done, request_review) in
 * shadow/on needs a passing result for the branch head, and `workplace/tests` reports it. The
 * server no longer runs the suites itself; it still runs the security guards on every push.
 */

export const PRE_PR_REFUSAL = 'Run scripts/pre-pr.sh on your latest commit first (results belong to a commit).';

/** passed/failed are null for a check without counts (a syntax check, the iOS build). */
export interface PrePrCheck { name: string; cmd?: string; ok: boolean; passed?: number | null; failed?: number | null; skipped?: number | null; durationSec?: number; exitCode?: number; timedOut?: boolean; tail?: string }
export interface PrePrResult {
  schema?: number; sha: string; base?: string; at?: string; by?: string; ok: boolean;
  /** Only a full run counts: `fast`, or a run limited to some areas (`only`), never passes the gate. */
  mode?: 'full' | 'fast'; only?: string[] | null; changedFiles?: string[];
  areas: { area: string; checks: PrePrCheck[]; notes?: string[] }[];
}

export const resultPath = (worktree: string, sha: string): string => join(worktree, '.workplace', 'pre-pr', `${sha}.json`);

/** The results for `sha` in `worktree`, or null when there are none (or they are unreadable). */
export function read(worktree: string, sha: string): PrePrResult | null {
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  const file = resultPath(worktree, sha);
  if (!existsSync(file)) return null;
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as PrePrResult;
    if (typeof r !== 'object' || !r || typeof r.ok !== 'boolean') return null;
    return { ...r, areas: Array.isArray(r.areas) ? r.areas.filter(a => a && Array.isArray(a.checks)) : [] };
  } catch { return null; }
}

/** A pass: ok, a full run over every area (`only` null), for exactly `sha`. */
export function passes(r: PrePrResult | null, sha: string): boolean {
  return !!r && r.ok === true && r.mode === 'full' && (r.only === null || r.only === undefined) && r.sha === sha;
}

/** Null when `r` is a passing result for exactly `sha`; else the one refusal sentence. */
export function refusal(r: PrePrResult | null, sha: string): string | null {
  return passes(r, sha) ? null : PRE_PR_REFUSAL;
}

/** The workplace/tests description: "mobile-android unit 16 passed · iris-api unit 379 passed — run by tara on bbd2d88". */
export function describe(r: PrePrResult): string {
  const parts: string[] = [];
  for (const a of r.areas) {
    for (const c of a.checks) {
      const label = c.name && c.name !== a.area ? `${a.area} ${c.name}` : a.area;
      const counted = typeof c.passed === 'number' || typeof c.failed === 'number';
      const counts = !counted ? (c.ok ? 'ok' : c.timedOut ? 'timed out' : 'failed')
        : [`${c.passed ?? 0} passed`, ...(c.failed ? [`${c.failed} failed`] : []), ...(!c.ok && !c.failed ? ['failed'] : [])].join(', ');
      parts.push(`${label} ${counts}`);
    }
  }
  const scope = r.mode !== 'full' || (r.only !== null && r.only !== undefined) ? ` (${r.mode === 'fast' ? 'fast' : 'partial'} run: not counted)` : '';
  const who = `${scope} — run by ${r.by || 'the author'} on ${r.sha.slice(0, 7)}`;
  let body = parts.join(' · ') || 'no checks (no code changed)';
  const max = 140 - who.length;
  if (body.length > max) body = `${body.slice(0, max - 1)}…`;
  return body + who;
}

/** The failing checks' output tails, for the item comment. */
export function failureDetails(r: PrePrResult): string {
  return r.areas.flatMap(a => a.checks.filter(c => !c.ok).map(c => `${a.area} ${c.name}: ${c.timedOut ? 'timed out' : `${c.failed ?? '?'} failed`} (exit ${c.exitCode ?? '?'})\n${(c.tail ?? '').slice(-1500)}`)).join('\n\n');
}
