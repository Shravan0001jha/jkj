import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { start, type Running } from '../../src/index.js';
import { installFakeRuntime, type FakeRuntime } from './fake-runtime.js';
import { tmpWorkplace, type TmpWorkplace } from './tmp-workplace.js';

/** The whole server over real HTTP on a random loopback port, a temp workplace, the fake runtime. */
export interface Booted { running: Running; base: string; tmp: TmpWorkplace; fake: FakeRuntime; stop(): Promise<void> }

export async function boot(env: Record<string, string> = {}): Promise<Booted> {
  const tmp = tmpWorkplace();
  tmp.db.close();
  mkdirSync(join(tmp.dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(tmp.dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test\n');
  const fake = installFakeRuntime();
  const config = loadConfig(['--no-open', '--no-telegram', '--no-seed', '--port', '0'], {
    IRIS_WORKPLACE_DIR: tmp.dir, IRIS_OPS_DIR: join(tmp.dir, 'ops'), WORKPLACE_CAP_INR: '1000', WORKPLACE_USD_INR: '88', ...env,
  });
  const running = await start(config);
  const port = (running.server.address() as { port: number }).port;
  return { running, base: `http://127.0.0.1:${port}`, tmp, fake, stop: async () => { await running.stop(); fake.restore(); tmp.cleanup(); } };
}

export async function call<T>(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() as T };
}

export const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
