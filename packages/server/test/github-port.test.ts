import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RealGitHub, redact, type Fetch } from '../src/services/github-port.js';

/**
 * The real GitHub port (docs/LLD-github-flow.md §2), with a fake token script and a fake fetch:
 * which App each call uses, the REST shapes, and that a token never reaches a message, a log line or
 * a command line.
 */

function tokenScript(dir: string, opts: { fail?: boolean } = {}): string {
  const path = join(dir, 'token.py');
  writeFileSync(path, [
    'import sys',
    `open(${JSON.stringify(join(dir, 'minted.log'))}, "a").write(sys.argv[1] + "\\n")`,
    opts.fail ? 'print("ghs_LEAKEDBUTFAILED0000000000000000"); sys.exit(3)' : 'print("ghs_" + sys.argv[1].replace("-", "") + "0123456789abcdefghij")',
  ].join('\n'));
  return path;
}

interface Call { url: string; method: string; auth?: string; body?: unknown }

function fakeFetch(calls: Call[], respond: (c: Call) => { status: number; body: unknown } = () => ({ status: 200, body: {} })): Fetch {
  return async (url, init) => {
    const c: Call = { url, method: init?.method ?? 'GET', ...(init?.headers?.['authorization'] ? { auth: init.headers['authorization'] } : {}), ...(init?.body ? { body: JSON.parse(init.body) } : {}) };
    calls.push(c);
    const r = respond(c);
    return { status: r.status, json: async () => r.body };
  };
}

function port(dir: string, fetch: Fetch, script = tokenScript(dir)): RealGitHub {
  return new RealGitHub({ org: 'shravan0001jha-iris-hq', repo: 'iris', tokenScript: script, pushApp: 'iris-workplace', reviewApp: 'iris-review', fetch });
}

test('PRs use the iris-workplace App, statuses the iris-review App; tokens are minted once per App', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-ghport-'));
  try {
    const calls: Call[] = [];
    const gh = port(dir, fakeFetch(calls, c => c.url.endsWith('/pulls') && c.method === 'POST'
      ? { status: 201, body: { number: 7, html_url: 'https://github.com/x/pull/7', head: { sha: 'abc' }, state: 'open', merged: false } }
      : { status: 201, body: {} }));
    const pr = await gh.openPr({ title: 't', body: 'b', head: 'emp/kabir/as_1', base: 'feat/iris-character' });
    assert.deepEqual(pr, { number: 7, url: 'https://github.com/x/pull/7', headSha: 'abc', state: 'open', merged: false });
    await gh.setStatus('abc', { context: 'workplace/review', state: 'pending', description: 'needs approvals' });
    await gh.setStatus('abc', { context: 'workplace/tests', state: 'success', description: 'green' });
    assert.equal(calls[0]!.url, 'https://api.github.com/repos/shravan0001jha-iris-hq/iris/pulls');
    assert.equal(calls[0]!.auth, 'Bearer ghs_irisworkplace0123456789abcdefghij');
    assert.equal(calls[1]!.url, 'https://api.github.com/repos/shravan0001jha-iris-hq/iris/statuses/abc');
    assert.equal(calls[1]!.auth, 'Bearer ghs_irisreview0123456789abcdefghij');
    assert.deepEqual(calls[1]!.body, { context: 'workplace/review', state: 'pending', description: 'needs approvals' });
    assert.deepEqual(readFileSync(join(dir, 'minted.log'), 'utf8').trim().split('\n'), ['iris-workplace', 'iris-review']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a status carries its target_url; a PR comment goes to the issue comments as the push App', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-ghport-'));
  try {
    const calls: Call[] = [];
    const gh = port(dir, fakeFetch(calls, () => ({ status: 201, body: {} })));
    await gh.setStatus('abc', { context: 'workplace/evidence', state: 'success', description: '4 passed', targetUrl: 'https://s3.example/x?sig=1' });
    await gh.comment(7, 'Evidence PASS');
    assert.deepEqual(calls[0]!.body, { context: 'workplace/evidence', state: 'success', description: '4 passed', target_url: 'https://s3.example/x?sig=1' });
    assert.equal(calls[1]!.url, 'https://api.github.com/repos/shravan0001jha-iris-hq/iris/issues/7/comments');
    assert.equal(calls[1]!.auth, 'Bearer ghs_irisworkplace0123456789abcdefghij');
    assert.deepEqual(calls[1]!.body, { body: 'Evidence PASS' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an existing PR for the branch is found instead of failing (422)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-ghport-'));
  try {
    const calls: Call[] = [];
    const gh = port(dir, fakeFetch(calls, c => c.method === 'POST'
      ? { status: 422, body: { message: 'A pull request already exists' } }
      : { status: 200, body: [{ number: 9, html_url: 'u9', head: { sha: 'def' }, state: 'open', merged_at: null }] }));
    const pr = await gh.openPr({ title: 't', body: 'b', head: 'emp/kabir/as_1', base: 'feat/iris-character' });
    assert.equal(pr.number, 9);
    assert.match(calls[1]!.url, /\/pulls\?head=shravan0001jha-iris-hq%3Aemp%2Fkabir%2Fas_1&state=open$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('merge uses a merge commit pinned to the reviewed sha; the branch is deleted by ref', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-ghport-'));
  try {
    const calls: Call[] = [];
    const gh = port(dir, fakeFetch(calls, c => c.url.endsWith('/merge') ? { status: 200, body: { merged: true, sha: 'm1' } } : { status: 204, body: {} }));
    assert.deepEqual(await gh.merge(7, 'abc', 'Merge story'), { merged: true, sha: 'm1' });
    await gh.deleteBranch('emp/kabir/as_1');
    assert.equal(calls[0]!.method, 'PUT');
    assert.deepEqual(calls[0]!.body, { merge_method: 'merge', sha: 'abc', commit_title: 'Merge story' });
    assert.equal(calls[1]!.method, 'DELETE');
    assert.match(calls[1]!.url, /\/git\/refs\/heads\/emp\/kabir\/as_1$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a token never reaches an error message or a git command line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-ghport-'));
  try {
    const gh = port(dir, fakeFetch([], () => ({ status: 401, body: { message: 'Bad credentials for ghs_irisworkplace0123456789abcdefghij' } })));
    await assert.rejects(gh.getPr(1), (err: Error) => {
      assert.match(err.message, /401/);
      assert.ok(!err.message.includes('ghs_irisworkplace'), err.message);
      return true;
    });
    const auth = await gh.gitAuth();
    assert.equal(auth.url, 'https://github.com/shravan0001jha-iris-hq/iris.git');
    assert.ok(!auth.url.includes('ghs_'));
    const values = Object.entries(auth.env).filter(([k]) => k.startsWith('GIT_CONFIG_VALUE_')).map(([, v]) => v);
    assert.ok(values.some(v => v.startsWith('AUTHORIZATION: basic ')), 'the token rides in the environment only');
    assert.equal(auth.env['GIT_TERMINAL_PROMPT'], '0');

    const failing = port(dir, fakeFetch([]), tokenScript(mkdtempSync(join(tmpdir(), 'iris-ghtok-')), { fail: true }));
    await assert.rejects(failing.getPr(1), (err: Error) => {
      assert.match(err.message, /token/i);
      assert.ok(!err.message.includes('LEAKEDBUTFAILED'), err.message);
      return true;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('redact strips tokens and basic credentials from any text', () => {
  const t = redact('push https://x-access-token:ghs_abcdefghijklmnopqrstuv@github.com/x AUTHORIZATION: basic eC1hY2Nlc3M= and ghp_abcdefghijklmnopqrstuvwxyz0123456789 and github_pat_11AAAA_bbbb');
  assert.ok(!/ghs_abc|ghp_abc|eC1hY2Nlc3M|github_pat_11/.test(t), t);
});
