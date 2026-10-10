import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitHubPort, PullRequest, StatusState } from '../../src/services/github-port.js';

/**
 * GitHub, faked with a local bare repository as the remote: pushes, merges, branch deletes and the
 * trunk's fast-forward pull are real git, so the tests prove what lands where. Pull requests and
 * statuses are kept in memory. `failNext(op, n)` makes the next n calls of an operation throw, the
 * way an outage or a revoked token would.
 */

export type Op = 'push' | 'findOpenPr' | 'openPr' | 'getPr' | 'setStatus' | 'comment' | 'merge' | 'deleteBranch' | 'pullFfOnly' | 'updateBranch' | 'fetchBranch';

export interface FakePr extends PullRequest { title: string; body: string; head: string; base: string }

export class FakeGitHub implements GitHubPort {
  readonly bare: string;
  readonly calls: { op: Op; args: unknown[] }[] = [];
  readonly prs: FakePr[] = [];
  /** `<sha>:<context>` → the last status posted. */
  readonly statuses = new Map<string, { state: StatusState; description: string; targetUrl?: string }>();
  /** PR number → the comments posted on it. */
  readonly comments = new Map<number, string[]>();
  private readonly failures = new Map<Op, number>();

  constructor(trunkRepo: string) {
    this.bare = mkdtempSync(join(tmpdir(), 'iris-fake-gh-'));
    execFileSync('git', ['clone', '-q', '--bare', trunkRepo, this.bare], { stdio: 'ignore' });
  }

  failNext(op: Op, n = 1, message?: string): void { this.failures.set(op, (this.failures.get(op) ?? 0) + n); if (message) this.failMessage.set(op, message); }
  private readonly failMessage = new Map<Op, string>();

  private enter(op: Op, ...args: unknown[]): void {
    this.calls.push({ op, args });
    const left = this.failures.get(op) ?? 0;
    if (left > 0) {
      this.failures.set(op, left - 1);
      throw new Error(this.failMessage.get(op) ?? `fake GitHub: ${op} failed (503)`);
    }
  }

  count(op: Op): number { return this.calls.filter(c => c.op === op).length; }

  remoteSha(branch: string): string | null {
    try { return execFileSync('git', ['-C', this.bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { encoding: 'utf8' }).trim(); } catch { return null; }
  }

  status(sha: string, context: string): { state: StatusState; description: string; targetUrl?: string } | undefined {
    return this.statuses.get(`${sha}:${context}`);
  }

  async push(repoDir: string, branch: string): Promise<void> {
    this.enter('push', repoDir, branch);
    execFileSync('git', ['-C', repoDir, 'push', '-q', this.bare, `refs/heads/${branch}:refs/heads/${branch}`], { stdio: 'pipe' });
    for (const pr of this.prs) if (pr.head === branch && pr.state === 'open') pr.headSha = this.remoteSha(branch)!;
  }

  async findOpenPr(branch: string): Promise<PullRequest | null> {
    this.enter('findOpenPr', branch);
    const pr = this.prs.find(p => p.head === branch && p.state === 'open');
    return pr ? this.view(pr) : null;
  }

  async openPr(pr: { title: string; body: string; head: string; base: string }): Promise<PullRequest> {
    this.enter('openPr', pr);
    if (this.prs.some(p => p.head === pr.head && p.state === 'open')) throw new Error('fake GitHub: a pull request already exists (422)');
    const sha = this.remoteSha(pr.head);
    if (!sha) throw new Error('fake GitHub: head branch not on GitHub (422)');
    const number = 100 + this.prs.length;
    const created: FakePr = { ...pr, number, url: `https://github.com/shravan0001jha-iris-hq/iris/pull/${number}`, headSha: sha, state: 'open', merged: false };
    this.prs.push(created);
    return this.view(created);
  }

  async getPr(n: number): Promise<PullRequest> {
    this.enter('getPr', n);
    const pr = this.prs.find(p => p.number === n);
    if (!pr) throw new Error('fake GitHub: no such PR (404)');
    return this.view(pr);
  }

  async setStatus(sha: string, s: { context: string; state: StatusState; description: string; targetUrl?: string }): Promise<void> {
    this.enter('setStatus', sha, s);
    this.statuses.set(`${sha}:${s.context}`, { state: s.state, description: s.description, ...(s.targetUrl ? { targetUrl: s.targetUrl } : {}) });
  }

  async comment(n: number, body: string): Promise<void> {
    this.enter('comment', n, body);
    this.comments.set(n, [...(this.comments.get(n) ?? []), body]);
  }

  async merge(n: number, sha: string, title: string): Promise<{ merged: boolean; sha?: string }> {
    this.enter('merge', n, sha, title);
    const pr = this.prs.find(p => p.number === n);
    if (!pr || pr.state !== 'open') throw new Error('fake GitHub: PR not open (405)');
    if (this.remoteSha(pr.head) !== sha) throw new Error('fake GitHub: head sha mismatch (409)');
    const work = mkdtempSync(join(tmpdir(), 'iris-fake-merge-'));
    try {
      const g = (args: string[]) => execFileSync('git', ['-C', work, ...args], { encoding: 'utf8', stdio: 'pipe' });
      execFileSync('git', ['clone', '-q', this.bare, work], { stdio: 'pipe' });
      g(['config', 'user.email', 'github@iris.local']); g(['config', 'user.name', 'github']);
      g(['checkout', '-q', pr.base]);
      g(['merge', '-q', '--no-ff', '-m', title, `origin/${pr.head}`]);
      g(['push', '-q', 'origin', pr.base]);
      const merged = g(['rev-parse', 'HEAD']).trim();
      pr.state = 'closed'; pr.merged = true;
      return { merged: true, sha: merged };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** GitHub's update-branch: a real merge of the base into the head branch in the bare repo; a conflict is GitHub's 422. */
  async updateBranch(n: number, expectedHeadSha: string): Promise<{ updated: boolean; conflict?: boolean }> {
    this.enter('updateBranch', n, expectedHeadSha);
    const pr = this.prs.find(p => p.number === n);
    if (!pr || pr.state !== 'open') throw new Error('fake GitHub: PR not open (404)');
    if (this.remoteSha(pr.head) !== expectedHeadSha) return { updated: false, conflict: true };
    const work = mkdtempSync(join(tmpdir(), 'iris-fake-update-'));
    try {
      const g = (args: string[]) => execFileSync('git', ['-C', work, ...args], { encoding: 'utf8', stdio: 'pipe' });
      execFileSync('git', ['clone', '-q', this.bare, work], { stdio: 'pipe' });
      g(['config', 'user.email', 'github@iris.local']); g(['config', 'user.name', 'github']);
      g(['checkout', '-q', pr.head]);
      try { g(['merge', '-q', '--no-ff', '-m', `Merge branch '${pr.base}' into ${pr.head}`, `origin/${pr.base}`]); } catch { return { updated: false, conflict: true }; }
      g(['push', '-q', 'origin', pr.head]);
      pr.headSha = this.remoteSha(pr.head)!;
      return { updated: true };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  async fetchBranch(repoDir: string, branch: string): Promise<void> {
    this.enter('fetchBranch', repoDir, branch);
    execFileSync('git', ['-C', repoDir, 'fetch', '-q', this.bare, `refs/heads/${branch}:refs/heads/${branch}`], { stdio: 'pipe' });
  }

  async deleteBranch(branch: string): Promise<void> {
    this.enter('deleteBranch', branch);
    execFileSync('git', ['-C', this.bare, 'update-ref', '-d', `refs/heads/${branch}`], { stdio: 'pipe' });
  }

  async pullFfOnly(repoDir: string, branch: string): Promise<void> {
    this.enter('pullFfOnly', repoDir, branch);
    execFileSync('git', ['-C', repoDir, 'pull', '-q', '--ff-only', this.bare, branch], { stdio: 'pipe' });
  }

  cleanup(): void { rmSync(this.bare, { recursive: true, force: true }); }

  private view(pr: FakePr): PullRequest {
    return { number: pr.number, url: pr.url, headSha: pr.headSha, state: pr.state, merged: pr.merged };
  }
}
