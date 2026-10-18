import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pace from '../src/services/pace.js';
import * as spend from '../src/services/spend.js';
import * as employees from '../src/services/employees.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/** Weekly pacing (owner, 3 Oct): day N may use at most N × 14% of the weekly limit. */

const DAY = 86_400_000;
const reset = Date.parse('2026-10-08T16:00:00Z');   // week started 1 Oct 16:00 UTC
const at = (days: number) => reset - 7 * DAY + days * DAY;

test('day N of the week allows N × 14%, the boundary is the reset time plus N days', () => {
  const r = (u: number) => ({ utilization: u, resetsAtMs: reset });
  assert.deepEqual(pace.evaluate(r(0.10), at(0.5)), { dayIndex: 1, allowance: 0.14, over: false, nextDayMs: at(1) });
  assert.equal(pace.evaluate(r(0.14), at(0.5)).over, true, 'reaching the allowance stops the day');
  const d2 = pace.evaluate(r(0.15), at(1.41));
  assert.equal(d2.dayIndex, 2); assert.equal(d2.allowance, 0.28); assert.equal(d2.over, false);
  assert.equal(pace.evaluate(r(0.5), at(6.9)).allowance, 0.98);
});

test('over the allowance: unattended work is held until the next pace day, then resumes', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    employees.talk(wp, 'mira', 'work', [], { autonomous: true });
    await new Promise(r => setTimeout(r, 5));
    const nowMs = Date.now();
    // A reading that puts "now" on day 2 with 30% used: over the 28% allowance.
    const resetsAtMs = nowMs - 1.5 * DAY + 7 * DAY;
    const v = pace.apply(wp, { utilization: 0.30, resetsAtMs }, nowMs);
    assert.equal(v.over, true);
    assert.equal(pace.holdUntil(wp, nowMs), new Date(v.nextDayMs).toISOString());
    assert.deepEqual(spend.canSpend(wp, 'mira'), { ok: false, scope: 'weekly-pace' });
    await new Promise(r => setTimeout(r, 20));
    // Park, not kill (owner, 17 Oct): the running turn finishes; nothing new starts.
    assert.equal(fake.last().interrupted, 0, 'the open session is not interrupted');
    assert.equal(employees.stateWithReason(wp, 'mira').state, 'working');
    assert.match(employees.stateWithReason(wp, 'rohan').reason!, /weekly limit/, 'an idle card says why');

    // A second reading the same day does not stack holds.
    pace.apply(wp, { utilization: 0.31, resetsAtMs }, nowMs + 60_000);
    assert.equal(wp.db.prepare("select count(*) as n from events where kind = 'pace-hold'").get()!.n as number, 1);

    // Next pace day: allowance 42%, the hold expires and work may run again.
    const later = v.nextDayMs + 60_000;
    pace.apply(wp, { utilization: 0.31, resetsAtMs }, later);
    assert.equal(pace.holdUntil(wp, later), null);
    assert.equal(wp.db.prepare("select count(*) as n from events where kind = 'pace-lifted'").get()!.n as number, 1);
    assert.equal(spend.canSpend(wp, 'mira').ok, true);
    assert.notEqual(employees.stateOf(wp, 'mira'), 'blocked');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('under the allowance nothing is held', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const nowMs = Date.now();
    pace.apply(wp, { utilization: 0.15, resetsAtMs: nowMs - 1.4 * DAY + 7 * DAY }, nowMs);
    assert.equal(pace.holdUntil(wp, nowMs), null);
    assert.equal(spend.canSpend(wp, 'mira').ok, true);
  } finally {
    tmp.cleanup();
  }
});

test('under a pace hold, idle/stall alerts (and the "spend" cap note) are not raised to Asha or the COO', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const manager = await import('../src/services/manager.js');
    const coo = await import('../src/services/coo.js');
    const nowMs = Date.now();
    pace.apply(wp, { utilization: 0.30, resetsAtMs: nowMs - 1.5 * DAY + 7 * DAY }, nowMs);
    const r = manager.alert(wp, { key: 'idle:x:1', itemId: 'as_none', title: 'Dev idle with 1 queued item', body: 'paused by the weekly-pace spend cap', decision: 'spend' }, nowMs);
    assert.equal(r, 'dropped');
    assert.equal(coo.listItems(wp).filter(i => /idle with/.test(i.title)).length, 0);
  } finally {
    tmp.cleanup();
  }
});

test('owner switch: pacing off lifts a hold at once and later readings never re-impose it', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const nowMs = Date.now();
    const resetsAtMs = nowMs - 1.5 * DAY + 7 * DAY;
    pace.apply(wp, { utilization: 0.30, resetsAtMs }, nowMs);
    assert.notEqual(pace.holdUntil(wp, nowMs), null);
    pace.setDisabled(wp, true);
    assert.equal(pace.holdUntil(wp, nowMs), null);
    assert.equal(spend.canSpend(wp, 'mira').ok, true);
    assert.equal(pace.apply(wp, { utilization: 0.90, resetsAtMs }, nowMs + 60_000).over, false);
    assert.equal(pace.holdUntil(wp, nowMs + 60_000), null, 'a reading while off never holds');
    pace.setDisabled(wp, false);
    assert.equal(pace.apply(wp, { utilization: 0.90, resetsAtMs }, nowMs + 120_000).over, true, 'back on: pacing applies again');
  } finally {
    tmp.cleanup();
  }
});

/** Per-pace-day cap override (owner, 18 Oct): raises today's cap only, expires with the pace day, never lowers. */
test('a cap override raises today\'s cap, lifts a hold below it, expires at the next pace day, never lowers', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const nowMs = Date.now();
    const resetsAtMs = nowMs - 3.5 * DAY + 7 * DAY;            // day 4: allowance 56%
    const r = { utilization: 0.58, resetsAtMs };
    const v = pace.apply(wp, r, nowMs);
    assert.equal(v.over, true);
    assert.ok(pace.holdUntil(wp, nowMs), 'held at 58% of 56%');

    assert.throws(() => pace.setCapOverride(wp, 0.50, 'coo', nowMs), /lower|allowance/i, 'cannot lower');
    assert.equal(pace.status(wp, nowMs).capOverride, null);

    pace.setCapOverride(wp, 0.60, 'coo', nowMs);
    assert.equal(pace.holdUntil(wp, nowMs), null, 'the hold below the new cap is lifted at once');
    const st = pace.status(wp, nowMs);
    assert.equal(st.capToday, 0.60);
    assert.deepEqual(st.capOverride, { value: 0.60, paceDay: 4 });
    // A later reading the same day uses the raised cap: 59% is fine, 60% holds.
    assert.equal(pace.apply(wp, { ...r, utilization: 0.59 }, nowMs + 60_000).over, false);
    assert.equal(pace.holdUntil(wp, nowMs + 60_000), null);
    assert.equal(pace.apply(wp, { ...r, utilization: 0.60 }, nowMs + 120_000).over, true);
    assert.ok(pace.holdUntil(wp, nowMs + 120_000));

    // Next pace day (day 5, allowance 70%): the override is gone and the plain allowance applies.
    const next = v.nextDayMs + 60_000;
    const v5 = pace.apply(wp, { ...r, utilization: 0.65 }, next);
    assert.equal(v5.allowance, 0.70);
    const st5 = pace.status(wp, next);
    assert.equal(st5.capOverride, null);
    assert.equal(st5.capToday, 0.70);
  } finally { tmp.cleanup(); }
});
