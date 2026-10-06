import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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
 *   - PASS: <case> — <how it was checked>
 *   - N/A: <case> — <why it does not apply>
 *   ## Report
 *   <what was checked, what was not, residual risk>
 */

export const MIN_CASES = 3;
const MIN_PASS = 2;
const MIN_REPORT = 40;
const CASE = /^\s*[-*]\s*(PASS|FAIL|N\/A)\s*:\s*(.+)$/i;

export interface QaCase { verdict: 'PASS' | 'FAIL' | 'N/A'; text: string }
export interface QaDoc { cases: QaCase[]; report: string }

export const QA_DOC_FORMAT = '"## Edge cases" with one line per case ("- PASS: <case> — <how checked>", "- N/A: <case> — <why>"), then "## Report" (what was checked, what was not, residual risk)';

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

/** Throws unless `text` is a QA doc that allows approval; a FAIL means send it back instead. */
export function require$(text: string | undefined): QaDoc {
  if (!text?.trim()) throw new BadRequest(`QA's approval needs the QA doc (qaDoc): ${QA_DOC_FORMAT}. List every edge case where the change might break and check each one before approving.`);
  const doc = parse(text);
  if ('errors' in doc) throw new BadRequest(`The QA doc is not complete: ${doc.errors.join('; ')}. Expected ${QA_DOC_FORMAT}.`);
  const failed = doc.cases.filter(c => c.verdict === 'FAIL');
  if (failed.length) throw new BadRequest(`The QA doc has ${failed.length} failing case(s) (${failed.map(c => c.text).join('; ')}), so this is not an approval: call review_send_back with the root cause.`);
  return doc;
}

export function dir(wp: Workplace): string { return join(wp.config.workplaceDir, 'qa'); }

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
