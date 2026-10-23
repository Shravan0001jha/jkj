import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { test } from 'node:test';
import { DEFAULT_LOCK_BOUNDS, DEPLOY_LOCK_PARAM, OLD_LOCK_PARAM, PROVISIONAL_PREFIX, RealStagingLock, STAGING_LOCK_PARAM, StagingBusyError, type LockBounds, type SsmPort } from '../src/services/evidence-ports.js';

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
const mk = (ssm: SsmPort, b = bounds()) => { const l = new RealStagingLock({ stagingUrl: 'http://127.0.0.1:9' } as never, 'ap-south-1', ssm, b); void l.setNonceAware(true); return l; };
const UNTIL = NOW + 25 * 60_000;

/** The shared case table lives on Iris trunk (scripts/staging-lock-cases.json); read live, never copied. Missing = fail clearly. */
interface Side { action: string; acquires: boolean | null }
interface Row { name: string; evidence: Side }
function loadTable(): { cases: Row[] } {
  let txt: string;
  try { txt = execFileSync('git', ['-C', `${homedir()}/claude-dev`, 'show', 'origin/feat/iris-character:scripts/staging-lock-cases.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { throw new Error(`scripts/staging-lock-cases.json is missing on origin/feat/iris-character (git fetch origin feat/iris-character in ~/claude-dev): ${String(e).slice(0, 200)}`); }
  return JSON.parse(txt) as { cases: Row[] };
}
const table = loadTable();
const keyName = { deploy: DEPLOY_LOCK_PARAM, evidence: STAGING_LOCK_PARAM, old: OLD_LOCK_PARAM };
const row = (n: string): Row => { const r = table.cases.find(c => c.name === n); assert.ok(r, `table row ${n} exists`); return r; };

/** What each named row sets up (the table says what must happen; this says how the fake is put into that state). */
const SETUP: Record<string, (ssm: FakeSsm) => void> = {
  both_free: () => undefined,
  deploy_held: ssm => { ssm.m.set(keyName.deploy, sec(600)); },
  evidence_established: ssm => { ssm.m.set(keyName.evidence, sec(1500) + ':aaaaaaaaaaaaaaaa'); },
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
      assert.match(ssm.m.get(STAGING_LOCK_PARAM)!, new RegExp(`^${Math.floor(UNTIL / 1000)}:[0-9a-f]{16}$`), 'established at the full TTL, with the run nonce');
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
  const nonce = lock.currentNonce()!;
  const bare = `${Math.floor(UNTIL / 1000)}:${nonce}`;
  assert.match(nonce, /^[0-9a-f]{16}$/);
  assert.deepEqual(seen, [PROVISIONAL_PREFIX + bare], 'provisional while the others are checked');
  assert.equal(ssm.m.get(STAGING_LOCK_PARAM), bare, 'established after');
  await lock.hold(UNTIL + 1000).catch(() => undefined);
  assert.equal(ssm.m.get(STAGING_LOCK_PARAM), `${Math.floor((UNTIL + 1000) / 1000)}:${lock.currentNonce()}`, 'refresh rewrites new expiry, same nonce');
  for (const v of ['garbage', 'p:', '12x', '12:XYZ', 'p:12:']) {
    const s2 = new FakeSsm(); s2.m.set(DEPLOY_LOCK_PARAM, v);
    await assert.rejects(mk(s2, bounds({ tries: 1 })).acquire(UNTIL), StagingBusyError, `${v} treated as held`);
  }
  const s3 = new FakeSsm(); s3.m.set(STAGING_LOCK_PARAM, 'p:' + sec(600) + ':abcd1234abcd1234');
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
  assert.equal(ssm.m.get(STAGING_LOCK_PARAM), `${Math.floor((UNTIL + 600_000) / 1000)}:${lock.currentNonce()}`);
  assert.deepEqual(ssm.log, [`put ${STAGING_LOCK_PARAM}`], 'only a refresh of its own key');
  // and a deploy arriving now loses: it would see the evidence key held
  assert.ok(Number(ssm.m.get(STAGING_LOCK_PARAM)!.split(':')[0]) * 1000 > NOW);
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

test('order: promote -> confirm (read back) -> acquire resolves; a failed or mis-read promote never starts and leaves no key', async () => {
  const ssm = new FakeSsm();
  const lock = mk(ssm);
  const order: string[] = [];
  await lock.acquire(UNTIL).then(() => order.push('start'));
  assert.deepEqual(ssm.log.filter(l => l.includes(STAGING_LOCK_PARAM)), [`create ${STAGING_LOCK_PARAM}`, `put ${STAGING_LOCK_PARAM}`], 'create (p:), then promote');
  const bare = `${Math.floor(UNTIL / 1000)}:${lock.currentNonce()}`;
  assert.equal(ssm.m.get(STAGING_LOCK_PARAM), bare);
  assert.deepEqual(order, ['start']);

  for (const mode of ['put-fails', 'reads-back-wrong']) {
    const s = new FakeSsm();
    if (mode === 'put-fails') s.put = async () => { throw new Error('boom'); };
    else { const g = s.get.bind(s); s.get = async n => { const v = await g(n); return n === STAGING_LOCK_PARAM && v && !v.startsWith('p:') ? 'p:' + v : v; }; }
    let started = false;
    await assert.rejects(mk(s).acquire(UNTIL).then(() => { started = true; }), /not confirmed, run not started/, mode);
    assert.equal(started, false);
    assert.equal(s.m.has(STAGING_LOCK_PARAM), false, `${mode}: own key deleted`);
  }
});

test('currentNonce: the run nonce while held (what the in-run deploy is told), null when not held; new run, new nonce', async () => {
  const ssm = new FakeSsm();
  const lock = mk(ssm);
  assert.equal(lock.currentNonce(), null);
  await lock.acquire(UNTIL);
  const n1 = lock.currentNonce()!;
  assert.ok(ssm.m.get(STAGING_LOCK_PARAM)!.endsWith(`:${n1}`));
  await lock.release();
  assert.equal(lock.currentNonce(), null);
  await lock.acquire(UNTIL);
  assert.notEqual(lock.currentNonce(), n1);
});

test('migration (staging.sh without the evidence key): legacy key held with the same expiry, refreshed, deleted on release', async () => {
  const ssm = new FakeSsm();
  const lock = mk(ssm);
  await lock.setNonceAware(false);
  await lock.acquire(UNTIL);
  assert.equal(ssm.m.get(OLD_LOCK_PARAM), String(Math.floor(UNTIL / 1000)));
  await lock.hold(UNTIL + 60_000).catch(() => undefined);
  assert.equal(ssm.m.get(OLD_LOCK_PARAM), String(Math.floor((UNTIL + 60_000) / 1000)));
  await lock.release();
  assert.equal(ssm.m.has(OLD_LOCK_PARAM), false);
  assert.equal(ssm.m.has(STAGING_LOCK_PARAM), false);
});

test('migration: the legacy key is released around the in-run deploy and restored in a finally, even when the deploy throws; refresh during it does not bring it back', async () => {
  const ssm = new FakeSsm();
  const lock = mk(ssm);
  await lock.setNonceAware(false);
  await lock.acquire(UNTIL);
  let during: { legacy: boolean; evidence: boolean } | undefined;
  await assert.rejects(lock.aroundLegacyDeploy(async () => {
    await lock.hold(UNTIL + 1000).catch(() => undefined);
    during = { legacy: ssm.m.has(OLD_LOCK_PARAM), evidence: ssm.m.has(STAGING_LOCK_PARAM) };
    throw new Error('deploy failed');
  }), /deploy failed/);
  assert.deepEqual(during, { legacy: false, evidence: true });
  assert.equal(ssm.m.get(OLD_LOCK_PARAM), String(Math.floor((UNTIL + 1000) / 1000)), 'restored with the latest expiry');
});

test('nonce-aware staging.sh (#543 landed): the legacy key is not written, not released around the deploy, and dropped if already held', async () => {
  const ssm = new FakeSsm();
  const lock = mk(ssm);
  await lock.setNonceAware(true);
  await lock.acquire(UNTIL);
  assert.equal(ssm.m.has(OLD_LOCK_PARAM), false);
  let ran = false;
  await lock.aroundLegacyDeploy(async () => { ran = true; });
  assert.ok(ran);
  assert.ok(!ssm.log.some(l => l.endsWith(' ' + OLD_LOCK_PARAM)), 'legacy key never touched');
  const s2 = new FakeSsm(); const l2 = mk(s2);
  await l2.setNonceAware(false); await l2.acquire(UNTIL);
  assert.ok(s2.m.has(OLD_LOCK_PARAM));
  await l2.setNonceAware(true);
  assert.equal(s2.m.has(OLD_LOCK_PARAM), false);
});

const memory = () => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string | null) => { if (v === null) m.delete(k); else m.set(k, v); }, m }; };
const mkMem = (ssm: SsmPort, mem: ReturnType<typeof memory>, aware: boolean) => { const l = new RealStagingLock({ stagingUrl: 'http://127.0.0.1:9' } as never, 'ap-south-1', ssm, bounds({ tries: 1 }), mem as never); void l.setNonceAware(aware); return l; };

test('restart with our own leftover legacy + evidence keys: acquire proceeds (not "busy (deploy)")', async () => {
  const ssm = new FakeSsm(); const mem = memory();
  const before = mkMem(ssm, mem, false);
  await before.acquire(UNTIL); // the previous process: holds both keys, then dies without releasing
  const legacy = ssm.m.get(OLD_LOCK_PARAM)!, ev = ssm.m.get(STAGING_LOCK_PARAM)!;
  assert.ok(legacy && ev);
  const after = mkMem(ssm, mem, false); // the new process, same settings memory
  await after.acquire(UNTIL + 5000);
  assert.equal(ssm.m.get(OLD_LOCK_PARAM), String(Math.floor((UNTIL + 5000) / 1000)));
  assert.notEqual(ssm.m.get(STAGING_LOCK_PARAM), ev);
});

test('a foreign legacy value (a real deploy from the old staging.sh) is still honoured', async () => {
  const ssm = new FakeSsm(); const mem = memory();
  const before = mkMem(ssm, mem, false);
  await before.acquire(UNTIL); await before.release();
  ssm.m.set(OLD_LOCK_PARAM, sec(900)); // not what we wrote
  await assert.rejects(mkMem(ssm, mem, false).acquire(UNTIL), (e: unknown) => e instanceof StagingBusyError && e.holder === 'old');
});

test('startup with nothing running reaps only keys equal to our own last writes', async () => {
  const ssm = new FakeSsm(); const mem = memory();
  await mkMem(ssm, mem, false).acquire(UNTIL);
  await mkMem(ssm, mem, false).reapLeftovers();
  assert.equal(ssm.m.has(OLD_LOCK_PARAM), false); assert.equal(ssm.m.has(STAGING_LOCK_PARAM), false);
  const s2 = new FakeSsm(); const m2 = memory();
  await mkMem(s2, m2, false).acquire(UNTIL);
  s2.m.set(OLD_LOCK_PARAM, sec(900)); // a deploy's, written after ours
  await mkMem(s2, m2, false).reapLeftovers();
  assert.equal(s2.m.get(OLD_LOCK_PARAM), sec(900), 'a foreign legacy value is left alone');
});

test('the default bound outlasts a real deploy (6-10 min): at least 12 min of waiting', () => {
  const b = DEFAULT_LOCK_BOUNDS;
  assert.ok((b.tries - 1) * b.baseMs >= 12 * 60_000);
});
