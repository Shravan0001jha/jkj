import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Employee, GitHubMode, PrApproval, PrRecord, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import type { GitHubPort, StatusState } from './github-port.js';
import { RealGitHub } from './github-port.js';
import * as quality from './quality.js';
import * as items from './items.js';
import * as work from './work.js';
import * as trail from './trail.js';
import * as coo from './coo.js';
import * as manager from './manager.js';
import { now } from './store.js';
import { isAgent, levelOf, nameOf, rawGet } from './v2-map.js';
import { branchFor, worktreePath } from './worktrees.js';
import * as prePr from './pre-pr.js';
import { GITHUB_MODES, githubMode, holds, isDeveloper, isQa, qaReviewer, writeGithubMode } from './review-policy.js';
import { freshLink } from './evidence-share.js';
import { BadRequest, Conflict, NotFound } from '../util/errors.js';
import { log } from '../util/logger.js';

/**
 * The GitHub pull-request flow (docs/HLD-github-flow.md, docs/LLD-github-flow.md §4).
 *
 * `local` (the default) is the Workplace as it was: every entry point returns before doing anything.
 * In `shadow` and `on`, a story moving to review has its branch pushed and a PR opened by the server
 * (employees never push), two approvals in order are recorded against the head commit, the
 * workplace/* statuses are posted, and the quality checks run. In `on`, "done" needs both approvals
 * and the COO merges through GitHub. Three GitHub failures in five minutes fall back to `local`.
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
  const episode = w.statusSince ?? '';
  const at = now();
  let tookOver = false;
  savePr(wp, itemId, cur => {
    const base: PrRecord = reuse
      ? { ...reuse }
      : { number: number!, url: url!, branch: ctx.branch, base: ctx.base, headSha: ctx.head, pushedAt: at, evidence: 'pending' };
    const record: PrRecord = { ...base, number: number!, url: url!, headSha: ctx.head, pushedAt: at };
    if (moved) {
      delete record.devApproval; delete record.qaApproval; delete record.tests;
      record.evidence = 'stale';
    }
    // A new stay in review (after a send-back): the approvals of the last one are over.
    for (const k of ['devApproval', 'qaApproval'] as const) if (record[k] && record[k]!.episode !== episode) delete record[k];
    // Evidence is run before submitting (handbook step 4, then 5): a finished run on this very head
    // carries over to a new PR record, or to a head the PR has just moved to.
    const ev = cur.evidenceRun;
    if (ev && ev.sha === ctx.head && (ev.state === 'success' || ev.state === 'failure') && (!reuse || moved)) {
      record.evidence = ev.state;
      tookOver = true;
      record.evidenceNote = `${ev.passed} passed, ${ev.failed} failed on ${ev.platforms.join('+')} (run_evidence)`;
    }
    return { pr: record, prRefused: undefined };
  });
  trail.record(wp, {
    itemId, by: 'workplace', kind: 'note',
    text: `Pushed ${ctx.branch} (${ctx.head.slice(0, 8)}) to GitHub; PR #${number}${moved ? ': new commits, both approvals reset and the evidence is stale' : ''}`,
  });
  log.info('github', `${itemId}: pushed ${ctx.branch} ${ctx.head.slice(0, 8)}, PR #${number} (by ${by})`);
  // With a PR the first review is a developer's (shadow and on): whoever the author named, the reviewer
  // becomes a developer approver until the developer approval holds (dry-run finding #3, 4 Oct: QA
  // named first refused and sent it back, a wasted round). The reviewer change wakes them.
  const fresh = rawGet(wp, itemId)!;
  const named = fresh.reviewerId ?? '';
  if (!holds(fresh.pr?.devApproval, fresh) && (!isDeveloper(employeeOf(wp, named)) || named === fresh.employeeId)) {
    const dev = devReviewer(wp, fresh);
    if (dev) items.update(wp, itemId, { reviewerId: dev, note: 'A developer reviews first, then QA' }, 'workplace');
  }

  try { await postStatuses(wp, itemId); } catch (err) { recordFailure(wp, 'status', itemId, Date.now(), errText(err)); }
  if (tookOver) {
    const ev = rawGet(wp, itemId)!.evidenceRun!;
    const link = ev.share ? (await freshLink(wp, ev.share))?.url : undefined;
    await prComment(wp, itemId, `Evidence ${ev.state === 'success' ? 'PASS' : 'FAIL'} on ${ev.sha.slice(0, 8)} (${ev.platforms.join(',')} / ${ev.features.join(',')}): ${ev.passed} passed, ${ev.failed} failed. Report: ${link ?? 'link unavailable'}`);
  }
  const tests = recordTests(wp, itemId, ctx);
  return {
    pr: { number: number!, url: url! }, tests,
    message: `The Workplace pushed your branch: pull request #${number} (${url}). ` +
      (moved ? 'Any new commit resets both approvals, so it goes back through the developer approver (approval 1 of 2) and QA (approval 2 of 2); run run_evidence again on this commit.'
        : 'Next: the developer approver (approval 1 of 2, a lead who is not the author), then QA (approval 2 of 2).'),
  };
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
    ? { context: CONTEXTS.review, state: 'success', description: `Approved by ${nameOf(wp, pr.devApproval!.by)} (developer approver) and ${nameOf(wp, pr.qaApproval!.by)} (QA)` }
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

/** The developer reviewer: the author's lead, else the lead (not the author) with the fewest reviews open. */
export function devReviewer(wp: Workplace, w: WorkItem): string | undefined {
  const author = w.employeeId ? employeeOf(wp, w.employeeId) : undefined;
  const lead = author?.reportsTo ? employeeOf(wp, author.reportsTo) : undefined;
  if (lead && isDeveloper(lead) && lead.id !== w.employeeId) return lead.id;
  const load = (id: string): number => (wp.db.prepare("select count(*) as n from work where status = 'in-review' and reviewer_id = ?").get(id) as { n: number }).n;
  const leads = wp.org.employees.filter(e => isDeveloper(e) && !e.virtual && e.id !== w.employeeId);
  return leads.map((e, i) => ({ id: e.id, n: load(e.id), i })).sort((a, b) => a.n - b.n || a.i - b.i)[0]?.id;
}

/** The item in review with its PR, its head re-read; a moved head is re-pushed and refused. */
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
    await onReview(wp, itemId, 'workplace');
    throw new Conflict(`Any new commit resets both approvals: ${ctx.branch} has a new commit (${ctx.head.slice(0, 8)}), so review the new head and call review_approve again (developer approver first, then QA).`);
  }
  return w;
}

export interface ApproveResult { stage: 'dev' | 'qa'; message: string }

export async function approve(wp: Workplace, itemId: string, by: string, note?: string): Promise<ApproveResult> {
  if (mode(wp) === 'local') throw new BadRequest(LOCAL_REVIEW);
  const w = await reviewable(wp, itemId);
  const pr = w.pr!;
  const author = w.employeeId;
  if (by === author) throw new BadRequest('You are the author, so you never approve your own story; another lead gives approval 1 of 2, then QA gives approval 2 of 2.');
  const who = employeeOf(wp, by);
  const approval: PrApproval = { by, at: now(), sha: pr.headSha, episode: w.statusSince ?? '', ...(note?.trim() ? { note: note.trim() } : {}) };

  if (!holds(pr.devApproval, w)) {
    if (!isDeveloper(who)) {
      if (isQa(who)) throw new BadRequest('QA reviews after a developer approval; ask a lead to review first.');
      throw new BadRequest(`${nameOf(wp, by)} is not a lead, and approval 1 of 2 comes from the developer approver (a lead who is not the author); ask a lead to review.`);
    }
    savePr(wp, itemId, c => ({ pr: { ...c.pr!, devApproval: approval } }));
    trail.record(wp, { itemId, by, kind: 'note', text: `Developer approval by ${nameOf(wp, by)} on ${pr.headSha.slice(0, 8)}${approval.note ? `: ${approval.note}` : ''}` });
    const qa = qaReviewer(wp.org.employees, w, [by]);
    if (qa && qa !== w.reviewerId) items.update(wp, itemId, { reviewerId: qa, note: 'Developer approval given; QA reviews next' }, by);
    try { await postStatuses(wp, itemId); } catch (err) { recordFailure(wp, 'status', itemId, Date.now(), errText(err)); }
    return { stage: 'dev', message: `Developer approval recorded (approval 1 of 2) on ${pr.headSha.slice(0, 8)}. QA reviews next${qa ? ` (${nameOf(wp, qa)})` : ''} for approval 2 of 2. Any new commit resets both approvals.` };
  }

  if (!isQa(who)) throw new BadRequest(`It already has the developer approval (1 of 2), and approval 2 of 2 is QA's (${qaNames(wp)}); leave it to QA.`);
  if (by === pr.devApproval!.by) throw new BadRequest('You gave approval 1 of 2, so approval 2 of 2 must come from another person in QA; leave it to them.');
  savePr(wp, itemId, c => ({ pr: { ...c.pr!, qaApproval: approval } }));
  trail.record(wp, { itemId, by, kind: 'note', text: `QA approval by ${nameOf(wp, by)} on ${pr.headSha.slice(0, 8)}${approval.note ? `: ${approval.note}` : ''}` });
  try { await postStatuses(wp, itemId); } catch (err) { recordFailure(wp, 'status', itemId, Date.now(), errText(err)); }
  items.update(wp, itemId, { status: 'done', reviewerId: by, note: `Approved by ${nameOf(wp, pr.devApproval!.by)} (developer) and ${nameOf(wp, by)} (QA)` }, by);
  return { stage: 'qa', message: 'QA approval recorded (approval 2 of 2); the story is done. The COO merges it once the tests check is green: approved is not merged.' };
}

export async function sendBack(wp: Workplace, itemId: string, by: string, note: string): Promise<WorkItem> {
  if (mode(wp) === 'local') throw new BadRequest(LOCAL_REVIEW);
  if (!note?.trim()) throw new BadRequest('A send-back needs the reason: say exactly what to change (QA: the root cause, what failed and why).');
  const w = rawGet(wp, itemId);
  if (!w) throw new NotFound(`No item ${itemId}`);
  if (!w.pr) throw new BadRequest('This story has no pull request, so send it back with item_update (status in-progress, with what to change).');
  if (by === w.employeeId) throw new BadRequest('You are the author: only a reviewer (the developer approver or QA) sends a story back.');
  const who = employeeOf(wp, by);
  if (!isDeveloper(who) && !isQa(who)) throw new BadRequest(`${nameOf(wp, by)} is not a reviewer: only the developer approver (a lead who is not the author) or QA sends a story back; add your view with item_comment instead.`);
  if (w.status !== 'in-review') throw new BadRequest(`This story is not in review (it is ${w.status}), so there is nothing to send back.`);
  if (!isDeveloper(who) && !holds(w.pr.devApproval, w)) throw new BadRequest(QA_WAIT);
  savePr(wp, itemId, c => ({ pr: { ...c.pr!, sendBack: { by, at: now(), note: note.trim() } } }));
  items.update(wp, itemId, { status: 'in-progress', note: `Sent back by ${nameOf(wp, by)}: ${note.trim()}` }, by);
  try { await postStatuses(wp, itemId); } catch (err) { recordFailure(wp, 'status', itemId, Date.now(), errText(err)); }
  return rawGet(wp, itemId)!;
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

/** In review with a PR and a moved head: re-pushed (which resets the approvals). Returns the moved ids. */
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
    if (typeof ctx === 'string' || ctx.head === w.pr.headSha) continue;
    await onReview(wp, w.id, 'workplace');
    moved.push(w.id);
  }
  return moved;
}

/** Every minute while not local: the sweep. Returns stop(). */
export function startGitHubFlow(wp: Workplace): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy || mode(wp) === 'local') return;
    busy = true;
    syncHeads(wp).catch(err => log.warn('github', `sweep: ${errText(err)}`)).finally(() => { busy = false; });
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
    await onReview(wp, itemId, 'workplace');
    blockers.push(`new commits on ${ctx0.branch} since the review (${ctx0.head.slice(0, 8)}): approvals reset`);
  }
  const w = rawGet(wp, itemId)!;
  const pr = w.pr!;
  if (!holds(pr.devApproval, w)) blockers.push('needs the developer approval');
  else if (!holds(pr.qaApproval, w)) blockers.push('needs the QA approval');
  if (!pr.tests || pr.tests.sha !== pr.headSha || pr.tests.state !== 'success') {
    blockers.push(`workplace/tests is ${pr.tests && pr.tests.sha === pr.headSha ? pr.tests.state : 'not run'} on ${pr.headSha.slice(0, 8)}`);
  }
  if (m === 'shadow') return { mode: m, merged: false, wouldMerge: blockers.length === 0, blockers };
  if (blockers.length) throw new Conflict(`Not merged: ${blockers.join('; ')}.`);

  const port = gitHubPort(wp);
  let mergedSha: string | undefined;
  try {
    const gh = await port.getPr(pr.number);
    if (gh.merged) throw new Conflict(`PR #${pr.number} was merged on GitHub outside the Workplace; check it by hand.`);
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
  try { await port.deleteBranch(pr.branch); } catch (err) {
    recordFailure(wp, 'delete branch', itemId, Date.now(), errText(err));
    trail.record(wp, { itemId, by: 'workplace', kind: 'note', text: `Merged, but ${pr.branch} was not deleted on GitHub: ${errText(err)}` });
  }

  const sync = await syncTrunk(wp, itemId, w, pr);
  return { mode: m, merged: true, ...(mergedSha ? { sha: mergedSha } : {}), synced: sync === null, ...(sync ? { syncError: sync } : {}) };
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
