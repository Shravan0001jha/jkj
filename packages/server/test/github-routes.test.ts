import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { start } from '../src/index.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { tmpWorkplace } from './fakes/tmp-workplace.js';

/** The COO's GitHub routes (docs/LLD-github-flow.md §6): loopback only, local by default. */

async function call<T>(base: string, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() as T };
}

test('GET/POST /api/coo/github and POST /api/coo/merge: local by default, loopback only, modes validated', async () => {
  const tmp = tmpWorkplace();
  tmp.db.close();
  mkdirSync(join(tmp.dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(tmp.dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test\n');
  const fake = installFakeRuntime();
  const config = loadConfig(['--no-open', '--no-telegram', '--no-seed', '--port', '0'], {
    IRIS_WORKPLACE_DIR: tmp.dir, IRIS_OPS_DIR: join(tmp.dir, 'ops'), IRIS_WORK_DIR: tmp.workDir, WORKPLACE_CAP_INR: '1000', WORKPLACE_USD_INR: '88',
  });
  const running = await start(config);
  const address = running.server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    const initial = await call<{ mode: string }>(base, 'GET', '/api/coo/github');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.mode, 'local');

    const tunnelled = await call<{ error: string }>(base, 'POST', '/api/coo/github', { mode: 'on' }, { 'x-via-tunnel': '1' });
    assert.equal(tunnelled.status, 400);
    const bad = await call<{ error: string }>(base, 'POST', '/api/coo/github', { mode: 'sometimes' });
    assert.equal(bad.status, 400);
    const set = await call<{ mode: string }>(base, 'POST', '/api/coo/github', { mode: 'shadow' });
    assert.equal(set.status, 200);
    assert.equal(set.body.mode, 'shadow');
    assert.equal((await call<{ mode: string }>(base, 'GET', '/api/coo/github')).body.mode, 'shadow');
    await call(base, 'POST', '/api/coo/github', { mode: 'local' });

    const merge = await call<{ error: string }>(base, 'POST', '/api/coo/merge', { itemId: 'as_nope' });
    assert.equal(merge.status, 400);
    assert.match(merge.body.error, /local/);
    const mergeTunnel = await call<{ error: string }>(base, 'POST', '/api/coo/merge', { itemId: 'as_nope' }, { 'x-via-tunnel': '1' });
    assert.equal(mergeTunnel.status, 400);
    assert.match(mergeTunnel.body.error, /this Mac/);
  } finally {
    await running.stop();
    fake.restore();
    tmp.cleanup();
  }
});
