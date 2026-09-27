import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as spend from '../src/services/spend.js';
import * as inbox from '../src/services/inbox.js';
import { testWorkplace } from './fakes/workplace.js';

/** Real money, ₹ = usd × the configured rate, so the old expectations still read naturally. */
const usage = (employeeId: string, usd: number, at?: string) => ({
  employeeId, sessionId: 's1', source: 'anthropic-api' as const, basis: 'metered' as const, what: 'test', inr: usd * RATE, detail: { usd }, ...(at ? { at } : {}),
});
let RATE = 88;

test('usd converts to inr at the configured rate and buckets by IST day', () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_USD_INR: '80' });
  RATE = 80;
  try {
    const e = spend.record(wp, usage('tara', 0.5, '2026-09-27T18:00:00.000Z'));   // 23:30 IST on 27 Sep
    assert.equal(e.inr, 40);
    spend.record(wp, usage('tara', 0.25, '2026-09-27T18:45:00.000Z'));           // 00:15 IST on 28 Sep
    assert.equal(spend.summary(wp, '2026-09-27').byEmployee['tara'], 40);
    assert.equal(spend.summary(wp, '2026-09-28').byEmployee['tara'], 20);
    assert.equal(spend.summary(wp, '2026-09-27').byUnit['platforms'], 40);
    assert.equal(spend.dayOf('2026-09-27T18:45:00.000Z'), '2026-09-28');
  } finally {
    tmp.cleanup();
  }
});

test('the company cap pauses spawns and files exactly one Inbox item; raising it unpauses', () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_CAP_INR: '100', WORKPLACE_USD_INR: '100' });
  RATE = 100;
  try {
    const day = '2026-09-27';
    const paused: string[] = [];
    spend.onPause((_wp, scope) => paused.push(scope));

    spend.record(wp, usage('tara', 0.5, `${day}T05:00:00.000Z`));   // ₹50
    assert.equal(spend.canSpend(wp, 'tara', day).ok, true);
    spend.record(wp, usage('mira', 0.5, `${day}T05:01:00.000Z`));   // ₹100 = cap
    const s = spend.summary(wp, day);
    assert.equal(s.companyInr, 100);
    assert.deepEqual(s.paused, ['company']);
    assert.deepEqual(paused, ['company']);
    assert.equal(spend.canSpend(wp, 'kabir', day).ok, false);
    assert.equal(spend.canSpend(wp, 'kabir', day).scope, 'company');

    // A second record at the cap does not file a second item.
    spend.record(wp, usage('mira', 0.01, `${day}T05:02:00.000Z`));
    const items = inbox.list(wp).filter(i => i.kind === 'cap');
    assert.equal(items.length, 1);
    assert.equal(items[0]!.context['scope'], 'company');

    // The owner raises today's cap through the Inbox answer.
    inbox.answer(wp, items[0]!.id, 'raise-today', '₹300', 'telegram');
    assert.equal(spend.capFor(wp, day), 300);
    assert.equal(spend.canSpend(wp, 'kabir', day).ok, true);
    assert.deepEqual(spend.summary(wp, day).paused, []);
    // Tomorrow the configured cap is back.
    assert.equal(spend.capFor(wp, '2026-09-28'), 100);
  } finally {
    tmp.cleanup();
  }
});

test('employee and unit caps are independent of the company cap', () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_CAP_INR: '100000', WORKPLACE_USD_INR: '100' });
  RATE = 100;
  try {
    const day = '2026-09-27';
    // tara: ₹150/day; platforms unit: ₹350/day
    spend.record(wp, usage('tara', 1.5, `${day}T05:00:00.000Z`));
    let s = spend.summary(wp, day);
    assert.deepEqual(s.paused, ['employee:tara']);
    assert.equal(spend.canSpend(wp, 'tara', day).ok, false);
    assert.equal(spend.canSpend(wp, 'rohan', day).ok, true, 'a unit-mate is not paused by an employee cap');

    spend.record(wp, usage('rohan', 2.0, `${day}T05:01:00.000Z`));   // unit total ₹350
    s = spend.summary(wp, day);
    assert.ok(s.paused.includes('unit:platforms'));
    assert.ok(s.paused.includes('employee:rohan'));
    assert.equal(spend.canSpend(wp, 'kabir', day).ok, true, 'kabir is in capabilities, not platforms');
  } finally {
    tmp.cleanup();
  }
});

test('remaining budget in USD is the smaller of the employee and company headroom', () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_CAP_INR: '200', WORKPLACE_USD_INR: '100' });
  RATE = 100;
  try {
    const day = '2026-09-27';
    spend.record(wp, usage('nikhil', 0.2, `${day}T05:00:00.000Z`));  // ₹20 of nikhil's 120; company 20 of 200
    assert.equal(spend.remainingUsd(wp, 'nikhil', day), 1.0);          // employee headroom ₹100
    spend.record(wp, usage('tara', 1.0, `${day}T05:01:00.000Z`));    // company now 120 of 200
    assert.equal(spend.remainingUsd(wp, 'nikhil', day), 0.8);          // company headroom ₹80 wins
  } finally {
    tmp.cleanup();
  }
});
