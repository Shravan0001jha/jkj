import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Employee, LiveCheck, PrExtraReviewer as ExtraReviewer, GitHubMode, PrApproval, PrRecord, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import type { GitHubPort, StatusState } from './github-port.js';
import { RealGitHub } from './github-port.js';
import * as quality from './quality.js';
import * as items from './items.js';
import * as work from './work.js';
import * as trail from './trail.js';
import * as coo from './coo.js';
import * as manager from './manager.js';
import * as lifecycleWatch from './lifecycle-watch.js';
import * as employees from './employees.js';
import * as runs from './runs.js';
import { now } from './store.js';
import { isAgent, levelOf, nameOf, rawGet } from './v2-map.js';
import { branchFor, worktreePath } from './worktrees.js';
import * as prePr from './pre-pr.js';
import { GITHUB_MODES, githubMode, holds, canApproveAsDeveloper, isCto, isQa, qaReviewer, writeGithubMode } from './review-policy.js';
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

export function gitHubPort(wp: Workplace): GitHubPort {
  let port = ports.get(wp);
  if (!port) {
    const g = wp.config.github;
    port = new RealGitHub({ org: g.org, repo: g.repo, tokenScript: g.tokenScript, python: existsSync(g.python) ? g.python : 'python3', pushApp: g.pushApp, reviewApp: g.reviewApp });
    ports.set(wp, port);
  }
  return port;
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

const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const revParse = (cwd: string, ref: string): string | null => { try { return git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim() || null; } catch { return null; } };

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
  const head = revParse(repo, `refs/heads/${branch}`);
  if (!head) return `no branch ${branch}`;
  const own = git(repo, ['rev-list', '--count', `${base}..${head}`]).trim();
  if (own === '0') return `no commits on ${branch} past ${base}`;
  return { w, emp, repo, base, branch, head };
}

/** Write the item's PR record from the current row (never a stale copy). */
function savePr(wp: Workplace, id: string, change: (w: WorkItem) => Partial<WorkItem>): WorkItem {
  const cur = rawGet(wp, id);
  if (!cur) throw new NotFound(`No item ${id}`);
  const next = { ...cur, ...change(cur) } as WorkItem;
  for (const k of ['pr', 'prRefused'] as const) if (next[k] === undefined) delete next[k];
  work.saveQuiet(wp, next);
  return next;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 300);

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
  if (w.status !== 'in-review') return { skipped: 'not in review', message: '' };
  const ctx = contextOf(wp, w);
  if (typeof ctx === 'string') return { skipped: ctx, message: '' };

  let cfg: quality.QualityConfig;
  try { cfg = quality.loadConfig(wp.config.workplaceDir); } catch (err) {
    return refuse(wp, itemId, ctx.head, [`quality.yaml could not be read: ${errText(err)}`]);
  }
  const problems = [branchProblem(ctx.branch, branchFor(ctx.emp, itemId)), ...quality.guardProblems(ctx.repo, ctx.base, ctx.head, cfg)].filter((p): p is string => !!p);
  if (problems.length) return refuse(wp, itemId, ctx.head, problems);

  const port = gitHubPort(wp);
  try {
    await port.push(ctx.repo, ctx.branch);
  } catch (err) {
    recordFailure(wp, 'push', itemId, Date.now(), errText(err));
    trail.record(wp, { itemId, by: 'workplace', kind: 'note', text: `Could not push ${ctx.branch} to GitHub: ${errText(err)}` });
    return { error: errText(err), message: `Your report is recorded, but GitHub did not take the push (${errText(err)}). Nothing to do: the Workplace retries every minute.` };
  }

  const prev = rawGet(wp, itemId)!.pr;
  const reuse = prev && !prev.merged && prev.branch === ctx.branch ? prev : undefined;
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
  const episode = w.statusSince ?? '';
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
    const nextExtra: ExtraReviewer[] = extra.map(c => { const p = prevExtra.find(e => e.id === c.id); return p ? { ...p, files: c.files } : c; });
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

const clearExtra = (e: ExtraReviewer): ExtraReviewer => { const { approvedAt: _a, sha: _s, episode: _e, ...rest } = e; return rest; };

/* ---------- trunk catch-up (rework W3) ---------- */

const isAncestor = (repo: string, a: string, b: string): boolean => {
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

/** The files a branch changes against the trunk (since they diverged). */
export function changedFiles(repo: string, base: string, head: string): string[] {
  return git(repo, ['diff', '--name-only', `${base}...${head}`]).split('\n').map(f => f.trim()).filter(Boolean);
}

/** A file's change counts as code when at least one added or removed line (whitespace and blank lines aside) is not a comment. */
export function realCodeChange(repo: string, base: string, head: string, file: string): boolean {
  if (notCode(file)) return false;
  const diff = git(repo, ['diff', '-w', '--ignore-blank-lines', `${base}...${head}`, '--', file]);
  return diff.split('\n').some(l => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---') && !!l.slice(1).trim() && !COMMENT_LINE.test(l.slice(1).trim()));
}

/** The other teams' leads whose charters own code this branch really changes, each with those files. */
function codeReviewersFor(wp: Workplace, ctx: Ctx): ExtraReviewer[] {
  const author = ctx.emp.id;
  const authorLead = teamOf(wp.org, author) ?? author;
  const repoId = wp.org.repos.find(r => r.root === ctx.repo)?.id ?? 'iris';
  const byLead = new Map<string, string[]>();
  let files: string[];
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

/** The extra reviewers whose approval does not hold on this head and stay in review. */
export function pendingExtra(w: WorkItem): ExtraReviewer[] {
  const pr = w.pr;
  if (!pr) return [];
  return (pr.extraReviewers ?? []).filter(e => !(e.approvedAt && e.sha === pr.headSha && e.episode === (w.statusSince ?? '')));
}

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
    for (const id of new Set(ids)) if (!list.some(e => e.id === id)) { list.push({ id, files: [], requested: true }); fresh.push(id); }
    return { pr: { ...c.pr!, extraReviewers: list } };
  });
  if (fresh.length) trail.comment(wp, itemId, { by: 'workplace', text: `Extra review before QA, asked by ${nameOf(wp, by)}: ${fresh.map(id => `@${id}`).join(', ')}. Review the change and call review_approve on ${itemId}; QA waits for you.`, mentions: fresh });
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

/** workplace/tests from the author's pre-pr.sh results for this head (the server runs no suites). */
async function recordTests(wp: Workplace, itemId: string, ctx: Ctx): Promise<void> {
  const sha = ctx.head;
  try {
    const r = prePr.read(authorWorktree(wp, ctx.emp), sha);
    const valid = r && r.sha === sha ? r : null;
    // Only a full run counts (pre-pr.ts passes); a fast or partial pass stays pending.
    const tests: NonNullable<PrRecord['tests']> = !valid
      ? { state: 'pending', sha, at: now(), summary: `Waiting for scripts/pre-pr.sh results on ${sha.slice(0, 7)}` }
      : !valid.ok
        ? { state: 'failure', sha, at: now(), summary: prePr.describe(valid), details: prePr.failureDetails(valid).slice(-4000) }
        : { state: prePr.passes(valid, sha) ? 'success' : 'pending', sha, at: now(), summary: prePr.describe(valid) };
    savePr(wp, itemId, c => (c.pr && c.pr.headSha === sha ? { pr: { ...c.pr, tests } } : {}));
    trail.record(wp, { itemId, by: 'workplace', kind: 'test', text: `Pre-PR checks ${tests.state === 'success' ? 'green' : tests.state} on ${sha.slice(0, 8)}: ${tests.summary}` });
    if (tests.state === 'failure') {
      trail.comment(wp, itemId, { by: 'workplace', text: `scripts/pre-pr.sh failed on ${sha.slice(0, 8)} (${tests.summary}). Fix it on your branch, commit, run scripts/pre-pr.sh again, then call report_done.`, ...(tests.details ? { details: tests.details } : {}) });
    }
    try { await postStatuses(wp, itemId); } catch (err) { recordFailure(wp, 'status', itemId, Date.now(), errText(err)); }
  } catch (err) {
    log.warn('github', `${itemId}: tests status: ${errText(err)}`);
  }
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
  const tests: Status = t ? { context: CONTEXTS.tests, state: t.state, description: t.summary } : { context: CONTEXTS.tests, state: 'pending', description: 'Checks queued' };
  const evidence: Status = pr.evidence === 'success' ? { context: CONTEXTS.evidence, state: 'success', description: pr.evidenceNote ?? 'Evidence checked' }
    : pr.evidence === 'failure' ? { context: CONTEXTS.evidence, state: 'failure', description: pr.evidenceNote ?? 'Evidence missing' }
    : pr.evidence === 'stale' ? { context: CONTEXTS.evidence, state: 'pending', description: 'Stale: a new commit needs run_evidence again' }
    : { context: CONTEXTS.evidence, state: 'pending', description: 'Waiting for run_evidence on this commit' };
  // The shared report of the run behind this status (the global link), when there is one.
  const share = w.evidenceRun?.sha === pr.headSha && w.evidenceRun.state === pr.evidence ? w.evidenceRun.share : undefined;
  if (share && (pr.evidence === 'success' || pr.evidence === 'failure')) evidence.targetUrl = share.url;
  return [review, tests, evidence];
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
    await port.setStatus(head, s);
    posted[s.context] = key;
    savePr(wp, itemId, c => (c.pr ? { pr: { ...c.pr, posted: { ...(c.pr.posted ?? {}), [s.context]: key } } } : {}));
  }
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

/** The one QA of a story: who it is now, honouring a change the Chief of Staff (or the owner, the COO) made with item_update reviewerId. */
function assignedQa(wp: Workplace, w: WorkItem, by: string): { qa: string | undefined; changed: boolean } {
  const set = w.pr?.qaReviewer;
  if (!set || by === set) return { qa: set, changed: false };
  const deciders = new Set(['owner', 'coo', chiefOfStaffId(wp) ?? '']);
  const moves = trail.activityFor(wp, w.id).filter(a => a.kind === 'reviewer');
  const lastToSet = moves.map(a => a.to).lastIndexOf(set);
  const lastToBy = moves.map(a => a.to).lastIndexOf(by);
  if (lastToBy > lastToSet && deciders.has(moves[lastToBy]!.by) && isQa(employeeOf(wp, by))) return { qa: by, changed: true };
  return { qa: set, changed: false };
}

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
  // One QA per story (owner, 10 Oct): named once, at the first developer approval, and kept.
  let qa = pr.qaReviewer;
  if (!qa) {
    const load: Record<string, number> = {};
    for (const i of items.list(wp, { status: 'in-review' })) if (i.reviewerId && i.id !== itemId) load[i.reviewerId] = (load[i.reviewerId] ?? 0) + 1;
    qa = qaReviewer(wp.org.employees, w, [by], load);
    if (qa) savePr(wp, itemId, c => ({ pr: { ...c.pr!, qaReviewer: qa } }));
  }
  if (qa && qa !== w.reviewerId) items.update(wp, itemId, { reviewerId: qa, note: 'system: developer approval given; QA reviews next' }, 'workplace');
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
  const { qa, changed } = assignedQa(wp, w, by);
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
  const doc = qaDoc.require$(qaText, proofRoots(wp, w));
  qaDocExtras(wp, w, doc, qaText!);
  const qaPath = qaDoc.file(wp, itemId, { title: w.title, by, sha: pr.headSha, at: approval.at }, qaText!);
  savePr(wp, itemId, c => ({ pr: { ...c.pr!, qaApproval: approval, qaReviewer: by } }));
  if (changed) trail.record(wp, { itemId, by: 'workplace', kind: 'note', text: `QA for this story is now ${nameOf(wp, by)} (changed by the Chief of Staff)` });
  trail.record(wp, { itemId, by, kind: 'note', text: `QA approval by ${nameOf(wp, by)} on ${pr.headSha.slice(0, 8)} with a QA doc of ${doc.cases.length} edge cases (${qaPath})${approval.note ? `: ${approval.note}` : ''}` });
  try { await postStatuses(wp, itemId); } catch (err) { recordFailure(wp, 'status', itemId, Date.now(), errText(err)); }
  items.update(wp, itemId, { status: 'done', reviewerId: by, note: `Approved by ${nameOf(wp, pr.devApproval!.by)} (developer) and ${nameOf(wp, by)} (QA)` }, by, { checked: true });
  const auto = await autoMerge(wp, itemId);
  return { stage: 'qa', message: `QA approval recorded (approval 2 of 2); the story is done. ${mergeTail(auto)}` };
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
  qaDocExtras(wp, w, doc, text);
  const path = qaDoc.file(wp, itemId, { title: w.title, by, sha: pr.headSha, at: now() }, text);
  trail.record(wp, { itemId, by, kind: 'note', text: `QA doc amended by ${nameOf(wp, by)} on ${pr.headSha.slice(0, 8)}: ${doc.cases.length} edge cases (${path})` });
  // The merge gate runs again on the amended doc; a stop recorded for this head (the evidence) is lifted first.
  dropSetting(wp, AUTO_BLOCKED_PREFIX + itemId);
  const merge = await autoMerge(wp, itemId);
  return { merge, message: `QA doc updated (${doc.cases.length} edge cases). ${mergeTail(merge)}` };
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
  const rows = (wp.db.prepare("select json from work where status = 'in-review'").all() as { json: string }[]).map(r => JSON.parse(r.json) as WorkItem);
  for (const w of rows) {
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
      await onReview(wp, w.id, 'workplace');
      moved.push(w.id);
      continue;
    }
    await catchUp(wp, w, ctx);
  }
  return moved;
}

const UPDATE_BRANCH_PREFIX = 'github:update-branch:';

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
  putSetting(wp, key, `${ctx.head}|${trunk}`);
  const port = gitHubPort(wp);
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
    if (gh.state !== 'open') throw new Conflict(`PR #${pr.number} is closed on GitHub.`);
    if (gh.headSha !== pr.headSha) throw new Conflict(`GitHub's head for PR #${pr.number} (${gh.headSha.slice(0, 8)}) is not the reviewed commit (${pr.headSha.slice(0, 8)}).`);
    const res = await port.merge(pr.number, pr.headSha, `Merge ${pr.branch}: ${w.title} [${w.id}]`);
    if (!res.merged) throw new Conflict(`GitHub did not merge PR #${pr.number}.`);
    mergedSha = res.sha;
  } catch (err) {
    if (!(err instanceof Conflict)) recordFailure(wp, 'merge', itemId, Date.now(), errText(err));
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
