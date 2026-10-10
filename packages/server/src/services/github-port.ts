import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from '../util/logger.js';

const run = promisify(execFile);

/**
 * GitHub, behind an interface (docs/LLD-github-flow.md §2), so the flow is tested against a fake
 * backed by a local bare repository and runs live against shravan0001jha-iris-hq/iris.
 *
 * The real port mints GitHub App installation tokens with `token.py <slug>`: `iris-workplace` pushes,
 * opens and merges PRs; `iris-review` posts the workplace/* statuses. A token lives only in memory
 * and in a git child's environment: never in a command line, a remote URL, a log line or an error.
 */

export type StatusState = 'pending' | 'success' | 'failure' | 'error';

export interface PullRequest {
  number: number;
  url: string;
  headSha: string;
  state: 'open' | 'closed';
  merged: boolean;
}

export interface GitHubPort {
  /** Push `refs/heads/<branch>` of `repoDir` to the same name on GitHub. Never forced. */
  push(repoDir: string, branch: string): Promise<void>;
  findOpenPr(branch: string): Promise<PullRequest | null>;
  openPr(pr: { title: string; body: string; head: string; base: string }): Promise<PullRequest>;
  getPr(n: number): Promise<PullRequest>;
  setStatus(sha: string, s: { context: string; state: StatusState; description: string; targetUrl?: string }): Promise<void>;
  /** A comment on the PR's conversation (posted by the push App). */
  comment(n: number, body: string): Promise<void>;
  /** A merge commit, and only if the PR head is still `sha`. */
  merge(n: number, sha: string, title: string): Promise<{ merged: boolean; sha?: string }>;
  deleteBranch(branch: string): Promise<void>;
  /** `git pull --ff-only` of `branch` into the checkout at `repoDir`; throws when it cannot fast-forward. */
  pullFfOnly(repoDir: string, branch: string): Promise<void>;
  /**
   * Merge the base into the PR's branch on GitHub (PUT /pulls/{n}/update-branch), only if its head is
   * still `expectedHeadSha`. `conflict` when GitHub refuses with 422 (a conflict, or the head moved).
   */
  updateBranch(n: number, expectedHeadSha: string): Promise<{ updated: boolean; conflict?: boolean }>;
  /** Fast-forward the local `refs/heads/<branch>` of `repoDir` to GitHub's (no checkout touched); throws when it cannot. */
  fetchBranch(repoDir: string, branch: string): Promise<void>;
}

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface RealGitHubOptions {
  org: string;
  repo: string;
  tokenScript: string;
  pushApp: string;
  reviewApp: string;
  fetch?: Fetch;
  apiBase?: string;
  python?: string;
  now?: () => number;
}

/** Tokens, `x-access-token:` credentials and basic-auth values, wherever they appear in a text. */
export function redact(text: string): string {
  return text
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+)/g, '[redacted]')
    .replace(/x-access-token:[^@\s]+/gi, 'x-access-token:[redacted]')
    .replace(/(basic|bearer)\s+[A-Za-z0-9+/=._-]+/gi, '$1 [redacted]');
}

const TOKEN_TTL_MS = 50 * 60_000;   // installation tokens live an hour

export class RealGitHub implements GitHubPort {
  private readonly tokens = new Map<string, { token: string; at: number }>();
  private readonly fetchImpl: Fetch;
  private readonly apiBase: string;
  private readonly now: () => number;

  constructor(private readonly o: RealGitHubOptions) {
    this.fetchImpl = o.fetch ?? (globalThis.fetch as unknown as Fetch);
    this.apiBase = o.apiBase ?? 'https://api.github.com';
    this.now = o.now ?? Date.now;
  }

  private get repoPath(): string { return `/repos/${this.o.org}/${this.o.repo}`; }

  /** An installation token for the App, from token.py, cached for 50 minutes. Never logged. */
  private async token(slug: string): Promise<string> {
    const cached = this.tokens.get(slug);
    if (cached && this.now() - cached.at < TOKEN_TTL_MS) return cached.token;
    let out: string;
    try {
      out = (await run(this.o.python ?? 'python3', [this.o.tokenScript, slug], { timeout: 20_000, maxBuffer: 64 * 1024 })).stdout;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      // stdout/stderr are never quoted: a half-printed token must not reach a message.
      throw new Error(`could not get a GitHub token for ${slug} (token.py exited ${String(code ?? 'with an error')})`);
    }
    const token = out.trim().split('\n').pop()?.trim() ?? '';
    if (!/^[A-Za-z0-9_.-]{20,}$/.test(token)) throw new Error(`token.py printed no usable token for ${slug}`);
    this.tokens.set(slug, { token, at: this.now() });
    log.info('github', `minted an installation token for ${slug}`);
    return token;
  }

  private async api(slug: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const token = await this.token(slug);
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        'user-agent': 'iris-workplace', ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let data: unknown = null;
    try { data = await res.json(); } catch { /* 204 */ }
    return { status: res.status, data };
  }

  private async ok(slug: string, method: string, path: string, body?: unknown, okStatuses = [200, 201, 204]): Promise<unknown> {
    const { status, data } = await this.api(slug, method, path, body);
    if (!okStatuses.includes(status)) {
      const msg = typeof (data as { message?: unknown })?.message === 'string' ? `: ${(data as { message: string }).message}` : '';
      throw new Error(redact(`GitHub ${method} ${path} failed (${status})${msg}`));
    }
    return data;
  }

  /** The remote URL and the environment that authenticates a git child with the push App's token. */
  async gitAuth(): Promise<{ url: string; env: Record<string, string> }> {
    const token = await this.token(this.o.pushApp);
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    return {
      url: `https://github.com/${this.o.org}/${this.o.repo}.git`,
      env: {
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '2',
        // No stored credential helper may answer instead (or as well): only the App's token.
        GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
      },
    };
  }

  private async git(repoDir: string, args: (url: string) => string[]): Promise<void> {
    const auth = await this.gitAuth();
    try {
      await run('git', ['-C', repoDir, ...args(auth.url)], { env: { ...process.env, ...auth.env }, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new Error(redact(String(e.stderr || e.message || err).trim().split('\n').slice(-3).join(' ')));
    }
  }

  async push(repoDir: string, branch: string): Promise<void> {
    await this.git(repoDir, url => ['push', '--quiet', '--no-verify', url, `refs/heads/${branch}:refs/heads/${branch}`]);
  }

  async pullFfOnly(repoDir: string, branch: string): Promise<void> {
    await this.git(repoDir, url => ['pull', '--quiet', '--ff-only', url, branch]);
  }

  async findOpenPr(branch: string): Promise<PullRequest | null> {
    const q = `head=${encodeURIComponent(`${this.o.org}:${branch}`)}&state=open`;
    const list = await this.ok(this.o.pushApp, 'GET', `${this.repoPath}/pulls?${q}`) as unknown[];
    return Array.isArray(list) && list.length ? view(list[0]) : null;
  }

  async openPr(pr: { title: string; body: string; head: string; base: string }): Promise<PullRequest> {
    const { status, data } = await this.api(this.o.pushApp, 'POST', `${this.repoPath}/pulls`, pr);
    if (status === 201) return view(data);
    if (status === 422) {
      const existing = await this.findOpenPr(pr.head);
      if (existing) return existing;
    }
    const msg = typeof (data as { message?: unknown })?.message === 'string' ? `: ${(data as { message: string }).message}` : '';
    throw new Error(redact(`GitHub could not open a PR for ${pr.head} (${status})${msg}`));
  }

  async getPr(n: number): Promise<PullRequest> {
    return view(await this.ok(this.o.pushApp, 'GET', `${this.repoPath}/pulls/${n}`));
  }

  async setStatus(sha: string, s: { context: string; state: StatusState; description: string; targetUrl?: string }): Promise<void> {
    await this.ok(this.o.reviewApp, 'POST', `${this.repoPath}/statuses/${sha}`, { context: s.context, state: s.state, description: s.description.slice(0, 140), ...(s.targetUrl ? { target_url: s.targetUrl } : {}) });
  }

  async comment(n: number, body: string): Promise<void> {
    await this.ok(this.o.pushApp, 'POST', `${this.repoPath}/issues/${n}/comments`, { body: body.slice(0, 60_000) }, [201, 200]);
  }

  async merge(n: number, sha: string, title: string): Promise<{ merged: boolean; sha?: string }> {
    const data = await this.ok(this.o.pushApp, 'PUT', `${this.repoPath}/pulls/${n}/merge`, { merge_method: 'merge', sha, commit_title: title }) as { merged?: boolean; sha?: string };
    return { merged: !!data?.merged, ...(data?.sha ? { sha: data.sha } : {}) };
  }

  async fetchBranch(repoDir: string, branch: string): Promise<void> {
    await this.git(repoDir, url => ['fetch', '--quiet', url, `refs/heads/${branch}:refs/heads/${branch}`]);
  }

  async updateBranch(n: number, expectedHeadSha: string): Promise<{ updated: boolean; conflict?: boolean }> {
    const { status, data } = await this.api(this.o.pushApp, 'PUT', `${this.repoPath}/pulls/${n}/update-branch`, { expected_head_sha: expectedHeadSha });
    if (status === 202 || status === 200) return { updated: true };
    if (status === 422) return { updated: false, conflict: true };
    const msg = typeof (data as { message?: unknown })?.message === 'string' ? `: ${(data as { message: string }).message}` : '';
    throw new Error(redact(`GitHub PUT ${this.repoPath}/pulls/${n}/update-branch failed (${status})${msg}`));
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.ok(this.o.pushApp, 'DELETE', `${this.repoPath}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, undefined, [204, 200, 422]);
  }
}

function view(raw: unknown): PullRequest {
  const p = raw as { number: number; html_url: string; head?: { sha?: string }; state?: string; merged?: boolean; merged_at?: string | null };
  return {
    number: p.number,
    url: p.html_url,
    headSha: p.head?.sha ?? '',
    state: p.state === 'closed' ? 'closed' : 'open',
    merged: !!p.merged || !!p.merged_at,
  };
}
