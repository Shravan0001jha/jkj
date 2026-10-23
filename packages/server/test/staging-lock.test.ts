import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { test } from 'node:test';
import { DEPLOY_LOCK_PARAM, OLD_LOCK_PARAM, PROVISIONAL_PREFIX, RealStagingLock, STAGING_LOCK_PARAM, StagingBusyError, type LockBounds, type SsmPort } from '../src/services/evidence-ports.js';

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

/** The shared case table lives on Iris trunk (scripts/staging-lock-cases.json); read live, never copied. Missing = fail clearly. */
interface Side { action: string; acquires: boolean | null }
interface Row { name: string; evidence: Side }
function loadTable(): { cases: Row[]; evidence_provisional_max_s?: number } {
  let txt: string;
  try { txt = execFileSync('git', ['-C', `${homedir()}/claude-dev`, 'show', 'origin/feat/iris-character:scripts/staging-lock-cases.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { throw new Error(`scripts/staging-lock-cases.json is missing on origin/feat/iris-character (git fetch origin feat/iris-character in ~/claude-dev): ${String(e).slice(0, 200)}`); }
  return JSON.parse(txt) as { cases: Row[]; evidence_provisional_max_s?: number };
}
const table = loadTable();
const keyName = { deploy: DEPLOY_LOCK_PARAM, evidence: STAGING_LOCK_PARAM, old: OLD_LOCK_PARAM };
const row = (n: string): Row => { const r = table.cases.find(c => c.name === n); assert.ok(r, `table row ${n} exists`); return r; };

/** What each named row sets up (the table says what must happen; this says how the fake is put into that state). */
const SETUP: Record<string, (ssm: FakeSsm) => void> = {
  both_free: () => undefined,
  deploy_held: ssm => { ssm.m.set(keyName.deploy, sec(600)); },
  evidence_established: ssm => { ssm.m.set(keyName.evidence, sec(1500)); },
  old_key_held: ssm => { ssm.m.set(keyName.old, sec(600)); },
  holder_expired: ssm => { ssm.m.set(keyName.deploy, sec(-600)); ssm.m.set(keyName.old, sec(-600)); },
  // deploy arrives in the instant between evidence's provisional create and its confirm check
  conflict_at_acquire: ssm => { const c = ssm.putIfAbsent.bind(ssm); ssm.putIfAbsent = async (n, v) => { const r = await c(n, v); if (r && n === keyName.evidence) ssm.m.set(keyName.deploy, sec(600)); return r; }; },
};

for (const name of ['both_free', 'deploy_held', 'evidence_established', 'conflict_at_acquire', 'old_key_held', 'holder_expired']) {
  test(`lock table: ${name}`, async () => {
    const ev = row(name).evidence;
    const ssm = new FakeSsm();
    SETUP[name]!(ssm);
    const before = new Map(ssm.m);
    const lock = mk(ssm, bounds({ tries: 1 }));
    if (ev.acquires) {
      await lock.acquire(UNTIL);
      assert.equal(ssm.m.get(STAGING_LOCK_PARAM), String(Math.floor(UNTIL / 1000)), 'established at the full TTL');
    } else {
      await assert.rejects(lock.acquire(UNTIL), StagingBusyError);
      if (ev.action === 'back_off_and_retry') assert.equal(ssm.m.has(STAGING_LOCK_PARAM), false, 'own key deleted on back-off');
      if (ev.action === 'wait_same_key') assert.equal(ssm.m.get(STAGING_LOCK_PARAM), before.get(STAGING_LOCK_PARAM), 'the other evidence run key untouched');
    }
    for (const k of ['deploy', 'old'] as const) if (name !== 'conflict_at_acquire') assert.equal(ssm.m.get(keyName[k]), before.get(keyName[k]), `${k} key untouched`);
  });
}

test('lock table: rows without a new evidence action exist (conflict_during_refresh = n/a, bound_reached = give_up_after_bound)', () => {
  assert.equal(row('conflict_during_refresh').evidence.action, 'n/a');
  assert.equal(row('bound_reached').evidence.action, 'give_up_after_bound');
});

test('value format: provisional p:<epoch> before the check, bare epoch once running, p: never written by refresh; unparseable reads as held', async () => {
  const ssm = new FakeSsm();
  const seen: string[] = [];
  const g = ssm.get.bind(ssm);
  ssm.get = async n => { if (n === DEPLOY_LOCK_PARAM) seen.push(ssm.m.get(STAGING_LOCK_PARAM) ?? ''); return g(n); };
  const lock = mk(ssm);
  await lock.acquire(UNTIL);
  const bare = String(Math.floor(UNTIL / 1000));
  assert.deepEqual(seen, [PROVISIONAL_PREFIX + bare], 'provisional while the others are checked');
  assert.equal(ssm.m.get(STAGING_LOCK_PARAM), bare, 'established after');
  await lock.hold(UNTIL + 1000).catch(() => undefined);
  assert.equal(ssm.m.get(STAGING_LOCK_PARAM), String(Math.floor((UNTIL + 1000) / 1000)));
  for (const v of ['garbage', 'p:', '12x']) {
    const s2 = new FakeSsm(); s2.m.set(DEPLOY_LOCK_PARAM, v);
    await assert.rejects(mk(s2, bounds({ tries: 1 })).acquire(UNTIL), StagingBusyError, `${v} treated as held`);
  }
  const s3 = new FakeSsm(); s3.m.set(STAGING_LOCK_PARAM, 'p:' + sec(600));
  await assert.rejects(mk(s3, bounds({ tries: 1 })).acquire(UNTIL), /another evidence run/, 'a live provisional evidence key is held too');
});

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
