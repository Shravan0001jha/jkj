import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as items from './items.js';
import * as trail from './trail.js';
import * as work from './work.js';
import * as flow from './github-flow.js';
import { approvalHolds, githubMode } from './review-policy.js';
import { isChiefOfStaff } from './employees.js';
import { nameOf, rawGet } from './v2-map.js';
import { resolve as resolveOwner } from './ownership.js';
import { BadRequest, Forbidden, NotFound } from '../util/errors.js';
import { log } from '../util/logger.js';

/**
 * Board maintenance (owner, 18 Oct 2026): the COO stops doing it by hand; Asha (the Chief of Staff) does,
 * through tools. Every function here takes the actor, requires a reason, writes it to the story's trail
 * (the audit), and refuses unless the guard it names holds. The COO and the owner may call the same
 * functions (POST /api/coo/board/<name>). Nothing here forces anything on GitHub: closing is not merging,
 * and the one overwrite (resetBranch) is a force-with-lease after a backup ref.
 */

const REASON_MIN = 10;

function requireMaintainer(wp: Workplace, by: string): void {
  if (by === 'owner' || by === 'coo' || isChiefOfStaff(wp, by)) return;
  throw new Forbidden('Forbidden: board maintenance is the Chief of Staff\'s (and the COO\'s and owner\'s); ask Asha with escalate.');
}

function reasonOf(reason: string | undefined): string {
  const r = reason?.trim() ?? '';
  if (r.length < REASON_MIN) throw new BadRequest(`Give a reason (at least ${REASON_MIN} characters): it goes on the story as the audit of this change.`);
  return r;
}

const item = (wp: Workplace, id: string): WorkItem => {
  const w = rawGet(wp, id);
  if (!w) throw new NotFound(`No item ${id}`);
  return w;
};

const audit = (wp: Workplace, itemId: string | null, by: string, text: string): void => {
  trail.record(wp, { itemId, by, kind: 'note', text });
  log.info('board', `${itemId ?? '-'}: ${text} (by ${by})`);
};

/* ---------- 1. close an unmerged PR and detach it ---------- */

/**
 * Close the story's unmerged PR on GitHub and detach it from the story, so the story can be closed. Refused
 * for a merged PR, for one with both approvals (it merges), and for the author's own story.
 */
export async function closePr(wp: Workplace, itemId: string, by: string, reason?: string): Promise<{ itemId: string; closed: number }> {
  requireMaintainer(wp, by);
  const why = reasonOf(reason);
  const w = item(wp, itemId);
  const pr = w.pr;
  if (!pr) throw new BadRequest(`${itemId} has no pull request to close.`);
  if (pr.merged) throw new BadRequest(`PR #${pr.number} is merged; there is nothing to close.`);
  if (w.employeeId && w.employeeId === by) throw new Forbidden('You never close the PR of your own story; ask Asha.');
  if (approvalHolds(w, 'qa')) throw new BadRequest(`PR #${pr.number} has both approvals: the Workplace merges it. Close it only if it must not merge, via the COO.`);
  if (githubMode(wp) !== 'local') {
    const port = flow.gitHubPort(wp);
    const gh = await port.getPr(pr.number);
    if (gh.merged) throw new BadRequest(`PR #${pr.number} is already merged on GitHub; record the merge instead of closing it.`);
    if (gh.state === 'open') await port.closePr(pr.number);
  }
  // Detached; the branch's commits must not be pushed into a new PR by the next sweep (prRefused: same head, no retry).
  const cur = item(wp, itemId);
  const next = { ...cur, prRefused: { at: new Date().toISOString(), sha: pr.headSha, reasons: [`PR #${pr.number} closed by ${by}: ${why}`] } } as WorkItem;
  delete next.pr;
  work.saveQuiet(wp, next);
  audit(wp, itemId, by, `Closed PR #${pr.number} (${pr.branch} at ${pr.headSha.slice(0, 8)}) without merging and detached it from the story: ${why}`);
  return { itemId, closed: pr.number };
}

/* ---------- 2. close a no-code story ---------- */

export function closeNoCode(wp: Workplace, itemId: string, by: string, reason?: string): { itemId: string; status: string } {
  requireMaintainer(wp, by);
  const why = reasonOf(reason);
  const w = item(wp, itemId);
  if (w.level === 'epic') throw new BadRequest('An epic is closed by the owner or its owner.');
  if (w.status === 'done') throw new BadRequest(`${itemId} is already done.`);
  if (w.pr && !w.pr.merged && !w.pr.closed) throw new BadRequest(`${itemId} has an open pull request (#${w.pr.number}): close the PR with pr_close_detach first, or let it go through review. A story with code is not closed this way.`);
  if (w.employeeId && w.employeeId === by) throw new Forbidden('You never mark your own work done.');
  items.update(wp, itemId, { status: 'done', note: `Closed without code by ${nameOf(wp, by)} (board maintenance): ${why}` }, by, { checked: true, maintenance: true });
  return { itemId, status: 'done' };
}

/* ---------- 3. re-cut a staging batch sign-off ---------- */

export function signoffFile(wp: Workplace): string { return join(wp.config.opsDir, 'state', 'staging-signoff'); }

/** Move the pending sign-off ("<sha> <story id>") to a newer trunk commit, and say so on the sign-off story. */
export function recutSignoff(wp: Workplace, sha: string, by: string, reason?: string): { from: string; to: string; storyId: string } {
  requireMaintainer(wp, by);
  const why = reasonOf(reason);
  const file = signoffFile(wp);
  const raw = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  const [current, storyId] = raw.split(/\s+/);
  if (!current || !storyId) throw new BadRequest('No sign-off is pending (staging-signoff is empty): the batch job files one when a batch is due.');
  const repoRoot = wp.org.repos.find(r => r.id === 'iris')?.root;
  if (!repoRoot) throw new BadRequest('No iris repo in the org.');
  const trunk = `origin/${wp.config.github.trunk}`;
  try { flow.git(repoRoot, ['fetch', '-q', 'origin', wp.config.github.trunk]); } catch { /* best effort: the checked-out ref is used */ }
  const full = /^[0-9a-f]{7,40}$/i.test(sha.trim()) ? flow.revParse(repoRoot, sha.trim()) : null;
  const tip = flow.revParse(repoRoot, trunk);
  if (!full) throw new BadRequest(`${sha} is not a commit in the trunk checkout.`);
  if (!tip) throw new BadRequest(`${trunk} is not known in the trunk checkout.`);
  if (!flow.isAncestor(repoRoot, full, tip)) throw new BadRequest(`${full.slice(0, 9)} is not on ${trunk}: a sign-off moves only to a trunk commit.`);
  if (full === current) throw new BadRequest(`The sign-off already names ${full.slice(0, 9)}.`);
  if (!flow.isAncestor(repoRoot, current, full)) throw new BadRequest(`${full.slice(0, 9)} is not a descendant of the current sign-off head ${current.slice(0, 9)}: it can only move forward.`);
  const story = item(wp, storyId);
  if (story.status === 'done') throw new BadRequest(`The sign-off story ${storyId} is already done: ${current.slice(0, 9)} deploys on the next tick.`);
  writeFileSync(file, `${full} ${storyId}\n`);
  trail.comment(wp, storyId, { by, text: `Sign-off head moved from ${current.slice(0, 9)} to ${full.slice(0, 9)} (trunk): ${why}. Check the QA docs of the stories added since; only ${full.slice(0, 9)} deploys.`, mentions: ['cto', 'asha'].filter(x => x !== by) });
  audit(wp, storyId, by, `Re-cut the staging sign-off head ${current.slice(0, 9)} → ${full.slice(0, 9)}: ${why}`);
  return { from: current, to: full, storyId };
}

/* ---------- 4. switch the GitHub flow back on ---------- */

export function resumeGithub(wp: Workplace, by: string, reason?: string): ReturnType<typeof flow.state> {
  requireMaintainer(wp, by);
  const why = reasonOf(reason);
  const st = flow.state(wp);
  if (!st.fallback || st.mode !== 'local') throw new BadRequest('The GitHub flow did not fall back to local on its own, so this tool does not switch it: ask the COO.');
  flow.setMode(wp, st.fallback.from, by);
  audit(wp, null, by, `GitHub flow back to ${st.fallback.from} after the automatic fallback (${st.fallback.reason}): ${why}`);
  return flow.state(wp);
}

/* ---------- 5. re-post a lost status ---------- */

export async function repostStatus(wp: Workplace, itemId: string, by: string, reason?: string): Promise<string[]> {
  requireMaintainer(wp, by);
  const why = reasonOf(reason);
  if (githubMode(wp) === 'local') throw new BadRequest('The GitHub flow is local: there are no statuses to post.');
  const w = item(wp, itemId);
  if (!w.pr || w.pr.merged) throw new BadRequest(`${itemId} has no open pull request.`);
  const sent = await flow.repostStatuses(wp, itemId);
  const lines = sent.map(s => `${s.context} ${s.state}`);
  audit(wp, itemId, by, `Re-posted the workplace/* statuses on PR #${w.pr.number} (${w.pr.headSha.slice(0, 8)}) from the Workplace's own state (${lines.join(', ')}): ${why}`);
  return lines;
}

/* ---------- 6. reset a story branch on GitHub to its owner's local tip ---------- */

export interface ResetResult { branch: string; was: string; now: string; backup: string; files: string[] }

const filesOf = (repo: string, c: string): string[] => flow.git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', '--root', c]).split('\n').map(x => x.trim()).filter(Boolean);
const blobAt = (repo: string, c: string, file: string): string | null => { try { return flow.git(repo, ['rev-parse', '--verify', '--quiet', `${c}:${file}`]).trim() || null; } catch { return null; } };

/**
 * The remote story branch has commits the owner's local tip lacks (a stray auto-saved WIP): put it at the
 * local tip. Only when every file in those stray commits exists identically on the local tip or on another
 * branch (so nothing is lost), after pushing `backup/<branch>-<sha8>` at the old remote tip; the overwrite
 * is a force-with-lease on that very tip.
 */
export async function resetBranch(wp: Workplace, itemId: string, by: string, reason?: string): Promise<ResetResult> {
  requireMaintainer(wp, by);
  const why = reasonOf(reason);
  if (githubMode(wp) === 'local') throw new BadRequest('The GitHub flow is local: nothing is on GitHub.');
  const w = item(wp, itemId);
  if (w.pr?.merged) throw new BadRequest(`PR #${w.pr.number} is merged; its branch is not reset.`);
  const emp = wp.org.employees.find(e => e.id === w.employeeId);
  if (!emp || emp.virtual) throw new BadRequest(`${itemId} is not assigned to an agent with a worktree.`);
  const branch = `emp/${emp.id}/${itemId}`;
  const problem = flow.branchProblem(branch, branch);
  if (problem) throw new BadRequest(problem);
  const repo = emp.workspace.repo;
  const local = flow.revParse(repo, `refs/heads/${branch}`);
  if (!local) throw new BadRequest(`No local branch ${branch}.`);
  const port = flow.gitHubPort(wp);
  await port.fetchRemotes(repo);
  const remote = flow.revParse(repo, `refs/remotes/github/${branch}`);
  if (!remote) throw new BadRequest(`${branch} is not on GitHub.`);
  if (remote === local) throw new BadRequest('GitHub already has the local tip; nothing to reset.');
  if (flow.isAncestor(repo, remote, local)) throw new BadRequest('GitHub is behind the local tip: a normal push brings it up, no overwrite needed.');
  const stray = flow.git(repo, ['rev-list', `${local}..${remote}`]).split('\n').map(x => x.trim()).filter(Boolean);
  if (!stray.length) throw new BadRequest('The remote has no commits the local tip lacks.');
  const others = flow.git(repo, ['for-each-ref', '--format=%(refname)', 'refs/remotes/github', 'refs/heads']).split('\n').map(x => x.trim())
    .filter(r => r && r !== `refs/remotes/github/${branch}` && r !== `refs/heads/${branch}` && !r.startsWith('refs/remotes/github/backup/'));
  const files = new Set<string>();
  const missing: string[] = [];
  for (const c of stray) {
    for (const f of filesOf(repo, c)) {
      files.add(f);
      const blob = blobAt(repo, c, f);
      const onTip = blobAt(repo, local, f);
      const kept = blob === null ? onTip === null : onTip === blob || others.some(r => blobAt(repo, r, f) === blob);
      if (!kept) missing.push(f);
    }
  }
  if (missing.length) throw new BadRequest(`Not reset: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` +${missing.length - 8} more` : ''} exist${missing.length === 1 ? 's' : ''} only in the stray commits of ${branch} (${stray.length}), identical nowhere else. Their author keeps or drops them: send it to them.`);
  const backup = `backup/${branch}-${remote.slice(0, 8)}`;
  await port.pushRef(repo, remote, `refs/heads/${backup}`);
  await port.forcePush(repo, branch, local, remote);
  audit(wp, itemId, by, `Reset ${branch} on GitHub from ${remote.slice(0, 8)} to the owner's local tip ${local.slice(0, 8)} (${stray.length} stray commit${stray.length === 1 ? '' : 's'}, ${files.size} file${files.size === 1 ? '' : 's'}, all identical elsewhere); backup ref ${backup}: ${why}`);
  return { branch, was: remote, now: local, backup, files: [...files] };
}

/* ---------- 7. assign unmapped files to a charter ---------- */

export function assignMap(wp: Workplace, paths: string[], charterId: string, by: string, reason?: string): { added: string[]; mapEntries: number } {
  requireMaintainer(wp, by);
  const why = reasonOf(reason);
  if (!paths.length) throw new BadRequest('Give at least one path.');
  if (!wp.org.charters.has(charterId)) throw new BadRequest(`No charter ${charterId}.`);
  const repoId = 'iris';
  const keys = [...new Set(paths.map(p => p.trim().replace(/^\.?\//, '').replace(/^iris:/, '')))];
  for (const k of keys) {
    if (!k || k.includes('..') || /\s/.test(k) || k.endsWith('/')) throw new BadRequest(`"${k}" is not a clean repo-relative path (no spaces, "..", or trailing slash).`);
    const owner = resolveOwner(wp.org.map, { kind: 'path', key: `${repoId}:${k}` });
    if (owner) throw new BadRequest(`${k} is already mapped to ${owner.primary}; a mapped path is changed by a map change through the COO.`);
  }
  const file = join(wp.config.workplaceDir, 'map.yaml');
  const text = readFileSync(file, 'utf8');
  const lines = keys.map(k => `  - kind: path\n    key: ${repoId}:${k}\n    primary: ${charterId}\n    contributors: []\n    consulted: []\n`).join('');
  appendFileSync(file, `${text.endsWith('\n') ? '' : '\n'}${lines}`);
  const org = wp.reloadOrg();
  for (const k of keys) {
    const o = resolveOwner(org.map, { kind: 'path', key: `${repoId}:${k}` });
    if (o?.primary !== charterId) throw new BadRequest(`The map did not take ${k} after the reload (resolves to ${o?.primary ?? 'nothing'}); map.yaml is not in the expected shape, tell the COO.`);
  }
  audit(wp, null, by, `Mapped ${keys.join(', ')} to charter ${charterId}: ${why}`);
  return { added: keys, mapEntries: org.map.length };
}
