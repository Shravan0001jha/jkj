import type { Employee, GitHubMode, PrApproval, PrExtraReviewer, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import { teamMembers, teamOf } from './org.js';

/**
 * Who may approve what, and whether an approval still holds (docs/LLD-github-flow.md §3). Pure
 * functions over the org and the item, plus the mode setting, so `items.ts` can ask without pulling
 * in the GitHub flow itself.
 *
 * Two approvals, in order: a developer (a member of the author's team who is not the author, or the
 * CTO), then QA (role `qa`, or the quality charter's holder), with any extra reviewer (another team's
 * lead whose charter's code the diff changes) approving before QA. An approval holds only for the
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
export const isCto = (e: Employee | undefined): boolean => !!e && e.roleId === 'cto';
/** A reviewing role (a lead or the CTO): who may look at any story's evidence, whatever the team. */
export const isReviewerRole = (e: Employee | undefined): boolean => isDeveloper(e) || isCto(e);

/* ---------- the team (rework W3, on W1's org-tree helpers in org.ts) ---------- */

/**
 * Who may give the developer approval (1 of 2) on `authorId`'s story (owner, 10 Oct): a member of the
 * author's own team who is not the author, or the CTO. A lead of another team reviews only the files of
 * their charters (an extra reviewer), never the story as a whole.
 */
export function canApproveAsDeveloper(employees: Employee[], actorId: string | undefined, authorId: string | undefined): boolean {
  if (!actorId || actorId === authorId) return false;
  const actor = employees.find(e => e.id === actorId);
  if (!actor || actor.virtual) return false;
  if (isCto(actor)) return true;
  const team = authorId ? teamOf({ employees }, authorId) : undefined;
  return !!team && teamMembers({ employees }, team).includes(actorId);
}
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
/**
 * The PR gate applies: the flow is on, or it is local only because of an automatic fallback from on
 * (case 6, 19 Oct, as_mvdis3x8bn3vj: three GitHub failures switched to local for 53 s, and in that window
 * QA marked a story with an open PR done with no approval 2; it sat Done and unmerged for 9 hours).
 */
export function prGateOn(wp: Workplace): boolean {
  const m = githubMode(wp);
  if (m === 'on') return true;
  if (m !== 'local') return false;
  const row = wp.db.prepare("select value from settings where key = 'github:fallback'").get() as { value: string } | undefined;
  try { return !!row && (JSON.parse(row.value) as { from?: string }).from === 'on'; } catch { return false; }
}

export function doneProblem(wp: Workplace, w: WorkItem, by: string): string | null {
  if (by === 'owner' || !w.pr || w.pr.merged || w.pr.closed || !prGateOn(wp)) return null;
  const s = stage(w);
  if (s === 'approved') return null;
  return s === 'dev'
    ? 'This story has a pull request, so it is done only through review_approve: approval 1 of 2 from the developer approver (a member of the author\'s team who is not the author), then approval 2 of 2 from QA. Ask your team to review first.'
    : 'This story has a pull request, so it is done only through review_approve: it has the developer approval (1 of 2) and needs QA\'s (2 of 2). QA calls review_approve.';
}

export const QA_WAIT = 'Wait: developer approval first. QA reviews after the developer approver (approval 1 of 2), so leave the story in review; you are woken when it is your turn.';

/** True when QA (not a lead) would act on a story whose PR has no developer approval yet. */
export function qaTooEarly(wp: Workplace, w: WorkItem, by: string): boolean {
  if (!w.pr || w.pr.merged || githubMode(wp) === 'local') return false;
  const who = wp.org.employees.find(e => e.id === by);
  return isQa(who) && !canApproveAsDeveloper(wp.org.employees, by, w.employeeId) && !approvalHolds(w, 'dev');
}

/** An In review story with a PR moved back by QA before the developer approval: refused (finding #3). */
export function earlyQaMoveProblem(wp: Workplace, w: WorkItem, by: string, from: string, to: string): string | null {
  return from === 'in-review' && to === 'in-progress' && qaTooEarly(wp, w, by) ? QA_WAIT : null;
}

/** Who takes the QA approval: the item's reviewer if QA, else the `qa` role, else the quality charter; never the excluded. */
export function qaReviewer(employees: Employee[], w: WorkItem, exclude: string[], load: Record<string, number> = {}): string | undefined {
  const ok = (e: Employee | undefined): e is Employee => !!e && isQa(e) && !exclude.includes(e.id) && e.id !== w.employeeId;
  const current = employees.find(e => e.id === w.reviewerId);
  if (ok(current)) return current.id;
  // RCA (7 Oct): this always returned the first `qa`-role employee (Nikhil), so every QA review queued on
  // one person while Zoya sat idle, and a QA the COO had routed elsewhere was overwritten at the developer
  // approval. Pick the QA-capable person with the fewest reviews waiting; ties keep the org order
  // (the `qa` role first), so a quiet floor behaves exactly as before.
  const pool = employees.filter(ok);
  if (!pool.length) return undefined;
  const rank = (e: Employee) => (load[e.id] ?? 0) * 2 + (e.roleId === 'qa' ? 0 : 1);
  return pool.reduce((best, e) => (rank(e) < rank(best) ? e : best)).id;
}

/* ---------- who acts next (board bugs 2 and 3, 19 Oct): one rule for the gate and for the wake ---------- */

/** The extra reviewers whose approval does not hold on this head and stay in review. The QA gate waits for them; review-wake wakes them. */
export function pendingExtra(w: WorkItem): PrExtraReviewer[] {
  const pr = w.pr;
  if (!pr) return [];
  return (pr.extraReviewers ?? []).filter(e => !(e.approvedAt && e.sha === pr.headSha && e.episode === (w.statusSince ?? '')));
}

/** The story's QA: the QA lock (pr.qaReviewer) once named; the board's reviewerId shows the same person in the QA stage. */
export const qaOf = (w: WorkItem): string | undefined => w.pr?.qaReviewer;

/** Whose turn it is on a story In review with an open PR: the developer approver (and any extra reviewer), then the extra reviewers, then QA. */
export type ReviewTurn = 'dev' | 'extra' | 'qa';
export function reviewTurn(w: WorkItem): ReviewTurn {
  if (!approvalHolds(w, 'dev')) return 'dev';
  return pendingExtra(w).length ? 'extra' : 'qa';
}

/**
 * A change of the reviewer on a story whose QA is locked (board bug 2, 19 Oct, as_mv41lj93y5zzd: the board
 * said Zoya, the gate said Nikhil). In the QA stage the reviewer IS the QA, so naming another reviewer
 * moves the lock in the same write, or is refused; the two can never disagree. Who may move it: the owner,
 * the COO, the Chief of Staff, the Workplace, or the current QA handing it on. The new QA is QA-capable and
 * is not the developer approver (who can never give approval 2). Null: nothing to do with the QA.
 */
export function qaHandover(employees: Employee[], w: WorkItem, to: string, by: string, chiefOfStaff: string | undefined): { qa: string } | { refuse: string } | null {
  const pr = w.pr;
  const lock = pr?.qaReviewer;
  if (!pr || pr.merged || pr.closed || !lock || !approvalHolds(w, 'dev')) return null;
  if (to === lock) return null;
  const name = (id: string): string => employees.find(e => e.id === id)?.name ?? id;
  const deciders = new Set(['owner', 'coo', 'workplace', ...(chiefOfStaff ? [chiefOfStaff] : [])]);
  if (!deciders.has(by) && by !== lock) {
    return { refuse: `${name(lock)} is this story's QA, and one QA sees a story through: only ${name(lock)}, the Chief of Staff, the COO or the owner changes it (item_update reviewerId with a reason).` };
  }
  if (!isQa(employees.find(e => e.id === to))) return { refuse: `${name(to)} is not QA: the story has the developer approval, so its reviewer is its QA (${name(lock)}). Name someone in QA.` };
  if (to === pr.devApproval?.by) return { refuse: `${name(to)} gave approval 1 of 2, so approval 2 of 2 must come from another person in QA.` };
  if (to === w.employeeId) return { refuse: 'The author never reviews their own story.' };
  return { qa: to };
}
