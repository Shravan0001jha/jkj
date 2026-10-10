import type { Employee, GitHubMode, PrApproval, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';

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

/* ---------- the team (rework W3; private copies of the org-tree helpers, by reportsTo and roleId) ---------- */

const isTeamLead = (e: Employee | undefined): boolean => !!e && (e.roleId === 'lead' || e.roleId === 'qa');

/**
 * The lead of `id`'s team: themselves when their role is lead or qa, else the first manager up the
 * chain whose role is. Undefined for people above the teams (the CoS, the CTO, the COO) and strangers.
 */
export function teamOf(employees: Employee[], id: string | undefined): string | undefined {
  const byId = (x: string | undefined) => (x ? employees.find(e => e.id === x) : undefined);
  let cur = byId(id);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    if (isTeamLead(cur)) return cur.id;
    seen.add(cur.id);
    cur = byId(cur.reportsTo ?? undefined);
  }
  return undefined;
}

/** A team: its lead and the lead's direct reports (virtual employees never review). */
export function teamMembers(employees: Employee[], leadId: string | undefined): string[] {
  if (!leadId) return [];
  return employees.filter(e => !e.virtual && (e.id === leadId || e.reportsTo === leadId)).map(e => e.id);
}

/** The lead answering for a charter: a holder whose role is lead or qa, else the team lead of its first holder. */
export function leadOfCharter(employees: Employee[], charterId: string): string | undefined {
  const holders = employees.filter(e => !e.virtual && e.charterIds.includes(charterId));
  const lead = holders.find(isTeamLead);
  return lead ? lead.id : holders.length ? teamOf(employees, holders[0]!.id) : undefined;
}

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
  const team = teamOf(employees, authorId);
  return !!team && teamMembers(employees, team).includes(actorId);
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
export function doneProblem(wp: Workplace, w: WorkItem, by: string): string | null {
  if (by === 'owner' || !w.pr || w.pr.merged || githubMode(wp) !== 'on') return null;
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
