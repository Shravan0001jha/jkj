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
import * as manager from '../src/services/manager.js';
import { installFakeRuntime, type FakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * Owner, 2 Oct (live): Nikhil's QA story for the P0 sat Blocked, waiting on Dev's story, for about
 * 40 minutes and nobody was told; when Dev's story went back to In review nothing woke Nikhil
 * either. Now: (a) entering Blocked on anyone but the owner tells Asha at once (owner, 2 Oct: she owns
 * stall handling, LLD §19.6e; the COO directly only when the COO is the one waited on, else when Asha
 * has not acted in 15 minutes) and the one waited on; (b) still blocked 15 minutes later re-tells, once; (c) an item reaching Done or In review wakes the assignees of items
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
const alerts = (wp: Wp, itemId: string) => manager.list(wp).filter(r => r.itemId === itemId);

function plan(wp: Wp) {
  const epic = items.create(wp, { level: 'epic', title: 'P0 Iris during music' }, 'owner');
  const devStory = items.create(wp, { level: 'story', parentId: epic.id, title: 'Duck music under speech', assigneeId: 'dev' }, 'asha');
  const qaStory = items.create(wp, { level: 'story', parentId: epic.id, title: 'QA the music bundle', assigneeId: 'nikhil' }, 'asha');
  items.update(wp, devStory.id, { status: 'in-progress', reason: 'test: moved' }, 'dev');
  items.update(wp, qaStory.id, { status: 'in-progress', reason: 'test: moved' }, 'nikhil');
  return { epic, devStory, qaStory };
}

function started(wp: Wp) {
  const fake = installFakeRuntime();
  const stops = [blocks.startBlockWatch(wp), reviewWake.startReviewWake(wp)];
  return { fake, stop: () => { for (const s of stops) s(); fake.restore(); } };
}

test('(a) blocked outside the team: Asha is told at once, not the COO; once per block', async () => {
  const { wp, tmp } = testWorkplace();
  const { fake, stop } = started(wp);
  try {
    withOauth(tmp.dir);
    coo.touchHeartbeatForTest(wp);
    const { qaStory } = plan(wp);
    items.update(wp, qaStory.id, { status: 'blocked', blockedReason: 'Needs the vendor\'s duck SDK build to test against.', waitingOn: 'external', reason: 'test: moved' }, 'nikhil');
    await tick();
    assert.equal(cooItems(wp, qaStory.id).length, 0, 'Asha first: not the COO');
    assert.equal(alerts(wp, qaStory.id).length, 1);
    assert.match(alerts(wp, qaStory.id)[0]!.title, /^Blocked: QA the music bundle/);
    assert.ok(told(fake, 'asha').some(t => /Nikhil is blocked on Story .*QA the music bundle.*waiting on someone outside the team.*duck SDK/s.test(t)));
    assert.ok(trail.activityFor(wp, qaStory.id).some(a => /told Asha/.test(a.text)), 'who was told is on the record');

    items.update(wp, qaStory.id, { points: 2 }, 'nikhil');
    await tick();
    assert.equal(alerts(wp, qaStory.id).length, 1, 'same block, no second alert');
    // Asha does not act: the COO gets it after 15 minutes, once.
    assert.equal(manager.escalate(wp, Date.now() + 16 * 60_000).length, 1);
    assert.equal(cooItems(wp, qaStory.id).length, 1);
    assert.match(cooItems(wp, qaStory.id)[0]!.body, /Nikhil.*waiting on someone outside the team.*duck SDK.*Asha has not acted/s);
  } finally {
    stop();
    tmp.cleanup();
  }
});

test('(a) waiting on the COO goes straight to the COO; blocked on the owner is the Inbox\'s, not this', async () => {
  const { wp, tmp } = testWorkplace();
  const { fake, stop } = started(wp);
  try {
    withOauth(tmp.dir);
    const { qaStory, devStory } = plan(wp);
    items.update(wp, qaStory.id, { status: 'blocked', blockedReason: 'Needs the relay redeployed.', waitingOn: 'coo', reason: 'test: moved' }, 'nikhil');
    await tick();
    assert.equal(cooItems(wp, qaStory.id).length, 1, 'the COO is the one waited on (filed for when the COO is back)');
    assert.equal(alerts(wp, qaStory.id).length, 0);
    assert.equal(told(fake, 'asha').filter(t => t.includes(qaStory.id)).length, 0);

    items.update(wp, devStory.id, { status: 'blocked', blockedReason: 'Which ducking curve?', waitingOn: 'owner', recommendation: 'linear', reason: 'test: moved' }, 'dev');
    await tick();
    assert.equal(cooItems(wp, devStory.id).length, 0);
  } finally {
    stop();
    tmp.cleanup();
  }
});

test('(b) still blocked after 15 minutes: told again, once (Asha; the COO for a COO wait); an unblocked item is not', async () => {
  const { wp, tmp } = testWorkplace();
  const { fake, stop } = started(wp);
  try {
    withOauth(tmp.dir);
    coo.touchHeartbeatForTest(wp);
    const { qaStory, devStory } = plan(wp);
    items.update(wp, qaStory.id, { status: 'blocked', blockedReason: 'Needs the vendor build.', waitingOn: 'external', reason: 'test: moved' }, 'nikhil');
    items.update(wp, devStory.id, { status: 'blocked', blockedReason: 'Needs the relay redeployed.', waitingOn: 'coo', reason: 'test: moved' }, 'dev');
    await tick();
    const t0 = Date.now();
    assert.equal(blocks.check(wp, qaStory.id, t0 + 10 * 60_000), null, 'not yet');
    items.update(wp, devStory.id, { status: 'in-progress', note: 'API landed' }, 'dev');
    assert.equal(blocks.check(wp, qaStory.id, t0 + 16 * 60_000), 'renotified');
    const still = alerts(wp, qaStory.id).find(r => /^Still blocked: QA the music bundle/.test(r.title))!;
    assert.match(still.body, /15 min/);
    assert.equal(cooItems(wp, qaStory.id).length, 0, 'Asha first');
    for (const s of fake.sessions.filter(x => x.options.cwd.includes('/asha/'))) s.result();
    await tick();
    manager.deliver(wp);
    assert.ok(told(fake, 'asha').some(t => /Still blocked: QA the music bundle/.test(t) || /blocked on Story .* for 15 min/.test(t)));
    assert.equal(blocks.check(wp, qaStory.id, t0 + 45 * 60_000), null, 'once');
    assert.equal(alerts(wp, qaStory.id).length, 2);
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
    items.update(wp, qaStory.id, { status: 'blocked', blockedReason: `Waiting for ${devStory.id} to land.`, waitingOn: 'coo', reason: 'test: moved' }, 'nikhil');
    const byTitle = items.create(wp, { level: 'story', parentId: epic.id, title: 'Release notes', assigneeId: 'tara' }, 'asha');
    items.update(wp, byTitle.id, { status: 'in-progress', reason: 'test: moved' }, 'tara');
    items.update(wp, byTitle.id, { status: 'blocked', blockedReason: 'Blocked until "Duck music under speech" is reviewed.', waitingOn: 'coo', reason: 'test: moved' }, 'tara');
    const other = items.create(wp, { level: 'epic', title: 'Greeting' }, 'owner');
    const unrelated = items.create(wp, { level: 'story', parentId: other.id, title: 'Weather greeting', assigneeId: 'kabir' }, 'asha');
    items.update(wp, unrelated.id, { status: 'in-progress', reason: 'test: moved' }, 'kabir');
    items.update(wp, unrelated.id, { status: 'blocked', blockedReason: 'Needs a weather API key.', waitingOn: 'external', reason: 'test: moved' }, 'kabir');
    await tick();
    const before = (emp: string) => told(fake, emp).filter(t => t.includes(devStory.id)).length;
    assert.equal(before('nikhil') + before('tara') + before('kabir'), 0);

    items.update(wp, devStory.id, { status: 'in-review', reviewerId: 'nikhil', reason: 'test: moved' }, 'dev');
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

    items.update(wp, devStory.id, { status: 'done', reason: 'test: moved' }, 'nikhil');
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
    items.update(wp, qaStory.id, { status: 'blocked', blockedReason: 'Needs the vendor build.', waitingOn: 'external', reason: 'test: moved' }, 'nikhil');
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

test('flag_stall naming who it waits on alerts once, not twice (Asha; the COO when it waits on the COO)', async () => {
  const { wp, tmp } = testWorkplace();
  const { stop } = started(wp);
  try {
    withOauth(tmp.dir);
    coo.touchHeartbeatForTest(wp);
    const { qaStory } = plan(wp);
    watch.flag(wp, qaStory.id, { by: 'nikhil', reason: 'Needs the vendor build.', waitingOn: 'external' });
    await tick();
    assert.equal(items.require$(wp, qaStory.id).status, 'blocked');
    assert.equal(alerts(wp, qaStory.id).length, 1, 'the flag, not the flag and the block');
    assert.equal(cooItems(wp, qaStory.id).length, 0);

    const { devStory } = { devStory: items.list(wp, { assigneeId: 'dev' })[0]! };
    watch.flag(wp, devStory.id, { by: 'dev', reason: 'Needs the relay redeployed.', waitingOn: 'coo' });
    await tick();
    assert.equal(cooItems(wp, devStory.id).length, 1, 'waiting on the COO: the COO, once');
    assert.equal(alerts(wp, devStory.id).length, 0);
  } finally {
    stop();
    tmp.cleanup();
  }
});
