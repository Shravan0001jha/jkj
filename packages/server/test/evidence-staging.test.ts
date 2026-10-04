import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { RealStaging } from '../src/services/evidence-ports.js';

/**
 * Staging by name (docs/HLD-evidence.md D6, 4 Oct gate): staging.sh checks health by IP, but the
 * apps need the name, and a stop by someone else deletes the A record again. ensureUp runs the
 * (idempotent) start again while it waits, healthy by name or a clear error; it never stops staging.
 */
test('RealStaging: healthy at once → no start; down → start, and start again while the name does not answer; gives up with a clear error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-staging-'));
  let healthyAfterStarts = 2;
  const server = createServer((_req, res) => {
    const starts = (() => { try { return readFileSync(join(dir, 'starts'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } })();
    res.writeHead(starts >= healthyAfterStarts ? 200 : 503); res.end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const script = join(dir, 'staging.sh');
  writeFileSync(script, `#!/usr/bin/env bash\n[ "$1" = start ] || { echo "only start: $1" >> "${join(dir, 'other')}"; exit 3; }\necho start >> "${join(dir, 'starts')}"\n`);
  const cfg = { ...loadConfig(['--no-open'], {}).evidence, stagingUrl: `http://127.0.0.1:${port}`, stagingScript: script };
  const starts = (): number => { try { return readFileSync(join(dir, 'starts'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
  try {
    await new RealStaging(cfg, join(dir, 'log'), 3000, 150, 20).ensureUp();
    assert.equal(starts(), 2, 'start ran again while the name was not answering');

    rmSync(join(dir, 'starts'));
    healthyAfterStarts = 0;
    await new RealStaging(cfg, join(dir, 'log'), 3000, 150, 20).ensureUp();
    assert.equal(starts(), 0, 'already healthy: never started');

    healthyAfterStarts = 1000;
    await assert.rejects(new RealStaging(cfg, join(dir, 'log'), 400, 100, 20).ensureUp(), /did not answer by name/);
    assert.throws(() => readFileSync(join(dir, 'other')), 'only ever `start`, never stop');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
