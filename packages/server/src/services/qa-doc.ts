import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Workplace } from './workplace.js';
import { BadRequest } from '../util/errors.js';

/**
 * The QA doc that goes with QA's approval (owner's review flow, 6 Oct, step 2): QA first lists
 * every edge case where the change might break, checks the code against each one, and writes a
 * report. Approval 2 of 2 is refused without it, so "QA approved" always means "these cases were
 * thought through and checked", never a bare evidence run. The doc travels with the approval
 * (not as a commit on the author's branch, where any new commit would reset both approvals) and
 * is filed under <workplaceDir>/qa/, where the staging test cycle (step 4) collects it.
 *
 * Shape:
 *   ## Edge cases
 *   - PASS: <case> — <how it was checked> evidence: <screenshot/log path or URL>
 *   - N/A: <case> — <why it does not apply>
 *   ## Report
 *   <what was checked, what was not, residual risk>
 *   Evidence: n/a — <why no robot evidence>     (optional; only with the next line)
 *   Tests: <command> <counts>
 *
 * QA proof (owner, 10 Oct): every PASS or FAIL case cites its proof, a file that exists (absolute, or
 * relative to the evidence folder or the author's worktree) or an http(s) URL. "Checked by hand" with
 * nothing to look at is not a check.
 */

export const MIN_CASES = 3;
const MIN_PASS = 2;
const MIN_REPORT = 40;
const CASE = /^\s*[-*]\s*(PASS|FAIL|N\/A)\s*:\s*(.+)$/i;

export interface QaCase { verdict: 'PASS' | 'FAIL' | 'N/A'; text: string }
export interface QaDoc { cases: QaCase[]; report: string }

export const QA_DOC_FORMAT = '"## Edge cases" with one line per case ("- PASS: <case> — <how checked> evidence: <screenshot/log path or URL>", "- N/A: <case> — <why>"), then "## Report" (what was checked, what was not, residual risk; "Evidence: n/a — <why>" only together with "Tests: <command> <counts>")';

export const PROOF_NEEDED = 'Each case needs proof: add "evidence: <screenshot/log path or URL>"';
const PROOF = /\bevidence:\s*(\S+)/i;
const URL_PROOF = /^https?:\/\/[^\s/]+\S*$/i;
/** "Evidence: n/a — <why>" on its own line: the change has no robot-suite evidence, on purpose. */
export const EVIDENCE_NA = /^\s*Evidence:\s*n\/a\b\s*[—–:-]*\s*(\S.*)?$/im;
/** "Tests: <command> <counts>": the suite that stands in for the evidence. */
const TESTS_LINE = /^\s*Tests:\s*\S.*\d/im;

/** True when the doc says the story has no robot-suite evidence on purpose (and names the tests instead). */
export const evidenceNa = (text: string | undefined): boolean => !!text && EVIDENCE_NA.test(text) && TESTS_LINE.test(text);

/** The proof a case line cites, or null when it cites none that exists. `roots` are where relative paths may live. */
export function proofOf(line: string, roots: string[]): string | null {
  const m = PROOF.exec(line);
  if (!m) return null;
  const ref = m[1]!.replace(/[)\].,;:'"`]+$/, '').replace(/^[(<'"`]+/, '');
  if (!ref) return null;
  if (URL_PROOF.test(ref)) return ref;
  if (/^[a-z]+:\/\//i.test(ref)) return null;
  if (isAbsolute(ref)) return existsSync(ref) ? ref : null;
  for (const root of roots) { const p = join(root, ref); if (existsSync(p)) return p; }
  return null;
}

/** Why the doc's proof is not enough (each PASS/FAIL case, the n/a line), or none. */
export function proofProblems(text: string, cases: QaCase[], roots: string[]): string[] {
  const problems: string[] = [];
  const missing = cases.filter(c => c.verdict !== 'N/A' && !proofOf(c.text, roots));
  if (missing.length) problems.push(`${PROOF_NEEDED} (${missing.length} case${missing.length === 1 ? '' : 's'} without one that exists: ${missing.map(c => `"${c.text.slice(0, 60)}"`).join('; ')})`);
  if (EVIDENCE_NA.test(text) && !TESTS_LINE.test(text)) problems.push('"Evidence: n/a" needs the tests that stand in for it on its own line: "Tests: <command> <counts>"');
  if (EVIDENCE_NA.test(text) && !EVIDENCE_NA.exec(text)?.[1]?.trim()) problems.push('"Evidence: n/a" needs its reason: "Evidence: n/a — <why>"');
  return problems;
}

/** The sections of a QA doc, or the reasons it is not one. */
export function parse(text: string): QaDoc | { errors: string[] } {
  const section = (name: string): string | undefined => {
    const m = new RegExp(`^##\\s*${name}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'im').exec(text);
    return m ? m[1]!.trim() : undefined;
  };
  const errors: string[] = [];
  const casesText = section('Edge cases');
  const report = section('Report');
  if (casesText === undefined) errors.push('no "## Edge cases" section');
  if (report === undefined) errors.push('no "## Report" section');
  const cases: QaCase[] = [];
  for (const line of (casesText ?? '').split('\n')) {
    const m = CASE.exec(line);
    if (m) cases.push({ verdict: m[1]!.toUpperCase() as QaCase['verdict'], text: m[2]!.trim() });
  }
  if (casesText !== undefined && cases.length < MIN_CASES) errors.push(`${cases.length} edge case(s) listed; at least ${MIN_CASES} are needed`);
  if (cases.length >= MIN_CASES && !cases.some(c => c.verdict === 'FAIL') && cases.filter(c => c.verdict === 'PASS').length < MIN_PASS) errors.push(`at least ${MIN_PASS} cases must be checked and PASS (N/A does not count)`);
  if (report !== undefined && report.length < MIN_REPORT) errors.push('the report is too short to say what was checked and what was not');
  return errors.length ? { errors } : { cases, report: report! };
}

/**
 * Throws unless `text` is a QA doc that allows approval; a FAIL means send it back instead. `roots`: the
 * folders a relative evidence path may be in (the evidence folder, the author's worktree).
 */
export function require$(text: string | undefined, roots: string[] = []): QaDoc {
  if (!text?.trim()) throw new BadRequest(`QA's approval needs the QA doc (qaDoc): ${QA_DOC_FORMAT}. List every edge case where the change might break and check each one before approving.`);
  const doc = parse(text);
  if ('errors' in doc) throw new BadRequest(`The QA doc is not complete: ${doc.errors.join('; ')}. Expected ${QA_DOC_FORMAT}.`);
  const proof = proofProblems(text, doc.cases, roots);
  if (proof.length) throw new BadRequest(`${proof.join('. ')}.`);
  const failed = doc.cases.filter(c => c.verdict === 'FAIL');
  if (failed.length) throw new BadRequest(`The QA doc has ${failed.length} failing case(s) (${failed.map(c => c.text).join('; ')}), so this is not an approval: call review_send_back with the root cause.`);
  return doc;
}

export function dir(wp: Workplace): string { return join(wp.config.workplaceDir, 'qa'); }

/** Where QA's screenshots and logs live (~/iris-workplace/evidence): a relative evidence path may name a file here. */
export function evidenceDir(wp: Workplace): string { return join(wp.config.workplaceDir, 'evidence'); }

/** The filed QA doc of a story, if any. */
export function filed(wp: Workplace, itemId: string): string | undefined {
  const path = join(dir(wp), `${itemId}.md`);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** File the doc for the staging test cycle; returns its path. */
export function file(wp: Workplace, itemId: string, meta: { title: string; by: string; sha: string; at: string }, text: string): string {
  mkdirSync(dir(wp), { recursive: true });
  const path = join(dir(wp), `${itemId}.md`);
  writeFileSync(path, `# QA: ${meta.title}\n\nStory ${itemId} · QA ${meta.by} · commit ${meta.sha.slice(0, 8)} · ${meta.at}\n\n${text.trim()}\n`);
  return path;
}

/** The filed QA docs approved at or after `since` (ISO), for a staging batch's test document. */
export function since(wp: Workplace, sinceIso: string): { itemId: string; text: string }[] {
  if (!existsSync(dir(wp))) return [];
  return readdirSync(dir(wp)).filter(f => f.endsWith('.md')).map(f => ({ itemId: f.slice(0, -3), text: readFileSync(join(dir(wp), f), 'utf8') }))
    .filter(d => (/ · (\d{4}-\d\d-\d\dT[^\s]+)\n/.exec(d.text)?.[1] ?? '') >= sinceIso);
}
