import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Employee, LiveCheck, MobileCiRecord, PrExtraReviewer as ExtraReviewer, GitHubMode, PrApproval, PrRecord, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import type { GitHubPort, StatusState } from './github-port.js';
import { RealGitHub } from './github-port.js';
import * as quality from './quality.js';
import * as items from './items.js';
import * as reviewWake from './review-wake.js';
import * as work from './work.js';
import * as trail from './trail.js';
import * as coo from './coo.js';
import * as manager from './manager.js';
import * as lifecycleWatch from './lifecycle-watch.js';
import * as employees from './employees.js';
import * as runs from './runs.js';
import { now, rowsJson } from './store.js';
import { humanDuration, isAgent, levelOf, nameOf, rawGet } from './v2-map.js';
import { AUTOSAVE_SUBJECT, branchFor, worktreePath } from './worktrees.js';
import * as prePr from './pre-pr.js';
import * as spendCaps from './spend-caps.js';
import { dayOf } from './spend.js';
import { GITHUB_MODES, githubMode, holds, canApproveAsDeveloper, isCto, isQa, pendingExtra, qaOf, qaReviewer, writeGithubMode } from './review-policy.js';
import { leadOfCharter, teamMembers, teamOf } from './org.js';
import { resolve as resolveOwner } from './ownership.js';
import { chiefOfStaffId } from './v2-map.js';
import { freshLink } from './evidence-share.js';
import * as qaDoc from './qa-doc.js';
import * as docs from './docs.js';
import { BadRequest, Conflict, NotFound } from '../util/errors.js';
import { log } from '../util/logger.js';

/**
 * The GitHub pull-request flow (docs/HLD-github-flow.md, docs/LLD-github-flow.md §4).
 *
 * `local` (the default) is the Workplace as it was: every entry point returns before doing anything.
 * In `shadow` and `on`, a story moving to review has its branch pushed and a PR opened by the server
 * (employees never push), two approvals in order are recorded against the head commit, the
 * workplace/* statuses are posted, and the quality checks run. In `on`, "done" needs both approvals
 * and the Workplace merges through GitHub itself once tests are green (autoMerge; the COO handles any blocker,
 * and POST /api/coo/merge stays for manual merges). Three GitHub failures in five minutes fall back to `local`.
 */

export { approvalHolds } from './review-policy.js';
import { QA_WAIT } from './review-policy.js';

const FAILURES_KEY = 'github:failures';
const FALLBACK_KEY = 'github:fallback';
const FAILURE_WINDOW_MS = 5 * 60_000;
const FAILURES_TO_FALL_BACK = 3;
const MIN = 60_000;

export const CONTEXTS = { review: 'workplace/review', tests: 'workplace/tests', evidence: 'workplace/evidence' } as const;

/* ---------- the port ---------- */

const ports = new WeakMap<Workplace, GitHubPort>();

/** Tests (and the real-app trial) hand the flow their own GitHub. */
export function useGitHub(wp: Workplace, port: GitHubPort): void { ports.set(wp, port); }

const cappedPorts = new WeakMap<GitHubPort, GitHubPort>();

/** The Workplace's GitHub, with the daily GitHub Actions cap applied (spend-caps.ts, owner 18 Oct). */
export function gitHubPort(wp: Workplace): GitHubPort {
  let port = ports.get(wp);
  if (!port) {
    const g = wp.config.github;
    port = new RealGitHub({ org: g.org, repo: g.repo, tokenScript: g.tokenScript, python: existsSync(g.python) ? g.python : 'python3', pushApp: g.pushApp, reviewApp: g.reviewApp, workflowRepo: g.workflowRepo, workflowRef: g.workflowRef });
    ports.set(wp, port);
  }
  let c = cappedPorts.get(port);
  if (!c) { c = spendCaps.capped(wp, port); cappedPorts.set(port, c); }
  return c;
}

/* ---------- the mode and the fallback ---------- */

export const mode = (wp: Workplace): GitHubMode => githubMode(wp);

export interface Fallback { at: string; from: GitHubMode; reason: string }

const getSetting = (wp: Workplace, key: string): string | undefined =>
  (wp.db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined)?.value;
const putSetting = (wp: Workplace, key: string, value: string): void => void wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(key, value);
const dropSetting = (wp: Workplace, key: string): void => void wp.db.prepare('delete from settings where key = ?').run(key);

export function setMode(wp: Workplace, next: string, by: string): GitHubMode {
  if (!(GITHUB_MODES as string[]).includes(next)) throw new BadRequest(`github mode must be one of ${GITHUB_MODES.join(', ')}`);
  const before = mode(wp);
  writeGithubMode(wp, next as GitHubMode);
  if (next !== 'local') { dropSetting(wp, FAILURES_KEY); dropSetting(wp, FALLBACK_KEY); }
  if (before !== next) {
    trail.record(wp, { itemId: null, by, kind: 'note', text: `GitHub flow: ${before} → ${next}` });
    log.info('github', `mode ${before} → ${next} (by ${by})`);
  }
  return next as GitHubMode;
}

function failures(wp: Workplace): number[] {
  try { return (JSON.parse(getSetting(wp, FAILURES_KEY) ?? '[]') as string[]).map(t => Date.parse(t)).filter(Number.isFinite); } catch { return []; }
}

export function state(wp: Workplace, nowMs = Date.now()): { mode: GitHubMode; fallback?: Fallback; failures: number } {
  let fallback: Fallback | undefined;
  try { const v = getSetting(wp, FALLBACK_KEY); if (v) fallback = JSON.parse(v) as Fallback; } catch { /* unreadable: none */ }
  return { mode: mode(wp), ...(fallback ? { fallback } : {}), failures: failures(wp).filter(t => t >= nowMs - FAILURE_WINDOW_MS).length };
}

/**
 * A GitHub failure (an API error, a push GitHub refused for a network or auth reason). Three within
 * five minutes switch the flow to `local` and alert the COO. A policy refusal is never counted.
 */
export function recordFailure(wp: Workplace, op: string, itemId: string | undefined, nowMs = Date.now(), message = ''): void {
  const recent = [...failures(wp).filter(t => t >= nowMs - FAILURE_WINDOW_MS), nowMs];
  putSetting(wp, FAILURES_KEY, JSON.stringify(recent.map(t => new Date(t).toISOString())));
  log.warn('github', `${op} failed${itemId ? ` for ${itemId}` : ''} (${recent.length} in 5 min)${message ? `: ${message}` : ''}`);
  const from = mode(wp);
  if (recent.length < FAILURES_TO_FALL_BACK || from === 'local') return;
  const reason = `${recent.length} GitHub failures within 5 minutes (last: ${op}${message ? `: ${message}` : ''})`;
  writeGithubMode(wp, 'local');
  putSetting(wp, FALLBACK_KEY, JSON.stringify({ at: new Date(nowMs).toISOString(), from, reason } satisfies Fallback));
  trail.record(wp, { itemId: null, by: 'workplace', kind: 'note', text: `GitHub flow fell back from ${from} to local: ${reason}` });
  coo.notifyStall(wp, {
    itemId: itemId ?? '', by: 'workplace',
    title: 'GitHub flow fell back to local',
    body: `${reason}. The flow is local again: reviews and merges work as before, nothing is pushed. Set it back with POST /api/coo/github {"mode":"${from}"} once GitHub is healthy.`,
  });
  log.warn('github', `fell back from ${from} to local: ${reason}`);
}

/* ---------- the item's branch ---------- */

const STORY_BRANCH = /^emp\/[a-z0-9][a-z0-9-]*\/[A-Za-z0-9_-]+$/;

/** Null when `branch` is the story branch the server expects; else why it is refused. */
export function branchProblem(branch: string, expected: string): string | null {
  if (!STORY_BRANCH.test(branch)) return `${branch} is not a story branch (emp/<name>/<story id>); only those are pushed`;
  if (branch !== expected) return `the branch must be ${expected}, not ${branch}`;
  return null;
}

export const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
export const revParse = (cwd: string, ref: string): string | null => { try { return git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim() || null; } catch { return null; } };

/**
 * The commit of `branch` that goes to GitHub: its tip, less any WIP commits the auto-save before a story
 * switch put on top (18 Oct, Kabir's emp/kabir/as_mvdgmpr4ueeu2: the push of the branch carried a stray
 * "WIP (auto-saved ...)" commit to the remote). Unsaved work is not part of the review.
 */
export function pushableTip(repo: string, branch: string): string | null {
  let tip = revParse(repo, `refs/heads/${branch}`);
  for (let i = 0; tip && i < 50; i++) {
    let subject = '';
    try { subject = git(repo, ['log', '-1', '--format=%s', tip]).trim(); } catch { return tip; }
    if (!subject.startsWith(AUTOSAVE_SUBJECT)) return tip;
    const parents = git(repo, ['rev-list', '--parents', '-n', '1', tip]).trim().split(/\s+/).slice(1);
    if (parents.length !== 1) return tip;
    tip = parents[0]!;
  }
  return tip;
}

interface Ctx { w: WorkItem; emp: Employee; repo: string; base: string; branch: string; head: string }

/** Why the flow does not apply to this item, or where its branch is. */
function contextOf(wp: Workplace, w: WorkItem): Ctx | string {
  const level = levelOf(w);
  if (level === 'epic') return 'an epic has no branch';
  if (!w.employeeId || !isAgent(wp, w.employeeId)) return 'not assigned to an agent';
  const emp = wp.org.employees.find(e => e.id === w.employeeId)!;
  const base = wp.config.github.trunk;
  if ((emp.workspace.branch ?? 'main') !== base) return `${emp.name} does not work on ${base}`;
  const repo = emp.workspace.repo;
  const branch = branchFor(emp, w.id);
  const head = pushableTip(repo, branch);
  if (!head) return `no branch ${branch}`;
  const own = git(repo, ['rev-list', '--count', `${base}..${head}`]).trim();
  if (own === '0') return `no commits on ${branch} past ${base}`;
  return { w, emp, repo, base, branch, head };
}

/** Write the item's PR record from the current row (never a stale copy). */
export function savePr(wp: Workplace, id: string, change: (w: WorkItem) => Partial<WorkItem>): WorkItem {
  const cur = rawGet(wp, id);
  if (!cur) throw new NotFound(`No item ${id}`);
  const next = { ...cur, ...change(cur) } as WorkItem;
  for (const k of ['pr', 'prRefused'] as const) if (next[k] === undefined) delete next[k];
  work.saveQuiet(wp, next);
  return next;
}

export const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 300);

/* ---------- moving to review: push and PR ---------- */

export interface ReviewResult {
  skipped?: string;
  refused?: string[];
  error?: string;
  pr?: { number: number; url: string };
  /** Settles when workplace/tests is recorded for this head (never rejects). */
  tests?: Promise<void>;
  /** The head moved only by merging the trunk: the approvals, tests and evidence carried over. */
  carried?: boolean;
  /** One line for the employee's tool reply ('' when nothing happened). */
  message: string;
}

function prBody(w: WorkItem, ctx: Ctx): string {
  return [
    `Workplace story **${w.id}**: ${w.title}`,
    '',
    `- Author: ${ctx.emp.name} (${ctx.emp.id})`,
    `- Branch: \`${ctx.branch}\` → \`${ctx.base}\``,
    '',
    '## Evidence',
    '',
    '_Pending: the Workplace evidence check fills this in (workplace/evidence)._',
    '',
    'Opened by the Iris Workplace. Merges need `workplace/review` (a developer approval, then QA) and `workplace/tests` green.',
  ].join('\n');
}

/**
 * The story moved to review (report_done, request_review) or its head moved while in review: push the
 * branch, open or reuse its PR, post the statuses and queue the checks. Local: nothing at all.
 */
export async function onReview(wp: Workplace, itemId: string, by: string): Promise<ReviewResult> {
  if (mode(wp) === 'local') return { skipped: 'local', message: '' };
  const w = rawGet(wp, itemId);
  if (!w) return { skipped: 'no such item', message: '' };
  // Done by approval but not merged yet (PR #374, 16 Oct): its head can still move by a trunk-only
  // update (GitHub update-branch, or the author merging the trunk in). That carries the approvals over
  // like it does in review; any other move leaves the record alone and the merge refuses it.
  const approvedDone = w.status === 'done' && !!w.pr && !w.pr.merged;
  if (w.status !== 'in-review' && !approvedDone) return { skipped: 'not in review', message: '' };
  const ctx = contextOf(wp, w);
  if (typeof ctx === 'string') return { skipped: ctx, message: '' };
  if (approvedDone && (ctx.head === w.pr!.headSha || ctx.branch !== w.pr!.branch || !trunkOnly(ctx.repo, ctx.base, w.pr!.headSha, ctx.head))) {
    return { skipped: 'not in review', message: '' };
  }

  let cfg: quality.QualityConfig;
  try { cfg = quality.loadConfig(wp.config.workplaceDir); } catch (err) {
    return refuse(wp, itemId, ctx.head, [`quality.yaml could not be read: ${errText(err)}`]);
  }
  const problems = [branchProblem(ctx.branch, branchFor(ctx.emp, itemId)), ...quality.guardProblems(ctx.repo, ctx.base, ctx.head, cfg)].filter((p): p is string => !!p);
  if (problems.length) return refuse(wp, itemId, ctx.head, problems);

  const port = gitHubPort(wp);
  try {
    await port.push(ctx.repo, ctx.branch, ctx.head);
  } catch (err) {
    recordFailure(wp, 'push', itemId, Date.now(), errText(err));
    trail.record(wp, { itemId, by: 'workplace', kind: 'note', text: `Could not push ${ctx.branch} to GitHub: ${errText(err)}` });
    return { error: errText(err), message: `Your report is recorded, but GitHub did not take the push (${errText(err)}). Nothing to do: the Workplace retries every minute.` };
  }

  const prev = rawGet(wp, itemId)!.pr;
  const reuse = prev && !prev.merged && !prev.closed && prev.branch === ctx.branch ? prev : undefined;
  let number = reuse?.number;
  let url = reuse?.url;
  if (!number) {
    try {
      const found = await port.findOpenPr(ctx.branch)
        ?? await port.openPr({ title: `${w.title} [${w.id}]`, body: prBody(w, ctx), head: ctx.branch, base: ctx.base });
      number = found.number;
      url = found.url;
    } catch (err) {
      recordFailure(wp, 'open PR', itemId, Date.now(), errText(err));
      trail.record(wp, { itemId, by: 'workplace', kind: 'note', text: `Pushed ${ctx.branch}, but GitHub did not open its PR: ${errText(err)}` });
      return { error: errText(err), message: `Your report is recorded and your branch is pushed, but GitHub did not open the pull request (${errText(err)}). Nothing to do: the Workplace retries every minute.` };
    }
  }

  const moved = !!reuse && reuse.headSha !== ctx.head;
  // Rework W3 (owner, 10 Oct): a head that moved only by merging the trunk in keeps the approvals,
  // the tests and the evidence; any commit of the author's own resets them.
  const carried = moved && trunkOnly(ctx.repo, ctx.base, reuse!.headSha, ctx.head);
  // The review stay the approvals belong to: in review, this one; done, the one QA approved in.
  const episode = approvedDone ? w.pr!.qaApproval?.episode ?? '' : w.statusSince ?? '';
  const at = now();
  let tookOver = false;
  const extra = codeReviewersFor(wp, ctx);
  let added: ExtraReviewer[] = [];
  savePr(wp, itemId, cur => {
    const base: PrRecord = reuse
      ? { ...reuse }
      : { number: number!, url: url!, branch: ctx.branch, base: ctx.base, headSha: ctx.head, pushedAt: at, evidence: 'pending' };
    const record: PrRecord = { ...base, number: number!, url: url!, headSha: ctx.head, pushedAt: at };
    const before = reuse?.headSha;
    if (moved && carried) {
      for (const k of ['devApproval', 'qaApproval'] as const) if (record[k] && record[k]!.sha === before) record[k] = { ...record[k]!, sha: ctx.head };
      if (record.tests && record.tests.sha === before) {
        const note = 'carried: trunk-only merge';
        record.tests = { ...record.tests, sha: ctx.head, at, summary: record.tests.summary.includes(note) ? record.tests.summary : `${record.tests.summary} (${note})` };
      }
      // The mobile-checks run on the old head checks the same diff: it carries over too, and its result
      // lands on this head (18 Oct, PR #400: left on the old head, the finished run was never picked up).
      // A refused dispatch (state error) is not a run: nothing to carry, the new head dispatches for itself
      // (board bug 4: carried, it named the old head as the run's commit, with no pre-pr result there).
      if (record.mobileCi && record.mobileCi.sha === before) {
        if (record.mobileCi.state === 'error') delete record.mobileCi; else record.mobileCi = carryMobileCi(record.mobileCi, ctx.head);
      }
      record.extraReviewers = (record.extraReviewers ?? []).map(e => (e.approvedAt && e.sha === before ? { ...e, sha: ctx.head } : e));
    } else if (moved) {
      delete record.devApproval; delete record.qaApproval; delete record.tests; delete record.spendApprovedAt;
      record.evidence = 'stale';
      record.extraReviewers = (record.extraReviewers ?? []).map(clearExtra);
    }
    // A new stay in review (after a send-back): the approvals of the last one are over.
    for (const k of ['devApproval', 'qaApproval'] as const) if (record[k] && record[k]!.episode !== episode) delete record[k];
    // The extra reviewers: the leads whose charters' code this diff changes (recomputed on every push),
    // plus anyone the author asked for; an approval given on this head and this stay keeps holding.
    const prevExtra = (record.extraReviewers ?? []).map(e => (e.approvedAt && e.episode !== episode ? clearExtra(e) : e));
    const nextExtra: ExtraReviewer[] = extra.map(c => { const p = prevExtra.find(e => e.id === c.id); return p ? { ...p, files: c.files } : asked(c); });
    for (const e of prevExtra) if (e.requested && !nextExtra.some(x => x.id === e.id)) nextExtra.push(e);
    added = nextExtra.filter(e => !prevExtra.some(x => x.id === e.id));
    if (nextExtra.length) record.extraReviewers = nextExtra; else delete record.extraReviewers;
    // Evidence is run before submitting (handbook step 4, then 5): a finished run on this very head
    // carries over to a new PR record, or to a head the PR has just moved to.
    const ev = cur.evidenceRun;
    if (ev && ev.sha === ctx.head && (ev.state === 'success' || ev.state === 'failure') && (!reuse || (moved && !carried))) {
      record.evidence = ev.state;
      tookOver = true;
      record.evidenceNote = `${ev.passed} passed, ${ev.failed} failed on ${ev.platforms.join('+')} (run_evidence)`;
    }
    // A live check on the head that only merged the trunk in still describes this code (like the approvals).
    const liveChecks = moved && carried && cur.liveChecks ? cur.liveChecks.map(l => (l.sha === before ? { ...l, sha: ctx.head } : l)) : cur.liveChecks;
    return { pr: record, prRefused: undefined, ...(liveChecks ? { liveChecks } : {}) };
  });
  trail.record(wp, {
    itemId, by: 'workplace', kind: 'note',
    // Dry run #23: evidence run on the new head before the push is not stale; say which it is.
    text: `Pushed ${ctx.branch} (${ctx.head.slice(0, 8)}) to GitHub; PR #${number}${carried ? ': only the trunk merged in, so the approvals, tests and evidence carry over' : moved ? `: new commits, both approvals reset; ${tookOver ? 'evidence already matches this commit' : 'the evidence is stale'}` : ''}`,
  });
  log.info('github', `${itemId}: pushed ${ctx.branch} ${ctx.head.slice(0, 8)}, PR #${number}${carried ? ' (trunk-only merge, approvals kept)' : ''} (by ${by})`);
  // With a PR the first review is a developer's (shadow and on): whoever the author named, the reviewer
  // becomes a developer approver (a member of the author's team, or the CTO) until the developer approval
  // holds (dry-run finding #3, 4 Oct: QA named first refused and sent it back, a wasted round).
  const fresh = rawGet(wp, itemId)!;
  const named = fresh.reviewerId ?? '';
  if (!holds(fresh.pr?.devApproval, fresh) && !canApproveAsDeveloper(wp.org.employees, named, fresh.employeeId)) {
    const dev = devReviewer(wp, fresh);
    if (dev) {
      items.update(wp, itemId, { reviewerId: dev, note: 'system: a developer from the author\'s team reviews first, then QA' }, 'workplace');
      savePr(wp, itemId, c => (c.pr ? { pr: { ...c.pr, devReviewer: dev } } : {}));
    } else if (isCto(employeeOf(wp, fresh.employeeId ?? ''))) {
      // Dry run #12: the CTO has no team and never approves his own, so the COO gives approval 1 of 2.
      trail.record(wp, { itemId, by: 'workplace', kind: 'note', text: `The CTO's story: the COO gives the developer approval (1 of 2) through POST /api/coo/review-approve; QA follows unless the change is docs only.` });
      coo.notifyStall(wp, { itemId, by: 'workplace', title: `Review the CTO's PR: ${fresh.title}`, body: `PR #${number} by ${nameOf(wp, fresh.employeeId)} needs approval 1 of 2, which only you give on the CTO's stories: POST /api/coo/review-approve {"itemId":"${itemId}","note":"<what you checked>"}. A docs-only change (*.md, docs/**) merges on your approval alone; otherwise QA reviews next.` });
    } else {
      trail.record(wp, { itemId, by: 'workplace', kind: 'note', text: `No developer approver for ${nameOf(wp, fresh.employeeId)}: nobody else in their team and no CTO. Asha names one (item_update reviewerId).` });
    }
  } else if (named && !fresh.pr?.devReviewer && canApproveAsDeveloper(wp.org.employees, named, fresh.employeeId)) {
    savePr(wp, itemId, c => (c.pr ? { pr: { ...c.pr, devReviewer: named } } : {}));
  }
  if (added.length) {
    const list = added.map(e => `@${e.id} (${e.files.length ? e.files.slice(0, 5).join(', ') + (e.files.length > 5 ? ` +${e.files.length - 5} more` : '') : 'asked by the author'})`).join('; ');
    trail.comment(wp, itemId, { by: 'workplace', text: `Extra review before QA: this pull request changes code your charters own. ${list}. Review those files and call review_approve on ${itemId}; QA waits for you.`, mentions: added.map(e => e.id) });
  }
  // Whose turn it is now (the developer approver, the extra reviewers, QA): review-wake tells them (board bug 3).
  reviewWake.onItem(wp, itemId);

  try { await postStatuses(wp, itemId); } catch (err) { recordFailure(wp, 'status', itemId, Date.now(), errText(err)); }
  if (tookOver) {
    const ev = rawGet(wp, itemId)!.evidenceRun!;
    const link = ev.share ? (await freshLink(wp, ev.share))?.url : undefined;
    await prComment(wp, itemId, `Evidence ${ev.state === 'success' ? 'PASS' : 'FAIL'} on ${ev.sha.slice(0, 8)} (${ev.platforms.join(',')} / ${ev.features.join(',')}): ${ev.passed} passed, ${ev.failed} failed. Report: ${link ?? 'link unavailable'}`);
  }
  const tests = carried ? Promise.resolve() : recordTests(wp, itemId, ctx);
  return {
    pr: { number: number!, url: url! }, tests, ...(carried ? { carried: true } : {}),
    message: `The Workplace pushed your branch: pull request #${number} (${url}). ` +
      (carried ? 'Only the trunk was merged in, so the approvals, tests and evidence carry over.'
        : moved ? `Your new commit resets both approvals, so it goes back through the developer approver (approval 1 of 2) and QA (approval 2 of 2); ${tookOver ? 'evidence already matches this commit.' : 'run run_evidence again on this commit.'}`
        : 'Next: the developer approver (approval 1 of 2, a member of your team who is not you), then QA (approval 2 of 2).'),
  };
}

/** Their approval no longer holds: they are asked again (askedAt), and review-wake tells them once more (board bug 3). */
const clearExtra = (e: ExtraReviewer): ExtraReviewer => { const { approvedAt: _a, sha: _s, episode: _e, ...rest } = e; return { ...rest, askedAt: now() }; };
/** Newly added: asked now. */
const asked = (e: ExtraReviewer): ExtraReviewer => (e.askedAt ? e : { ...e, askedAt: now() });

/* ---------- trunk catch-up (rework W3) ---------- */

export const isAncestor = (repo: string, a: string, b: string): boolean => {
  try { execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', a, b], { stdio: 'ignore' }); return true; } catch { return false; }
};

/**
 * True when `to` differs from `from` only by merges of the trunk: `from` is an ancestor of `to`, there is
 * no non-merge commit in from..to that is not on the trunk, every merge's parents are on the branch before it (from, or another
 * merge in the range) or on the trunk, and each merge is a clean one (its tree is what git's own merge of
 * its parents gives: no change slipped in while "resolving"). Anything else is the author's work.
 */
export function trunkOnly(repo: string, base: string, from: string, to: string): boolean {
  try {
    if (from === to || !isAncestor(repo, from, to)) return false;
    const trunks = [`refs/heads/${base}`, `refs/remotes/origin/${base}`].map(r => revParse(repo, r)).filter((x): x is string => !!x);
    if (!trunks.length) return false;
    // The branch's own new commits: in from..to and not on the trunk (the trunk's commits came in by the merge).
    const own = (flag: string): string[] => git(repo, ['rev-list', flag, to, `^${from}`, ...trunks.map(t => `^${t}`)]).split('\n').map(x => x.trim()).filter(Boolean);
    if (own('--no-merges').length) return false;
    const merges = own('--merges');
    if (!merges.length) return false;
    const range = new Set(merges);
    for (const m of merges) {
      const parents = git(repo, ['rev-list', '--parents', '-n', '1', m]).trim().split(/\s+/).slice(1);
      if (parents.length !== 2) return false;
      let fromTrunk = false;
      for (const p of parents) {
        const ownSide = p === from || range.has(p) || isAncestor(repo, p, from);
        const trunk = trunks.some(t => isAncestor(repo, p, t));
        if (!ownSide && !trunk) return false;
        if (trunk && !ownSide) fromTrunk = true;
      }
      if (!fromTrunk) return false;
      let clean: string;
      try { clean = git(repo, ['merge-tree', '--write-tree', parents[0]!, parents[1]!]).split('\n')[0]!.trim(); } catch { return false; }
      if (clean !== git(repo, ['rev-parse', `${m}^{tree}`]).trim()) return false;
    }
    return true;
  } catch { return false; }
}

/* ---------- extra reviewers (rework W3) ---------- */

/** A comment line in any of the languages we write: //, #, *, /* or <!--. */
const COMMENT_LINE = /^(\/\/|#|\*|\/\*|<!--)/;

/** Docs never call for a code review from another team. */
const notCode = (file: string): boolean => /\.md$/i.test(file) || file.startsWith('docs/');

/**
 * The merge-base of the head with the trunk, taking the nearest of the local and origin trunk refs: a stale
 * local trunk would otherwise put everything a catch-up merge brought in on the author's diff (19 Oct).
 */
export function trunkMergeBase(repo: string, base: string, head: string): string {
  const bases: string[] = [];
  for (const r of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
    try { bases.push(git(repo, ['merge-base', r, head]).trim()); } catch { /* ref missing */ }
  }
  if (!bases.length) return base;
  // The nearest one is the one every other is an ancestor of.
  return bases.find(b => bases.every(o => o === b || isAncestor(repo, o, b))) ?? bases[0]!;
}

/** The files a branch changes against the trunk (since they diverged): the diff from the merge-base only. */
export function changedFiles(repo: string, base: string, head: string): string[] {
  return git(repo, ['diff', '--name-only', `${trunkMergeBase(repo, base, head)}..${head}`]).split('\n').map(f => f.trim()).filter(Boolean);
}

/** A file's change counts as code when at least one added or removed line (whitespace and blank lines aside) is not a comment. */
export function realCodeChange(repo: string, base: string, head: string, file: string): boolean {
  if (notCode(file)) return false;
  const diff = git(repo, ['diff', '-w', '--ignore-blank-lines', `${trunkMergeBase(repo, base, head)}..${head}`, '--', file]);
  return diff.split('\n').some(l => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---') && !!l.slice(1).trim() && !COMMENT_LINE.test(l.slice(1).trim()));
}

/** The other teams' leads whose charters own code this branch really changes, each with those files. */
function codeReviewersFor(wp: Workplace, ctx: Ctx): ExtraReviewer[] {
  const author = ctx.emp.id;
  const authorLead = teamOf(wp.org, author) ?? author;
  const repoId = wp.org.repos.find(r => r.root === ctx.repo)?.id ?? 'iris';
  const byLead = new Map<string, string[]>();
  let files: string[];
  // A fresh origin trunk first, so the merge-base is the real one (best effort: offline keeps the last fetch).
  try { execFileSync('git', ['-C', ctx.repo, 'fetch', '--quiet', 'origin', ctx.base], { stdio: 'ignore', timeout: 30_000 }); } catch { /* keep what we have */ }
  try { files = changedFiles(ctx.repo, ctx.base, ctx.head); } catch { return []; }
  for (const f of files) {
    if (notCode(f)) continue;
    const owner = resolveOwner(wp.org.map, { kind: 'path', key: `${repoId}:${f}` });
    if (!owner) continue;
    const lead = leadOfCharter(wp.org, owner.primary);
    if (!lead || lead === authorLead || lead === author) continue;
    let real = false;
    try { real = realCodeChange(ctx.repo, ctx.base, ctx.head, f); } catch { real = false; }
    if (!real) continue;
    byLead.set(lead, [...(byLead.get(lead) ?? []), f]);
  }
  return [...byLead].map(([id, fs]) => ({ id, files: fs }));
}

/**
 * Re-evaluate the extra reviewers on a head that did not move (19 Oct: as_mv6varf8ftb1v kept two reviewers
 * computed against a stale trunk): the code reviewers drop or gain with the real diff; approvals and
 * reviewers the author asked for stay.
 */
function refreshExtraReviewers(wp: Workplace, w: WorkItem, ctx: Ctx): void {
  const prev = w.pr?.extraReviewers ?? [];
  const fresh = codeReviewersFor(wp, ctx);
  const next: ExtraReviewer[] = fresh.map(c => { const p = prev.find(e => e.id === c.id); return p ? { ...p, files: c.files } : asked(c); });
  for (const e of prev) if (e.requested && !next.some(x => x.id === e.id)) next.push(e);
  if (next.length === prev.length && next.every(n => prev.some(p => p.id === n.id && p.files.join() === n.files.join()))) return;
  savePr(wp, w.id, cur => { const pr = { ...cur.pr! }; if (next.length) pr.extraReviewers = next; else delete pr.extraReviewers; return { pr }; });
  trail.record(wp, { itemId: w.id, by: 'workplace', kind: 'note', text: `Extra reviewers re-evaluated against the real diff: ${next.length ? next.map(e => nameOf(wp, e.id)).join(', ') : 'none'}.` });
  reviewWake.onItem(wp, w.id);
}

/** The extra reviewers whose approval does not hold on this head and stay in review (one rule, review-policy: the gate and the wake read it). */
export { pendingExtra };

/** The author asks other leads to approve before QA (request_review extraReviewers). */
export function requestExtraReviewers(wp: Workplace, itemId: string, by: string, ids: string[]): ExtraReviewer[] {
  const w = rawGet(wp, itemId);
  if (!w) throw new NotFound(`No item ${itemId}`);
  if (by !== w.employeeId) throw new BadRequest('Only the author adds extra reviewers to their pull request.');
  if (!w.pr) throw new BadRequest('This story has no pull request yet: report_done opens it, then add extra reviewers.');
  const unknown = ids.filter(id => !wp.org.employees.some(e => e.id === id && !e.virtual));
  if (unknown.length) throw new BadRequest(`No such employee: ${unknown.join(', ')}.`);
  if (ids.includes(w.employeeId!)) throw new BadRequest('You never review your own story.');
  const lead = w.employeeId ? teamOf(wp.org, w.employeeId) : undefined;
  const team = lead ? teamMembers(wp.org, lead) : [];
  const mates = ids.filter(id => team.includes(id));
  if (mates.length) throw new BadRequest(`${mates.map(id => nameOf(wp, id)).join(', ')} ${mates.length === 1 ? 'is' : 'are'} in your team: your team gives the developer approval; extra reviewers are other teams' leads.`);
  const fresh: string[] = [];
  const saved = savePr(wp, itemId, c => {
    const list = [...(c.pr!.extraReviewers ?? [])];
    for (const id of new Set(ids)) if (!list.some(e => e.id === id)) { list.push({ id, files: [], requested: true, askedAt: now() }); fresh.push(id); }
    return { pr: { ...c.pr!, extraReviewers: list } };
  });
  if (fresh.length) trail.comment(wp, itemId, { by: 'workplace', text: `Extra review before QA, asked by ${nameOf(wp, by)}: ${fresh.map(id => `@${id}`).join(', ')}. Review the change and call review_approve on ${itemId}; QA waits for you.`, mentions: fresh });
  reviewWake.onItem(wp, itemId);
  return saved.pr!.extraReviewers ?? [];
}

function refuse(wp: Workplace, itemId: string, sha: string, reasons: string[]): ReviewResult {
  savePr(wp, itemId, () => ({ prRefused: { at: now(), sha, reasons } }));
  trail.comment(wp, itemId, { by: 'workplace', text: `Not pushed to GitHub: ${reasons.length} problem${reasons.length === 1 ? '' : 's'} on the branch. Fix ${reasons.length === 1 ? 'it' : 'them'} on your branch, then call report_done again.`, details: reasons.map(r => `- ${r}`).join('\n') });
  log.warn('github', `${itemId}: push refused (${reasons.length}): ${reasons.map(r => r.split(':')[0]).join(', ')}`);
  return { refused: reasons, message: `Your report is recorded, but the Workplace did not push your branch: ${reasons.join('; ')}. Fix ${reasons.length === 1 ? 'it' : 'them'} on your branch, then call report_done again.` };
}

/* ---------- the pre-PR gate (workplace/tests) ---------- */

/** Where the author's pre-pr.sh results live: their worktree. */
function authorWorktree(wp: Workplace, emp: Employee): string { return worktreePath(wp.config.workDir, emp); }

/**
 * The author's scripts/pre-pr.sh result covering `head`: the one for the head itself, else the newest one
 * on a commit from which `head` differs only by trunk merges (approvals carry over the same way). Null when
 * none: the author has to run pre-pr.sh on the head.
 */
function coveringPrePr(wp: Workplace, ctx: Ctx, head: string, hint?: string): prePr.PrePrResult | null {
  const wt = authorWorktree(wp, ctx.emp);
  const exact = prePr.read(wt, head);
  if (exact && exact.sha === head) return exact;
  const seen = new Set<string>([head]);
  for (const c of [hint, ...prePr.shasWithResults(wt, 6)]) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    const r = prePr.read(wt, c);
    if (r && r.sha === c && trunkOnly(ctx.repo, ctx.base, c, head)) return r;
  }
  return null;
}

/**
 * report_done / request_review in shadow or on: a passing scripts/pre-pr.sh result for the branch
 * head must be in the author's worktree. Null when the submit may go on (local mode, no code branch,
 * or a passing result); else the refusal sentence.
 */
export function prePrGate(wp: Workplace, itemId: string): string | null {
  if (mode(wp) === 'local') return null;
  const w = rawGet(wp, itemId);
  if (!w) return null;
  const ctx = contextOf(wp, w);
  if (typeof ctx === 'string') return null;
  return prePr.refusal(prePr.read(authorWorktree(wp, ctx.emp), ctx.head), ctx.head);
}

/** Kept for callers that wait for checks: workplace/tests is now recorded synchronously. */
export async function settled(): Promise<void> { /* nothing runs in the background */ }

/** workplace/tests from the author's pre-pr.sh results for this head, plus GitHub's for the mobile areas it deferred. */
async function recordTests(wp: Workplace, itemId: string, ctx: Ctx): Promise<void> {
  const sha = ctx.head;
  try {
    // A head reached by a trunk-only merge while its mobile checks ran: the pre-pr.sh result those
    // checks complete is the one of the commit they run on (PR #400).
    const ci = rawGet(wp, itemId)?.pr?.mobileCi;
    // Board bug 4 (19 Oct, PR #449): the author's result that covers this head, by one rule: for the head
    // itself, else for a commit the head reached only by trunk merges (GitHub's update-branch). A stored
    // "run commit" is only a hint: a refused dispatch once named a GitHub merge nobody ran pre-pr on.
    const valid = coveringPrePr(wp, ctx, sha, ci && ci.sha === sha ? ci.runSha : undefined);
    const localSha = valid?.sha ?? sha;
    // Only a full run counts (pre-pr.ts passes); a fast or partial pass stays pending.
    let tests: NonNullable<PrRecord['tests']> = !valid
      ? { state: 'pending', sha, at: now(), summary: `Waiting for scripts/pre-pr.sh results on ${localSha.slice(0, 7)}` }
      : !valid.ok
        ? { state: 'failure', sha, at: now(), summary: prePr.describe(valid), details: prePr.failureDetails(valid).slice(-4000) }
        : { state: prePr.passes(valid, localSha) ? 'success' : 'pending', sha, at: now(), summary: prePr.describe(valid) };
    let failureText = `scripts/pre-pr.sh failed on ${sha.slice(0, 8)} (${tests.summary}). Fix it on your branch, commit, run scripts/pre-pr.sh again, then call report_done.`;
    // Cloud migration (17 Oct): the mobile areas a Linux pre-pr.sh could not build run on GitHub.
    if (valid && tests.state === 'success' && prePr.deferredAreas(valid).length) {
      const gh = await mobileChecks(wp, itemId, sha, valid);
      tests = gh.tests;
      if (gh.failureText) failureText = gh.failureText;
    }
    const prev = rawGet(wp, itemId)?.pr?.tests;
    // A pending status keeps its clock across re-reads and head moves (pendingTestsAlarm reads it).
    if (tests.state === 'pending') tests = { ...tests, pendingSince: prev?.state === 'pending' ? prev.pendingSince ?? prev.at : now() };
    const changed = !prev || prev.sha !== sha || prev.state !== tests.state || prev.summary !== tests.summary;
    savePr(wp, itemId, c => (c.pr && c.pr.headSha === sha ? { pr: { ...c.pr, tests } } : {}));
    // A sweep re-reads a pending result every minute: the trail says it once per change, not per minute.
    if (changed) {
      trail.record(wp, { itemId, by: 'workplace', kind: 'test', text: `Pre-PR checks ${tests.state === 'success' ? 'green' : tests.state} on ${sha.slice(0, 8)}: ${tests.summary}` });
      if (tests.state === 'failure') {
        trail.comment(wp, itemId, { by: 'workplace', text: failureText, ...(tests.details ? { details: tests.details } : {}) });
      }
    }
    try { await postStatuses(wp, itemId); } catch (err) { recordFailure(wp, 'status', itemId, Date.now(), errText(err)); }
  } catch (err) {
    log.warn('github', `${itemId}: tests status: ${errText(err)}`);
  }
}

/* ---------- mobile checks on GitHub (cloud migration, 17 Oct) ---------- */

export const MOBILE_WORKFLOW = 'mobile-checks.yml';
export const MOBILE_ARTIFACT = 'mobile-checks-result';
/** retryMs: a refused dispatch is tried again after this; lostMs: a dispatch whose run never appeared is redone after this. */
export const mobileCiTiming = { retryMs: 5 * 60_000, lostMs: 30 * 60_000 };

export const mobileRequestId = (itemId: string, sha: string): string => `${itemId}-${sha.slice(0, 8)}`;
const agoMs = (iso: string): number => Date.now() - Date.parse(iso);

/**
 * The GitHub half of workplace/tests for a head whose local pre-pr.sh passed with mobile areas deferred:
 * dispatch mobile-checks.yml once per head, follow the run on later calls (the minute sweep), and on
 * completion merge its result.json into the local result. Never throws: a GitHub error is recorded and
 * the tests stay pending, so the merge waits.
 */
async function mobileChecks(wp: Workplace, itemId: string, sha: string, local: prePr.PrePrResult): Promise<{ tests: NonNullable<PrRecord['tests']>; failureText?: string }> {
  const areas = prePr.deferredAreas(local);
  const port = gitHubPort(wp);
  const pending = (summary: string): { tests: NonNullable<PrRecord['tests']> } => ({ tests: { state: 'pending', sha, at: now(), summary } });
  const save = (rec: MobileCiRecord): void => { savePr(wp, itemId, c => (c.pr && c.pr.headSha === sha ? { pr: { ...c.pr, mobileCi: rec } } : {})); };
  let rec = rawGet(wp, itemId)?.pr?.mobileCi;
  if (rec && rec.sha !== sha) rec = undefined;
  // A run carried over a trunk-only head move is still found by its own request id, and checks its own commit.
  const requestId = rec?.requestId ?? mobileRequestId(itemId, sha);
  const runSha = rec?.runSha ?? sha;

  // Done before (a later re-read): the stored verdict stands.
  if (rec && (rec.state === 'success' || rec.state === 'failure')) {
    const prev = rawGet(wp, itemId)?.pr?.tests;
    if (prev && prev.sha === sha && prev.state !== 'pending') return { tests: prev };
  }

  // Kept as a refused dispatch (state error) so the sweep keeps following it, retried on every pass while capped.
  const capped = (message: string, attempts: number): { tests: NonNullable<PrRecord['tests']> } => {
    save({ sha, requestId: mobileRequestId(itemId, sha), areas, state: 'error', attemptAt: now(), attempts, lastError: message });
    const key = `spend-cap:told:${itemId}:${dayOf()}`;
    if (!getSetting(wp, key)) {
      putSetting(wp, key, now());
      trail.comment(wp, itemId, { by: 'workplace', text: `Mobile checks (${areas.join(', ')}) for ${sha.slice(0, 8)} not started: ${message}. workplace/tests stays pending, and they start by themselves once it lifts.` });
    }
    return pending(`${message} (mobile checks ${areas.join(', ')} waiting)`);
  };
  const dispatch = async (attempts: number): Promise<{ tests: NonNullable<PrRecord['tests']> }> => {
    // A new run is always for this head itself.
    const requestId = mobileRequestId(itemId, sha);
    // The daily GitHub cap (owner, 18 Oct): no dispatch; the tests stay pending (never failed) and the
    // story hears why once a day. The next sweep dispatches once the cap lifts.
    const blocked = spendCaps.githubBlock(wp);
    if (blocked) return capped(blocked.message, attempts - 1);
    try {
      await port.dispatchWorkflow(MOBILE_WORKFLOW, { iris_ref: sha, areas: areas.join(','), request_id: requestId });
    } catch (err) {
      if (err instanceof spendCaps.GitHubCapError) return capped(err.message, attempts - 1);
      const why = errText(err);
      recordFailure(wp, 'dispatch mobile checks', itemId, Date.now(), why);
      save({ sha, requestId, areas, state: 'error', attemptAt: now(), attempts, lastError: why });
      return pending(`mobile checks (${areas.join(', ')}) could not start on GitHub (${why.slice(0, 60)}); retrying`);
    }
    save({ sha, requestId, areas, state: 'dispatched', attemptAt: now(), attempts });
    trail.record(wp, { itemId, by: 'workplace', kind: 'note', text: `Mobile checks (${areas.join(', ')}) started on GitHub for ${sha.slice(0, 8)} (${MOBILE_WORKFLOW}, ${requestId})` });
    return pending(`mobile checks (${areas.join(', ')}) running on GitHub`);
  };

  if (!rec) return dispatch(1);
  if (rec.state === 'error') {
    // Waiting on the daily GitHub cap is not a failed attempt: try again on every pass, at no cost.
    if (rec.lastError?.startsWith(spendCaps.GITHUB_PAUSED)) return dispatch(rec.attempts + 1);
    return agoMs(rec.attemptAt) >= mobileCiTiming.retryMs ? dispatch(rec.attempts + 1) : pending(`mobile checks (${areas.join(', ')}) could not start on GitHub (${(rec.lastError ?? '').slice(0, 60)}); retrying`);
  }

  let run;
  try { run = await port.findWorkflowRun(MOBILE_WORKFLOW, requestId); } catch (err) {
    recordFailure(wp, 'find mobile checks run', itemId, Date.now(), errText(err));
    return pending(`mobile checks (${areas.join(', ')}) running on GitHub${rec.runUrl ? `: ${rec.runUrl}` : ''}`);
  }
  if (!run) {
    if (agoMs(rec.attemptAt) >= mobileCiTiming.lostMs) return dispatch(rec.attempts + 1);
    return pending(`mobile checks (${areas.join(', ')}) queued on GitHub`);
  }
  if (run.status !== 'completed') {
    if (rec.state !== 'running' || rec.runId !== run.id) save({ ...rec, state: 'running', runId: run.id, runUrl: run.url });
    return pending(`mobile checks (${areas.join(', ')}) running on GitHub: ${run.url}`);
  }

  // Completed: its result.json decides, whatever the run's own conclusion says.
  const dir = join(wp.config.workplaceDir, 'ci', itemId, requestId);
  let gh: prePr.GitHubChecksResult | null = null;
  try {
    const art = (await port.listArtifacts(run.id)).find(a => a.name === MOBILE_ARTIFACT);
    if (art) {
      rmSync(dir, { recursive: true, force: true });
      await port.downloadArtifact(art.id, dir);
      const raw = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as prePr.GitHubChecksResult;
      if (raw && raw.sha === runSha && typeof raw.ok === 'boolean' && Array.isArray(raw.areas)) gh = raw;
    }
  } catch (err) {
    log.warn('github', `${itemId}: mobile checks result of run ${run.id}: ${errText(err)}`);
  }
  if (!gh) {
    save({ ...rec, state: 'failure', runId: run.id, runUrl: run.url });
    return { tests: { state: 'error', sha, at: now(), summary: `mobile checks on GitHub ended ${run.conclusion ?? 'without a conclusion'} with no result for ${runSha.slice(0, 7)}: ${run.url}`.slice(0, 300) } };
  }
  const merged = prePr.withGitHub(local, gh);
  save({ ...rec, state: merged.ok ? 'success' : 'failure', runId: run.id, runUrl: run.url });
  trail.record(wp, { itemId, by: 'workplace', kind: 'note', text: `Mobile checks on GitHub ${merged.ok ? 'passed' : 'failed'} for ${sha.slice(0, 8)}: ${run.url}` });
  if (merged.ok) return { tests: { state: 'success', sha, at: now(), summary: prePr.describe(merged) } };
  return {
    tests: { state: 'failure', sha, at: now(), summary: prePr.describe(merged), details: prePr.failureDetails(merged).slice(-4000) },
    failureText: `The mobile checks on GitHub failed on ${sha.slice(0, 8)} (${prePr.describe(merged)}): ${run.url}. Fix it on your branch, commit, run scripts/pre-pr.sh again, then call report_done.`,
  };
}

/** The record moved to a head reached from its own by a trunk-only merge: same run, same request id. */
function carryMobileCi(rec: MobileCiRecord, head: string): MobileCiRecord {
  return { ...rec, sha: head, runSha: rec.runSha ?? rec.sha };
}

const MOBILE_UNAPPLIED_PREFIX = 'github:mobile-ci-unapplied:';

/**
 * Follow the mobile-checks run of an open PR, whatever the story's status (18 Oct, PR #400: a story sent
 * back to building, then blocked, while its run finished was never looked at again). Reads the PR's own
 * head, not wherever the author's branch has gone since. A record an earlier trunk-only carry left on the
 * old head is moved first. A run GitHub shows finished whose result still could not be applied is said
 * on the story once per run, never left silent.
 */
async function followMobileCi(wp: Workplace, itemId: string): Promise<void> {
  const w = rawGet(wp, itemId);
  const pr = w?.pr;
  // Board bug 4 (19 Oct): every pending workplace/tests is re-read here, not only one with a mobile run
  // record (a "Waiting for scripts/pre-pr.sh results" had no re-reader at all, and a refused record left on
  // an old head returned before the re-read).
  if (!w || !pr || pr.merged || (!pr.mobileCi && !testsStale(pr))) return;
  const ctx = contextOf(wp, w);
  if (typeof ctx === 'string') return;
  const head = pr.headSha;
  const rec = pr.mobileCi;
  if (rec && rec.sha !== head) {
    const inFlight = rec.state === 'dispatched' || rec.state === 'running';
    if (inFlight && pr.tests?.sha === head && pr.tests.state === 'pending' && trunkOnly(ctx.repo, ctx.base, rec.runSha ?? rec.sha, head)) {
      savePr(wp, itemId, c => (c.pr && c.pr.headSha === head && c.pr.mobileCi?.sha === rec.sha ? { pr: { ...c.pr, mobileCi: carryMobileCi(c.pr.mobileCi, head) } } : {}));
      log.info('github', `${itemId}: mobile checks run ${rec.requestId} carried from ${rec.sha.slice(0, 8)} to ${head.slice(0, 8)} (trunk-only merge)`);
    } else if (inFlight) {
      return;   // a run still going on another head: its own story (PR #400 heal) is the carry above
    }
  }
  if (!testsStale(pr)) return;
  await recordTests(wp, itemId, { ...ctx, head });

  const after = rawGet(wp, itemId)?.pr?.mobileCi;
  if (!after || after.sha !== head || (after.state !== 'dispatched' && after.state !== 'running')) return;
  let run;
  try { run = await gitHubPort(wp).findWorkflowRun(MOBILE_WORKFLOW, after.requestId); } catch { return; }
  if (!run || run.status !== 'completed') return;
  const key = MOBILE_UNAPPLIED_PREFIX + itemId;
  if (getSetting(wp, key) === String(run.id)) return;
  putSetting(wp, key, String(run.id));
  const tests = rawGet(wp, itemId)?.pr?.tests;
  const why = tests && tests.sha === head ? tests.summary : `no workplace/tests record for ${head.slice(0, 8)}`;
  log.warn('github', `${itemId}: mobile checks run ${run.id} finished (${run.conclusion ?? 'no conclusion'}) but its result could not be applied: ${why}`);
  trail.comment(wp, itemId, {
    by: 'workplace',
    text: `The mobile checks run on GitHub finished (${run.conclusion ?? 'no conclusion'}) but the Workplace could not apply its result to ${head.slice(0, 8)}: ${why}. workplace/tests stays pending. Run: ${run.url}. Run scripts/pre-pr.sh again on this commit and call report_done, or ask the COO.`,
  });
}

/* ---------- statuses ---------- */

interface Status { context: string; state: StatusState; description: string; targetUrl?: string }

export function statusesFor(wp: Workplace, w: WorkItem): Status[] {
  const pr = w.pr!;
  const dev = holds(pr.devApproval, w);
  const qa = dev && holds(pr.qaApproval, w);
  const review: Status = qa
    ? { context: CONTEXTS.review, state: 'success', description: cooDocsApproval(w) ? 'Approved by the COO (a docs-only change by the CTO)' : `Approved by ${nameOf(wp, pr.devApproval!.by)} (developer approver) and ${nameOf(wp, pr.qaApproval!.by)} (QA)` }
    : dev
      ? { context: CONTEXTS.review, state: 'pending', description: `Approval 1 of 2 by ${nameOf(wp, pr.devApproval!.by)} (developer approver); waiting for QA (2 of 2)` }
      : { context: CONTEXTS.review, state: 'pending', description: 'Waiting for the developer approver (1 of 2), then QA (2 of 2)' };
  const t = pr.tests && pr.tests.sha === pr.headSha ? pr.tests : undefined;
  const ci = pr.mobileCi && pr.mobileCi.sha === pr.headSha && pr.mobileCi.runUrl ? pr.mobileCi.runUrl : undefined;
  const tests: Status = t ? { context: CONTEXTS.tests, state: t.state, description: t.summary, ...(ci ? { targetUrl: ci } : {}) } : { context: CONTEXTS.tests, state: 'pending', description: 'Checks queued' };
  const evidence: Status = pr.evidence === 'success' ? { context: CONTEXTS.evidence, state: 'success', description: pr.evidenceNote ?? 'Evidence checked' }
    : pr.evidence === 'failure' ? { context: CONTEXTS.evidence, state: 'failure', description: pr.evidenceNote ?? 'Evidence missing' }
    : pr.evidence === 'stale' ? { context: CONTEXTS.evidence, state: 'pending', description: 'Stale: a new commit needs run_evidence again' }
    : { context: CONTEXTS.evidence, state: 'pending', description: 'Waiting for run_evidence on this commit' };
  // The shared report of the run behind this status (the global link), when there is one.
  const share = w.evidenceRun?.sha === pr.headSha && w.evidenceRun.state === pr.evidence ? w.evidenceRun.share : undefined;
  if (share && (pr.evidence === 'success' || pr.evidence === 'failure')) evidence.targetUrl = share.url;
  return [review, tests, evidence];
}

/**
 * A GitHub status POST that fails is tried again after a pause (18 Oct, PR #447: one GitHub 500 left
 * workplace/review pending for good). Backoff delays in ms between attempts; tests shorten them.
 */
export const statusRetry = { delaysMs: [1000, 4000, 10000] };

async function withRetry(op: () => Promise<void>, what: string): Promise<void> {
  for (let i = 0; ; i++) {
    try { return await op(); } catch (err) {
      const wait = statusRetry.delaysMs[i];
      if (wait === undefined) throw err;
      log.warn('github', `${what} failed (${errText(err)}); retrying in ${wait} ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

/** Post what changed since the last post on this head. Throws a GitHub error to the caller. */
async function postStatuses(wp: Workplace, itemId: string): Promise<void> {
  const w = rawGet(wp, itemId);
  if (!w?.pr || w.pr.merged) return;
  const port = gitHubPort(wp);
  const head = w.pr.headSha;
  const posted = { ...(w.pr.posted ?? {}) };
  for (const status of statusesFor(wp, w)) {
    const s: Status = { ...status };
    const key = `${head}|${s.state}|${s.description}`;
    if (posted[s.context] === key) continue;
    // Re-posted after the 7-day link expired: sign a fresh one first.
    const share = w.evidenceRun?.share;
    if (s.targetUrl && share) {
      const fresh = await freshLink(wp, share);
      if (!fresh) delete s.targetUrl;
      else if (fresh.url !== share.url) {
        const cur = rawGet(wp, itemId)!;
        if (cur.evidenceRun?.share?.key === share.key) work.saveQuiet(wp, { ...cur, evidenceRun: { ...cur.evidenceRun, share: fresh } });
        s.targetUrl = fresh.url;
      }
    }
    await withRetry(() => port.setStatus(head, s), `status ${s.context}`);
    posted[s.context] = key;
    savePr(wp, itemId, c => (c.pr ? { pr: { ...c.pr, posted: { ...(c.pr.posted ?? {}), [s.context]: key } } } : {}));
  }
}

/** Forget what was posted for this head and post every workplace/* status again (board maintenance). */
export async function repostStatuses(wp: Workplace, itemId: string): Promise<Status[]> {
  const w = rawGet(wp, itemId);
  if (!w?.pr || w.pr.merged) throw new BadRequest(`${itemId} has no open pull request.`);
  savePr(wp, itemId, c => (c.pr ? { pr: { ...c.pr, posted: {} } } : {}));
  await postStatuses(wp, itemId);
  return statusesFor(wp, rawGet(wp, itemId)!);
}

/** A comment on the item's open PR (shadow/on): the evidence summary with its link. */
export async function prComment(wp: Workplace, itemId: string, body: string): Promise<void> {
  if (mode(wp) === 'local') return;
  const pr = rawGet(wp, itemId)?.pr;
  if (!pr || pr.merged) return;
  try { await gitHubPort(wp).comment(pr.number, body); } catch (err) { recordFailure(wp, 'comment', itemId, Date.now(), errText(err)); }
}

/** The evidence hook (docs/HLD-github-flow.md D7): the evidence tool, when it exists, calls this. */
export async function setEvidence(wp: Workplace, itemId: string, value: PrRecord['evidence'], note?: string): Promise<void> {
  if (mode(wp) === 'local') return;
  const w = rawGet(wp, itemId);
  if (!w?.pr) throw new BadRequest(`${itemId} has no pull request`);
  savePr(wp, itemId, c => { const pr: PrRecord = { ...c.pr!, evidence: value }; if (note) pr.evidenceNote = note; else delete pr.evidenceNote; return { pr }; });
  try { await postStatuses(wp, itemId); } catch (err) { recordFailure(wp, 'status', itemId, Date.now(), errText(err)); }
}

/* ---------- approvals ---------- */

const LOCAL_REVIEW = 'The Workplace is in local mode, so there is no pull request to approve: the reviewer marks the story done with item_update, or moves it to in-progress with what to change.';

function employeeOf(wp: Workplace, id: string): Employee | undefined { return wp.org.employees.find(e => e.id === id); }

/** QA's names, for a refusal that says who gives approval 2 of 2. */
function qaNames(wp: Workplace): string {
  const names = wp.org.employees.filter(e => isQa(e) && !e.virtual).map(e => e.name);
  return names.length ? names.join(' or ') : 'QA';
}

/** Reviews each person has open (in review with them as the reviewer). */
const openReviews = (wp: Workplace, id: string): number => (wp.db.prepare("select count(*) as n from work where status = 'in-review' and reviewer_id = ?").get(id) as { n: number }).n;

/**
 * The developer approver (rework W3, owner 10 Oct): for an engineer, their team lead; for a lead (or the
 * QA lead), the member of their own team with the fewest reviews open; the CTO when the team has nobody else.
 */
export function devReviewer(wp: Workplace, w: WorkItem): string | undefined {
  const employees = wp.org.employees;
  const author = w.employeeId;
  if (!author) return undefined;
  const lead = teamOf(wp.org, author);
  if (lead && lead !== author) return lead;
  const members = teamMembers(wp.org, lead ?? author).filter(id => id !== author && !employees.find(e => e.id === id)?.virtual);
  const pick = members.map((id, i) => ({ id, n: openReviews(wp, id), i })).sort((a, b) => a.n - b.n || a.i - b.i)[0]?.id;
  // Never the author: the CTO's own story has no developer approver here (the COO gives it, dry run #12).
  return pick ?? employees.find(e => isCto(e) && !e.virtual && e.id !== author)?.id;
}

/** The item in review with its PR, its head re-read; a moved head is re-pushed and refused, unless it only merged the trunk in. */
async function reviewable(wp: Workplace, itemId: string): Promise<WorkItem> {
  const w = rawGet(wp, itemId);
  if (!w) throw new NotFound(`No item ${itemId}`);
  if (!w.pr) {
    throw new BadRequest(w.prRefused
      ? `This story has no pull request: the Workplace refused to push its branch (${w.prRefused.reasons.join('; ')}). Send it back to its author with item_update so they fix it.`
      : 'This story has no pull request yet; the Workplace opens one when its author calls report_done, so review it after that.');
  }
  if (w.status !== 'in-review') throw new BadRequest(`This story is not in review (it is ${w.status}); review it once its author calls report_done.`);
  const ctx = contextOf(wp, w);
  if (typeof ctx !== 'string' && ctx.head !== w.pr.headSha) {
    const r = await onReview(wp, itemId, 'workplace');
    if (r.carried) return rawGet(wp, itemId)!;
    throw new Conflict(`A new commit resets both approvals: ${ctx.branch} has a new commit (${ctx.head.slice(0, 8)}), so review the new head and call review_approve again (developer approver first, then QA).`);
  }
  return w;
}

export interface ApproveResult { stage: 'dev' | 'extra' | 'qa' | 'done'; message: string }

/** Where a QA doc's relative evidence paths may live: the evidence folder and the author's worktree. */
function proofRoots(wp: Workplace, w: WorkItem): string[] {
  const author = w.employeeId ? employeeOf(wp, w.employeeId) : undefined;
  return [qaDoc.evidenceDir(wp), ...(author ? [authorWorktree(wp, author)] : [])];
}

/** Approval 1 of 2 recorded (by the author's team, the CTO, or the COO for a CTO-authored story); names the one QA. */
async function giveDevApproval(wp: Workplace, w: WorkItem, approval: PrApproval): Promise<string> {
  const itemId = w.id;
  const by = approval.by;
  const pr = w.pr!;
  savePr(wp, itemId, c => ({ pr: { ...c.pr!, devApproval: approval, devReviewer: c.pr!.devReviewer ?? by } }));
  trail.record(wp, { itemId, by, kind: 'note', text: `Developer approval by ${nameOf(wp, by)} on ${pr.headSha.slice(0, 8)}${approval.note ? `: ${approval.note}` : ''}` });
  // One QA per story (owner, 10 Oct): named once, at the first developer approval, and kept, unless the
  // lock can never give approval 2: it is this developer approver (as_mv41lj93y5zzd, 19 Oct: Nikhil was QA
  // in round 1 and the developer approver in round 2) or is no longer QA.
  let qa = pr.qaReviewer;
  if (qa && (qa === by || qa === w.employeeId || !isQa(employeeOf(wp, qa)))) {
    trail.record(wp, { itemId, by: 'workplace', kind: 'note', text: `QA for this story was ${nameOf(wp, qa)}, who ${qa === by ? 'gave approval 1 of 2' : qa === w.employeeId ? 'is its author' : 'is not in QA'}: a new QA is named` });
    qa = undefined;
  }
  if (!qa) {
    const load: Record<string, number> = {};
    for (const i of items.list(wp, { status: 'in-review' })) if (i.reviewerId && i.id !== itemId) load[i.reviewerId] = (load[i.reviewerId] ?? 0) + 1;
    qa = qaReviewer(wp.org.employees, w, [by], load);
    if (qa) savePr(wp, itemId, c => ({ pr: { ...c.pr!, qaReviewer: qa } }));
  }
  if (qa && qa !== w.reviewerId) items.update(wp, itemId, { reviewerId: qa, note: 'system: developer approval given; QA reviews next' }, 'workplace');
  reviewWake.onItem(wp, itemId);   // the turn moved on: extra reviewers, then QA
  try { await postStatuses(wp, itemId); } catch (err) { recordFailure(wp, 'status', itemId, Date.now(), errText(err)); }
  const left = pendingExtra(rawGet(wp, itemId)!);
  return `Developer approval recorded (approval 1 of 2) on ${pr.headSha.slice(0, 8)}. ${left.length ? `${left.map(e => nameOf(wp, e.id)).join(', ')} approve their files, then ` : ''}QA reviews next${qa ? ` (${nameOf(wp, qa)})` : ''} for approval 2 of 2. A commit that only merges the trunk keeps it; any other new commit resets both approvals.`;
}

/**
 * A story with no pull request on purpose (dry run #11, 10 Oct): non-code work, or work in another repo
 * (the iris-alpha site). Its branch has no commits past the trunk and no push was refused, so no PR is
 * coming; a story with commits but no PR yet (the push failed or was refused) is not one.
 */
export function noPullRequest(wp: Workplace, w: WorkItem): boolean {
  return !w.pr && !w.prRefused && levelOf(w) !== 'epic' && typeof contextOf(wp, w) === 'string';
}

/** The current reviewer passes a no-PR story: done, with their note (what they checked) on the story. */
function passWithoutPr(wp: Workplace, w: WorkItem, by: string, note: string | undefined): ApproveResult {
  if (w.status !== 'in-review') throw new BadRequest(`This story is not in review (it is ${w.status}); review it once its author moves it to review with you as the reviewer.`);
  if (by !== w.reviewerId) throw new BadRequest(`${nameOf(wp, w.reviewerId)} is this story's reviewer, so they pass it; add your view with item_comment.`);
  const why = note?.trim() ?? '';
  if (why.length < 3) throw new BadRequest('Passing a story with no pull request needs your note: what you checked and why it is done (it goes on the story).');
  items.update(wp, w.id, { status: 'done', note: `Passed without a pull request by ${nameOf(wp, by)}: ${why}` }, by);
  return { stage: 'done', message: 'Passed: this story has no pull request (no code on its branch), so your approval closes it. It is done, with your note on the story.' };
}

export interface ApproveOptions {
  /** The review_approve tool: QA's approval also needs the evidence opened since it last changed (dry run #7). */
  requireReads?: boolean;
}

export async function approve(wp: Workplace, itemId: string, by: string, note?: string, qaText?: string, opts: ApproveOptions = {}): Promise<ApproveResult> {
  const w0 = rawGet(wp, itemId);
  if (w0 && noPullRequest(wp, w0)) return passWithoutPr(wp, w0, by, note);
  if (mode(wp) === 'local') throw new BadRequest(LOCAL_REVIEW);
  const w = await reviewable(wp, itemId);
  const pr = w.pr!;
  const author = w.employeeId;
  const employees = wp.org.employees;
  if (by === author) throw new BadRequest('You are the author, so you never approve your own story; a member of your team gives approval 1 of 2, then QA gives approval 2 of 2.');
  const who = employeeOf(wp, by);
  const approval: PrApproval = { by, at: now(), sha: pr.headSha, episode: w.statusSince ?? '', ...(note?.trim() ? { note: note.trim() } : {}) };

  // An extra reviewer (another team's lead whose charter's code the diff changes) approves their files.
  const mine = (pr.extraReviewers ?? []).find(e => e.id === by);
  if (mine && pendingExtra(w).some(e => e.id === by)) {
    savePr(wp, itemId, c => ({ pr: { ...c.pr!, extraReviewers: (c.pr!.extraReviewers ?? []).map(e => (e.id === by ? { ...e, approvedAt: approval.at, sha: pr.headSha, episode: approval.episode } : e)) } }));
    trail.record(wp, { itemId, by, kind: 'note', text: `Extra review: ${nameOf(wp, by)} approved their files on ${pr.headSha.slice(0, 8)}${mine.files.length ? ` (${mine.files.join(', ')})` : ''}${approval.note ? `: ${approval.note}` : ''}` });
    const left = pendingExtra(rawGet(wp, itemId)!);
    reviewWake.onItem(wp, itemId);   // the last one in: QA's turn (board bug 3)
    return { stage: 'extra', message: `Your approval of your files is recorded on ${pr.headSha.slice(0, 8)}.${left.length ? ` QA still waits for ${left.map(e => nameOf(wp, e.id)).join(', ')}.` : ' QA reviews once the developer approval is in.'} Any new commit of the author's resets it.` };
  }

  if (!holds(pr.devApproval, w)) {
    if (!canApproveAsDeveloper(employees, by, author)) {
      if (isQa(who)) throw new BadRequest('QA reviews after a developer approval; ask the author\'s team to review first.');
      const lead = author ? teamOf(wp.org, author) : undefined;
      const team = (lead ? teamMembers(wp.org, lead) : []).filter(id => id !== author && !employees.find(e => e.id === id)?.virtual).map(id => nameOf(wp, id));
      throw new BadRequest(`${nameOf(wp, by)} is not in ${nameOf(wp, author)}'s team, and approval 1 of 2 comes from the developer approver (a member of the author's team who is not the author${team.length ? `: ${team.join(' or ')}` : ''}, or the CTO).${mine ? ' Your own approval as an extra reviewer is already recorded.' : ''}`);
    }
    const message = await giveDevApproval(wp, w, approval);
    return { stage: 'dev', message };
  }

  if (!isQa(who)) throw new BadRequest(`It already has the developer approval (1 of 2), and approval 2 of 2 is QA's (${pr.qaReviewer ? nameOf(wp, pr.qaReviewer) : qaNames(wp)}); leave it to QA.`);
  if (by === pr.devApproval!.by) throw new BadRequest('You gave approval 1 of 2, so approval 2 of 2 must come from another person in QA; leave it to them.');
  const qa = qaOf(w);
  if (qa && qa !== by) throw new BadRequest(`${nameOf(wp, qa)} is this story's QA, and one QA sees a story through: leave approval 2 of 2 to them. Asha can change the QA with item_update reviewerId and a reason.`);
  const waiting = pendingExtra(w);
  if (waiting.length) throw new BadRequest(`Waiting for ${waiting.map(e => nameOf(wp, e.id)).join(', ')} to approve their files: QA approves after every extra reviewer.`);
  // Dry run #7 (10 Oct): QA approved before opening the developer's evidence. Through the tool, QA's
  // approval needs the story (and its doc) read since they last changed.
  if (opts.requireReads) {
    const unread = unreadEvidence(wp, w, by);
    if (unread.length) throw new BadRequest(`Open the evidence first: since it last changed you have not read ${unread.join(' or ')}. Read each, cite the specific lines you checked in the QA doc, then approve.`);
  }
  // Owner's review flow step 2 (6 Oct): no QA approval without the edge-case doc and its report; each case cites its proof (10 Oct).
  // Without the text, the story's QA doc already filed (its Notion page, else the file) is checked the same way (18 Oct).
  if (!qaText?.trim()) qaText = await storedQaText(wp, w);
  const doc = qaDoc.require$(qaText, proofRoots(wp, w));
  if (opts.requireReads && !fileOnlyQaDoc(wp, w)) qaDoc.requireUsers(qaText!);
  qaDocExtras(wp, w, doc, qaText!);
  // 11 Oct: approved stories sat unmerged for hours because the QA doc named no evidence. Through the tool,
  // approval 2 is the moment the evidence question is answered, so approval means ready to merge.
  if (opts.requireReads && !(pr.evidence === 'success' || qaDoc.evidenceNa(qaText) || liveCheckEvidence(wp, w, qaText))) {
    throw new BadRequest('Name the evidence before approving, or the merge will wait: a passing run_evidence on the head, OR "Evidence: live check <lc_id>" for a live check the developer recorded (record_live_check), OR, only for a change the robot suite cannot run (server-only, agent-svc, docs, tooling), "Evidence: n/a — <why>" plus a "Tests: <command> <counts>" line.');
  }
  const filedDoc = await fileQaDoc(wp, itemId, by, pr.headSha, approval.at, qaText!);
  savePr(wp, itemId, c => ({ pr: { ...c.pr!, qaApproval: approval, qaReviewer: by } }));
  trail.record(wp, { itemId, by, kind: 'note', text: `QA approval by ${nameOf(wp, by)} on ${pr.headSha.slice(0, 8)} with a QA doc of ${doc.cases.length} edge cases (${filedDoc.where})${approval.note ? `: ${approval.note}` : ''}`, ...(filedDoc.url ? { link: filedDoc.url } : {}) });
  try { await postStatuses(wp, itemId); } catch (err) { recordFailure(wp, 'status', itemId, Date.now(), errText(err)); }
  items.update(wp, itemId, { status: 'done', reviewerId: by, note: `Approved by ${nameOf(wp, pr.devApproval!.by)} (developer) and ${nameOf(wp, by)} (QA)` }, by, { checked: true });
  const auto = await autoMerge(wp, itemId);
  return { stage: 'qa', message: `QA approval recorded (approval 2 of 2); the story is done. ${mergeTail(auto)}${filedDoc.url ? ` QA doc: ${filedDoc.url}` : ''}${filedDoc.note}` };
}

/** What the automatic merge did, in one sentence for the approver. */
function mergeTail(auto: AutoMergeOutcome): string {
  return auto === 'merged' ? 'The Workplace merged it into the trunk.'
    : auto === 'waiting' ? 'The Workplace merges it itself once the tests and evidence checks are green (or the QA doc cites a recorded live check, or says "Evidence: n/a"): approved is not merged.'
    : auto === 'held' ? 'It changes CI or infrastructure, so it merges once the COO approves the spend: approved is not merged.'
    : auto === 'blocked' ? 'The automatic merge was stopped and the COO is alerted: approved is not merged.'
    : 'The COO merges it once the tests check is green: approved is not merged.';
}

/**
 * What QA has not read since it last changed (dry run #7): the story (item_read) since the review began
 * or the developer's evidence last changed (a robot run, a live check), and its doc (doc_read) since
 * someone else last wrote it. Empty when everything is read.
 */
export function unreadEvidence(wp: Workplace, w: WorkItem, by: string): string[] {
  const reads = qaDoc.readsOf(wp, w.id, by);
  const latest = (xs: (string | undefined)[]): string => xs.filter((x): x is string => !!x).sort().pop() ?? '';
  const itemSince = latest([w.statusSince, w.evidenceRun?.at, ...(w.liveChecks ?? []).map(l => l.at)]);
  const docSince = latest(trail.activityFor(wp, w.id).filter(a => a.kind === 'doc' && a.by !== by).map(a => a.at));
  const out: string[] = [];
  if (!reads.item || reads.item < itemSince) out.push(`the story (item_read ${w.id})`);
  if (w.docId && docSince && (!reads.doc || reads.doc < docSince)) out.push(`its doc (doc_read ${w.id})`);
  return out;
}

/**
 * The QA doc's checks beyond its shape: every blind case answered (dry run #8), and every live check it
 * cites as evidence recorded on this story, on this head, with its logs still there (dry run #5).
 */
function qaDocExtras(wp: Workplace, w: WorkItem, doc: qaDoc.QaDoc, text: string): void {
  const blind = w.qaCases?.titles ?? [];
  const missing = qaDoc.unansweredBlind(blind, doc.cases);
  if (missing.length) throw new BadRequest(`The QA doc does not answer every blind case: add a "- PASS/FAIL/N/A: <case> — …" line for ${missing.map(t => `"${t}"`).join(', ')}.`);
  for (const id of qaDoc.citedLiveChecks(text)) {
    const lc = (w.liveChecks ?? []).find(l => l.id === id);
    if (!lc) throw new BadRequest(`The QA doc cites live check ${id}, which is not recorded on this story: the developer records it with record_live_check (item_read lists them).`);
    if (lc.sha !== w.pr?.headSha) throw new BadRequest(`Live check ${id} was recorded on an older commit (${lc.sha.slice(0, 8)}, the head is ${(w.pr?.headSha ?? '').slice(0, 8)}): the developer runs it again on this commit.`);
    const gone = lc.logPaths.filter(f => !existsSync(f));
    if (gone.length) throw new BadRequest(`Live check ${id}'s logs are gone (${gone.join(', ')}), so it is not evidence any more.`);
  }
}

/** A live check cited by the filed QA doc, on the PR's head, with its logs: evidence for the merge (dry run #5). */
function liveCheckEvidence(wp: Workplace, w: WorkItem, filedDoc: string | undefined): boolean {
  const head = w.pr?.headSha;
  if (!head) return false;
  return qaDoc.citedLiveChecks(filedDoc).some(id => {
    const lc = (w.liveChecks ?? []).find(l => l.id === id);
    return !!lc && lc.sha === head && lc.logPaths.length > 0 && lc.logPaths.every(f => existsSync(f));
  });
}

/** Both approvals are the COO's: a CTO-authored docs-only PR (dry run #12), which needs no QA doc or robot evidence. */
const cooDocsApproval = (w: WorkItem): boolean => w.pr?.devApproval?.by === 'coo' && w.pr?.qaApproval?.by === 'coo';

/**
 * QA amends its filed doc while the story is done but not merged (dry run #5: the merge held on a doc
 * that lacked "Evidence: n/a" and QA could not fix it). Only the QA who gave approval 2, while it still
 * holds; the doc is checked like at approval, refiled, and the merge gate runs again.
 */
export async function amendQaDoc(wp: Workplace, itemId: string, by: string, text: string): Promise<{ merge: AutoMergeOutcome; message: string }> {
  if (mode(wp) === 'local') throw new BadRequest(LOCAL_REVIEW);
  const w = rawGet(wp, itemId);
  if (!w) throw new NotFound(`No item ${itemId}`);
  const pr = w.pr;
  if (!pr) throw new BadRequest('This story has no pull request, so it has no QA doc to amend.');
  if (pr.merged) throw new BadRequest(`PR #${pr.number} is already merged: the QA doc is final.`);
  if (w.status !== 'done' || !pr.qaApproval || !holds(pr.qaApproval, w)) throw new BadRequest(`This story is not done with a QA approval that holds (it is ${w.status}): while it is in review, give the doc with review_approve qaDoc.`);
  if (by !== pr.qaApproval.by) throw new BadRequest(`${nameOf(wp, pr.qaApproval.by)} gave approval 2 of 2, so only they amend its QA doc.`);
  const doc = qaDoc.require$(text, proofRoots(wp, w));
  if (!fileOnlyQaDoc(wp, w)) qaDoc.requireUsers(text);
  qaDocExtras(wp, w, doc, text);
  const filedDoc = await fileQaDoc(wp, itemId, by, pr.headSha, now(), text);
  trail.record(wp, { itemId, by, kind: 'note', text: `QA doc amended by ${nameOf(wp, by)} on ${pr.headSha.slice(0, 8)}: ${doc.cases.length} edge cases (${filedDoc.where})`, ...(filedDoc.url ? { link: filedDoc.url } : {}) });
  // The merge gate runs again on the amended doc; a stop recorded for this head (the evidence) is lifted first.
  dropSetting(wp, AUTO_BLOCKED_PREFIX + itemId);
  const merge = await autoMerge(wp, itemId);
  return { merge, message: `QA doc updated (${doc.cases.length} edge cases). ${mergeTail(merge)}${filedDoc.url ? ` QA doc: ${filedDoc.url}` : ''}${filedDoc.note}` };
}

/**
 * File QA's doc (owner, 18 Oct): in Notion, where the owner reads and comments (docs.writeQaDocPage), and
 * always in the local file, which the merge gate and the staging cycle read and which stands in when
 * Notion is down (a warning, never a refused approval). A story whose QA doc was a file before the move
 * (a file and no qaDoc record) keeps the file only: existing QA docs are not migrated.
 */
/** The story's QA doc predates Notion (a file, no qaDoc record): it stays a file, in the old format. */
const fileOnlyQaDoc = (wp: Workplace, w: WorkItem): boolean => !w.qaDoc && qaDoc.filed(wp, w.id) !== undefined;

async function fileQaDoc(wp: Workplace, itemId: string, by: string, sha: string, at: string, text: string): Promise<{ where: string; url?: string; note: string }> {
  const cur = rawGet(wp, itemId)!;
  const fileOnly = fileOnlyQaDoc(wp, cur);
  const path = qaDoc.file(wp, itemId, { title: cur.title, by, sha, at }, text);
  if (fileOnly) return { where: path, note: '' };
  let page: { id: string; url: string } | null = null;
  let note = '';
  let failed = false;
  try { page = await docs.writeQaDocPage(wp, by, cur, text, cur.qaDoc?.pageId); }
  catch (err) {
    failed = true;
    note = ` Notion was not written (${errText(err)}); the QA doc is kept on the server and the next QA doc write retries Notion.`;
    log.warn('github', `${itemId}: QA doc to Notion: ${errText(err)}; kept in ${path}`);
  }
  const latest = rawGet(wp, itemId)!;
  const pageId = page?.id ?? latest.qaDoc?.pageId;
  const url = page?.url ?? latest.qaDoc?.url;
  work.saveQuiet(wp, { ...latest, qaDoc: { by, at, sha, ...(pageId ? { pageId } : {}), ...(url ? { url } : {}), ...(failed && pageId ? { stale: true } : {}) } });
  return { where: page ? `${page.url}; cached in ${path}` : path, ...(url ? { url } : {}), note };
}

/** The story's QA doc as filed: its Notion page when that is current, else the local file (Notion down, or a pre-Notion doc). */
async function storedQaText(wp: Workplace, w: WorkItem): Promise<string | undefined> {
  const pageId = w.qaDoc?.pageId;
  if (pageId && !w.qaDoc!.stale) {
    try { return await docs.readQaDocPage(wp, pageId); }
    catch (err) { log.warn('github', `${w.id}: reading the QA doc from Notion: ${errText(err)}; using the local copy`); }
  }
  return qaDoc.filed(wp, w.id);
}

const LIVE_CHECKS_KEPT = 20;

/**
 * The developer records a live check (dry run #5): a Mac-queue run (real audio, the desktop app) with
 * the raw logs that show it, on the branch head. It is evidence for the merge only once QA's doc cites
 * it ("Evidence: live check <id>"), and only for the commit it was run on.
 */
export function recordLiveCheck(wp: Workplace, itemId: string, by: string, summary: string, logPaths: string[]): LiveCheck {
  const w = rawGet(wp, itemId);
  if (!w) throw new NotFound(`No item ${itemId}`);
  if (by !== w.employeeId) throw new BadRequest(`Only the story's author (${nameOf(wp, w.employeeId)}) records a live check on it; QA cites it in the QA doc.`);
  if (!summary?.trim()) throw new BadRequest('A live check needs its summary: what you ran and what the logs show.');
  if (!logPaths?.length) throw new BadRequest('A live check needs its raw logs: logPaths of the log files or screenshots (not retyped text).');
  const roots = proofRoots(wp, w);
  const resolved = logPaths.map(p => ({ p, at: /^[a-z]+:\/\//i.test(p.trim()) ? null : qaDoc.proofOf(`evidence: ${p.trim()}`, roots) }));
  const missing = resolved.filter(r => !r.at).map(r => r.p);
  if (missing.length) throw new BadRequest(`These logs do not exist: ${missing.join(', ')}. Attach the raw files (absolute, or relative to ~/iris-workplace/evidence or your worktree).`);
  const ctx = contextOf(wp, w);
  const sha = typeof ctx === 'string' ? w.pr?.headSha : ctx.head;
  if (!sha) throw new BadRequest('No commit to record it on: commit your change on the story branch first.');
  const lc: LiveCheck = { id: `lc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, by, at: now(), sha, summary: summary.trim(), logPaths: resolved.map(r => r.at!) };
  const cur = rawGet(wp, itemId)!;
  work.saveQuiet(wp, { ...cur, liveChecks: [...(cur.liveChecks ?? []), lc].slice(-LIVE_CHECKS_KEPT) });
  trail.record(wp, { itemId, by, kind: 'note', text: `Live check ${lc.id} by ${nameOf(wp, by)} on ${sha.slice(0, 8)}: ${lc.summary} (logs: ${lc.logPaths.join(', ')})` });
  return lc;
}

/**
 * QA's blind cases (dry run #8): written at the plan step, before the code, by QA only. Stored on the
 * item (never projected or shown to the assignee) and, when Notion is set up, as a separate "QA report"
 * page that is not the story's doc. Approval 2 must answer each one. Returns the tool's reply.
 */
export async function writeQaCases(wp: Workplace, itemId: string, by: string, markdown: string): Promise<string> {
  const w = rawGet(wp, itemId);
  if (!w) throw new NotFound(`No item ${itemId}`);
  if (!isQa(employeeOf(wp, by))) throw new BadRequest('Only QA writes blind cases: the developer never sees them.');
  if (by === w.employeeId) throw new BadRequest('You are the story\'s assignee: blind cases come from QA who does not build it.');
  const titles = qaDoc.blindTitles(markdown ?? '');
  if (!titles.length) throw new BadRequest('No cases found: write one case per line ("- <case> — <why it might break>").');
  let page: { id: string; url: string } | null = null;
  let notionNote = '';
  try { page = await docs.writeQaCasesPage(wp, by, w, markdown, w.qaCases?.docId); }
  catch (err) { notionNote = ` Notion was not written (${errText(err)}); the cases are kept on the story.`; log.warn('github', `${itemId}: blind QA cases to Notion: ${errText(err)}`); }
  const cur = rawGet(wp, itemId)!;
  const docId = page?.id ?? cur.qaCases?.docId;
  const docUrl = page?.url ?? cur.qaCases?.docUrl;
  work.saveQuiet(wp, { ...cur, qaCases: { markdown, titles, by, at: now(), ...(docId ? { docId } : {}), ...(docUrl ? { docUrl } : {}) } });
  // The trail says that they exist, never what they are: the assignee reads the trail.
  trail.record(wp, { itemId, by, kind: 'note', text: `${nameOf(wp, by)} wrote ${titles.length} blind QA case${titles.length === 1 ? '' : 's'} (hidden from the assignee)` });
  return `Wrote ${titles.length} blind case${titles.length === 1 ? '' : 's'} on ${itemId}${page ? ` (${page.url}, not linked on the story)` : ''}. Your approval (2 of 2) must answer each with a PASS, FAIL or N/A line.${notionNote}`;
}

/**
 * The COO's developer approval of a CTO-authored PR (dry run #12, POST /api/coo/review-approve): the CTO
 * has no team, and the author never approves their own, so the COO (who reconciles the tech and product
 * docs) gives approval 1 of 2 on the CTO's stories, and only those. QA's approval 2 is still needed,
 * unless the PR changes only docs (*.md, docs/**): then the COO's approval alone is enough to merge.
 */
export async function cooReviewApprove(wp: Workplace, itemId: string, note: string): Promise<{ stage: 'dev' | 'approved'; message: string; merge?: AutoMergeOutcome }> {
  if (mode(wp) === 'local') throw new BadRequest(LOCAL_REVIEW);
  const pre = rawGet(wp, itemId);
  if (!pre) throw new NotFound(`No item ${itemId}`);
  if (!isCto(employeeOf(wp, pre.employeeId ?? ''))) throw new BadRequest(`The COO's review approval is only for stories the CTO authored (he has no team to give approval 1 of 2); ${nameOf(wp, pre.employeeId)}'s story is approved by their own team.`);
  if (!note?.trim()) throw new BadRequest('The approval needs a note: what you checked.');
  const w = await reviewable(wp, itemId);
  const pr = w.pr!;
  if (holds(pr.devApproval, w)) throw new BadRequest(`This story already has the developer approval (1 of 2, ${nameOf(wp, pr.devApproval!.by)}); QA gives approval 2 of 2.`);
  const approval: PrApproval = { by: 'coo', at: now(), sha: pr.headSha, episode: w.statusSince ?? '', note: note.trim() };
  const ctx = contextOf(wp, w);
  let files: string[] = [];
  try { if (typeof ctx !== 'string') files = changedFiles(ctx.repo, ctx.base, pr.headSha); } catch { files = []; }
  const docsOnly = files.length > 0 && files.every(notCode);
  if (!docsOnly) {
    const message = await giveDevApproval(wp, w, approval);
    return { stage: 'dev', message };
  }
  savePr(wp, itemId, c => ({ pr: { ...c.pr!, devApproval: approval, qaApproval: approval, devReviewer: 'coo' } }));
  trail.record(wp, { itemId, by: 'coo', kind: 'note', text: `COO approval on ${pr.headSha.slice(0, 8)} of the CTO's docs-only change (${files.length} file${files.length === 1 ? '' : 's'}); no QA approval needed: ${approval.note}` });
  try { await postStatuses(wp, itemId); } catch (err) { recordFailure(wp, 'status', itemId, Date.now(), errText(err)); }
  items.update(wp, itemId, { status: 'done', reviewerId: 'coo', note: `Approved by the COO (a docs-only change by the CTO): ${approval.note}` }, 'coo', { checked: true });
  const merge = await autoMerge(wp, itemId);
  return { stage: 'approved', merge, message: `COO approval recorded: a docs-only change, so it is done without QA. ${mergeTail(merge)}` };
}

export async function sendBack(wp: Workplace, itemId: string, by: string, note: string): Promise<WorkItem> {
  if (mode(wp) === 'local') throw new BadRequest(LOCAL_REVIEW);
  if (!note?.trim()) throw new BadRequest('A send-back needs the reason: say exactly what to change (QA: the root cause, what failed and why).');
  const w = rawGet(wp, itemId);
  if (!w) throw new NotFound(`No item ${itemId}`);
  if (!w.pr) throw new BadRequest('This story has no pull request, so send it back with item_update (status in-progress, with what to change).');
  if (by === w.employeeId) throw new BadRequest('You are the author: only a reviewer (the developer approver or QA) sends a story back.');
  const who = employeeOf(wp, by);
  const developer = canApproveAsDeveloper(wp.org.employees, by, w.employeeId);
  const extraReviewer = (w.pr.extraReviewers ?? []).some(e => e.id === by);
  if (!developer && !extraReviewer && !isQa(who)) throw new BadRequest(`${nameOf(wp, by)} is not a reviewer: only the developer approver (a member of the author's team, or the CTO), an extra reviewer or QA sends a story back; add your view with item_comment instead.`);
  if (w.status !== 'in-review') throw new BadRequest(`This story is not in review (it is ${w.status}), so there is nothing to send back.`);
  if (!developer && !extraReviewer && !holds(w.pr.devApproval, w)) throw new BadRequest(QA_WAIT);
  savePr(wp, itemId, c => ({ pr: { ...c.pr!, sendBack: { by, at: now(), note: note.trim() } } }));
  items.update(wp, itemId, { status: 'in-progress', note: `Sent back by ${nameOf(wp, by)}: ${note.trim()}` }, by, { checked: true });
  tellAuthor(wp, itemId, by, note.trim());
  try { await postStatuses(wp, itemId); } catch (err) { recordFailure(wp, 'status', itemId, Date.now(), errText(err)); }
  return rawGet(wp, itemId)!;
}

/** What the author is told on a send-back. */
export function sendBackText(wp: Workplace, w: WorkItem, by: string, note: string): string {
  return `Sent back by ${nameOf(wp, by)}: Story ${w.id} "${w.title}" is In progress again. ${nameOf(wp, by)} says: ${note} ` +
    `Fix it on branch emp/${w.employeeId}/${w.id}, commit, run scripts/pre-pr.sh and run_evidence on the new commit, then report_done. ` +
    'Disagree with a QA send-back? review_dispute once, with your reason.';
}

/**
 * The author hears of a send-back at once (dry run #20: Tara sat idle for 6 minutes): a message into
 * their open session, whatever it is doing (a running turn gets it next), else a session on the
 * story. A refusal to start (floor paused, capped) is noted on the story; the note is there anyway.
 */
function tellAuthor(wp: Workplace, itemId: string, by: string, note: string): void {
  const w = rawGet(wp, itemId);
  const author = w?.employeeId;
  if (!w || !author || !isAgent(wp, author)) return;
  const text = sendBackText(wp, w, by, note);
  try {
    const open = employees.openSession(author);
    if (open && employees.redirectTo(wp, itemId, text)) {
      trail.record(wp, { itemId, by: 'workplace', kind: 'note', text: `Send-back delivered to ${nameOf(wp, author)}: their open session is switched back to this story` });
    } else if (open) {
      runs.sendMessage(open.agentId, text, [], { from: 'workplace' });
      trail.record(wp, { itemId, by: 'workplace', kind: 'note', text: `Send-back delivered to ${nameOf(wp, author)} in the open session` });
    } else {
      employees.spawn(wp, author, { assignment: w, prompt: text });
      trail.record(wp, { itemId, by: 'workplace', kind: 'note', text: `Send-back delivered to ${nameOf(wp, author)}: a session started` });
    }
    log.info('github', `${itemId}: send-back delivered to ${author}`);
  } catch (err) {
    trail.record(wp, { itemId, by: 'workplace', kind: 'note', text: `${nameOf(wp, author)} could not be woken for the send-back: ${errText(err)}` });
    log.warn('github', `${itemId}: send-back not delivered to ${author}: ${errText(err)}`);
  }
}

/** The author disputes a QA send-back: Asha first, the COO if she does not act, then the owner. */
export async function dispute(wp: Workplace, itemId: string, by: string, reason: string): Promise<void> {
  if (mode(wp) === 'local') throw new BadRequest(LOCAL_REVIEW);
  const w = rawGet(wp, itemId);
  if (!w) throw new NotFound(`No item ${itemId}`);
  const sb = w.pr?.sendBack;
  if (!sb) throw new BadRequest('There is no QA send-back on this story to dispute; review_dispute is only for a QA send-back.');
  if (!isQa(employeeOf(wp, sb.by))) throw new BadRequest(`The send-back came from ${nameOf(wp, sb.by)}, the developer approver, not QA; talk it through with them on the item with item_comment.`);
  if (by !== w.employeeId) throw new BadRequest(`Only the author (${nameOf(wp, w.employeeId)}) disputes a send-back; add your view on the item with item_comment.`);
  if (sb.disputedAt) throw new BadRequest('You already disputed this send-back; Asha decides (then the COO, then the owner), so wait for the answer on the item.');
  if (!reason?.trim()) throw new BadRequest('A dispute needs your reason in one or two sentences.');
  manager.alert(wp, {
    key: `dispute:${itemId}:${sb.at}`, itemId, by,
    title: `Disputed QA send-back: ${w.title}`,
    body: `${nameOf(wp, by)} disputes ${nameOf(wp, sb.by)}'s send-back ("${sb.note}"): ${reason.trim()}`,
    text: `Disputed QA send-back on "${w.title}" [${itemId}]: ${nameOf(wp, by)} disputes ${nameOf(wp, sb.by)}'s send-back ("${sb.note}") because: ${reason.trim()}. ` +
      'You decide it first: keep the send-back, or have QA review again, and say so with item_comment. If you cannot decide, escalate to the COO with both sides in two lines; the COO decides or takes it to the owner.',
  });
  savePr(wp, itemId, c => ({ pr: { ...c.pr!, sendBack: { ...c.pr!.sendBack!, disputedAt: now() } } }));
  trail.record(wp, { itemId, by, kind: 'note', text: `Disputed ${nameOf(wp, sb.by)}'s send-back: ${reason.trim()}` });
}

/* ---------- the sweep ---------- */

/**
 * In review with a PR and a moved head: re-pushed (a real commit resets the approvals; a trunk-only
 * merge keeps them). A PR whose branch is behind the trunk is brought up to date through GitHub's
 * update-branch (rework W3), so a story never has to be resubmitted only to catch up. Returns the moved ids.
 */
export async function syncHeads(wp: Workplace): Promise<string[]> {
  if (mode(wp) === 'local') return [];
  const moved: string[] = [];
  const rows = (wp.db.prepare("select json from work where status in ('in-review', 'done')").all() as { json: string }[]).map(r => JSON.parse(r.json) as WorkItem);
  for (const row of rows) {
    // Re-read: an earlier story's turn in this sweep can take minutes (its tests), and a review may
    // have finished meanwhile (PR #374: update-branch ran on a snapshot taken before QA approved).
    const w = rawGet(wp, row.id);
    if (!w) continue;
    if (w.status === 'done') {
      // Approved, waiting to merge: only a trunk-only move of its head is picked up (onReview carries it).
      if (!w.pr || w.pr.merged) continue;
      const ctx = contextOf(wp, w);
      if (typeof ctx !== 'string' && ctx.head !== w.pr.headSha && (await onReview(wp, w.id, 'workplace')).carried) moved.push(w.id);
      continue;
    }
    if (w.status !== 'in-review') continue;
    if (!w.pr) {
      // The first push failed (GitHub down): try again, unless that head was refused on policy.
      const ctx = contextOf(wp, w);
      if (typeof ctx !== 'string' && w.prRefused?.sha !== ctx.head) await onReview(wp, w.id, 'workplace');
      continue;
    }
    if (w.pr.merged) continue;
    const ctx = contextOf(wp, w);
    if (typeof ctx === 'string') continue;
    if (ctx.head !== w.pr.headSha) {
      // The sweep finishes one story before the next: its tests (and any mobile-checks dispatch) included.
      await (await onReview(wp, w.id, 'workplace')).tests;
      moved.push(w.id);
      continue;
    }
    // A PR closed without a merge is not caught up with the trunk: GitHub refuses update-branch on it, which
    // read as a conflict and sent the story back (18 Oct, as_mvdf2ivfmuhtz, PR #448 closed: twice).
    if (w.pr.closed) continue;
    refreshExtraReviewers(wp, w, ctx);
    await catchUp(wp, w, ctx);
    // Mobile checks running on GitHub for this head (cloud migration, 17 Oct): follow the run.
    await followMobileCi(wp, w.id);
  }
  // A run is followed whatever the story's status (PR #400: sent back to building, then blocked).
  const others = (wp.db.prepare("select id from work where status not in ('in-review') and json like '%\"mobileCi\"%'").all() as { id: string }[]);
  for (const { id } of others) await followMobileCi(wp, id);
  try { pendingTestsAlarm(wp); } catch (err) { log.warn('github', `pending tests alarm: ${errText(err)}`); }
  return moved;
}

/** A workplace/tests pending this long is told (board bug 4, 19 Oct: 8 hours pending, nobody told). */
export const TESTS_PENDING_ALERT_MS = 60 * 60_000;

/**
 * No pending status is terminal: a story whose workplace/tests has been pending on its head for an hour
 * gets one alert to Asha per pending episode (manager.alert: the COO hears if she does not act in 15 min),
 * saying why it pends and who does what. Returns the items told.
 */
export function pendingTestsAlarm(wp: Workplace, nowMs = Date.now()): string[] {
  if (mode(wp) === 'local') return [];
  const out: string[] = [];
  for (const w of rowsJson<WorkItem>(wp.db.prepare("select json from work where status in ('in-review', 'done') and json_extract(json, '$.pr.tests.state') = 'pending'").all())) {
    const pr = w.pr;
    const t = pr?.tests;
    if (!pr || !t || pr.merged || pr.closed || t.sha !== pr.headSha) continue;
    const since = t.pendingSince ?? t.at;
    const age = nowMs - Date.parse(since);
    if (!(age >= TESTS_PENDING_ALERT_MS)) continue;
    const key = `tests-pending:${w.id}:${since}`;
    if (manager.list(wp).some(r => r.key === key)) continue;
    const author = nameOf(wp, w.employeeId);
    const what = t.summary.startsWith('Waiting for scripts/pre-pr.sh')
      ? `${author} runs scripts/pre-pr.sh on the head ${pr.headSha.slice(0, 8)} (no result covers it) and calls report_done`
      : t.summary.startsWith(spendCaps.GITHUB_PAUSED)
        ? 'it waits on the GitHub daily cap: it starts by itself when the cap lifts; ask the COO to lift it if the story cannot wait'
        : `check the mobile checks run${pr.mobileCi?.runUrl ? ` (${pr.mobileCi.runUrl})` : ''} on GitHub, or ask the COO`;
    const text = `workplace/tests has been pending for ${humanDuration(age)} on ${pr.headSha.slice(0, 8)} of "${w.title}" (PR #${pr.number}): ${t.summary}. Next: ${what}.`;
    trail.record(wp, { itemId: w.id, by: 'workplace', kind: 'note', text });
    manager.alert(wp, { key, itemId: w.id, title: `Tests pending ${humanDuration(age)}: ${w.title}`, body: text, text }, nowMs);
    out.push(w.id);
  }
  return out;
}

const UPDATE_BRANCH_PREFIX = 'github:update-branch:';
const UPDATE_BRANCH_AT_PREFIX = 'github:update-branch-at:';
/** At most one automatic catch-up per branch per this long (19 Oct: ~10 per story in 50 minutes starved pre-pr). */
export const CATCH_UP_MIN_GAP_MS = 30 * 60_000;

/** Files changed on `ref` since its merge-base with the trunk. */
function changedSinceBase(repo: string, trunk: string, ref: string): Set<string> {
  try {
    const mb = git(repo, ['merge-base', trunk, ref]).trim();
    return new Set(git(repo, ['diff', '--name-only', mb, ref]).split('\n').map(x => x.trim()).filter(Boolean));
  } catch { return new Set(); }
}

/**
 * The trunk moved past the PR's base: ask GitHub to merge the trunk into the branch (once per trunk
 * commit), then fast-forward the author's worktree to it. The next sweep sees a trunk-only merge, which
 * keeps the approvals. A conflict (GitHub's 422) goes back to the author, as an auto-merge conflict does.
 */
async function catchUp(wp: Workplace, w: WorkItem, ctx: Ctx): Promise<void> {
  const pr = w.pr!;
  const trunk = revParse(ctx.repo, `refs/heads/${ctx.base}`);
  if (!trunk || isAncestor(ctx.repo, trunk, ctx.head)) return;
  const key = UPDATE_BRANCH_PREFIX + w.id;
  if (getSetting(wp, key) === `${ctx.head}|${trunk}`) return;
  const atKey = UPDATE_BRANCH_AT_PREFIX + w.id;
  const last = Number(getSetting(wp, atKey) ?? 0);
  if (last && Date.now() - last < CATCH_UP_MIN_GAP_MS) return;
  // pre-pr is running on this head: a catch-up would move the head and reset it, unless the trunk change touches
  // files this branch touches (then the sooner the conflict shows, the better).
  const t = pr.tests;
  if (t && t.state === 'pending' && t.sha === ctx.head) {
    const mine = changedSinceBase(ctx.repo, trunk, ctx.head);
    const theirs = changedSinceBase(ctx.repo, ctx.head, trunk);
    if (![...theirs].some(f => mine.has(f))) return;
  }
  const port = gitHubPort(wp);
  putSetting(wp, key, `${ctx.head}|${trunk}`);
  try {
    const gh = await port.getPr(pr.number);
    if (gh.state === 'closed' && !gh.merged) {
      savePr(wp, w.id, c => (c.pr ? { pr: { ...c.pr, closed: { at: now(), by: 'github', reason: 'closed on GitHub without a merge' } } } : {}));
      return;
    }
  } catch { /* GitHub unreachable: the update below reports it */ }
  // GitHub's own view: when the branch is not behind there, local trunk refs (which may hold commits GitHub
  // never saw) must not trigger an update, which would only mint a fresh head each time.
  try { if (await port.behindBy(pr.base, pr.branch) === 0) return; } catch { /* unknown: carry on */ }
  putSetting(wp, atKey, String(Date.now()));
  let res: { updated: boolean; conflict?: boolean };
  try { res = await port.updateBranch(pr.number, pr.headSha); } catch (err) {
    recordFailure(wp, 'update branch', w.id, Date.now(), errText(err));
    return;
  }
  if (res.conflict) {
    trail.record(wp, { itemId: w.id, by: 'workplace', kind: 'note', text: `GitHub could not bring ${pr.branch} up to date with ${pr.base}: it conflicts` });
    reopenForConflict(wp, rawGet(wp, w.id) ?? w, 'GitHub could not bring it up to date with the trunk');
    return;
  }
  if (!res.updated) return;
  trail.record(wp, { itemId: w.id, by: 'workplace', kind: 'note', text: `GitHub merged ${pr.base} into ${pr.branch} (update-branch); the trunk-only merge keeps the approvals` });
  // The local branch follows GitHub: in the author's worktree when it has the branch checked out (a
  // fast-forward pull), else the ref alone (a fetch; the author has moved on to another story). Never forced.
  const wt = authorWorktree(wp, ctx.emp);
  let on = '';
  try { on = git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(); } catch { /* no worktree */ }
  try {
    if (on === ctx.branch) await port.pullFfOnly(wt, ctx.branch);
    else await port.fetchBranch(ctx.repo, ctx.branch);
  } catch (err) {
    trail.record(wp, { itemId: w.id, by: 'workplace', kind: 'note', text: `${ctx.branch} could not follow GitHub's update locally (${errText(err)}); the next push may be refused until it does` });
    log.warn('github', `${w.id}: local branch not fast-forwarded after update-branch: ${errText(err)}`);
  }
}

/** Every minute while not local: the sweep. Returns stop(). */
export function startGitHubFlow(wp: Workplace): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy || mode(wp) === 'local') return;
    busy = true;
    syncHeads(wp).catch(err => log.warn('github', `sweep: ${errText(err)}`))
      .then(() => autoMergeSweep(wp)).catch(err => log.warn('github', `auto-merge sweep: ${errText(err)}`))
      .finally(() => { busy = false; });
  }, MIN);
  timer.unref?.();
  return () => clearInterval(timer);
}

/* ---------- the merge (the COO's) ---------- */

export interface MergeResult {
  mode: GitHubMode;
  merged: boolean;
  wouldMerge?: boolean;
  blockers?: string[];
  sha?: string;
  synced?: boolean;
  syncError?: string;
}

export async function merge(wp: Workplace, itemId: string, by: string): Promise<MergeResult> {
  const m = mode(wp);
  if (m === 'local') throw new BadRequest('The GitHub flow is local: merge by hand as before (POST /api/coo/github changes the mode).');
  const w0 = rawGet(wp, itemId);
  if (!w0) throw new NotFound(`No item ${itemId}`);
  if (!w0.pr) throw new BadRequest(`${itemId} has no pull request.`);
  if (w0.pr.merged) throw new Conflict(`${itemId} is already merged (PR #${w0.pr.number}).`);

  const blockers: string[] = [];
  const ctx0 = contextOf(wp, w0);
  if (typeof ctx0 !== 'string' && ctx0.head !== w0.pr.headSha) {
    const r = await onReview(wp, itemId, 'workplace');
    if (!r.carried) blockers.push(`new commits on ${ctx0.branch} since the review (${ctx0.head.slice(0, 8)}): approvals reset`);
  }
  if (typeof ctx0 !== 'string' && ctx0.head === w0.pr.headSha && testsStale(w0.pr)) await recordTests(wp, itemId, ctx0);
  const w = rawGet(wp, itemId)!;
  const pr = w.pr!;
  if (!holds(pr.devApproval, w)) blockers.push('needs the developer approval');
  else if (!holds(pr.qaApproval, w)) blockers.push('needs the QA approval');
  if (!pr.tests || pr.tests.sha !== pr.headSha || pr.tests.state !== 'success') {
    blockers.push(`workplace/tests is ${pr.tests && pr.tests.sha === pr.headSha ? pr.tests.state : 'not run'} on ${pr.headSha.slice(0, 8)}`);
  }
  // Evidence before merge (owner, 10 Oct): the robot suite passed, or QA's doc says why there is none.
  if (!evidenceOk(wp, w)) blockers.push(`workplace/evidence is ${pr.evidence}, and the QA doc does not say "Evidence: n/a — <why>" with a "Tests:" line`);
  if (m === 'shadow') return { mode: m, merged: false, wouldMerge: blockers.length === 0, blockers };
  if (blockers.length) throw new Conflict(`Not merged: ${blockers.join('; ')}.`);

  const port = gitHubPort(wp);
  let mergedSha: string | undefined;
  try {
    const gh = await port.getPr(pr.number);
    // Already merged on GitHub (5 Oct: PR #27's only commit came in with PR #30): record it, don't alert.
    if (gh.merged) {
      savePr(wp, itemId, c => ({ pr: { ...c.pr!, merged: { at: now(), sha: '', by: 'github' } } }));
      trail.record(wp, { itemId, by: 'workplace', kind: 'merged', text: `PR #${pr.number} was already merged on GitHub (its commits reached ${pr.base} another way); recorded as merged` });
      try { lifecycleWatch.onMerged(wp, itemId, by); } catch (err) { log.warn('github', `${itemId}: after merge: ${errText(err)}`); }
      return { mode: m, merged: true, synced: true };
    }
    if (gh.state !== 'open') {
      // Closed without a merge: remember it, so the story is not held from "done" by a PR that is gone.
      savePr(wp, itemId, c => (c.pr ? { pr: { ...c.pr, closed: { at: now(), by: 'github', reason: 'closed on GitHub without a merge' } } } : {}));
      throw new Conflict(`PR #${pr.number} is closed on GitHub.`);
    }
    if (gh.headSha !== pr.headSha) throw new Conflict(`GitHub's head for PR #${pr.number} (${gh.headSha.slice(0, 8)}) is not the reviewed commit (${pr.headSha.slice(0, 8)}).`);
    const res = await port.merge(pr.number, pr.headSha, `Merge ${pr.branch}: ${w.title} [${w.id}]`);
    if (!res.merged) throw new Conflict(`GitHub did not merge PR #${pr.number}.`);
    mergedSha = res.sha;
  } catch (err) {
    // A 405 is GitHub's "not mergeable": most often a required workplace/* status it never received.
    // That is ours to repair (re-post), not an outage, so it does not count toward the fallback to local.
    if (/\(405\)/.test(errText(err)) && /status/i.test(errText(err))) {
      savePr(wp, itemId, c => (c.pr ? { pr: { ...c.pr, posted: {} } } : {}));
      try { await postStatuses(wp, itemId); } catch (e2) { recordFailure(wp, 'status', itemId, Date.now(), errText(e2)); }
    } else if (!(err instanceof Conflict)) recordFailure(wp, 'merge', itemId, Date.now(), errText(err));
    throw err instanceof BadRequest ? err : new Error(`GitHub merge of PR #${pr.number} failed: ${errText(err)}`);
  }
  savePr(wp, itemId, c => ({ pr: { ...c.pr!, merged: { at: now(), sha: mergedSha ?? '', by } } }));
  trail.record(wp, { itemId, by, kind: 'merged', text: `Merged PR #${pr.number} (${pr.branch}) into ${pr.base} on GitHub${mergedSha ? ` as ${mergedSha.slice(0, 8)}` : ''}` });
  log.info('github', `${itemId}: merged PR #${pr.number} (by ${by})`);
  // Merged (docs/HLD-jira-lifecycle.md §3): the story is Done-by-merge and Asha is told to close it.
  try { lifecycleWatch.onMerged(wp, itemId, by); } catch (err) { log.warn('github', `${itemId}: after merge: ${errText(err)}`); }
  try { await port.deleteBranch(pr.branch); } catch (err) {
    recordFailure(wp, 'delete branch', itemId, Date.now(), errText(err));
    trail.record(wp, { itemId, by: 'workplace', kind: 'note', text: `Merged, but ${pr.branch} was not deleted on GitHub: ${errText(err)}` });
  }

  const sync = await syncTrunk(wp, itemId, w, pr);
  return { mode: m, merged: true, ...(mergedSha ? { sha: mergedSha } : {}), synced: sync === null, ...(sync ? { syncError: sync } : {}) };
}

/* ---------- the automatic merge (owner-approved, 5 Oct) ---------- */

export type AutoMergeOutcome = 'merged' | 'waiting' | 'held' | 'blocked' | 'off';

const AUTO_BLOCKED_PREFIX = 'github:automerge-blocked:';
const autoInFlight = new Set<string>();

/**
 * Evidence before merge: workplace/evidence passed, or the filed QA doc says "Evidence: n/a — <why>" with
 * its "Tests:" line, or cites a live check recorded on the head (dry run #5), or the change is the CTO's
 * docs-only one the COO approved (dry run #12).
 */
export function evidenceOk(wp: Workplace, w: WorkItem): boolean {
  if (w.pr?.evidence === 'success' || cooDocsApproval(w)) return true;
  const filed = qaDoc.filed(wp, w.id);
  return qaDoc.evidenceNa(filed) || liveCheckEvidence(wp, w, filed);
}

/**
 * In `on`: both approvals holding on the head, workplace/tests green on it, and the evidence passed (or
 * marked n/a in the QA doc). A red test or failed evidence is `red`; anything not yet there is `waiting`.
 */
export function autoReady(wp: Workplace, w: WorkItem): 'ready' | 'waiting' | 'red' {
  const pr = w.pr;
  if (!pr || pr.merged || !holds(pr.devApproval, w) || !holds(pr.qaApproval, w)) return 'waiting';
  if (!pr.tests || pr.tests.sha !== pr.headSha) return 'waiting';
  if (pr.tests.state !== 'success') return pr.tests.state === 'pending' ? 'waiting' : 'red';
  if (evidenceOk(wp, w)) return 'ready';
  return pr.evidence === 'failure' ? 'red' : 'waiting';
}

/** CI and infrastructure: a change here can cost money, so it merges only after the COO approves the spend. */
export const SPEND_PATH = /^\.github\/workflows\/|^infra\/|\.tf$/;

/** The spend-relevant files a story's branch changes against the trunk; none when its branch cannot be read. */
export function spendFilesIn(wp: Workplace, w: WorkItem): string[] {
  const ctx = contextOf(wp, w);
  if (typeof ctx === 'string') return [];
  try { return changedFiles(ctx.repo, ctx.base, w.pr?.headSha ?? ctx.head).filter(f => SPEND_PATH.test(f)); } catch { return []; }
}

const SPEND_HELD_PREFIX = 'github:spend-held:';

/** The COO approves a spend-relevant PR (POST /api/coo/approve-spend); the automatic merge then goes on. */
export async function approveSpend(wp: Workplace, itemId: string, by: string): Promise<{ itemId: string; spendApprovedAt: string; merge: AutoMergeOutcome }> {
  const w = rawGet(wp, itemId);
  if (!w) throw new NotFound(`No item ${itemId}`);
  if (!w.pr) throw new BadRequest(`${itemId} has no pull request.`);
  if (w.pr.merged) throw new Conflict(`${itemId} is already merged (PR #${w.pr.number}).`);
  const at = now();
  savePr(wp, itemId, c => ({ pr: { ...c.pr!, spendApprovedAt: at } }));
  trail.record(wp, { itemId, by, kind: 'note', text: `Spend approved by ${nameOf(wp, by)} for PR #${w.pr.number} (CI or infrastructure change)` });
  dropSetting(wp, SPEND_HELD_PREFIX + itemId);
  return { itemId, spendApprovedAt: at, merge: await autoMerge(wp, itemId) };
}

function blockAuto(wp: Workplace, w: WorkItem, why: string): void {
  const pr = w.pr!;
  putSetting(wp, AUTO_BLOCKED_PREFIX + w.id, pr.headSha);
  coo.notifyStall(wp, {
    itemId: w.id, by: 'workplace',
    title: `Auto-merge stopped: ${w.title}`,
    body: `PR #${pr.number} (${pr.branch} at ${pr.headSha.slice(0, 8)}) has both approvals, but the Workplace did not merge it: ${why}. Nothing was forced; it is left for you. Merge it by hand with POST /api/coo/merge {"itemId":"${w.id}"} once it is clear.`,
  });
  trail.record(wp, { itemId: w.id, by: 'workplace', kind: 'note', text: `Automatic merge stopped (${why}); left for the COO` });
  log.warn('github', `${w.id}: auto-merge stopped: ${why}`);
}

/**
 * The automatic merge: in `on`, once a story's PR has both approvals on its head and workplace/tests
 * is green, the Workplace merges it with `merge` (pinned to the reviewed head, branch deleted, trunk
 * fast-forwarded). Any blocker alerts the COO once per head and is left for him; never forced, never throws.
 */
/** workplace/tests is worth re-reading from the author's pre-pr.sh results: missing, pending, or for another commit (11 Oct: a docs PR whose pre-pr ran after its push sat unmerged). */
const testsStale = (pr: { tests?: { state: string; sha: string }; headSha: string }): boolean => !pr.tests || pr.tests.state === 'pending' || pr.tests.sha !== pr.headSha;

export async function autoMerge(wp: Workplace, itemId: string): Promise<AutoMergeOutcome> {
  if (mode(wp) !== 'on') return 'off';
  const w = rawGet(wp, itemId);
  if (!w?.pr || w.pr.merged) return 'off';
  if (getSetting(wp, AUTO_BLOCKED_PREFIX + itemId) === w.pr.headSha) return 'blocked';
  // A pre-pr.sh result that arrives after review (B7, 7 Oct: approved, tests stuck pending all night)
  // is only read at submit time, so re-read it here before deciding to wait.
  if (testsStale(w.pr)) { const ctx = contextOf(wp, w); if (typeof ctx !== 'string' && ctx.head === w.pr.headSha) await recordTests(wp, itemId, ctx); }
  const cur = rawGet(wp, itemId) ?? w;
  const ready = autoReady(wp, cur);
  if (ready === 'waiting') return 'waiting';
  if (ready === 'red') {
    const t = cur.pr!.tests!;
    blockAuto(wp, cur, t.state !== 'success' ? `workplace/tests is ${t.state} on ${cur.pr!.headSha.slice(0, 8)}` : `workplace/evidence failed on ${cur.pr!.headSha.slice(0, 8)}`);
    return 'blocked';
  }
  // Rework W3 (owner, 10 Oct): design docs merge after both approvals like any change (the COO's
  // DESIGN_DOC hold is gone). What waits for the COO is spend: CI workflows and infrastructure.
  const spend = cur.pr!.spendApprovedAt ? [] : spendFilesIn(wp, cur);
  if (spend.length) {
    if (getSetting(wp, SPEND_HELD_PREFIX + itemId) !== cur.pr!.headSha) {
      putSetting(wp, SPEND_HELD_PREFIX + itemId, cur.pr!.headSha);
      trail.comment(wp, itemId, { by: 'workplace', text: `Held for the COO: PR #${cur.pr!.number} changes CI or infrastructure (${spend.slice(0, 5).join(', ')}${spend.length > 5 ? ` +${spend.length - 5} more` : ''}), which can cost money. It merges once the COO approves the spend (POST /api/coo/approve-spend {"itemId":"${itemId}"}).` });
      coo.notifyStall(wp, { itemId, by: 'workplace', title: `Spend approval: ${cur.title}`, body: `PR #${cur.pr!.number} has both approvals and green checks, and changes ${spend.join(', ')}. Approve the spend with POST /api/coo/approve-spend {"itemId":"${itemId}"}; it then merges itself.` });
    }
    return 'held';
  }
  const late = unansweredCtoComment(wp, w);
  if (late) { blockAuto(wp, w, `the CTO commented after the developer approval (${late.at.slice(11, 19)} UTC: "${late.text.slice(0, 120)}"), so his feedback rides on no review`); return 'blocked'; }
  if (autoInFlight.has(itemId)) return 'waiting';
  autoInFlight.add(itemId);
  try {
    const res = await merge(wp, itemId, 'workplace');
    if (!res.merged) { blockAuto(wp, rawGet(wp, itemId) ?? w, (res.blockers ?? []).join('; ') || 'not merged'); return 'blocked'; }
    dropSetting(wp, AUTO_BLOCKED_PREFIX + itemId);
    const pr = rawGet(wp, itemId)!.pr!;
    manager.alert(wp, {
      key: `merged:${itemId}:${pr.headSha}`, itemId, by: 'workplace', notice: true,
      title: `Merged: ${w.title}`,
      body: `PR #${pr.number} merged into ${pr.base}${res.sha ? ` as ${res.sha.slice(0, 8)}` : ''}${res.synced ? '' : ' (the trunk checkout was not synced; the COO is alerted)'}.`,
      text: `Merged automatically: "${w.title}" [${itemId}], PR #${pr.number} into ${pr.base}${res.sha ? ` as ${res.sha.slice(0, 8)}` : ''}, after both approvals and green tests. Nothing to do unless it unblocks other work.`,
    });
    return 'merged';
  } catch (err) {
    const why = errText(err);
    // A conflict with trunk is the author's to resolve, not the COO's (as_muuuumbovh9zc, 5 Oct): the
    // story was Done by approval but never merged, so it goes back to them In progress.
    if (/merge conflict/i.test(why) && reopenForConflict(wp, rawGet(wp, itemId) ?? w)) return 'blocked';
    blockAuto(wp, rawGet(wp, itemId) ?? w, why);
    return 'blocked';
  } finally {
    autoInFlight.delete(itemId);
  }
}

/**
 * A CTO comment newer than the developer approval, with no new commit since (8 Oct: Vikram's review
 * feedback on the QA escape doc landed between the developer approval and QA's, and the story merged
 * 54 s later with it unread). Only the CTO's: his comments are reviews, while the COO and Asha post
 * status notes that must not stall a merge. A new commit resets both approvals, so it clears this.
 */
export function unansweredCtoComment(wp: Workplace, w: WorkItem): { at: string; text: string } | null {
  const since = w.pr?.devApproval?.at;
  if (!since) return null;
  const late = trail.activityFor(wp, w.id).filter(a => a.kind === 'comment' && a.by === 'cto' && a.at > since);
  const last = late[late.length - 1];
  return last ? { at: last.at, text: last.text } : null;
}

/** Not merged (or not brought up to date) because it conflicts with trunk: back to its author, who merges trunk and resubmits. */
function reopenForConflict(wp: Workplace, w: WorkItem, what = 'it was not merged'): boolean {
  const pr = w.pr!;
  if (!w.employeeId || !isAgent(wp, w.employeeId)) return false;
  const note = `PR #${pr.number} conflicts with ${pr.base}, so ${what}. Merge origin/${pr.base} into ${pr.branch}, resolve the conflict keeping both sides' intent, ` +
    'run scripts/pre-pr.sh, then report_done: the conflict resolution is your own change, so it needs both approvals again.';
  try {
    items.update(wp, w.id, { status: 'in-progress', note: `system: reopened by the Workplace: ${note}` }, 'workplace');
  } catch (err) {
    log.warn('github', `${w.id}: reopen after a merge conflict failed: ${errText(err)}`);
    return false;
  }
  putSetting(wp, AUTO_BLOCKED_PREFIX + w.id, pr.headSha);
  trail.record(wp, { itemId: w.id, by: 'workplace', kind: 'note', text: `Automatic merge hit a conflict with ${pr.base}; reopened for ${nameOf(wp, w.employeeId)}` });
  tellAuthor(wp, w.id, 'workplace', note);
  log.warn('github', `${w.id}: PR #${pr.number} conflicts with ${pr.base}; reopened for ${w.employeeId}`);
  return true;
}

/** The sweep's half for merges: every approved, unmerged story in `on`. Returns the merged ids. */
export async function autoMergeSweep(wp: Workplace): Promise<string[]> {
  if (mode(wp) !== 'on') return [];
  const rows = (wp.db.prepare("select json from work where status = 'done'").all() as { json: string }[]).map(r => JSON.parse(r.json) as WorkItem);
  const merged: string[] = [];
  for (const w of rows) {
    if (!w.pr || w.pr.merged) continue;
    if (await autoMerge(wp, w.id) === 'merged') merged.push(w.id);
  }
  return merged;
}

/** `git pull --ff-only` of the trunk into its main checkout. Never forced; a failure alerts the COO. Null when synced. */
async function syncTrunk(wp: Workplace, itemId: string, w: WorkItem, pr: PrRecord): Promise<string | null> {
  const emp = w.employeeId ? employeeOf(wp, w.employeeId) : undefined;
  const repo = emp?.workspace.repo;
  if (!repo) return 'no trunk checkout';
  let why: string | null = null;
  try {
    const on = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (on !== pr.base) why = `${repo} is on ${on}, not ${pr.base}; it was not pulled`;
    else await gitHubPort(wp).pullFfOnly(repo, pr.base);
  } catch (err) {
    why = errText(err);
  }
  if (!why) { log.info('github', `${repo}: fast-forwarded ${pr.base}`); return null; }
  coo.notifyStall(wp, {
    itemId, by: 'workplace',
    title: `Trunk checkout not synced after merging "${w.title}"`,
    body: `PR #${pr.number} is merged on GitHub, but ${repo} could not fast-forward to it (${why}). Nothing was forced; bring ${pr.base} up to date by hand.`,
  });
  log.warn('github', `trunk sync after ${itemId}: ${why}`);
  return why;
}
