import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/services/store.js';
import { recordBoot, bootHistory, bootsWithin, isCrashLoop, marks, RECENT_BOOTS } from '../src/services/boots.js';

/** Boot history lives in the settings table (docs/RESILIENCE-workplace.md §5): the restart count the phone shows. */

const MIN = 60_000;

test('each boot is counted and the recent list keeps the newest fifty', () => {
  const db = openStore(':memory:');
  try {
    assert.deepEqual(bootHistory(db), { total: 0, recent: [] });
    const t0 = 1_000_000_000_000;
    const first = recordBoot(db, new Date(t0));
    assert.equal(first.total, 1);
    assert.deepEqual(first.recent, [new Date(t0).toISOString()]);
    for (let i = 1; i < 60; i += 1) recordBoot(db, new Date(t0 + i * MIN));
    const h = bootHistory(db);
    assert.equal(h.total, 60);
    assert.equal(h.recent.length, RECENT_BOOTS);
    assert.equal(h.recent[h.recent.length - 1], new Date(t0 + 59 * MIN).toISOString(), 'newest last');
    assert.equal(h.recent[0], new Date(t0 + 10 * MIN).toISOString(), 'oldest dropped');
  } finally { db.close(); }
});

test('boots within a window, and the crash-loop rule: three or more in ten minutes', () => {
  const now = 1_000_000_000_000;
  const iso = (t: number) => new Date(t).toISOString();
  const h = { total: 5, recent: [iso(now - 25 * 60 * MIN), iso(now - 9 * MIN), iso(now - 4 * MIN), iso(now)] };
  assert.equal(bootsWithin(h, now, 24 * 60 * MIN), 3);
  assert.equal(bootsWithin(h, now, 10 * MIN), 3);
  assert.equal(isCrashLoop(h, now), true);
  assert.equal(isCrashLoop({ total: 2, recent: [iso(now - 9 * MIN), iso(now)] }, now), false);
  assert.equal(isCrashLoop({ total: 3, recent: [iso(now - 11 * MIN), iso(now - 4 * MIN), iso(now)] }, now), false);
  assert.equal(isCrashLoop({ total: 0, recent: [] }, now), false);
});

test('the crash-loop mark persists across processes and clears', () => {
  const db = openStore(':memory:');
  try {
    const m = marks(db);
    assert.equal(m.crashLoopAlertedAt(), null);
    m.markCrashLoop('2026-09-28T10:00:00.000Z');
    assert.equal(marks(db).crashLoopAlertedAt(), '2026-09-28T10:00:00.000Z');
    m.markCrashLoop(null);
    assert.equal(marks(db).crashLoopAlertedAt(), null);
    recordBoot(db);
    assert.equal(m.history().total, 1);
  } finally { db.close(); }
});
