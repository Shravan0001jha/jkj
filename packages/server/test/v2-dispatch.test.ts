import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as items from '../src/services/items.js';
import * as trail from '../src/services/trail.js';
import * as employees from '../src/services/employees.js';
import * as runs from '../src/services/runs.js';
import * as watch from '../src/services/watch.js';
import * as coo from '../src/services/coo.js';
import * as spend from '../src/services/spend.js';
import * as reviewWake from '../src/services/review-wake.js';
import * as dispatch from '../src/services/dispatch.js';
import * as manager from '../src/services/manager.js';
import { rawGet } from '../src/services/v2-map.js';
import { installFakeRuntime, type FakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';
import { boot, tick as bootTick } from './fakes/boot.js';

/**
 * The dispatcher (outage 2 Oct, LLD §19.6d). The watcher parked Dev's story in Backlog because Dev
 * was busy; when Dev finished nothing gave him his next story, and nothing said so for two hours.
 * Now a free employee is handed their next work (reviews first, then focus stories), held Backlog
 * stays put, stale reviews are woken once, and an employee idle with queued work is reported once.
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

function setup() {
  const t = testWorkplace();
  const fake = installFakeRuntime();
  withOauth(t.tmp.dir);
  const epic = items.create(t.wp, { level: 'epic', title: 'Iris during music' }, 'owner');
  const other = items.create(t.wp, { level: 'epic', title: 'Not the focus' }, 'owner');
  items.setFocus(t.wp, [epic.id], 'owner');
  const story = (title: string, assigneeId: string, parentId = epic.id) => items.create(t.wp, { level: 'story', parentId, title, assigneeId }, 'asha');
  return { ...t, fake, epic, other, story, done: () => { fake.restore(); t.tmp.cleanup(); } };
}

const pause = (wp: Wp, employeeId: string) =>
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`paused:${spend.dayOf()}:employee:${employeeId}`, new Date().toISOString());

test('busy-parked: the watcher keeps the story Ready, queued for Dev; it starts the moment Dev frees up', async () => {
  const { wp, fake, story, done } = setup();
  const stop = dispatch.startDispatch(wp);
  try {
    const a = story('Mic gate opens over music', 'dev');
    employees.assign(wp, a.id);
    await tick();
    assert.equal(runs.getRunAgent(employees.openSession('dev')!.agentId)!.status, 'running');

    const b = story('Dance tempo follows the beat', 'dev');
    const r = watch.check(wp, b.id, Date.now() + 16 * MIN)!;
    assert.equal(r.action, 'queued');
    const queued = items.require$(wp, b.id);
    assert.equal(queued.status, 'ready', 'never Backlog for "busy"');
    assert.equal(queued.queuedFor, 'dev');
    assert.equal(queued.hold, undefined);
    assert.ok(trail.activityFor(wp, b.id).some(x => /Queued for Dev/.test(x.text) && /Mic gate/.test(x.text)));
    assert.equal(watch.evaluate(wp, rawGet(wp, b.id)!, Date.now() + 120 * MIN), null, 'the dispatcher owns it now: no "not started" stall');

    // Dev finishes A (to review) while the turn is still running: nothing is pushed into the turn.
    items.update(wp, a.id, { status: 'in-review', reviewerId: 'nikhil' }, 'dev');
    await tick();
    assert.equal(items.require$(wp, b.id).status, 'ready');
    // The turn ends: Dev is free, and B goes to his open session, on B's branch.
    of(fake, 'dev')[0]!.result();
    await tick(40);
    assert.equal(employees.openSession('dev')!.assignmentId, b.id);
    assert.equal(items.require$(wp, b.id).status, 'in-progress');
    assert.equal(items.require$(wp, b.id).queuedFor, undefined, 'queuedFor is dropped once it starts');
    assert.match(of(fake, 'dev')[0]!.sent.at(-1)!.text, new RegExp(`New assignment ${b.id}`));
    assert.equal(of(fake, 'dev').length, 1, 'the open session took it: no second session');
    assert.ok(trail.activityFor(wp, b.id).some(x => /Started: Dev was free/.test(x.text)));
  } finally {
    stop();
    done();
  }
});

test('a story the old watcher parked in Backlog (no hold) restarts when the assignee\'s session ends', async () => {
  const { wp, fake, story, done } = setup();
  const stop = dispatch.startDispatch(wp);
  try {
    const a = story('Mic gate', 'dev');
    employees.assign(wp, a.id);
    await tick();
    const c = story('Dance tempo', 'dev');
    items.update(wp, c.id, { status: 'backlog', note: 'Moved to Backlog by Asha: Dev is busy on Mic gate' }, 'asha');
    assert.equal(items.require$(wp, c.id).hold, undefined, 'the watcher\'s busy-parking is not a hold');
    items.update(wp, a.id, { status: 'in-review', reviewerId: 'nikhil' }, 'dev');
    employees.close(wp, employees.openSession('dev')!.agentId, 'ended');
    await tick(40);
    assert.equal(of(fake, 'dev').length, 2, 'a fresh session for the parked story');
    assert.equal(employees.openSession('dev')!.assignmentId, c.id);
    assert.equal(items.require$(wp, c.id).status, 'in-progress');
  } finally {
    stop();
    done();
  }
});

test('held Backlog is never started: a COO/owner move, a hold note, or hold: true; nor Backlog outside the focus', () => {
  const { wp, fake, story, other, done } = setup();
  try {
    const h1 = story('Greeting copy', 'dev');
    items.update(wp, h1.id, { status: 'backlog', note: 'waits for the P0 fixes' }, 'coo');
    const h2 = story('Weather line', 'dev');
    items.update(wp, h2.id, { status: 'backlog', note: 'parked until the P0 ships' }, 'asha');
    const h3 = story('Speaker primitive', 'dev');
    items.update(wp, h3.id, { hold: true }, 'owner');
    const side = story('Side quest', 'dev', other.id);
    items.update(wp, side.id, { status: 'backlog', note: 'Moved to Backlog by Asha: not in focus' }, 'asha');

    for (const id of [h1.id, h2.id, h3.id]) {
      const it = items.require$(wp, id);
      assert.equal(it.status, 'backlog', id);
      assert.equal(it.hold, true, id);
    }
    assert.equal(items.require$(wp, side.id).hold, undefined);
    assert.deepEqual(dispatch.queue(wp, 'dev').map(w => w.id), [], 'held and unfocused Backlog are not queued work');
    dispatch.sweep(wp);
    assert.equal(dispatch.dispatch(wp, 'dev').action, 'none');
    assert.equal(fake.sessions.length, 0);

    // Only the owner or the COO holds an item.
    assert.throws(() => items.update(wp, h1.id, { hold: false }, 'dev'), /owner or the COO/);
    assert.throws(() => items.update(wp, side.id, { hold: true, status: 'ready' }, 'owner'), /Backlog/);
    // Leaving Backlog clears the hold; the owner lifting it makes the item work again.
    items.update(wp, h3.id, { status: 'ready' }, 'owner');
    assert.equal(items.require$(wp, h3.id).hold, undefined);
    items.update(wp, h1.id, { hold: false }, 'coo');
    assert.equal(items.require$(wp, h1.id).hold, undefined);
    assert.deepEqual(dispatch.queue(wp, 'dev').map(w => w.id), [h1.id, h3.id], 'focus order, then rank, then age');
  } finally {
    done();
  }
});

test('reviews come before stories: a free reviewer gets the queued review first, the story after that turn', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const s = story('QA the release', 'nikhil');
    const r = story('Mic gate', 'owner');
    employees.talk(wp, 'nikhil', 'Long job', [], { autonomous: true });
    await tick();
    items.update(wp, r.id, { status: 'in-progress' }, 'owner');
    items.update(wp, r.id, { status: 'in-review', reviewerId: 'nikhil' }, 'owner');
    reviewWake.onItem(wp, r.id);
    assert.deepEqual(reviewWake.queued(wp, 'nikhil'), [r.id], 'queued: Nikhil is mid-turn');
    assert.equal(dispatch.dispatch(wp, 'nikhil').action, 'skipped', 'mid-turn: nothing pushed');

    const session = of(fake, 'nikhil')[0]!;
    session.result();
    await tick();
    const first = dispatch.dispatch(wp, 'nikhil');
    assert.equal(first.action, 'review');
    assert.match(session.sent.at(-1)!.text, new RegExp(`Review request: Story ${r.id}`));
    assert.equal(items.require$(wp, s.id).status, 'ready', 'the story waits for the review');

    session.result();
    await tick();
    const second = dispatch.dispatch(wp, 'nikhil');
    assert.equal(second.action, 'story');
    assert.equal(second.itemId, s.id);
    assert.match(session.sent.at(-1)!.text, new RegExp(`New assignment ${s.id}`));
    assert.equal(of(fake, 'nikhil').length, 1);
  } finally {
    done();
  }
});

test('stale In review items (from before the review wake) are woken once; a review session that died is requeued once', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const r = story('Errand flow — Server', 'owner');
    items.update(wp, r.id, { status: 'in-progress' }, 'owner');
    items.update(wp, r.id, { status: 'in-review', reviewerId: 'nikhil' }, 'owner');
    assert.equal(of(fake, 'nikhil').length, 0, 'no review wake running: nobody was woken');

    assert.deepEqual(dispatch.wakeStaleReviews(wp), [r.id]);
    await tick();
    assert.equal(of(fake, 'nikhil').length, 1);
    assert.match(of(fake, 'nikhil')[0]!.options.prompt, new RegExp(r.id));
    assert.deepEqual(dispatch.wakeStaleReviews(wp), [], 'deduped: the reviewer has an open review');
    dispatch.sweep(wp, Date.now() + 2 * MIN);
    dispatch.sweep(wp, Date.now() + 4 * MIN);
    assert.equal(told(fake, 'nikhil').filter(t => t.includes(r.id)).length, 1, 'sweeps never wake twice');

    // The review session ends with no verdict: requeued once, never again for the same episode.
    employees.close(wp, employees.openSession('nikhil')!.agentId, 'ended');
    assert.deepEqual(dispatch.wakeStaleReviews(wp), [r.id]);
    await tick();
    assert.equal(of(fake, 'nikhil').length, 2);
    employees.close(wp, employees.openSession('nikhil')!.agentId, 'ended');
    assert.deepEqual(dispatch.wakeStaleReviews(wp), []);
    await tick();
    assert.equal(of(fake, 'nikhil').length, 2, 'once per episode');
    assert.ok(trail.activityFor(wp, r.id).some(a => /Review requested again from Nikhil/.test(a.text)));
  } finally {
    done();
  }
});

test('the idle alert: queued focus work and idle 10+ minutes; a spend cap is the COO\'s call, once per episode', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const s = story('Dance tempo', 'dev');
    pause(wp, 'dev');
    const t0 = Date.now();
    dispatch.sweep(wp, t0);
    dispatch.sweep(wp, t0 + 5 * MIN);
    const alerts = () => coo.listItems(wp).filter(i => /idle with/.test(i.title));
    assert.equal(alerts().length, 0, 'not before 10 minutes');
    dispatch.sweep(wp, t0 + 11 * MIN);
    assert.equal(alerts().length, 1);
    assert.equal(alerts()[0]!.title, 'Dev idle with 1 queued item');
    assert.match(alerts()[0]!.body, /^Dev idle with 1 queued item: paused by the employee:dev spend cap/);
    assert.equal(alerts()[0]!.itemId, s.id);
    dispatch.sweep(wp, t0 + 20 * MIN);
    dispatch.sweep(wp, t0 + 40 * MIN);
    assert.equal(alerts().length, 1, 'once per episode');
    assert.equal(fake.sessions.length, 0, 'the cap is respected');

    // The cap lifts: the story starts, the episode ends.
    spend.liftPause(wp, 'employee:dev', spend.dayOf(), 'owner');
    dispatch.sweep(wp, t0 + 42 * MIN);
    await tick();
    assert.equal(fake.sessions.length, 1);
    assert.equal(wp.db.prepare('select 1 from settings where key = ?').get('dispatch-idle:dev'), undefined);
  } finally {
    done();
  }
});

test('the idle alert for any other reason goes to Asha first; the COO hears only if she does not act in 15 minutes', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const x = story('Mic gate', 'dev');
    items.update(wp, x.id, { status: 'in-progress' }, 'dev'); // In progress, but no session on it
    const y = story('Dance tempo', 'dev');
    const t0 = Date.now();
    dispatch.sweep(wp, t0);
    assert.deepEqual(dispatch.sweep(wp, t0 + 11 * MIN).alerts, ['dev']);
    await tick();
    const alert = manager.list(wp).find(r => r.title === 'Dev idle with 1 queued item')!;
    assert.match(alert.body, /Dev has "Mic gate" In progress/);
    assert.ok(told(fake, 'asha').some(t => /Dev idle with 1 queued item/.test(t)), 'Asha is told');
    assert.equal(coo.listItems(wp).filter(i => /idle with/.test(i.title)).length, 0, 'not the COO');
    manager.escalate(wp, t0 + 20 * MIN);
    assert.equal(coo.listItems(wp).filter(i => /idle with/.test(i.title)).length, 0, 'not before 15 minutes');
    manager.escalate(wp, t0 + 27 * MIN);
    const filed = coo.listItems(wp).filter(i => /idle with/.test(i.title));
    assert.equal(filed.length, 1);
    assert.equal(filed[0]!.itemId, y.id);
    assert.match(filed[0]!.body, /Asha has not acted on it in 15 min/);
  } finally {
    done();
  }
});

test('caps are respected: the concurrency cap and the spend cap stop a start, and say why', async () => {
  const { wp, fake, story, done } = setup();
  try {
    story('Dance tempo', 'dev');
    const dev = wp.org.employees.find(e => e.id === 'dev')!;
    const cap = dev.budget.concurrentSessions;
    dev.budget.concurrentSessions = 0;
    const r1 = dispatch.dispatch(wp, 'dev');
    assert.equal(r1.action, 'skipped');
    assert.match(r1.reason!, /concurrency cap \(0\)/);
    dev.budget.concurrentSessions = cap;

    pause(wp, 'dev');
    const r2 = dispatch.dispatch(wp, 'dev');
    assert.equal(r2.action, 'skipped');
    assert.match(r2.reason!, /spend cap/);
    assert.equal(fake.sessions.length, 0);

    spend.liftPause(wp, 'employee:dev', spend.dayOf(), 'owner');
    assert.equal(dispatch.dispatch(wp, 'dev').action, 'story');
    await tick();
    assert.equal(fake.sessions.length, 1);
    // One story at a time: with that one In progress, the next waits.
    story('Beat confidence', 'dev');
    fake.last().result();
    await tick();
    const r3 = dispatch.dispatch(wp, 'dev');
    assert.equal(r3.action, 'skipped');
    assert.match(r3.reason!, /In progress/);
  } finally {
    done();
  }
});

test('the boot migration holds Backlog the COO/owner parked and leaves the watcher\'s parking unheld; once', () => {
  const { wp, story, done } = setup();
  try {
    const strip = (id: string) => wp.db.prepare("update work set json = json_remove(json, '$.hold') where id = ?").run(id);
    const byCoo = story('Greeting copy', 'dev');
    items.update(wp, byCoo.id, { status: 'backlog', note: 'release QA waits for the P0 fixes. Not a stall.' }, 'coo');
    const migrated = story('Weather line', 'dev');
    items.update(wp, migrated.id, { status: 'backlog', note: 'v2 migration: parked by the COO → Backlog' }, 'workplace');
    const watcher = story('Dance tempo', 'dev');
    items.update(wp, watcher.id, { status: 'backlog', note: 'Moved to Backlog by Asha: Dev is busy on Mic gate' }, 'asha');
    for (const id of [byCoo.id, migrated.id, watcher.id]) strip(id);

    assert.deepEqual(dispatch.migrateHolds(wp).sort(), [byCoo.id, migrated.id].sort());
    assert.equal(items.require$(wp, byCoo.id).hold, true);
    assert.equal(items.require$(wp, migrated.id).hold, true);
    assert.equal(items.require$(wp, watcher.id).hold, undefined);
    strip(byCoo.id);
    assert.deepEqual(dispatch.migrateHolds(wp), [], 'once');
  } finally {
    done();
  }
});

test('wired at boot: the first sweep wakes the seeded In review items nobody was reviewing, and holds parked Backlog', async () => {
  const b = await boot({ WORKPLACE_DISPATCH_BOOT_DELAY_SEC: '0' });
  try {
    await bootTick(100);
    const wp = b.running.wp;
    const stale = (wp.db.prepare("select id from work where status = 'in-review'").all() as { id: string }[]).map(r => r.id);
    assert.ok(stale.length > 0, 'the seed has items In review');
    for (const id of stale) assert.ok(reviewWake.wakeOf(wp, id), `${id} is in the review queue`);
    assert.ok(of(b.fake, 'nikhil').some(s => /Review request/.test(s.options.prompt)), 'the reviewer was woken');
    assert.ok(wp.db.prepare("select 1 from settings where key = 'hold-migration'").get(), 'the hold migration ran');
  } finally {
    await b.stop();
  }
});
