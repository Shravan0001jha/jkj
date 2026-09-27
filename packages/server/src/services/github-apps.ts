import { createSign, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../util/logger.js';
import { BadRequest } from '../util/errors.js';

/**
 * One GitHub App per lead (HLD D12). The Workplace holds the App's
 * configuration and private key, mints short JWTs, exchanges them for hourly
 * installation tokens, and does PR plumbing with them. It never creates
 * Apps, never logs a token, and never returns a key or a token to a client.
 */

export interface AppConfig {
  slug: string;
  appId: number;
  installationId: number;
  /** Absolute path of the PEM, mode 600, under ~/iris-ops/workplace/apps/. Never read into a response. */
  keyPath: string;
  org: string;
  repos: string[];
}

export interface AppPresence {
  slug: string;
  configured: boolean;
  keyPresent: boolean;
  org?: string;
  repos?: string[];
}

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface GitHubOptions {
  appsDir: string;
  fetch?: Fetch;
  apiBase?: string;
  now?: () => number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class GitHubApps {
  private readonly cache = new Map<string, CachedToken>();
  private readonly fetchImpl: Fetch;
  private readonly apiBase: string;
  private readonly now: () => number;

  constructor(private readonly options: GitHubOptions) {
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as Fetch);
    this.apiBase = options.apiBase ?? 'https://api.github.com';
    this.now = options.now ?? Date.now;
  }

  /** What exists, never what it contains. Safe to show in a UI. */
  list(): AppPresence[] {
    if (!existsSync(this.options.appsDir)) return [];
    return readdirSync(this.options.appsDir)
      .filter(n => n.endsWith('.json'))
      .map(n => {
        const slug = n.replace(/\.json$/, '');
        const config = this.readConfig(slug);
        return {
          slug,
          configured: config !== null,
          keyPresent: config !== null && existsSync(config.keyPath),
          ...(config ? { org: config.org, repos: config.repos } : {}),
        };
      });
  }

  presence(slug: string): AppPresence {
    return this.list().find(a => a.slug === slug) ?? { slug, configured: false, keyPresent: false };
  }

  /** A 9-minute RS256 JWT for the App itself (GitHub allows 10). */
  appJwt(slug: string): string {
    const config = this.requireConfig(slug);
    const key = readFileSync(config.keyPath, 'utf8');
    const nowSec = Math.floor(this.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: String(config.appId) }));
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key);
    return `${header}.${payload}.${b64url(signature)}`;
  }

  /** An installation token, cached until five minutes before it expires. */
  async installationToken(slug: string): Promise<string> {
    const cached = this.cache.get(slug);
    if (cached && cached.expiresAt - this.now() > 5 * 60 * 1000) return cached.token;

    const config = this.requireConfig(slug);
    const res = await this.fetchImpl(`${this.apiBase}/app/installations/${config.installationId}/access_tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.appJwt(slug)}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (res.status !== 201) throw new Error(`GitHub refused an installation token for ${slug} (${res.status})`);
    const body = await res.json() as { token: string; expires_at: string };
    this.cache.set(slug, { token: body.token, expiresAt: new Date(body.expires_at).getTime() });
    log.info('github', `minted an installation token for ${slug}`);   // never the token itself
    return body.token;
  }

  async openPr(slug: string, repo: string, pr: { title: string; body: string; head: string; base: string }): Promise<{ number: number; url: string }> {
    const config = this.requireConfig(slug);
    const res = await this.api(slug, 'POST', `/repos/${config.org}/${repo}/pulls`, pr);
    const data = res as { number: number; html_url: string };
    return { number: data.number, url: data.html_url };
  }

  async requestReview(slug: string, repo: string, number: number, reviewers: string[]): Promise<void> {
    const config = this.requireConfig(slug);
    await this.api(slug, 'POST', `/repos/${config.org}/${repo}/pulls/${number}/requested_reviewers`, { reviewers });
  }

  async approve(slug: string, repo: string, number: number, body: string): Promise<void> {
    const config = this.requireConfig(slug);
    await this.api(slug, 'POST', `/repos/${config.org}/${repo}/pulls/${number}/reviews`, { event: 'APPROVE', body });
  }

  async checks(slug: string, repo: string, ref: string): Promise<{ total: number; passed: number; failed: number; pending: number }> {
    const config = this.requireConfig(slug);
    const data = await this.api(slug, 'GET', `/repos/${config.org}/${repo}/commits/${ref}/check-runs`) as { check_runs: { status: string; conclusion: string | null }[] };
    const runs = data.check_runs ?? [];
    return {
      total: runs.length,
      passed: runs.filter(r => r.conclusion === 'success').length,
      failed: runs.filter(r => r.conclusion && r.conclusion !== 'success' && r.conclusion !== 'neutral' && r.conclusion !== 'skipped').length,
      pending: runs.filter(r => r.status !== 'completed').length,
    };
  }

  async merge(slug: string, repo: string, number: number): Promise<{ merged: boolean; sha?: string }> {
    const config = this.requireConfig(slug);
    const data = await this.api(slug, 'PUT', `/repos/${config.org}/${repo}/pulls/${number}/merge`, { merge_method: 'squash' }) as { merged: boolean; sha?: string };
    return { merged: !!data.merged, ...(data.sha ? { sha: data.sha } : {}) };
  }

  private async api(slug: string, method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await this.installationToken(slug);
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status >= 300) throw new Error(`GitHub ${method} ${path} failed (${res.status})`);
    return res.json();
  }

  private readConfig(slug: string): AppConfig | null {
    try {
      const raw = JSON.parse(readFileSync(join(this.options.appsDir, `${slug}.json`), 'utf8')) as Partial<AppConfig>;
      if (!raw.appId || !raw.installationId || !raw.org) return null;
      return {
        slug,
        appId: raw.appId,
        installationId: raw.installationId,
        keyPath: raw.keyPath ?? join(this.options.appsDir, `${slug}.pem`),
        org: raw.org,
        repos: raw.repos ?? [],
      };
    } catch {
      return null;
    }
  }

  private requireConfig(slug: string): AppConfig {
    const config = this.readConfig(slug);
    if (!config) throw new BadRequest(`GitHub App "${slug}" is not configured (expected ${join(this.options.appsDir, `${slug}.json`)}).`);
    if (!existsSync(config.keyPath)) throw new BadRequest(`GitHub App "${slug}" has no private key on this machine.`);
    return config;
  }
}

const b64url = (input: string | Buffer): string =>
  Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export const newIdempotencyKey = (): string => randomUUID();
