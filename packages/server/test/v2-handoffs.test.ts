import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as items from '../src/services/items.js';
import * as trail from '../src/services/trail.js';
import * as coo from '../src/services/coo.js';
import * as inbox from '../src/services/inbox.js';
import * as work from '../src/services/work.js';
import * as employees from '../src/services/employees.js';
import * as blocks from '../src/services/blocks.js';
import * as manager from '../src/services/manager.js';
import * as reviewWake from '../src/services/review-wake.js';
import * as handoff from '../src/services/handoff.js';
import * as waits from '../src/services/waits.js';
import { workplaceTools } from '../src/services/employees.js';
import { rawGet } from '../src/services/v2-map.js';
import { installFakeRuntime, type FakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';
import { boot, call } from './fakes/boot.js';
import type { ItemDetail, PlanResponse } from '@jkj/shared';

/**
 * Owner, 2 Oct: "any story which has an agent working on it should not be marked blocked; they can
 * be rather assigned to the person working on it" (LLD §19.6c). A wait on a teammate is either a
 * review (→ In review with them as reviewer) or their work (→ a handoff: assigned to them, In
 * progress, back to the original assignee with item_handback). Blocked stays for the owner (his
 * Inbox) and for the COO / someone outside the team (the COO is told, again after 15 minutes).
 * Rework (Oct 2026): the rewrite to a review or a handoff happens only with an explicit `kind`;
 * without one, a wait on a teammate is `waiting` on them and the item stays with its assignee.
 */

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
type Wp = ReturnType<typeof testWorkplace>['wp'];

function withOauth(dir: string): void {
  mkdirSync(join(dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token-value\n');
}
const of = (fake: FakeRuntime, emp: string) => fake.sessions.filter(s => s.options.cwd.includes(`/${emp}/`));
const told = (fake: FakeRuntime, emp: string) => of(fake, emp).flatMap(s => [s.options.prompt, ...s.sent.map(m => m.text)]);
const cooItems = (wp: Wp, itemId: string) => coo.listItems(wp).filter(i => i.itemId === itemId);

function plan(wp: Wp) {
  const epic = items.create(wp, { level: 'epic', title: 'P0 Iris during music' }, 'owner');
  const qaStory = items.create(wp, { level: 'story', parentId: epic.id, title: 'QA the music bundle', assigneeId: 'nikhil' }, 'asha');
  items.update(wp, qaStory.id, { status: 'in-progress', reason: 'test: moved' }, 'nikhil');
  return { epic, qaStory };
}

function started(wp: Wp) {
  const fake = installFakeRuntime();
  const stops = [blocks.startBlockWatch(wp), reviewWake.startReviewWake(wp), handoff.startHandoffWatch(wp)];
  return { fake, stop: () => { for (const s of stops) s(); fake.restore(); } };
}

async function toolsFor(wp: Wp, employeeId: string, assignmentId?: string) {
  const server = workplaceTools(wp, employeeId, () => ({ agentId: 'a', employeeId, ...(assignmentId ? { assignmentId } : {}), startedAt: '', seen: {}, planCaptured: false }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(st);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(ct);
  return async (name: string, args: Record<string, unknown>) => JSON.stringify((await client.callTool({ name, arguments: args })).content);
}

test('classify: owner and outside waits block; a teammate is a review or a handoff by kind, else a wait', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const c = (waitingOn: string, reason: string, kind?: 'review' | 'work') => waits.classify(wp, { assigneeId: 'nikhil', waitingOn, reason, ...(kind ? { kind } : {}) });
    assert.equal(c('owner', 'Which curve?'), 'block');
    assert.equal(c('coo', 'Needs the relay redeployed'), 'block');
    assert.equal(c('external', 'Apple review of the build'), 'block', 'outside the team stays a block, keyword or not');
    assert.equal(c('nikhil', 'myself'), 'block', 'waiting on yourself is not a handoff');
    // No more guessing from the reason: without kind it is a wait on them.
    assert.equal(c('dev', 'Needs Dev to review the ducking curve'), 'wait');
    assert.equal(c('dev', 'Waiting for his sign-off'), 'wait');
    assert.equal(c('dev', 'Needs the duck build to test against'), 'wait');
    assert.equal(c('dev', 'Needs the duck build', 'review'), 'review');
    assert.equal(c('dev', 'Fix what the review found', 'work'), 'handoff');
  } finally {
    tmp.cleanup();
  }
});

test('review wait: Blocked on a teammate with kind review becomes In review with them as reviewer, and wakes them', async () => {
  const { wp, tmp } = testWorkplace();
  const { fake, stop } = started(wp);
  try {
    withOauth(tmp.dir);
    coo.touchHeartbeatForTest(wp);
    const { qaStory } = plan(wp);
    const it = items.update(wp, qaStory.id, { status: 'blocked', blockedReason: 'Needs Dev to sign off the test plan.', waitingOn: 'dev', kind: 'review', reason: 'test: moved' }, 'nikhil');
    assert.equal(it.status, 'in-review');
    assert.equal(it.reviewerId, 'dev');
    assert.equal(it.assigneeId, 'nikhil');
    assert.equal(it.blocked, undefined);
    await tick();
    assert.ok(told(fake, 'dev').some(t => t.includes(qaStory.id) && /Review request/.test(t)), 'review-wake wakes Dev');
    assert.equal(cooItems(wp, qaStory.id).length, 0, 'not a block: the COO is not told');
    assert.ok(!trail.updates(wp).some(u => u.kind === 'blocked'), 'no Blocked line in the feed');
  } finally {
    stop();
    tmp.cleanup();
  }
});

test('review wait by explicit kind through the tool: item_update kind review', async () => {
  const { wp, tmp } = testWorkplace();
  const { fake, stop } = started(wp);
  try {
    withOauth(tmp.dir);
    const { qaStory } = plan(wp);
    const nikhil = await toolsFor(wp, 'nikhil', qaStory.id);
    const reply = await nikhil('item_update', { itemId: qaStory.id, status: 'blocked', blockedReason: 'Needs his eyes on the curve.', waitingOn: 'dev', kind: 'review' });
    assert.match(reply, /in review/i);
    assert.equal(items.get(wp, qaStory.id)!.status, 'in-review');
    assert.equal(items.get(wp, qaStory.id)!.reviewerId, 'dev');
    await tick();
    assert.ok(told(fake, 'dev').some(t => t.includes(qaStory.id)));
  } finally {
    stop();
    tmp.cleanup();
  }
});

test('work wait: a handoff — reassigned, In progress, recorded, the teammate woken on the item; then handed back', async () => {
  const { wp, tmp } = testWorkplace();
  const { fake, stop } = started(wp);
  try {
    withOauth(tmp.dir);
    coo.touchHeartbeatForTest(wp);
    const { epic, qaStory } = plan(wp);
    const it = items.update(wp, qaStory.id, { status: 'blocked', blockedReason: 'Needs the duck build to test against.', waitingOn: 'dev', kind: 'work', reason: 'test: moved' }, 'nikhil');
    assert.equal(it.status, 'in-progress', 'kept In progress, never Blocked');
    assert.equal(it.assigneeId, 'dev');
    assert.equal(it.blocked, undefined);
    assert.equal(it.handoff?.fromId, 'nikhil');
    assert.equal(it.handoff?.reason, 'Needs the duck build to test against.');
    assert.ok(trail.activityFor(wp, qaStory.id).some(a => a.text === 'Handed to Dev: Needs the duck build to test against; returns to Nikhil'));
    await tick();
    const dev = of(fake, 'dev');
    assert.equal(dev.length, 1, 'a session was started for Dev');
    assert.equal(dev[0]!.options.prompt.includes(qaStory.id), true);
    assert.match(dev[0]!.options.prompt, /item_handback/);
    assert.equal(employees.openSession('dev')!.assignmentId, qaStory.id, 'the session is on that item');
    assert.equal(cooItems(wp, qaStory.id).length, 0, 'a handoff is not a block: the COO is not told');

    // More events on the same handoff wake nobody again.
    items.update(wp, qaStory.id, { points: 3 }, 'dev');
    await tick();
    assert.equal(told(fake, 'dev').filter(t => t.includes(qaStory.id)).length, 1);

    // The Plan shows it: "with Dev (handed by Nikhil)".
    const card = items.plan(wp).unfiled.find(c => c.epic.id === epic.id)!;
    assert.deepEqual(card.handoffs?.map(h => [h.itemId, h.withId, h.fromId]), [[qaStory.id, 'dev', 'nikhil']]);
    assert.equal(card.flags.length, 0);

    // Dev hands it back with a note: Nikhil has it again and is woken.
    const devTool = await toolsFor(wp, 'dev', qaStory.id);
    assert.match(await devTool('item_handback', { itemId: qaStory.id, note: 'Duck build is on emp/dev, commit abc123.' }), /Nikhil/);
    const back = items.get(wp, qaStory.id)!;
    assert.equal(back.assigneeId, 'nikhil');
    assert.equal(back.status, 'in-progress');
    assert.equal(back.handoff, undefined);
    assert.ok(trail.activityFor(wp, qaStory.id).some(a => /^Handed back to Nikhil by Dev: Duck build/.test(a.text)));
    await tick();
    assert.ok(told(fake, 'nikhil').some(t => t.includes(qaStory.id) && /abc123/.test(t)), 'Nikhil is woken with the note');
    assert.equal(items.plan(wp).unfiled.find(c => c.epic.id === epic.id)!.handoffs, undefined);

    // A second handback has nothing to hand back.
    assert.match(await devTool('item_handback', { itemId: qaStory.id, note: 'again' }), /Not handed back/);
  } finally {
    stop();
    tmp.cleanup();
  }
});

test('work wait through flag_stall: a handoff, and the COO gets no "Flagged" item; an open session is messaged', async () => {
  const { wp, tmp } = testWorkplace();
  const { fake, stop } = started(wp);
  try {
    withOauth(tmp.dir);
    coo.touchHeartbeatForTest(wp);
    const { qaStory } = plan(wp);
    employees.talk(wp, 'dev', 'Hello', [], { autonomous: true });
    await tick();
    of(fake, 'dev')[0]!.result();
    await tick();
    const nikhil = await toolsFor(wp, 'nikhil', qaStory.id);
    const reply = await nikhil('flag_stall', { reason: 'Needs the duck build.', waitingOn: 'dev', kind: 'work' });
    assert.match(reply, /Dev/);
    assert.equal(items.get(wp, qaStory.id)!.assigneeId, 'dev');
    assert.equal(items.get(wp, qaStory.id)!.status, 'in-progress');
    await tick();
    assert.equal(of(fake, 'dev').length, 1, 'the open session, not a new one');
    assert.match(of(fake, 'dev')[0]!.sent.at(-1)!.text, new RegExp(`${qaStory.id}.*item_handback`, 's'));
    assert.equal(cooItems(wp, qaStory.id).length, 0);
  } finally {
    stop();
    tmp.cleanup();
  }
});

test('handback over the API, and nested handoffs unwind in order', async () => {
  const b = await boot();
  try {
    const wp = b.running.wp;
    const { qaStory } = plan(wp);
    items.update(wp, qaStory.id, { status: 'blocked', blockedReason: 'Needs the duck build.', waitingOn: 'dev', kind: 'work', reason: 'test: moved' }, 'nikhil');
    items.update(wp, qaStory.id, { status: 'blocked', blockedReason: 'Needs the memory API.', waitingOn: 'kabir', kind: 'work', reason: 'test: moved' }, 'dev');
    assert.equal(items.get(wp, qaStory.id)!.assigneeId, 'kabir');
    assert.equal(items.get(wp, qaStory.id)!.handoff?.fromId, 'dev');
    let r = await call<ItemDetail>(b.base, 'POST', `/api/items/${qaStory.id}/handback`, { note: 'API landed.' });
    assert.equal(r.status, 200);
    assert.equal(r.body.item.assigneeId, 'dev');
    assert.equal(r.body.item.handoff?.fromId, 'nikhil', 'the earlier handoff is still open');
    r = await call<ItemDetail>(b.base, 'POST', `/api/items/${qaStory.id}/handback`, { note: 'Build ready.' });
    assert.equal(r.body.item.assigneeId, 'nikhil');
    assert.equal(r.body.item.handoff, undefined);
    const again = await call<{ error: string }>(b.base, 'POST', `/api/items/${qaStory.id}/handback`, { note: 'x' });
    assert.equal(again.status, 400);

    // The API's update takes kind too.
    const u = await call<ItemDetail>(b.base, 'POST', `/api/items/${qaStory.id}`, { status: 'blocked', blockedReason: 'Fix the review findings', waitingOn: 'dev', kind: 'work' });
    assert.equal(u.status, 200);
    assert.equal(u.body.item.status, 'in-progress');
    assert.equal(u.body.item.assigneeId, 'dev');
    const p = await call<PlanResponse>(b.base, 'GET', '/api/plan');
    assert.equal(p.body.unfiled.flatMap(c => c.handoffs ?? []).length, 1);
  } finally {
    await b.stop();
  }
});

test('owner wait stays Blocked and raises his Inbox question; the COO is not told', async () => {
  const { wp, tmp } = testWorkplace();
  const { stop } = started(wp);
  try {
    withOauth(tmp.dir);
    coo.touchHeartbeatForTest(wp);
    const { qaStory } = plan(wp);
    const it = items.update(wp, qaStory.id, { status: 'blocked', blockedReason: 'Which device do we sign off on?', waitingOn: 'owner', recommendation: 'iPhone 15', reason: 'test: moved' }, 'nikhil');
    assert.equal(it.status, 'blocked', 'the owner is not a teammate, even for a sign-off');
    assert.equal(it.assigneeId, 'nikhil');
    assert.ok(inbox.list(wp, 'open').some(i => i.context['itemId'] === qaStory.id && /Blocked on you/.test(i.title)));
    await tick();
    assert.equal(cooItems(wp, qaStory.id).length, 0);
  } finally {
    stop();
    tmp.cleanup();
  }
});

test('external wait stays Blocked: Asha is told at once and again after 15 minutes; the COO if she does not act', async () => {
  const { wp, tmp } = testWorkplace();
  const { stop } = started(wp);
  try {
    withOauth(tmp.dir);
    coo.touchHeartbeatForTest(wp);
    const { qaStory } = plan(wp);
    const it = items.update(wp, qaStory.id, { status: 'blocked', blockedReason: 'Apple has to review the TestFlight build.', waitingOn: 'external', reason: 'test: moved' }, 'nikhil');
    assert.equal(it.status, 'blocked');
    assert.equal(it.blocked?.waitingOn, 'external');
    await tick();
    const alerts = () => manager.list(wp).filter(r => r.itemId === qaStory.id);
    assert.equal(cooItems(wp, qaStory.id).length, 0, 'Asha first (LLD §19.6e)');
    assert.equal(alerts().length, 1);
    assert.match(alerts()[0]!.body, /someone outside the team/);
    assert.equal(blocks.check(wp, qaStory.id, Date.now() + 16 * 60_000), 'renotified');
    assert.equal(alerts().length, 2);
    assert.ok(manager.escalate(wp, Date.now() + 16 * 60_000).length >= 1, 'Asha did not act: the COO hears');
    assert.ok(cooItems(wp, qaStory.id).length >= 1);
    assert.match(cooItems(wp, qaStory.id)[0]!.body, /Asha has not acted/);

    // Waiting on the COO is a real block too.
    const other = items.create(wp, { level: 'story', parentId: it.parentId!, title: 'Relay deploy', assigneeId: 'dev' }, 'asha');
    items.update(wp, other.id, { status: 'in-progress', reason: 'test: moved' }, 'dev');
    assert.equal(items.update(wp, other.id, { status: 'blocked', blockedReason: 'Needs the relay redeployed.', waitingOn: 'coo', reason: 'test: moved' }, 'dev').status, 'blocked');
  } finally {
    stop();
    tmp.cleanup();
  }
});

test('migration: Blocked items waiting on a teammate become Waiting on them at boot, once; owner and outside blocks are left alone', async () => {
  const { wp, tmp } = testWorkplace();
  const { fake, stop } = started(wp);
  try {
    withOauth(tmp.dir);
    const { epic, qaStory } = plan(wp);
    const mk = (title: string, assigneeId: string) => {
      const s = items.create(wp, { level: 'story', parentId: epic.id, title, assigneeId }, 'asha');
      items.update(wp, s.id, { status: 'in-progress', reason: 'test: moved' }, assigneeId);
      return s;
    };
    const reviewOne = mk('Echo fix', 'mira');
    const ownerOne = mk('Pick a voice', 'tara');
    const outside = mk('Store listing', 'rohan');
    // Old-style blocks (before this rule): written straight into the store.
    const oldBlock = (id: string, waitingOn: string, reason: string) => {
      items.update(wp, id, { status: 'blocked', blockedReason: reason, waitingOn: 'coo', reason: 'test: moved' }, 'workplace');
      const w = rawGet(wp, id)!;
      work.saveQuiet(wp, { ...w, waitingOn });
    };
    oldBlock(qaStory.id, 'dev', 'Needs the duck build.');
    oldBlock(reviewOne.id, 'nikhil', 'Waiting for Nikhil to review it.');
    items.update(wp, ownerOne.id, { status: 'blocked', blockedReason: 'Which voice?', waitingOn: 'owner', recommendation: 'Aria', reason: 'test: moved' }, 'tara');
    items.update(wp, outside.id, { status: 'blocked', blockedReason: 'Apple review.', waitingOn: 'external', reason: 'test: moved' }, 'rohan');
    await tick();

    // Rework (Oct 2026): no kind was ever given, so nothing is rewritten: each is Waiting on that person.
    assert.deepEqual(handoff.migrateBlockedWaits(wp).sort(), [qaStory.id, reviewOne.id].sort());
    const qa = items.get(wp, qaStory.id)!;
    assert.deepEqual([qa.status, qa.assigneeId, qa.waiting?.on, qa.handoff], ['waiting', 'nikhil', 'dev', undefined]);
    const rv = items.get(wp, reviewOne.id)!;
    assert.deepEqual([rv.status, rv.assigneeId, rv.waiting?.on, rv.waiting?.reason], ['waiting', 'mira', 'nikhil', 'Waiting for Nikhil to review it.']);
    assert.equal(items.get(wp, ownerOne.id)!.status, 'blocked');
    assert.equal(items.get(wp, outside.id)!.status, 'blocked');
    await tick();
    assert.ok(!told(fake, 'dev').some(t => t.includes(qaStory.id) && /item_handback/.test(t)), 'nothing is handed to Dev');

    assert.deepEqual(handoff.migrateBlockedWaits(wp), [], 'idempotent');
  } finally {
    stop();
    tmp.cleanup();
  }
});
