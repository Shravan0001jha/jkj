import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { start } from '../src/index.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { tmpWorkplace } from './fakes/tmp-workplace.js';

/**
 * The report route (docs/LLD-evidence.md §5): a run's index.html and its files, read-only, never a
 * byte outside the run's directory, the same auth as every /api route (so the tunnel works), and the
 * queue for the COO from this Mac only.
 */

/** A raw GET: the path is sent exactly as given (fetch would normalise dot segments first). */
function rawGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/evidence/<item>/<run>/…: serves the report and its files; refuses traversal, symlinks out and bad ids; /api/coo/evidence is this Mac only', async () => {
  const tmp = tmpWorkplace();
  tmp.db.close();
  mkdirSync(join(tmp.dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(tmp.dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test\n');
  const fake = installFakeRuntime();
  const config = loadConfig(['--no-open', '--no-telegram', '--no-seed', '--port', '0'], {
    IRIS_WORKPLACE_DIR: tmp.dir, IRIS_OPS_DIR: join(tmp.dir, 'ops'), IRIS_WORK_DIR: tmp.workDir, WORKPLACE_CAP_INR: '1000', WORKPLACE_USD_INR: '88',
  });
  // A finished run, as the runner leaves it, plus a secret next to the evidence dir.
  const run = 'abcdef012345-20261004120000';
  const dir = join(config.evidence.dir, 'as_story1', run);
  mkdirSync(join(dir, 'shots'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><img src="shots/a.png">report');
  writeFileSync(join(dir, 'shots', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dir, 'summary.txt'), 'verdict PASS\n');
  writeFileSync(join(config.evidence.dir, 'secret.txt'), 'SECRET');
  writeFileSync(join(tmp.dir, 'top-secret.txt'), 'SECRET');
  symlinkSync(join(tmp.dir, 'top-secret.txt'), join(dir, 'link.txt'));
  mkdirSync(join(dir, '.hidden'), { recursive: true });
  writeFileSync(join(dir, '.hidden', 'x.txt'), 'SECRET');

  const running = await start(config);
  const address = running.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `/api/evidence/as_story1/${run}`;
  try {
    const page = await rawGet(port, `${base}/index.html`);
    assert.equal(page.status, 200);
    assert.match(page.body, /report/);
    assert.match(String(page.headers['content-type']), /text\/html/);
    assert.match(String(page.headers['content-security-policy']), /sandbox/, 'the report never runs as the Workplace origin');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal((await rawGet(port, `${base}/`)).status, 200, 'the run itself is its index.html');
    const shot = await rawGet(port, `${base}/shots/a.png`);
    assert.equal(shot.status, 200);
    assert.equal(shot.headers['content-type'], 'image/png');
    // Through the tunnel (the owner's phone): the same route answers.
    assert.equal((await rawGet(port, `${base}/summary.txt`, { 'x-via-tunnel': '1' })).status, 200);

    for (const bad of [
      `${base}/../../secret.txt`,                       // dot segments (the server normalises them away: no route)
      `${base}/..%2f..%2fsecret.txt`,                   // encoded slashes inside one segment
      `${base}/%2e%2e/%2e%2e/secret.txt`,
      `${base}/..%5c..%5csecret.txt`,                   // backslashes
      `${base}/link.txt`,                               // a symlink out of the run
      `${base}/.hidden/x.txt`,                          // hidden files
      `${base}/shots`,                                  // a directory
      `${base}/nope.html`,
      `/api/evidence/as_story1/not-a-run/index.html`,   // bad run id
      `/api/evidence/..%2f..%2f/${run}/index.html`,     // bad item id
      `/api/evidence/as_story1/${run}/%00`,
    ]) {
      const r = await rawGet(port, bad);
      assert.ok(r.status === 404, `${bad} → ${r.status}`);
      assert.doesNotMatch(r.body, /SECRET/, bad);
    }
    // Read-only: no other method reaches it.
    const post = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: `${base}/index.html`, method: 'POST' }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject); req.end();
    });
    assert.equal(post, 404);

    const q = await rawGet(port, '/api/coo/evidence');
    assert.equal(q.status, 200);
    const state = JSON.parse(q.body) as { slots: unknown[]; queued: unknown[]; recent: unknown[] };
    assert.equal(state.slots.length, 2);
    assert.deepEqual(state.queued, []);
    assert.equal((state as unknown as { staging: { state: string } }).staging.state, 'unknown', 'which server commit staging runs');
    const staging = await rawGet(port, '/api/coo/evidence/staging');
    assert.equal(staging.status, 200);
    assert.deepEqual(JSON.parse(staging.body), { state: 'unknown', sha: null });
    assert.equal((await rawGet(port, '/api/coo/evidence/staging', { 'x-via-tunnel': '1' })).status, 400);
    assert.equal((await rawGet(port, '/api/coo/evidence', { 'x-via-tunnel': '1' })).status, 400, 'the queue is for this Mac only');
  } finally {
    await running.stop();
    fake.restore();
    tmp.cleanup();
  }
});
