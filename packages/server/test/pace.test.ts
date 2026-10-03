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
    const st = employees.stateWithReason(wp, 'mira');
    assert.equal(st.state, 'blocked', 'the open session was interrupted and the card says why');
    assert.match(st.reason!, /weekly limit/);

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
