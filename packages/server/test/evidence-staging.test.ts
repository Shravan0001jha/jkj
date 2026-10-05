import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { RealServerDeployer, RealStaging } from '../src/services/evidence-ports.js';

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

test('RealServerDeployer: runs the checkout\'s own scripts/staging.sh deploy with STAGING_HOST, the repo\'s venv linked in; a failed deploy throws its reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-deploy-'));
  const repo = join(dir, 'repo');
  const checkout = join(dir, 'checkout');
  mkdirSync(join(repo, '.venv', 'bin'), { recursive: true });
  mkdirSync(join(checkout, 'scripts'), { recursive: true });
  const seen = join(dir, 'seen');
  const script = (body: string): void => writeFileSync(join(checkout, 'scripts', 'staging.sh'), `#!/usr/bin/env bash\n${body}\n`);
  const cfg = { ...loadConfig(['--no-open'], {}).evidence, stagingUrl: 'https://staging.example.test' };
  const deployer = new RealServerDeployer(cfg);
  try {
    script(`echo "$1|$STAGING_HOST|$(pwd -P)|\${GITHUB_TOKEN:-none}" > "${seen}"`);
    process.env['GITHUB_TOKEN'] = 'must-not-leak';
    await deployer.deploy({ repo, checkout, sha: 'abc', log: join(dir, 'deploy.log') });
    const [verb, host, cwd, token] = readFileSync(seen, 'utf8').trim().split('|');
    assert.equal(verb, 'deploy');
    assert.equal(host, 'staging.example.test');
    assert.equal(cwd, (await import('node:fs')).realpathSync(checkout));
    assert.equal(token, 'none', 'the Workplace\'s tokens never reach the deploy');
    assert.ok(lstatSync(join(checkout, '.venv')).isSymbolicLink(), 'the repo\'s .venv is linked for the deploy\'s local tests');

    script('echo "▶ 4/4 health check"; echo "❌ /healthz did not come back green" >&2; exit 1');
    await assert.rejects(deployer.deploy({ repo, checkout, sha: 'abc', log: join(dir, 'deploy.log') }), /exit 1.*healthz did not come back green/);

    rmSync(join(checkout, 'scripts', 'staging.sh'));
    await assert.rejects(deployer.deploy({ repo, checkout, sha: 'abc', log: join(dir, 'deploy.log') }), /no scripts\/staging\.sh/);
  } finally {
    delete process.env['GITHUB_TOKEN'];
    rmSync(dir, { recursive: true, force: true });
  }
});
