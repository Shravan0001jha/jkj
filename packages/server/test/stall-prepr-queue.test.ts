import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as items from '../src/services/items.js';
import * as stall from '../src/services/stall-chain.js';
import { rawGet } from '../src/services/v2-map.js';
import { testWorkplace } from './fakes/workplace.js';

/** 14 Nov: two stories rang the owner as "stalled" while they only waited in the pre-pr queue (1-3 h). */
test('an In-progress story whose author has a pre-pr run live is not stalled; without one it is', () => {
  const { wp, tmp } = testWorkplace();
  const real = stall.prePrLive;
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Timeparse' }, 'owner');
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'for 3 raaton reads 15:00', assigneeId: 'kabir' }, 'asha');
    items.update(wp, s.id, { status: 'in-progress', reason: 'test: moved' }, 'kabir');
    const later = Date.now() + 120 * 60_000;
    stall.setPrePrLiveForTest(() => false);
    assert.ok(stall.evaluate(wp, rawGet(wp, s.id)!, later), 'no pre-pr: nobody on it, so it is stalled (control)');
    stall.setPrePrLiveForTest((_wp, who) => who === 'kabir');
    assert.equal(stall.evaluate(wp, rawGet(wp, s.id)!, later), null, 'pre-pr live for its author: waiting on the queue');
  } finally { stall.setPrePrLiveForTest(real); tmp.cleanup(); }
});
