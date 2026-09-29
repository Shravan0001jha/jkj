import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { start } from '../src/index.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { tmpWorkplace } from './fakes/tmp-workplace.js';

/**
 * What the phone can show (docs/RESILIENCE-workplace.md §5): /api/health carries the boot count,
 * when this process started, the tunnel's last connect and the watchdog's incident, from the real
 * server over real HTTP.
 */

interface Health {
  ok: boolean;
  uptimeSeconds: number;
  workplace: { published: string };
  resilience: {
    startedAt: string;
    uptimeSeconds: number;
    boots: { total: number; last24h: number; recent: string[] };
    tunnel: null | { status: string; lastConnectedAt: string | null; connects: number };
    watchdog: { link: string; downSince: string | null; incident: unknown; incidents: number };
  };
}

test('/api/health reports boots, start time, tunnel and watchdog; a restart of the same organisation counts as a second boot', async () => {
  const tmp = tmpWorkplace();
  tmp.db.close();
  mkdirSync(join(tmp.dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(tmp.dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test\n');
  const fake = installFakeRuntime();
  const config = loadConfig(['--no-open', '--no-telegram', '--no-seed', '--port', '0'], {
    IRIS_WORKPLACE_DIR: tmp.dir, IRIS_OPS_DIR: join(tmp.dir, 'ops'), IRIS_WORK_DIR: tmp.workDir, WORKPLACE_CAP_INR: '1000', WORKPLACE_USD_INR: '88',
  });
  const fetchHealth = async (port: number): Promise<Health> => (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as Promise<Health>;
  try {
    const before = Date.now();
    let running = await start(config);
    let port = (running.server.address() as { port: number }).port;
    let h = await fetchHealth(port);
    assert.equal(h.ok, true);
    assert.equal(h.resilience.boots.total, 1);
    assert.equal(h.resilience.boots.last24h, 1);
    assert.equal(h.resilience.boots.recent.length, 1);
    assert.ok(Date.parse(h.resilience.startedAt) >= before - 1000, 'started now');
    assert.equal(typeof h.resilience.uptimeSeconds, 'number');
    assert.equal(h.workplace.published, 'not-configured');
    assert.equal(h.resilience.tunnel, null, 'no relay.env → no tunnel stats');
    assert.equal(h.resilience.watchdog.link, 'not-configured');
    assert.equal(h.resilience.watchdog.incident, null);
    assert.equal(h.resilience.watchdog.incidents, 0);
    await running.stop();

    running = await start(config);
    port = (running.server.address() as { port: number }).port;
    h = await fetchHealth(port);
    assert.equal(h.resilience.boots.total, 2, 'the second start of the same organisation is the second boot');
    assert.equal(h.resilience.boots.recent.length, 2);
    await running.stop();
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});
