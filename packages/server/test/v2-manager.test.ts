import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as items from '../src/services/items.js';
import * as trail from '../src/services/trail.js';
import * as coo from '../src/services/coo.js';
import * as spend from '../src/services/spend.js';
import * as manager from '../src/services/manager.js';
import { installFakeRuntime, type FakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * Owner, 2 Oct (LLD §19.6e): Asha manages every agent and owns stall handling. Operational alerts go
 * to Asha first (a message between turns, a short session when she has none, queued while she is
 * mid-turn); the COO hears only when she has not acted within 15 minutes, when the call is above her
 * authority, or when she herself is stuck. Every 20 minutes while work is active she gets one digest.
 */

const MIN = 60_000;
const tick = (ms = 15) => new Promise(r => setTimeout(r, ms));
type Wp = ReturnType<typeof testWorkplace>['wp'];

function withOauth(dir: string): void {
  mkdirSync(join(dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token-value\n');
}
const of = (fake: FakeRuntime, emp: string) => fake.sessions.filter(s => s.options.cwd.includes(`/${emp}/`));
const told = (fake: FakeRuntime, emp: string) => of(fake, emp).flatMap(s => [s.options.prompt, ...s.sent.map(m => m.text)]);
const cooItems = (wp: Wp, itemId: string) => coo.listItems(wp).filter(i => i.itemId === itemId);

function setup() {
  const t = testWorkplace();
  const fake = installFakeRuntime();
  withOauth(t.tmp.dir);
  const epic = items.create(t.wp, { level: 'epic', title: 'Iris during music' }, 'owner');
  items.setFocus(t.wp, [epic.id], 'owner');
  const story = (title: string, assigneeId: string) => items.create(t.wp, { level: 'story', parentId: epic.id, title, assigneeId }, 'asha');
  return { ...t, fake, epic, story, done: () => { fake.restore(); t.tmp.cleanup(); } };
}

/** A new reason on an item already Blocked (the API sets it only on the move in). */
function reblock(wp: Wp, id: string, reason: string): void {
  const row = wp.db.prepare('select json from work where id = ?').get(id) as { json: string };
  wp.db.prepare('update work set json = ? where id = ?').run(JSON.stringify({ ...JSON.parse(row.json), blockedReason: reason }), id);
}

const stalled = (id: string, title: string, key = `idle:${id}:t0`) =>
  ({ key, itemId: id, title: `Stalled: ${title}`, body: `Dev's story has had no activity for 12 min.`, subjectId: 'dev' });

test('an alert reaches Asha: a short session when she has none, queued while she is mid-turn, delivered when her turn ends; once per key', async () => {
  const { wp, fake, story, done } = setup();
  const stop = manager.startManager(wp);
  try {
    const a = story('Mic gate', 'dev');
    assert.equal(manager.alert(wp, stalled(a.id, a.title)), 'asha');
    await tick();
    assert.equal(of(fake, 'asha').length, 1);
    assert.match(of(fake, 'asha')[0]!.options.prompt, new RegExp(`Stalled: Mic gate.*${a.id}`, 's'));
    assert.match(of(fake, 'asha')[0]!.options.prompt, /item_comment/);
    assert.equal(cooItems(wp, a.id).length, 0, 'the COO is not told first');
    assert.ok(trail.activityFor(wp, a.id).some(x => /Told Asha: Stalled: Mic gate/.test(x.text)));
    assert.equal(manager.alert(wp, stalled(a.id, a.title)), 'duplicate', 'once per key');

    // Asha is mid-turn: the next alert waits, then arrives as a message when the turn ends.
    const b = story('Dance tempo', 'dev');
    assert.equal(manager.alert(wp, stalled(b.id, b.title)), 'queued');
    const session = of(fake, 'asha')[0]!;
    assert.equal(session.sent.length, 0, 'nothing pushed into her running turn');
    session.result();
    await tick(30);
    assert.equal(session.sent.length, 1);
    assert.match(session.sent[0]!.text, /Stalled: Dance tempo/);
    assert.equal(of(fake, 'asha').length, 1, 'her open session, not a second one');
  } finally {
    stop();
    done();
  }
});

test('not acted on within 15 minutes: the COO gets one bridge item; an alert Asha acted on is not escalated', async () => {
  const { wp, story, done } = setup();
  try {
    const a = story('Mic gate', 'dev');
    const b = story('Dance tempo', 'dev');
    const t0 = Date.now();
    manager.alert(wp, stalled(a.id, a.title), t0);
    manager.alert(wp, stalled(b.id, b.title), t0);
    await tick();
    trail.comment(wp, b.id, { by: 'asha', text: 'Restarted Dev on it.' });
    assert.deepEqual(manager.escalate(wp, t0 + 10 * MIN), [], 'not before 15 minutes');
    assert.deepEqual(manager.escalate(wp, t0 + 16 * MIN), [`idle:${a.id}:t0`]);
    assert.equal(cooItems(wp, a.id).length, 1);
    assert.equal(cooItems(wp, a.id)[0]!.title, 'Stalled: Mic gate');
    assert.match(cooItems(wp, a.id)[0]!.body, /Asha has not acted on it in 15 min/);
    assert.equal(cooItems(wp, b.id).length, 0, 'Asha acted: no escalation');
    assert.deepEqual(manager.escalate(wp, t0 + 40 * MIN), [], 'once');
    assert.ok(trail.activityFor(wp, a.id).some(x => /Escalated to the COO/.test(x.text)));
  } finally {
    done();
  }
});

test('straight to the COO: a decision above her authority, an alert about Asha, a capped Asha; a notice to a stuck Asha is dropped', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const a = story('Mic gate', 'dev');
    assert.equal(manager.alert(wp, { ...stalled(a.id, a.title, 'k-spend'), title: 'Dev idle with 1 queued item', decision: 'spend' }), 'coo');
    assert.match(cooItems(wp, a.id)[0]!.body, /spend decision/);
    const mine = story('Weekly review', 'asha');
    assert.equal(manager.alert(wp, { ...stalled(mine.id, mine.title, 'k-asha'), subjectId: 'asha' }), 'coo');
    assert.match(cooItems(wp, mine.id)[0]!.body, /about Asha/);

    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`paused:${spend.dayOf()}:employee:asha`, new Date().toISOString());
    const b = story('Dance tempo', 'dev');
    assert.equal(manager.alert(wp, stalled(b.id, b.title)), 'coo');
    assert.match(cooItems(wp, b.id)[0]!.body, /Asha is paused by the employee:asha spend cap/);
    assert.equal(manager.alert(wp, { ...stalled(b.id, b.title, 'k-note'), notice: true }), 'dropped');
    assert.equal(cooItems(wp, b.id).length, 1);
    await tick();
    assert.equal(of(fake, 'asha').length, 0, 'nothing reached Asha');
  } finally {
    done();
  }
});

test('the manager digest: every 20 minutes while work is active; nothing when there is nothing to act on', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const t0 = Date.now();
    assert.equal(manager.digest(wp, t0), null, 'no work: no digest');

    const blocked = story('QA the bundle', 'nikhil');
    items.update(wp, blocked.id, { status: 'in-progress', reason: 'test: moved' }, 'nikhil');
    items.update(wp, blocked.id, { status: 'blocked', blockedReason: 'Needs the vendor build. It ships Friday.', waitingOn: 'external', reason: 'test: moved' }, 'nikhil');
    const review = story('Mic gate', 'owner');
    items.update(wp, review.id, { status: 'in-progress', reason: 'test: moved' }, 'owner');
    items.update(wp, review.id, { status: 'in-review', reviewerId: 'nikhil', reason: 'test: moved' }, 'owner');
    story('Dance tempo', 'dev');
    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`paused:${spend.dayOf()}:employee:dev`, new Date().toISOString());

    const text = manager.digest(wp, t0 + 60 * MIN)!;
    assert.ok(text, 'a digest');
    assert.match(text, /Dev.*1 queued.*Dance tempo/s);
    assert.match(text, /Stale reviews:.*Mic gate.*Nikhil/s);
    assert.match(text, /Blocked:.*QA the bundle.*someone outside the team.*Needs the vendor build\./s);
    assert.doesNotMatch(text, /ships Friday/, 'the reason\'s first sentence only');
    await tick();
    assert.ok(told(fake, 'asha').some(t => t.includes('Manager digest')));
    assert.equal(manager.digest(wp, t0 + 70 * MIN), null, 'not again within 20 minutes');
    reblock(wp, blocked.id, 'Needs the vendor build v2.');
    assert.ok(manager.digest(wp, t0 + 81 * MIN), 'again after 20 minutes, when something changed');
  } finally {
    done();
  }
});

test('the manager digest repeats nothing: only items whose state changed or that crossed a new age threshold; nothing new, no digest', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const t0 = Date.now();
    const blocked = story('QA the bundle', 'nikhil');
    items.update(wp, blocked.id, { status: 'in-progress', reason: 'test: moved' }, 'nikhil');
    items.update(wp, blocked.id, { status: 'blocked', blockedReason: 'Needs the vendor build.', waitingOn: 'external', reason: 'test: moved' }, 'nikhil');
    const review = story('Mic gate', 'owner');
    items.update(wp, review.id, { status: 'in-progress', reason: 'test: moved' }, 'owner');
    items.update(wp, review.id, { status: 'in-review', reviewerId: 'nikhil', reason: 'test: moved' }, 'owner');
    story('Dance tempo', 'dev');
    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`paused:${spend.dayOf()}:employee:dev`, new Date().toISOString());

    const first = manager.digest(wp, t0 + 61 * MIN)!;
    assert.match(first, /Dance tempo/);
    assert.match(first, /Mic gate/);
    assert.match(first, /QA the bundle/);
    assert.doesNotMatch(first, /unchanged/, 'nothing was delivered before: everything is new');
    await tick();
    const session = of(fake, 'asha')[0]!;
    fake.onSend = s => queueMicrotask(() => s.result()); // each digest message is a turn she finishes
    session.result();
    await tick(30);
    const heard = () => told(fake, 'asha').filter(t => t.includes('Manager digest')).length;
    assert.equal(heard(), 1);

    // Twenty minutes on and nothing changed: no digest, no message, no session.
    assert.equal(manager.digest(wp, t0 + 82 * MIN), null, 'nothing new: no digest');
    await tick(30);
    assert.equal(heard(), 1, 'Asha is not told the same thing again');
    assert.equal(of(fake, 'asha').length, 1);

    // The blocked reason changes: only that item, the rest in one line.
    reblock(wp, blocked.id, 'Vendor build slipped to Monday.');
    const second = manager.digest(wp, t0 + 103 * MIN)!;
    assert.ok(second, 'a changed item: a digest');
    assert.match(second, /Blocked:.*QA the bundle.*Vendor build slipped to Monday\./s);
    assert.doesNotMatch(second, /Mic gate|Dance tempo/, 'unchanged items are not repeated');
    assert.match(second, /2 items unchanged since your last digest/);
    await tick(30);
    assert.equal(heard(), 2);

    // A reviewer change is a state change too.
    items.update(wp, review.id, { reviewerId: 'dev' }, 'owner');
    const third = manager.digest(wp, t0 + 124 * MIN)!;
    assert.match(third, /Mic gate.*with Dev/s);
    assert.doesNotMatch(third, /Dance tempo/);
    assert.match(third, /unchanged since your last digest/);
    await tick(30);

    // Nothing changed, but the review and the block have now been waiting past the next threshold (4 h).
    assert.equal(manager.digest(wp, t0 + 145 * MIN), null);
    const fourth = manager.digest(wp, t0 + 245 * MIN)!;
    assert.ok(fourth, 'a newly crossed age threshold: a digest');
    assert.match(fourth, /Mic gate/);
    assert.match(fourth, /QA the bundle/);
    assert.match(fourth, /1 item unchanged since your last digest/);
    assert.doesNotMatch(fourth, /Dance tempo/);
    await tick(30);
  } finally {
    done();
  }
});

test('the manager digest: an undelivered digest does not count as told', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const t0 = Date.now();
    const blocked = story('QA the bundle', 'nikhil');
    items.update(wp, blocked.id, { status: 'in-progress', reason: 'test: moved' }, 'nikhil');
    items.update(wp, blocked.id, { status: 'blocked', blockedReason: 'Needs the vendor build.', waitingOn: 'external', reason: 'test: moved' }, 'nikhil');
    // Asha is mid-turn: the first digest waits in the queue.
    manager.alert(wp, stalled(blocked.id, blocked.title), t0);
    await tick();
    assert.ok(manager.digest(wp, t0 + 61 * MIN));
    assert.ok(manager.list(wp).some(r => r.key.startsWith('digest:') && r.state === 'queued'));
    // Still not delivered twenty minutes later: the next digest says it all again and replaces the queued one.
    const again = manager.digest(wp, t0 + 82 * MIN)!;
    assert.match(again, /QA the bundle/);
    assert.equal(manager.list(wp).filter(r => r.key.startsWith('digest:') && r.state === 'queued').length, 1, 'one digest waits, not two');
    of(fake, 'asha')[0]!.result();
    await tick(30);
    assert.equal(manager.deliver(wp, t0 + 83 * MIN), 1);
    await tick(30);
    assert.equal(told(fake, 'asha').filter(t => t.includes('Manager digest')).length, 1);
    assert.equal(manager.digest(wp, t0 + 103 * MIN), null, 'delivered now: nothing new');
    await tick(30);
  } finally {
    done();
  }
});
