import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as items from '../src/services/items.js';
import * as trail from '../src/services/trail.js';
import * as coo from '../src/services/coo.js';
import * as blocks from '../src/services/blocks.js';
import * as reviewWake from '../src/services/review-wake.js';
import * as watch from '../src/services/watch.js';
import { installFakeRuntime, type FakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * Owner, 2 Oct (live): Nikhil's QA story for the P0 sat Blocked, waiting on Dev's story, for about
 * 40 minutes and nobody was told; when Dev's story went back to In review nothing woke Nikhil
 * either. Now: (a) entering Blocked on anyone but the owner tells the COO at once (a bridge item)
 * and the one waited on (Asha too when the COO is offline); (b) still blocked 15 minutes later
 * re-tells the COO, once; (c) an item reaching Done or In review wakes the assignees of items
 * blocked on it; (d) In review wakes the reviewer (review-wake.ts).
 *
 * Since the owner's later rule (LLD §19.6c) a story never stays Blocked on a teammate (it becomes a
 * review or a handoff: v2-handoffs.test.ts), so the blocks here wait on someone outside the team or the COO.
 */

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
type Wp = ReturnType<typeof testWorkplace>['wp'];

function withOauth(dir: string): void {
  mkdirSync(join(dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token-value\n');
}
const told = (fake: FakeRuntime, emp: string) => fake.sessions.filter(s => s.options.cwd.includes(`/${emp}/`)).flatMap(s => [s.options.prompt, ...s.sent.map(m => m.text)]);
const cooItems = (wp: Wp, itemId: string) => coo.listItems(wp).filter(i => i.itemId === itemId);

function plan(wp: Wp) {
  const epic = items.create(wp, { level: 'epic', title: 'P0 Iris during music' }, 'owner');
  const devStory = items.create(wp, { level: 'story', parentId: epic.id, title: 'Duck music under speech', assigneeId: 'dev' }, 'asha');
  const qaStory = items.create(wp, { level: 'story', parentId: epic.id, title: 'QA the music bundle', assigneeId: 'nikhil' }, 'asha');
  items.update(wp, devStory.id, { status: 'in-progress' }, 'dev');
  items.update(wp, qaStory.id, { status: 'in-progress' }, 'nikhil');
  return { epic, devStory, qaStory };
}

function started(wp: Wp) {
  const fake = installFakeRuntime();
  const stops = [blocks.startBlockWatch(wp), reviewWake.startReviewWake(wp)];
  return { fake, stop: () => { for (const s of stops) s(); fake.restore(); } };
}

test('(a) blocked outside the team: the COO gets a bridge item at once; once per block', async () => {
  const { wp, tmp } = testWorkplace();
  const { fake, stop } = started(wp);
  try {
    withOauth(tmp.dir);
    coo.touchHeartbeatForTest(wp);
    const { qaStory } = plan(wp);
    items.update(wp, qaStory.id, { status: 'blocked', blockedReason: 'Needs the vendor\'s duck SDK build to test against.', waitingOn: 'external' }, 'nikhil');
    await tick();
    const filed = cooItems(wp, qaStory.id);
    assert.equal(filed.length, 1);
    assert.equal(filed[0]!.kind, 'stall');
    assert.match(filed[0]!.title, /^Blocked: QA the music bundle/);
    assert.match(filed[0]!.body, /Nikhil.*waiting on someone outside the team.*duck SDK/s);
    assert.equal(told(fake, 'asha').length, 0, 'the COO is online: Asha is not bothered');
    assert.ok(trail.activityFor(wp, qaStory.id).some(a => /told the COO/.test(a.text)), 'who was told is on the record');

    items.update(wp, qaStory.id, { points: 2 }, 'nikhil');
    await tick();
    assert.equal(cooItems(wp, qaStory.id).length, 1, 'same block, no second item');
  } finally {
    stop();
    tmp.cleanup();
  }
});

test('(a) the COO offline: Asha is told as well; blocked on the owner is the Inbox\'s, not this', async () => {
  const { wp, tmp } = testWorkplace();
  const { fake, stop } = started(wp);
  try {
    withOauth(tmp.dir);
    const { qaStory, devStory } = plan(wp);
    items.update(wp, qaStory.id, { status: 'blocked', blockedReason: 'Needs the vendor build.', waitingOn: 'external' }, 'nikhil');
    await tick();
    assert.equal(cooItems(wp, qaStory.id).length, 1, 'the bridge item is filed for when the COO is back');
    assert.ok(told(fake, 'asha').some(t => t.includes(qaStory.id) && /COO is offline/i.test(t)));

    items.update(wp, devStory.id, { status: 'blocked', blockedReason: 'Which ducking curve?', waitingOn: 'owner', recommendation: 'linear' }, 'dev');
    await tick();
    assert.equal(cooItems(wp, devStory.id).length, 0);
  } finally {
    stop();
    tmp.cleanup();
  }
});

test('(b) still blocked after 15 minutes: the COO is told again, once; an unblocked item is not', async () => {
  const { wp, tmp } = testWorkplace();
  const { stop } = started(wp);
  try {
    withOauth(tmp.dir);
    coo.touchHeartbeatForTest(wp);
    const { qaStory, devStory } = plan(wp);
    items.update(wp, qaStory.id, { status: 'blocked', blockedReason: 'Needs the vendor build.', waitingOn: 'external' }, 'nikhil');
    items.update(wp, devStory.id, { status: 'blocked', blockedReason: 'Needs the relay redeployed.', waitingOn: 'coo' }, 'dev');
    await tick();
    const t0 = Date.now();
    assert.equal(blocks.check(wp, qaStory.id, t0 + 10 * 60_000), null, 'not yet');
    items.update(wp, devStory.id, { status: 'in-progress', note: 'API landed' }, 'dev');
    assert.equal(blocks.check(wp, qaStory.id, t0 + 16 * 60_000), 'renotified');
    const filed = cooItems(wp, qaStory.id);
    assert.equal(filed.length, 2);
    assert.match(filed[0]!.title, /^Still blocked: QA the music bundle/);
    assert.match(filed[0]!.body, /15 min/);
    assert.equal(blocks.check(wp, qaStory.id, t0 + 45 * 60_000), null, 'once');
    assert.equal(cooItems(wp, qaStory.id).length, 2);
    assert.equal(blocks.check(wp, devStory.id, t0 + 16 * 60_000), null, 'unblocked in time: nothing');
    assert.equal(cooItems(wp, devStory.id).length, 1);
  } finally {
    stop();
    tmp.cleanup();
  }
});

test('(c) an item reaching In review or Done wakes the assignees blocked on it (by id or by title)', async () => {
  const { wp, tmp } = testWorkplace();
  const { fake, stop } = started(wp);
  try {
    withOauth(tmp.dir);
    coo.touchHeartbeatForTest(wp);
    const { epic, devStory, qaStory } = plan(wp);
    items.update(wp, qaStory.id, { status: 'blocked', blockedReason: `Waiting for ${devStory.id} to land.`, waitingOn: 'coo' }, 'nikhil');
    const byTitle = items.create(wp, { level: 'story', parentId: epic.id, title: 'Release notes', assigneeId: 'tara' }, 'asha');
    items.update(wp, byTitle.id, { status: 'in-progress' }, 'tara');
    items.update(wp, byTitle.id, { status: 'blocked', blockedReason: 'Blocked until "Duck music under speech" is reviewed.', waitingOn: 'coo' }, 'tara');
    const other = items.create(wp, { level: 'epic', title: 'Greeting' }, 'owner');
    const unrelated = items.create(wp, { level: 'story', parentId: other.id, title: 'Weather greeting', assigneeId: 'kabir' }, 'asha');
    items.update(wp, unrelated.id, { status: 'in-progress' }, 'kabir');
    items.update(wp, unrelated.id, { status: 'blocked', blockedReason: 'Needs a weather API key.', waitingOn: 'external' }, 'kabir');
    await tick();
    const before = (emp: string) => told(fake, emp).filter(t => t.includes(devStory.id)).length;
    assert.equal(before('nikhil') + before('tara') + before('kabir'), 0);

    items.update(wp, devStory.id, { status: 'in-review', reviewerId: 'nikhil' }, 'dev');
    await tick(30);
    const unblockHint = (emp: string, blockedId: string) => told(fake, emp).filter(t => t.includes(devStory.id) && t.includes(blockedId) && /unblock/i.test(t));
    assert.equal(unblockHint('nikhil', qaStory.id).length, 1, 'by id');
    assert.equal(unblockHint('tara', byTitle.id).length, 1, 'by title');
    assert.equal(told(fake, 'kabir').filter(t => t.includes(devStory.id)).length, 0, 'unrelated block: not woken');
    // (d) the reviewer is woken too (review-wake): Nikhil hears of the review once his turn ends.
    for (const s of fake.sessions.filter(x => x.options.cwd.includes('/nikhil/'))) s.result();
    await tick(30);
    assert.ok(told(fake, 'nikhil').some(t => /Review request/.test(t) && t.includes(devStory.id)));

    items.update(wp, devStory.id, { points: 3 }, 'dev');
    await tick(30);
    assert.equal(unblockHint('nikhil', qaStory.id).length, 1, 'once per arrival');

    items.update(wp, devStory.id, { status: 'done' }, 'nikhil');
    await tick(30);
    assert.equal(unblockHint('tara', byTitle.id).length, 2, 'Done is a new arrival: told again');
  } finally {
    stop();
    tmp.cleanup();
  }
});

test('at start, blocks that already exist are not announced as new; they get the one 15-minute re-tell', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    withOauth(tmp.dir);
    coo.touchHeartbeatForTest(wp);
    const { qaStory } = plan(wp);
    items.update(wp, qaStory.id, { status: 'blocked', blockedReason: 'Needs the vendor build.', waitingOn: 'external' }, 'nikhil');
    const stop = blocks.startBlockWatch(wp);
    try {
      items.update(wp, qaStory.id, { points: 2 }, 'nikhil');
      await tick();
      assert.equal(cooItems(wp, qaStory.id).length, 0, 'not a new block');
      assert.equal(told(fake, 'dev').length, 0);
      assert.equal(blocks.check(wp, qaStory.id, Date.now() + 16 * 60_000), 'renotified');
    } finally {
      stop();
    }
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('flag_stall naming who it waits on tells the COO once, not twice', async () => {
  const { wp, tmp } = testWorkplace();
  const { stop } = started(wp);
  try {
    withOauth(tmp.dir);
    coo.touchHeartbeatForTest(wp);
    const { qaStory } = plan(wp);
    watch.flag(wp, qaStory.id, { by: 'nikhil', reason: 'Needs the vendor build.', waitingOn: 'external' });
    await tick();
    assert.equal(items.require$(wp, qaStory.id).status, 'blocked');
    assert.equal(cooItems(wp, qaStory.id).length, 1);
  } finally {
    stop();
    tmp.cleanup();
  }
});
