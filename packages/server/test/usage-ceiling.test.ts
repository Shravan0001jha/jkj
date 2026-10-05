import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ceiling from '../src/services/usage-ceiling.js';
import * as floor from '../src/services/floor.js';
import { testWorkplace } from './fakes/workplace.js';

/** The usage ceiling (owner, 5 Oct): 98% of the 5-hour or the weekly limit parks the floor. */

const reset = Date.parse('2026-10-08T16:00:00Z');
const five = Date.parse('2026-10-05T12:00:00Z');

test('either window at 98% is over; below on both is not', () => {
  assert.equal(ceiling.evaluate({ utilization: 0.97, resetsAtMs: reset, fiveHour: { utilization: 0.5, resetsAtMs: five } }).over, false);
  const w = ceiling.evaluate({ utilization: 0.98, resetsAtMs: reset });
  assert.equal(w.over, true); assert.equal(w.window, '7d');
  const h = ceiling.evaluate({ utilization: 0.4, resetsAtMs: reset, fiveHour: { utilization: 0.99, resetsAtMs: five } });
  assert.equal(h.over, true); assert.equal(h.window, '5h'); assert.equal(h.resetsAtMs, five);
});

test('over pauses the floor; back under resumes it; a manual pause is never lifted by the ceiling', () => {
  const { wp, tmp } = testWorkplace();
  try {
    ceiling.apply(wp, { utilization: 0.5, resetsAtMs: reset, fiveHour: { utilization: 0.985, resetsAtMs: five } });
    const st = floor.state(wp);
    assert.equal(st.paused, true); assert.equal(st.by, ceiling.BY); assert.match(st.reason!, /5h limit at 99%/);
    ceiling.apply(wp, { utilization: 0.5, resetsAtMs: reset, fiveHour: { utilization: 0.1, resetsAtMs: five } });
    assert.equal(floor.paused(wp), false, 'resumed once back under');
    floor.setPaused(wp, true, 'owner stop', 'coo');
    ceiling.apply(wp, { utilization: 0.2, resetsAtMs: reset });
    assert.equal(floor.paused(wp), true, "the ceiling never lifts someone else's pause");
  } finally { tmp.cleanup(); }
});
