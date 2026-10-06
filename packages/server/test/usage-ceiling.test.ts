import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ceiling from '../src/services/usage-ceiling.js';
import * as floor from '../src/services/floor.js';
import * as coo from '../src/services/coo.js';
import { testWorkplace } from './fakes/workplace.js';

/** The usage line (owner, 6 Oct): "Don't park at 98, just ping me at 99." */

const reset = Date.parse('2026-10-08T16:00:00Z');
const five = Date.parse('2026-10-05T12:00:00Z');
const pings = (wp: Parameters<typeof coo.transcript>[0]) => coo.transcript(wp).filter(m => m.from === 'coo' && /usage is at/.test(m.text));

test('either window at 99% is over; 98% is not', () => {
  assert.equal(ceiling.evaluate({ utilization: 0.98, resetsAtMs: reset, fiveHour: { utilization: 0.5, resetsAtMs: five } }).over, false);
  const w = ceiling.evaluate({ utilization: 0.99, resetsAtMs: reset });
  assert.equal(w.over, true); assert.equal(w.window, '7d');
  const h = ceiling.evaluate({ utilization: 0.4, resetsAtMs: reset, fiveHour: { utilization: 0.995, resetsAtMs: five } });
  assert.equal(h.over, true); assert.equal(h.window, '5h'); assert.equal(h.resetsAtMs, five);
});

test('at 99% the owner is pinged once per window and reset, and nothing is ever paused', () => {
  const { wp, tmp } = testWorkplace();
  try {
    ceiling.apply(wp, { utilization: 0.985, resetsAtMs: reset });
    assert.equal(pings(wp).length, 0, 'no ping at 98.5%');
    ceiling.apply(wp, { utilization: 0.99, resetsAtMs: reset });
    ceiling.apply(wp, { utilization: 0.995, resetsAtMs: reset });
    assert.equal(pings(wp).length, 1, 'one ping, not one per poll');
    assert.match(pings(wp)[0]!.text, /weekly usage is at 99%/);
    assert.equal(floor.paused(wp), false, 'never paused');
    ceiling.apply(wp, { utilization: 0.99, resetsAtMs: reset + 7 * 86_400_000 });
    assert.equal(pings(wp).length, 2, 'a new window pings again');
  } finally { tmp.cleanup(); }
});

test('a pause left by the old park rule is lifted; anyone else\'s pause is untouched', () => {
  const { wp, tmp } = testWorkplace();
  try {
    floor.setPaused(wp, true, 'usage ceiling: old rule', ceiling.BY);
    ceiling.apply(wp, { utilization: 0.5, resetsAtMs: reset });
    assert.equal(floor.paused(wp), false);
    floor.setPaused(wp, true, 'owner stop', 'coo');
    ceiling.apply(wp, { utilization: 0.995, resetsAtMs: reset });
    assert.equal(floor.paused(wp), true, "the ceiling never lifts someone else's pause");
  } finally { tmp.cleanup(); }
});
