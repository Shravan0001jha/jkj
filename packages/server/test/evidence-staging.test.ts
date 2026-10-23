import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync as rf } from 'node:fs';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { RealServerDeployer, RealStaging, trunkTooling, scriptsReferenced, classifyDeployPath, DEPLOY_TOOLING_PATHS } from '../src/services/evidence-ports.js';

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
  const deployer = new RealServerDeployer(cfg, undefined, undefined, undefined, async () => ({ 'scripts/staging.sh': rf(join(checkout, 'scripts', 'staging.sh'), 'utf8') }));
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
  } finally {
    delete process.env['GITHUB_TOKEN'];
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RealServerDeployer: passes STAGING_DEPLOY_FOR_EVIDENCE = the run nonce only (not the whole key value), only while held', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-deploy-env-'));
  const repo = join(dir, 'repo'); const checkout = join(dir, 'checkout');
  mkdirSync(join(repo, '.venv', 'bin'), { recursive: true });
  mkdirSync(join(checkout, 'scripts'), { recursive: true });
  const seen = join(dir, 'seen');
  writeFileSync(join(checkout, 'scripts', 'staging.sh'), `#!/usr/bin/env bash\necho "\${STAGING_DEPLOY_FOR_EVIDENCE:-unset}" > "${seen}"\n`);
  const cfg = { ...loadConfig(['--no-open'], {}).evidence, stagingUrl: 'https://staging.example.test' };
  try {
    await new RealServerDeployer(cfg, undefined, async () => 'abcd1234abcd1234', undefined, async () => ({ 'scripts/staging.sh': rf(join(checkout, 'scripts', 'staging.sh'), 'utf8') })).deploy({ repo, checkout, sha: 'abc', log: join(dir, 'd.log') });
    assert.equal(readFileSync(seen, 'utf8').trim(), 'abcd1234abcd1234');
    await new RealServerDeployer(cfg, undefined, async () => null, undefined, async () => ({ 'scripts/staging.sh': rf(join(checkout, 'scripts', 'staging.sh'), 'utf8') })).deploy({ repo, checkout, sha: 'abc', log: join(dir, 'd.log') });
    assert.equal(readFileSync(seen, 'utf8').trim(), 'unset');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('RealServerDeployer: releases the legacy key around the deploy only when the staging.sh that runs (trunk\'s) does not know the evidence key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-deploy-mig-'));
  const repo = join(dir, 'repo'); const checkout = join(dir, 'checkout');
  mkdirSync(join(repo, '.venv', 'bin'), { recursive: true });
  mkdirSync(join(checkout, 'scripts'), { recursive: true });
  const cfg = { ...loadConfig(['--no-open'], {}).evidence, stagingUrl: 'https://staging.example.test' };
  const events: string[] = [];
  const around = async <T>(fn: () => Promise<T>): Promise<T> => { events.push('release'); try { return await fn(); } finally { events.push('re-hold'); } };
  let trunkText = '';
  const d = new RealServerDeployer(cfg, undefined, async () => 'n', around, async () => ({ 'scripts/staging.sh': trunkText }));
  try {
    trunkText = '#!/usr/bin/env bash\ntrue\n';
    await d.deploy({ repo, checkout, sha: 'abc', log: join(dir, 'd.log') });
    assert.deepEqual(events, ['release', 're-hold']);
    events.length = 0;
    trunkText = '#!/usr/bin/env bash\n# STAGING_DEPLOY_FOR_EVIDENCE\ntrue\n';
    await d.deploy({ repo, checkout, sha: 'abc', log: join(dir, 'd.log') });
    assert.deepEqual(events, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const OLD = '#!/usr/bin/env bash\n# old tooling DEPLOY_LOCK_WAIT=600\necho old > "$SEEN"\n';

test('RealServerDeployer: runs TRUNK\'s staging.sh over a story checkout\'s old one, logs its sha, and restores the story\'s afterwards (also on failure)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-deploy-trunk-'));
  const repo = join(dir, 'repo'); const checkout = join(dir, 'checkout');
  mkdirSync(join(repo, '.venv', 'bin'), { recursive: true });
  mkdirSync(join(checkout, 'scripts'), { recursive: true });
  const seen = join(dir, 'seen'); const logf = join(dir, 'd.log');
  const staging = join(checkout, 'scripts', 'staging.sh');
  writeFileSync(staging, OLD);
  writeFileSync(join(checkout, 'scripts', 'deploy-api.sh'), 'story payload\n');
  const cfg = { ...loadConfig(['--no-open'], {}).evidence, stagingUrl: 'https://staging.example.test' };
  const trunk = `#!/usr/bin/env bash\n# STAGING_DEPLOY_FOR_EVIDENCE\necho trunk "$(basename "$(pwd)")" > "${seen}"\ngrep -q trunk-marker "$0" && exit \${FAIL:-0}\n# trunk-marker\n`;
  const mk = (around?: <T>(fn: () => Promise<T>) => Promise<T>) => new RealServerDeployer(cfg, undefined, async () => 'n', around, async () => ({ 'scripts/staging.sh': trunk, 'scripts/deploy-target.sh': 'trunk target\n' }));
  try {
    await mk().deploy({ repo, checkout, sha: 'abc', log: logf });
    assert.match(readFileSync(seen, 'utf8'), /^trunk checkout\n$/, 'trunk\'s script ran, in the story checkout');
    assert.equal(readFileSync(staging, 'utf8'), OLD, 'the story\'s staging.sh is back');
    assert.equal(readFileSync(join(checkout, 'scripts', 'deploy-api.sh'), 'utf8'), 'story payload\n', 'payload scripts are the story\'s');
    assert.throws(() => readFileSync(join(checkout, 'scripts', 'deploy-target.sh')), 'a tooling file the story lacked is removed again');
    assert.match(readFileSync(logf, 'utf8'), /from trunk: staging\.sh sha256 [0-9a-f]{12}/);

    // trunk is nonce-aware, so no legacy release even though the story's copy is old
    const events: string[] = [];
    await mk(async fn => { events.push('release'); return fn(); }).deploy({ repo, checkout, sha: 'abc', log: logf });
    assert.deepEqual(events, [], 'awareness is judged on the script that runs (trunk\'s)');

    // failure: restored too
    process.env['FAIL'] = '1';
    const failing = new RealServerDeployer(cfg, undefined, async () => null, undefined, async () => ({ 'scripts/staging.sh': '#!/usr/bin/env bash\nexit 1\n' }));
    await assert.rejects(failing.deploy({ repo, checkout, sha: 'abc', log: logf }), /exit 1/);
    assert.equal(readFileSync(staging, 'utf8'), OLD, 'restored after a failed deploy');

    // trunk unavailable: refuse, story's copy untouched
    const none = new RealServerDeployer(cfg, undefined, async () => null, undefined, async () => { throw new Error('no origin'); });
    await assert.rejects(none.deploy({ repo, checkout, sha: 'abc', log: logf }), /trunk's scripts\/staging\.sh/);
    assert.equal(readFileSync(staging, 'utf8'), OLD);
  } finally { delete process.env['FAIL']; rmSync(dir, { recursive: true, force: true }); }
});

test('trunkStagingSh: fetches, then reads scripts/staging.sh from origin/<trunk>', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-trunk-'));
  const sh = (c: string, cwd: string): string => execFileSync('sh', ['-c', c], { cwd, encoding: 'utf8' });
  try {
    sh('git init -q -b main origin && cd origin && mkdir scripts && echo trunk-v1 > scripts/staging.sh && git add . && git -c user.email=a@b -c user.name=a commit -qm one', dir);
    sh('git clone -q origin repo', dir);
    sh('echo trunk-v2 > scripts/staging.sh && git -c user.email=a@b -c user.name=a commit -qam two', join(dir, 'origin'));
    assert.equal((await trunkTooling(join(dir, 'repo'), 'main'))['scripts/staging.sh']!.trim(), 'trunk-v2', 'fetched first');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deploy tooling set: scriptsReferenced reads non-comment references; every scripts/ file trunk\'s staging.sh (and the payload scripts it runs) uses is classified', () => {
  assert.deepEqual(scriptsReferenced('# scripts/a.sh\nsource scripts/deploy-target.sh # x\n./scripts/deploy-api.sh\nX="scripts/env-required/staging.names"\n'),
    ['scripts/deploy-api.sh', 'scripts/deploy-target.sh', 'scripts/env-required/staging.names']);
  assert.equal(classifyDeployPath('scripts/env-required/staging.names'), 'tooling');
  assert.equal(classifyDeployPath('scripts/deploy-api.sh'), 'payload');
  assert.equal(classifyDeployPath('scripts/new-helper.sh'), null);
  assert.ok(DEPLOY_TOOLING_PATHS.includes('scripts/staging.sh'));
});

test('deploy tooling set: trunk\'s real staging.sh and deploy scripts reference no unclassified scripts/ file', async (t) => {
  const repo = process.env['IRIS_REPO'] ?? join(process.env['HOME'] ?? '', 'claude-dev');
  const show = (f: string): string | null => { try { return execFileSync('git', ['-C', repo, 'show', `origin/feat/iris-character:${f}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
  const staging = show('scripts/staging.sh');
  if (staging === null) return t.skip('no Iris repo with origin/feat/iris-character here');
  const unknown: string[] = [];
  for (const f of ['scripts/staging.sh', 'scripts/deploy-api.sh', 'scripts/deploy-agent.sh', 'scripts/deploy-target.sh', 'scripts/check-required-env.sh']) {
    for (const ref of scriptsReferenced(show(f) ?? '')) if (!classifyDeployPath(ref)) unknown.push(`${f} -> ${ref}`);
  }
  assert.deepEqual(unknown, [], 'classify each in DEPLOY_TOOLING_PATHS (trunk) or DEPLOY_PAYLOAD_PATHS (story)');
});
