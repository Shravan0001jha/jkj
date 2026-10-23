import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { test } from 'node:test';
import { DEPLOY_LOCK_PARAM, OLD_LOCK_PARAM, RealStagingLock, STAGING_LOCK_PARAM, StagingBusyError, type LockBounds, type SsmPort } from '../src/services/evidence-ports.js';

/** In-memory SSM: every method is atomic (no await between check and set), as a conditional create is. */
class FakeSsm implements SsmPort {
  m = new Map<string, string>();
  log: string[] = [];
  constructor(private readonly lag: () => Promise<void> = async () => undefined) {}
  async get(n: string) { await this.lag(); return this.m.get(n) ?? null; }
  async putIfAbsent(n: string, v: string) { await this.lag(); if (this.m.has(n)) return false; this.m.set(n, v); this.log.push(`create ${n}`); return true; }
  async put(n: string, v: string) { await this.lag(); this.m.set(n, v); this.log.push(`put ${n}`); }
  async delete(n: string) { await this.lag(); this.m.delete(n); this.log.push(`delete ${n}`); }
}

const NOW = 1_800_000_000_000;
const sec = (off: number) => String(Math.floor(NOW / 1000) + off);
const bounds = (over: Partial<LockBounds> = {}): LockBounds => ({ tries: 3, baseMs: 1, jitterMs: 1, sleep: async () => undefined, now: () => NOW, ...over });
const mk = (ssm: SsmPort, b = bounds()) => new RealStagingLock({ stagingUrl: 'http://127.0.0.1:9' } as never, 'ap-south-1', ssm, b);
const UNTIL = NOW + 25 * 60_000;

/** The shared case table (Iris scripts/staging-lock-cases.json, Vivek's story as_mvk9n36u0tbhy). Until it lands on trunk a draft with the same rows stands in. */
interface Row { name: string; keys: Partial<Record<'deploy' | 'evidence' | 'old', 'live' | 'expired'>>; expect: 'acquired' | 'busy'; holder?: string }
const DRAFT: Row[] = [
  { name: 'deploy held', keys: { deploy: 'live' }, expect: 'busy', holder: 'deploy' },
  { name: 'evidence held', keys: { evidence: 'live' }, expect: 'busy', holder: 'evidence' },
  { name: 'old key held', keys: { old: 'live' }, expect: 'busy', holder: 'old' },
  { name: 'both free', keys: {}, expect: 'acquired' },
  { name: 'holder expired (deploy, evidence, old)', keys: { deploy: 'expired', evidence: 'expired', old: 'expired' }, expect: 'acquired' },
];
function loadTable(): { rows: Row[]; real: boolean } {
  try {
    const txt = execFileSync('git', ['-C', `${homedir()}/claude-dev`, 'show', 'origin/feat/iris-character:scripts/staging-lock-cases.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { rows: (JSON.parse(txt) as { cases?: Row[] }).cases ?? (JSON.parse(txt) as Row[]), real: true };
  } catch {
    if (process.env['STAGING_LOCK_REQUIRE_TABLE']) throw new Error('scripts/staging-lock-cases.json is missing on origin/feat/iris-character');
    return { rows: DRAFT, real: false };
  }
}
const table = loadTable();
const keyName = { deploy: DEPLOY_LOCK_PARAM, evidence: STAGING_LOCK_PARAM, old: OLD_LOCK_PARAM };

for (const row of table.rows) {
  test(`lock table${table.real ? '' : ' (DRAFT)'}: ${row.name}`, async () => {
    const ssm = new FakeSsm();
    for (const [k, st] of Object.entries(row.keys)) ssm.m.set(keyName[k as keyof typeof keyName], sec(st === 'live' ? 600 : -600));
    const lock = mk(ssm, bounds({ tries: 2 }));
    if (row.expect === 'acquired') {
      await lock.acquire(UNTIL);
      assert.equal(ssm.m.get(STAGING_LOCK_PARAM), String(Math.floor(UNTIL / 1000)));
    } else {
      await assert.rejects(lock.acquire(UNTIL), (e: unknown) => e instanceof StagingBusyError && (!row.holder || (e as StagingBusyError).holder === row.holder));
      // yielding leaves a live evidence key only when evidence itself was the holder
      if (row.holder !== 'evidence') assert.equal(ssm.m.has(STAGING_LOCK_PARAM), false, 'own key deleted on yield');
    }
    // never touches the other keys
    for (const k of ['deploy', 'old'] as const) assert.equal(ssm.m.get(keyName[k]), row.keys[k] ? sec(row.keys[k] === 'live' ? 600 : -600) : undefined);
  });
}

test('bound: gives up after N tries with the visible deferred message, sleeping between tries only', async () => {
  const ssm = new FakeSsm(); ssm.m.set(DEPLOY_LOCK_PARAM, sec(600));
  let sleeps = 0;
  const lock = mk(ssm, bounds({ tries: 6, sleep: async () => { sleeps++; } }));
  await assert.rejects(lock.acquire(UNTIL), /staging busy \(deploy\), run deferred/);
  assert.equal(sleeps, 5);
  assert.equal(ssm.log.filter(l => l === `create ${STAGING_LOCK_PARAM}`).length, 6);
});

test('conflict at acquire: the deploy key appearing during the wait is honoured on the next try, then it proceeds when the deploy ends', async () => {
  const ssm = new FakeSsm(); ssm.m.set(DEPLOY_LOCK_PARAM, sec(600));
  const lock = mk(ssm, bounds({ tries: 4, sleep: async () => { ssm.m.delete(DEPLOY_LOCK_PARAM); } }));
  await lock.acquire(UNTIL);
  assert.ok(ssm.m.has(STAGING_LOCK_PARAM));
});

test('conflict during refresh: a deploy key appearing mid-run never makes evidence yield; the key is extended and kept', async () => {
  const ssm = new FakeSsm();
  const lock = mk(ssm);
  await lock.acquire(UNTIL);
  ssm.m.set(DEPLOY_LOCK_PARAM, sec(900));
  ssm.log.length = 0;
  await lock.hold(UNTIL + 600_000).catch(() => undefined); // the touch of an unreachable staging may fail; the key is what counts
  assert.equal(ssm.m.get(STAGING_LOCK_PARAM), String(Math.floor((UNTIL + 600_000) / 1000)));
  assert.deepEqual(ssm.log, [`put ${STAGING_LOCK_PARAM}`], 'only a refresh of its own key');
  // and a deploy arriving now loses: it would see the evidence key held
  assert.ok(Number(ssm.m.get(STAGING_LOCK_PARAM)) * 1000 > NOW);
});

test('release deletes only the evidence key; latestExpiry reads all three', async () => {
  const ssm = new FakeSsm(); ssm.m.set(DEPLOY_LOCK_PARAM, sec(100)); ssm.m.set(OLD_LOCK_PARAM, sec(900));
  const lock = mk(ssm);
  assert.equal(await lock.latestExpiry(), Number(sec(900)));
  ssm.m.delete(DEPLOY_LOCK_PARAM); ssm.m.delete(OLD_LOCK_PARAM);
  await lock.acquire(UNTIL);
  ssm.m.set(DEPLOY_LOCK_PARAM, sec(100));
  await lock.release();
  assert.equal(ssm.m.has(STAGING_LOCK_PARAM), false);
  assert.equal(ssm.m.get(DEPLOY_LOCK_PARAM), sec(100));
  assert.deepEqual(ssm.log.filter(l => l.startsWith('delete')), [`delete ${STAGING_LOCK_PARAM}`]);
});

test('race x50: two evidence starters and a deploy starter from a standing start; never two inside; deploy beats evidence at acquire', async () => {
  for (let it = 0; it < 50; it++) {
    const lag = () => new Promise<void>(r => setTimeout(r, Math.random() * 3));
    const ssm = new FakeSsm(lag);
    let inside = 0, max = 0;
    const entered: string[] = [];
    const enter = async (who: string) => { entered.push(who); inside++; max = Math.max(max, inside); await new Promise(r => setTimeout(r, 8)); inside--; };
    const b = bounds({ tries: 40, sleep: ms => new Promise(r => setTimeout(r, Math.random() * 4 + ms)) });
    const evidence = async (who: string) => {
      const lock = mk(ssm, b);
      try { await lock.acquire(UNTIL); } catch { return; }
      await enter(who); await lock.release();
    };
    // the deploy side, as staging.sh does: create own key, then read the evidence key; if held, drop own key and retry
    const deploy = async () => {
      for (let i = 0; i < 200; i++) {
        if (await ssm.putIfAbsent(DEPLOY_LOCK_PARAM, sec(600))) {
          const e = await ssm.get(STAGING_LOCK_PARAM);
          if (e === null || Number(e) * 1000 <= NOW) { await enter('deploy'); await ssm.delete(DEPLOY_LOCK_PARAM); return; }
          await ssm.delete(DEPLOY_LOCK_PARAM);
        }
        await new Promise(r => setTimeout(r, Math.random() * 4));
      }
    };
    await Promise.all([evidence('e1'), evidence('e2'), deploy(), new Promise(r => setTimeout(r, Math.random() * 6)).then(() => undefined)]);
    assert.equal(max, 1, `iteration ${it}: never two inside (${entered})`);
    assert.ok(entered.includes('deploy'), `iteration ${it}: deploy proceeds (${entered})`);
    assert.equal(ssm.m.has(STAGING_LOCK_PARAM) || ssm.m.has(DEPLOY_LOCK_PARAM), false, 'all keys cleaned');
  }
});
