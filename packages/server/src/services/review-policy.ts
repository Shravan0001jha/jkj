import type { Employee, GitHubMode, PrApproval, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';

/**
 * Who may approve what, and whether an approval still holds (docs/LLD-github-flow.md §3). Pure
 * functions over the org and the item, plus the mode setting, so `items.ts` can ask without pulling
 * in the GitHub flow itself.
 *
 * Two approvals, in order: a developer (a lead who is not the author — for a lead's own story, a
 * peer lead), then QA (role `qa`, or the quality charter's holder). An approval holds only for the
 * commit it was given on and the stay in review it was given in.
 */

export const GITHUB_MODES: readonly GitHubMode[] = ['local', 'shadow', 'on'];
export const QUALITY_CHARTER = 'qa-release';
const MODE_KEY = 'github:mode';

/** The setting; absent (or unreadable) is `local`, which is exactly the Workplace before this flow. */
export function githubMode(wp: Workplace): GitHubMode {
  const row = wp.db.prepare('select value from settings where key = ?').get(MODE_KEY) as { value: string } | undefined;
  return row && (GITHUB_MODES as string[]).includes(row.value) ? row.value as GitHubMode : 'local';
}

export function writeGithubMode(wp: Workplace, mode: GitHubMode): void {
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(MODE_KEY, mode);
}

export const isDeveloper = (e: Employee | undefined): boolean => !!e && e.roleId === 'lead';
export const isQa = (e: Employee | undefined): boolean => !!e && (e.roleId === 'qa' || e.charterIds.includes(QUALITY_CHARTER));

/**
 * The approval is for the PR's current head and its current review episode, and the item is still in
 * that review (or was closed by it). A new commit, a send-back or a new review ends it.
 */
export function holds(a: PrApproval | undefined, w: WorkItem): boolean {
  const pr = w.pr;
  if (!a || !pr || a.sha !== pr.headSha) return false;
  if (w.status === 'in-review') return a.episode === (w.statusSince ?? '');
  if (w.status === 'done') return !!pr.qaApproval && a.episode === pr.qaApproval.episode;
  return false;
}

export function approvalHolds(w: WorkItem, which: 'dev' | 'qa'): boolean {
  const dev = holds(w.pr?.devApproval, w);
  return which === 'dev' ? dev : dev && holds(w.pr?.qaApproval, w);
}

export type Stage = 'dev' | 'qa' | 'approved';

export function stage(w: WorkItem): Stage {
  if (!approvalHolds(w, 'dev')) return 'dev';
  return approvalHolds(w, 'qa') ? 'approved' : 'qa';
}

/**
 * In mode `on`, a story with an open PR is done only once both approvals hold (the owner excepted).
 * Null when the move is fine; local and shadow always return null.
 */
export function doneProblem(wp: Workplace, w: WorkItem, by: string): string | null {
  if (by === 'owner' || !w.pr || w.pr.merged || githubMode(wp) !== 'on') return null;
  const s = stage(w);
  if (s === 'approved') return null;
  return s === 'dev'
    ? 'This story has a pull request: it needs the developer approval, then the QA approval (review_approve), not a status change.'
    : 'This story has a pull request: it has the developer approval and needs the QA approval (review_approve), not a status change.';
}

/** Who takes the QA approval: the item's reviewer if QA, else the `qa` role, else the quality charter; never the excluded. */
export function qaReviewer(employees: Employee[], w: WorkItem, exclude: string[]): string | undefined {
  const ok = (e: Employee | undefined): e is Employee => !!e && isQa(e) && !exclude.includes(e.id) && e.id !== w.employeeId;
  const current = employees.find(e => e.id === w.reviewerId);
  if (ok(current)) return current.id;
  return employees.find(e => ok(e) && e.roleId === 'qa')?.id ?? employees.find(e => ok(e))?.id;
}
