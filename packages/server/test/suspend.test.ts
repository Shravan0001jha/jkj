import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SuspendDetector } from '../src/services/suspend.js';
import { parsePmset, PowerMonitor } from '../src/services/power.js';

/** The process noticing it was frozen, and the power source (B2, 29 Sep; docs/RESILIENCE-workplace.md §9). */

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Freeze this thread, as sleep freezes the process: no timers, no I/O. Node allows Atomics.wait on the main thread. */
const freeze = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

test('a frozen process is noticed on resume with the length of the freeze; normal ticks are not', async () => {
  const d = new SuspendDetector({ intervalMs: 20, thresholdMs: 60 });
  const gaps: number[] = [];
  d.onResume(g => gaps.push(g));
  d.start();
  try {
    await wait(120);
    assert.deepEqual(d.state, { count: 0, lastAt: null, lastSeconds: 0, totalSeconds: 0 }, 'no false resumes from ordinary scheduling');

    freeze(200);
    await wait(60);
    assert.equal(d.state.count, 1);
    assert.equal(gaps.length, 1);
    assert.ok(gaps[0]! >= 140 && gaps[0]! < 400, `the gap is about the freeze: ${gaps[0]}`);
    assert.ok(d.state.lastAt, 'stamped');

    // A short stall under the threshold is scheduler jitter, not a sleep.
    freeze(30);
    await wait(60);
    assert.equal(d.state.count, 1);

    freeze(150);
    await wait(60);
    assert.equal(d.state.count, 2);
    assert.equal(gaps.length, 2);
  } finally {
    d.stop();
  }
});

test('driven by a fake clock: only a late tick counts, and the total accumulates', () => {
  let now = 1_000_000;
  const d = new SuspendDetector({ intervalMs: 5_000, thresholdMs: 15_000, now: () => now });
  const gaps: number[] = [];
  d.onResume(g => gaps.push(g));
  d.start();
  d.stop();
  now += 5_000; d.tick();
  now += 5_400; d.tick();
  assert.equal(d.state.count, 0);
  now += 485_000; d.tick();          // the 22:10 → 22:18 sleep
  assert.equal(d.state.count, 1);
  assert.equal(d.state.lastSeconds, 480);
  now += 5_000; d.tick();
  now += 1_000_000; d.tick();
  assert.equal(d.state.count, 2);
  assert.equal(d.state.totalSeconds, 480 + 995);
  assert.deepEqual(gaps, [480_000, 995_000]);
});

test('pmset output → power source, percent, charging; and the monitor never throws when pmset is not there', async () => {
  const ac = parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=36307043)\t86%; charging; 0:44 remaining present: true\n");
  assert.equal(ac.source, 'ac'); assert.equal(ac.percent, 86); assert.equal(ac.charging, true);
  const batt = parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=36307043)\t68%; discharging; 5:10 remaining present: true\n");
  assert.equal(batt.source, 'battery'); assert.equal(batt.percent, 68); assert.equal(batt.charging, false);
  const full = parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n");
  assert.equal(full.charging, true);
  const none = parsePmset('');
  assert.deepEqual([none.source, none.percent, none.charging], ['unknown', null, null]);

  const failing = new PowerMonitor(async () => { throw new Error('no pmset'); });
  assert.equal((await failing.refresh()).source, 'unknown');
  const reads: number[] = [];
  const ok = new PowerMonitor(async () => { reads.push(Date.now()); return "Now drawing from 'Battery Power'\n 50%; discharging"; });
  ok.start(20);
  await wait(70);
  ok.stop();
  assert.ok(reads.length >= 3, `read on start and on the interval: ${reads.length}`);
  assert.equal(ok.state.source, 'battery');
});
