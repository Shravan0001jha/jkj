import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as items from '../src/services/items.js';
import * as trail from '../src/services/trail.js';
import * as employees from '../src/services/employees.js';
import * as runs from '../src/services/runs.js';
import * as reviewWake from '../src/services/review-wake.js';
import { installFakeRuntime, type FakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';
import { boot, call } from './fakes/boot.js';

/**
 * QA, 2 Oct: an item entering In review woke nobody; the reviewer heard of it only when the stall
 * watcher told the COO 30 minutes later. Now the reviewer is woken at once (a message into an
 * open, idle session, or a short review session when free), a busy reviewer's reviews queue (P0 /
 * focus first, then oldest) and start when the current turn or session ends, and one item never
 * gets two review sessions.
 */

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
type Wp = ReturnType<typeof testWorkplace>['wp'];

function withOauth(dir: string): void {
  mkdirSync(join(dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token-value\n');
}

const of = (fake: FakeRuntime, emp: string) => fake.sessions.filter(s => s.options.cwd.includes(`/${emp}/`));
/** Every text the reviewer was handed: opening prompts and follow-up messages. */
const told = (fake: FakeRuntime, emp: string) => of(fake, emp).flatMap(s => [s.options.prompt, ...s.sent.map(m => m.text)]);

function plan(wp: Wp) {
  const epic = items.create(wp, { level: 'epic', title: 'Iris during music' }, 'owner');
  const focusEpic = items.create(wp, { level: 'epic', title: 'Greeting' }, 'owner');
  items.setFocus(wp, [focusEpic.id], 'owner');
  // Assignee 'owner': no sessions are started for the builders, so only the reviewer's show up.
  const story = (title: string, parent = epic.id, assigneeId = 'owner') => items.create(wp, { level: 'story', parentId: parent, title, assigneeId }, 'asha');
  return { epic, focusEpic, story };
}

const toReview = (wp: Wp, id: string, reviewerId = 'nikhil') => {
  items.update(wp, id, { status: 'in-progress' }, 'owner');
  items.update(wp, id, { status: 'in-review', reviewerId }, 'owner');
};

test('a free reviewer gets a short review session at once, naming the item; never a second one for the same item', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  const stop = reviewWake.startReviewWake(wp);
  try {
    withOauth(tmp.dir);
    const { story } = plan(wp);
    const s = story('Mic stays live at volume 0');
    toReview(wp, s.id);
    await tick();
    assert.equal(of(fake, 'nikhil').length, 1, 'one review session');
    assert.match(of(fake, 'nikhil')[0]!.options.prompt, new RegExp(`${s.id}.*Mic stays live at volume 0`, 's'));
    assert.match(of(fake, 'nikhil')[0]!.options.prompt, /item_update/);
    assert.ok(trail.activityFor(wp, s.id).some(a => /review/i.test(a.text) && /Nikhil/.test(a.text)), 'the wake is on the item\'s record');

    // More events on the same item, and the review session ending, start nothing new.
    items.update(wp, s.id, { points: 3 }, 'owner');
    trail.comment(wp, s.id, { by: 'owner', text: 'any news?' });
    await tick();
    const open = employees.openSession('nikhil')!;
    employees.close(wp, open.agentId, 'ended');
    await tick();
    assert.equal(of(fake, 'nikhil').length, 1, 'one item, one review session');
    assert.equal(told(fake, 'nikhil').filter(t => t.includes(s.id)).length, 1);
  } finally {
    stop();
    fake.restore();
    tmp.cleanup();
  }
});

test('a reviewer with an open, idle session is messaged in it; no new session', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  const stop = reviewWake.startReviewWake(wp);
  try {
    withOauth(tmp.dir);
    const { story } = plan(wp);
    employees.talk(wp, 'nikhil', 'Hello', [], { autonomous: true });
    await tick();
    of(fake, 'nikhil')[0]!.result();
    await tick();
    const s = story('Duck music under speech');
    toReview(wp, s.id);
    await tick();
    assert.equal(of(fake, 'nikhil').length, 1, 'the open session, not a new one');
    assert.match(of(fake, 'nikhil')[0]!.sent.at(-1)!.text, new RegExp(s.id));
  } finally {
    stop();
    fake.restore();
    tmp.cleanup();
  }
});

test('a busy reviewer: reviews queue, then go one per finished turn, P0/focus first, then oldest', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  const stop = reviewWake.startReviewWake(wp);
  try {
    withOauth(tmp.dir);
    const { story, focusEpic } = plan(wp);
    employees.talk(wp, 'nikhil', 'Long job', [], { autonomous: true });
    await tick();
    assert.equal(runs.getRunAgent(employees.openSession('nikhil')!.agentId)!.status, 'running');
    const older = story('Older plain story');
    toReview(wp, older.id);
    await tick(5);
    const p0 = story('P0 echo fix');
    toReview(wp, p0.id);
    await tick(5);
    const focused = story('Greeting line', focusEpic.id);
    toReview(wp, focused.id);
    await tick();
    const session = of(fake, 'nikhil')[0]!;
    assert.equal(session.sent.length, 0, 'nothing is pushed into a turn that is running');
    assert.deepEqual(reviewWake.queued(wp, 'nikhil'), [p0.id, focused.id, older.id], 'P0 and focus before plain, each oldest first');

    session.result();
    await tick();
    assert.equal(session.sent.length, 1);
    assert.match(session.sent[0]!.text, new RegExp(p0.id));
    session.result();
    await tick();
    assert.match(session.sent[1]!.text, new RegExp(focused.id));
    session.result();
    await tick();
    assert.match(session.sent[2]!.text, new RegExp(older.id));
    session.result();
    await tick();
    assert.equal(session.sent.length, 3, 'each item once');
    assert.equal(of(fake, 'nikhil').length, 1);
  } finally {
    stop();
    fake.restore();
    tmp.cleanup();
  }
});

test('when the busy reviewer\'s session ends, the next queued review starts a session; a shutdown starts nothing', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  const stop = reviewWake.startReviewWake(wp);
  try {
    withOauth(tmp.dir);
    const { story, focusEpic } = plan(wp);
    employees.talk(wp, 'nikhil', 'Long job', [], { autonomous: true });
    await tick();
    const plain = story('Plain story');
    toReview(wp, plain.id);
    await tick(5);
    const focused = story('Greeting line', focusEpic.id);
    toReview(wp, focused.id);
    await tick();
    employees.close(wp, employees.openSession('nikhil')!.agentId, 'ended');
    await tick();
    assert.equal(of(fake, 'nikhil').length, 2, 'a review session started when the old one ended');
    assert.match(of(fake, 'nikhil')[1]!.options.prompt, new RegExp(focused.id));
    assert.deepEqual(reviewWake.queued(wp, 'nikhil'), [plain.id]);

    employees.closeAll(wp, 'shutdown');
    await tick();
    assert.equal(of(fake, 'nikhil').length, 2, 'a shutdown never starts a review');
    assert.deepEqual(reviewWake.queued(wp, 'nikhil'), [plain.id], 'still queued for after the restart');
  } finally {
    stop();
    fake.restore();
    tmp.cleanup();
  }
});

test('an item that leaves In review leaves the queue; the owner as reviewer wakes nobody', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  const stop = reviewWake.startReviewWake(wp);
  try {
    withOauth(tmp.dir);
    const { story, epic } = plan(wp);
    employees.talk(wp, 'nikhil', 'Long job', [], { autonomous: true });
    await tick();
    const s = story('Sent back soon');
    toReview(wp, s.id);
    await tick();
    assert.deepEqual(reviewWake.queued(wp, 'nikhil'), [s.id]);
    items.update(wp, s.id, { status: 'in-progress', note: 'not ready' }, 'owner');
    await tick();
    assert.deepEqual(reviewWake.queued(wp, 'nikhil'), []);
    of(fake, 'nikhil')[0]!.result();
    await tick();
    assert.equal(of(fake, 'nikhil')[0]!.sent.length, 0);

    // Re-entering review later is a new episode: it is woken again.
    toReview(wp, s.id);
    await tick();
    assert.equal(of(fake, 'nikhil')[0]!.sent.length, 1);

    const mine = story('Owner reviews this', epic.id, 'dev');
    const before = fake.sessions.length;
    toReview(wp, mine.id, 'owner');
    await tick();
    assert.equal(fake.sessions.length, before);
  } finally {
    stop();
    fake.restore();
    tmp.cleanup();
  }
});

test('wired at boot: POST /api/items/:id to in-review wakes the reviewer', async () => {
  const b = await boot();
  try {
    const epic = await call<{ item: { id: string } }>(b.base, 'POST', '/api/items', { level: 'epic', title: 'Iris during music' });
    const s = await call<{ item: { id: string } }>(b.base, 'POST', '/api/items', { level: 'story', parentId: epic.body.item.id, title: 'Mic stays live', assigneeId: 'owner' });
    await call(b.base, 'POST', `/api/items/${s.body.item.id}`, { status: 'in-progress' });
    const r = await call(b.base, 'POST', `/api/items/${s.body.item.id}`, { status: 'in-review', reviewerId: 'nikhil' });
    assert.equal(r.status, 200);
    await tick(30);
    assert.ok(of(b.fake, 'nikhil').some(x => x.options.prompt.includes(s.body.item.id)));
  } finally {
    await b.stop();
  }
});
