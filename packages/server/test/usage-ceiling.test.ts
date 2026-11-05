import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ceiling from '../src/services/usage-ceiling.js';
import * as floor from '../src/services/floor.js';
import * as coo from '../src/services/coo.js';
import { testWorkplace } from './fakes/workplace.js';
const WED = Date.parse('2026-11-04T06:00:00Z');   // a Wednesday 11:30 IST: the 90% line
const THU = Date.parse('2026-11-05T06:00:00Z');   // a Thursday 11:30 IST: the 98% line (owner, 5 Nov)

/** The usage line (owner, 8 Oct): "stop things at 90% weekly usage"; the 5-hour window still only pings at 99%. */

const reset = Date.parse('2026-10-08T16:00:00Z');
const five = Date.parse('2026-10-05T12:00:00Z');
const msgs = (wp: Parameters<typeof coo.transcript>[0]) => coo.transcript(wp).filter(m => m.from === 'coo' && /usage is at/.test(m.text));

test('weekly at 90% is a stop; 89% is not; the 5-hour window only pings at 99%', () => {
  assert.equal(ceiling.evaluate({ utilization: 0.89, resetsAtMs: reset, fiveHour: { utilization: 0.5, resetsAtMs: five } }).over, false);
  const w = ceiling.evaluate({ utilization: 0.9, resetsAtMs: reset });
  assert.equal(w.over, true); assert.equal(w.stop, true); assert.equal(w.window, '7d');
  const h = ceiling.evaluate({ utilization: 0.4, resetsAtMs: reset, fiveHour: { utilization: 0.995, resetsAtMs: five } });
  assert.equal(h.over, true); assert.equal(h.stop, false); assert.equal(h.window, '5h');
  assert.equal(ceiling.evaluate({ utilization: 0.4, resetsAtMs: reset, fiveHour: { utilization: 0.95, resetsAtMs: five } }).over, false);
});

test('at 90% weekly the floor pauses and the owner gets one message; a new window lifts it', () => {
  const { wp, tmp } = testWorkplace();
  try {
    ceiling.apply(wp, { utilization: 0.85, resetsAtMs: reset }, WED);
    assert.equal(floor.paused(wp), false);
    ceiling.apply(wp, { utilization: 0.9, resetsAtMs: reset }, WED);
    ceiling.apply(wp, { utilization: 0.93, resetsAtMs: reset }, WED);
    assert.equal(floor.paused(wp), true, 'paused at the line');
    assert.equal(msgs(wp).length, 1, 'one message, not one per poll');
    assert.match(msgs(wp)[0]!.text, /Weekly usage is at 90%.*paused/);
    ceiling.apply(wp, { utilization: 0.05, resetsAtMs: reset + 7 * 86_400_000 }, WED);
    assert.equal(floor.paused(wp), false, 'the new week lifts its own pause');
  } finally { tmp.cleanup(); }
});

test('the 5-hour window at 99% pings once and never pauses', () => {
  const { wp, tmp } = testWorkplace();
  try {
    ceiling.apply(wp, { utilization: 0.3, resetsAtMs: reset, fiveHour: { utilization: 0.995, resetsAtMs: five } }, WED);
    ceiling.apply(wp, { utilization: 0.3, resetsAtMs: reset, fiveHour: { utilization: 0.999, resetsAtMs: five } }, WED);
    assert.equal(msgs(wp).length, 1);
    assert.equal(floor.paused(wp), false);
  } finally { tmp.cleanup(); }
});

test("the ceiling never lifts or overrides someone else's pause", () => {
  const { wp, tmp } = testWorkplace();
  try {
    floor.setPaused(wp, true, 'owner stop', 'coo');
    ceiling.apply(wp, { utilization: 0.5, resetsAtMs: reset }, WED);
    assert.equal(floor.paused(wp), true, "a COO/owner pause stays");
    assert.equal(floor.state(wp).by, 'coo');
  } finally { tmp.cleanup(); }
});

test('29 Oct: the owner lifts the 90% stop for this window; readings at 90-97% no longer re-pause, and the next window stops at 90% again', () => {
  const { wp, tmp } = testWorkplace();
  try {
    ceiling.apply(wp, { utilization: 0.9, resetsAtMs: reset }, WED);
    assert.equal(floor.paused(wp), true, 'paused at the line');
    wp.db.prepare("insert or replace into settings (key, value) values ('pace:last', ?)").run(JSON.stringify({ utilization: 0.9, resetsAtMs: reset }));
    assert.equal(ceiling.liftWeeklyStop(wp, 'coo'), new Date(reset).toISOString());
    floor.setPaused(wp, false, 'owner: keep working till 98%', 'coo');
    ceiling.apply(wp, { utilization: 0.92, resetsAtMs: reset }, WED);
    ceiling.apply(wp, { utilization: 0.97, resetsAtMs: reset }, WED);
    assert.equal(floor.paused(wp), false, 'lifted for this window');
    ceiling.apply(wp, { utilization: 0.91, resetsAtMs: reset + 7 * 86_400_000 }, WED);
    assert.equal(floor.paused(wp), true, 'a new window has its own 90% stop');
  } finally { tmp.cleanup(); }
});


test('owner 5 Nov: on a Thursday (IST) the weekly stop is 98%, not 90%; other days stay at 90%', () => {
  assert.equal(ceiling.weeklyStopAt(THU), 0.98);
  assert.equal(ceiling.weeklyStopAt(WED), 0.90);
  assert.equal(ceiling.weeklyStopAt(Date.parse('2026-11-05T19:00:00Z')), 0.90, 'Thursday 19:00 UTC is Friday 00:30 IST: back to 90%');
  assert.equal(ceiling.weeklyStopAt(Date.parse('2026-11-04T19:00:00Z')), 0.98, 'Wednesday 19:00 UTC is Thursday 00:30 IST: 98%');
  assert.equal(!!ceiling.evaluate({ utilization: 0.93 }, ceiling.CEILING, ceiling.weeklyStopAt(THU)).stop, false);
  assert.equal(ceiling.evaluate({ utilization: 0.98 }, ceiling.CEILING, ceiling.weeklyStopAt(THU)).stop, true);
  assert.equal(ceiling.evaluate({ utilization: 0.93 }, ceiling.CEILING, ceiling.weeklyStopAt(WED)).stop, true);
});
