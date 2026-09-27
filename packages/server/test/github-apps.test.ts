import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubApps, type Fetch } from '../src/services/github-apps.js';

function appsDir(): { dir: string; publicKey: string } {
  const dir = mkdtempSync(join(tmpdir(), 'apps-'));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(join(dir, 'iris-mobile-lead.pem'), privateKey.export({ type: 'pkcs1', format: 'pem' }), { mode: 0o600 });
  writeFileSync(join(dir, 'iris-mobile-lead.json'), JSON.stringify({ appId: 12345, installationId: 777, org: 'shravan0001jha-iris-hq', repos: ['iris-mobile'] }));
  writeFileSync(join(dir, 'iris-qa.json'), JSON.stringify({ appId: 1, installationId: 2, org: 'shravan0001jha-iris-hq' }));   // no key
  return { dir, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) as string };
}

function fakeFetch(log: { url: string; method: string; body?: string; auth?: string }[], expiresInMs = 3600_000, now = () => Date.now()): Fetch {
  return async (url, init) => {
    log.push({ url, method: init?.method ?? 'GET', ...(init?.body ? { body: init.body } : {}), ...(init?.headers?.['authorization'] ? { auth: init.headers['authorization'] } : {}) });
    if (url.endsWith('/access_tokens')) return { status: 201, json: async () => ({ token: `ghs_${log.length}`, expires_at: new Date(now() + expiresInMs).toISOString() }) };
    if (url.endsWith('/pulls') && init?.method === 'POST') return { status: 201, json: async () => ({ number: 42, html_url: 'https://github.com/x/y/pull/42' }) };
    if (url.includes('/check-runs')) return { status: 200, json: async () => ({ check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null }] }) };
    if (url.endsWith('/merge')) return { status: 200, json: async () => ({ merged: true, sha: 'deadbeef' }) };
    return { status: 200, json: async () => ({}) };
  };
}

test('presence reports what exists, never what it contains', () => {
  const { dir } = appsDir();
  try {
    const apps = new GitHubApps({ appsDir: dir, fetch: fakeFetch([]) });
    const list = apps.list().sort((a, b) => a.slug.localeCompare(b.slug));
    assert.deepEqual(list.map(a => [a.slug, a.configured, a.keyPresent]), [['iris-mobile-lead', true, true], ['iris-qa', true, false]]);
    assert.ok(!JSON.stringify(list).includes('PRIVATE KEY'));
    assert.ok(!JSON.stringify(list).includes('.pem'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the App JWT is RS256 with iat-60 and a nine-minute exp, signed by the key on disk', () => {
  const { dir, publicKey } = appsDir();
  try {
    const now = 1_790_000_000_000;
    const apps = new GitHubApps({ appsDir: dir, fetch: fakeFetch([]), now: () => now });
    const jwt = apps.appJwt('iris-mobile-lead');
    const [h, p, s] = jwt.split('.');
    const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
    assert.equal(payload.iss, '12345');
    assert.equal(payload.iat, Math.floor(now / 1000) - 60);
    assert.equal(payload.exp - payload.iat, 600);
    assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, 'base64url')));
    assert.throws(() => apps.appJwt('iris-qa'), /no private key/);
    assert.throws(() => apps.appJwt('nope'), /not configured/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installation tokens are minted once and cached until five minutes before expiry', async () => {
  const { dir } = appsDir();
  try {
    let now = 1_790_000_000_000;
    const log: { url: string; method: string }[] = [];
    const apps = new GitHubApps({ appsDir: dir, fetch: fakeFetch(log, 3600_000, () => now), now: () => now });
    const t1 = await apps.installationToken('iris-mobile-lead');
    const t2 = await apps.installationToken('iris-mobile-lead');
    assert.equal(t1, t2);
    assert.equal(log.filter(l => l.url.endsWith('/access_tokens')).length, 1);
    assert.ok(log[0]!.url.endsWith('/app/installations/777/access_tokens'));
    now += 56 * 60 * 1000;   // 4 minutes left: refresh
    const t3 = await apps.installationToken('iris-mobile-lead');
    assert.notEqual(t3, t1);
    assert.equal(log.filter(l => l.url.endsWith('/access_tokens')).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PR plumbing hits the right endpoints with the installation token', async () => {
  const { dir } = appsDir();
  try {
    const log: { url: string; method: string; body?: string; auth?: string }[] = [];
    const apps = new GitHubApps({ appsDir: dir, fetch: fakeFetch(log) });
    const pr = await apps.openPr('iris-mobile-lead', 'iris-mobile', { title: 'Errand composer', body: 'x', head: 'tara/errands', base: 'main' });
    assert.deepEqual(pr, { number: 42, url: 'https://github.com/x/y/pull/42' });
    await apps.requestReview('iris-mobile-lead', 'iris-mobile', 42, ['iris-qa[bot]']);
    const checks = await apps.checks('iris-mobile-lead', 'iris-mobile', 'abc');
    assert.deepEqual(checks, { total: 2, passed: 1, failed: 0, pending: 1 });
    const merged = await apps.merge('iris-mobile-lead', 'iris-mobile', 42);
    assert.deepEqual(merged, { merged: true, sha: 'deadbeef' });

    const calls = log.filter(l => !l.url.endsWith('/access_tokens'));
    assert.deepEqual(calls.map(l => `${l.method} ${new URL(l.url).pathname}`), [
      'POST /repos/shravan0001jha-iris-hq/iris-mobile/pulls',
      'POST /repos/shravan0001jha-iris-hq/iris-mobile/pulls/42/requested_reviewers',
      'GET /repos/shravan0001jha-iris-hq/iris-mobile/commits/abc/check-runs',
      'PUT /repos/shravan0001jha-iris-hq/iris-mobile/pulls/42/merge',
    ]);
    assert.ok(calls.every(l => l.auth?.startsWith('Bearer ghs_')));
    assert.ok(log[0]!.auth?.startsWith('Bearer ey'), 'the token request itself carries the App JWT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
