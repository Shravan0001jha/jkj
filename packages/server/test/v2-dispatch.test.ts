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
import * as floor from '../src/services/floor.js';
import * as dispatch from '../src/services/dispatch.js';
import * as manager from '../src/services/manager.js';
import { rawGet } from '../src/services/v2-map.js';
import { installFakeRuntime, type FakeRuntime } from './fakes/fake-runtime.js';
import { dayClock, testWorkplace } from './fakes/workplace.js';
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

const pause = (wp: Wp, employeeId: string, at = Date.now()) =>
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`paused:${spend.dayOf(new Date(at))}:employee:${employeeId}`, new Date(at).toISOString());

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
    items.update(wp, a.id, { status: 'in-review', reviewerId: 'nikhil', reason: 'test: moved' }, 'dev');
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
    items.update(wp, a.id, { status: 'in-review', reviewerId: 'nikhil', reason: 'test: moved' }, 'dev');
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

test('held Backlog is never started: a COO/owner move, a hold note, or hold: true (parked); nor Backlog outside the focus', () => {
  const { wp, fake, story, other, done } = setup();
  try {
    const h1 = story('Greeting copy', 'dev');
    items.update(wp, h1.id, { status: 'backlog', note: 'waits for the P0 fixes' }, 'coo');
    const h2 = story('Weather line', 'dev');
    items.update(wp, h2.id, { status: 'backlog', note: 'parked until the P0 ships' }, 'asha');
    const h3 = story('Speaker primitive', 'dev');
    items.update(wp, h3.id, { hold: true, note: 'needs the owner at the Mac' }, 'owner');
    const side = story('Side quest', 'dev', other.id);
    items.update(wp, side.id, { status: 'backlog', note: 'Moved to Backlog by Asha: not in focus' }, 'asha');

    for (const id of [h1.id, h2.id]) {
      const it = items.require$(wp, id);
      assert.equal(it.status, 'backlog', id);
      assert.equal(it.hold, true, id);
    }
    // Rework (Oct 2026): an explicit hold parks the item (status parked), which is never queued either.
    assert.equal(items.require$(wp, h3.id).status, 'parked');
    assert.equal(items.require$(wp, side.id).hold, undefined);
    assert.deepEqual(dispatch.queue(wp, 'dev').map(w => w.id), [], 'held and unfocused Backlog are not queued work');
    dispatch.sweep(wp);
    assert.equal(dispatch.dispatch(wp, 'dev').action, 'none');
    assert.equal(fake.sessions.length, 0);

    // Only the owner, the COO or the Chief of Staff holds an item.
    assert.throws(() => items.update(wp, h1.id, { hold: false, reason: 'test: moved' }, 'dev'), /owner, the COO or the Chief of Staff/);
    assert.throws(() => items.update(wp, side.id, { hold: true, status: 'ready', reason: 'test: moved' }, 'owner'), /A hold parks an item/);
    // Leaving Parked or Backlog clears the hold; the owner lifting it makes the item work again.
    items.update(wp, h3.id, { status: 'ready', reason: 'test: moved' }, 'owner');
    assert.equal(items.require$(wp, h3.id).parked, undefined);
    items.update(wp, h1.id, { hold: false, reason: 'test: moved' }, 'coo');
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
    items.update(wp, r.id, { status: 'in-progress', reason: 'test: moved' }, 'owner');
    items.update(wp, r.id, { status: 'in-review', reviewerId: 'nikhil', reason: 'test: moved' }, 'owner');
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
    items.update(wp, r.id, { status: 'in-progress', reason: 'test: moved' }, 'owner');
    items.update(wp, r.id, { status: 'in-review', reviewerId: 'nikhil', reason: 'test: moved' }, 'owner');
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

test('idle with queued work is no longer alerted from the dispatcher (LLD-rework W2 §6: the stall chain tells people); the reason is still kept and the cap respected', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const s = story('Dance tempo', 'dev');
    const t0 = dayClock(60); // the sweeps below stay within one IST day, so the day's pause still holds
    pause(wp, 'dev', t0);
    for (const m of [0, 5, 11, 20, 40]) assert.deepEqual(dispatch.sweep(wp, t0 + m * MIN).alerts, []);
    assert.equal(coo.listItems(wp).filter(i => /idle with/.test(i.title)).length, 0, 'not the COO');
    assert.equal(manager.list(wp).filter(r => /idle with/.test(r.title)).length, 0, 'not Asha');
    assert.match(dispatch.lastReason(wp, 'dev')!, /paused by the employee:dev spend cap/);
    assert.equal(fake.sessions.length, 0, 'the cap is respected');

    // An episode recorded before the rework is cleared, so it is never escalated.
    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run('dispatch-idle:mira', JSON.stringify({ since: new Date(t0).toISOString(), alerted: true }));
    dispatch.sweep(wp, t0 + 41 * MIN);
    assert.equal(wp.db.prepare('select 1 from settings where key = ?').get('dispatch-idle:mira'), undefined);

    // The cap lifts: the story starts.
    spend.liftPause(wp, 'employee:dev', spend.dayOf(new Date(t0)), 'owner');
    dispatch.sweep(wp, t0 + 42 * MIN);
    await tick();
    assert.equal(fake.sessions.length, 1);
    assert.equal(employees.openSession('dev')!.assignmentId, s.id);
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

test('orphan: an In-progress story with no session behind it (after a restart) is resumed once, not left idle', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const a = story('Presence facts', 'mira');
    employees.assign(wp, a.id);
    await tick();
    assert.equal(rawGet(wp, a.id)!.status, 'in-progress');
    employees.closeAll(wp, 'shutdown');            // the session is gone, the story stays In progress
    await tick();
    assert.equal(employees.openSession('mira'), undefined);
    const before = of(fake, 'mira').length;

    const r = dispatch.dispatch(wp, 'mira');
    await tick();
    assert.equal(r.action, 'story');
    assert.equal(r.itemId, a.id);
    assert.ok(of(fake, 'mira').length > before, 'a new session started for the In-progress story');

    // Throttled: the same story is not resumed again within the window, so a waiting story cannot loop.
    employees.closeAll(wp, 'shutdown');
    await tick();
    const again = dispatch.dispatch(wp, 'mira');
    assert.notEqual(again.action, 'story');
  } finally {
    done();
  }
});

test('busy includes In-progress work with no session: the watcher queues a Ready story, never starts a second one', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const a = story('DND toggle expert', 'mira');
    items.update(wp, a.id, { status: 'in-progress', reason: 'test: moved' }, 'mira');   // In progress, no session behind it
    assert.equal(employees.openSession('mira'), undefined);
    const b = story('Decline counter', 'mira');
    const r = watch.check(wp, b.id, Date.now() + 16 * MIN)!;
    assert.equal(r.action, 'queued');
    assert.equal(items.require$(wp, b.id).status, 'ready');
    assert.equal(items.require$(wp, b.id).queuedFor, 'mira');
    assert.equal(of(fake, 'mira').length, 0, 'no session started for the second story');
  } finally {
    done();
  }
});

test('orphan: an idle session left on a finished story does not hide the person\'s In-progress story', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const a = story('Wi-Fi toggle', 'mira');
    employees.assign(wp, a.id);
    await tick();
    const s = fake.last();
    s.result({ costUsd: 0 });                                      // the turn ends; the session stays open, idle
    await tick();
    items.update(wp, a.id, { status: 'in-review', reviewerId: 'nikhil', reason: 'test: moved' }, 'mira');
    const b = story('Bluetooth toggle', 'mira');
    items.update(wp, b.id, { status: 'in-progress', reason: 'test: moved' }, 'mira');     // In progress, nothing behind it
    assert.equal(employees.openSession('mira')!.assignmentId, a.id);

    const r = dispatch.dispatch(wp, 'mira');
    await tick();
    assert.equal(r.action, 'story');
    assert.equal(r.itemId, b.id);
  } finally {
    done();
  }
});

test('a throttled orphan resume never falls through to starting new work: the In-progress story comes first (Neel, 7 Oct)', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const a = story('Activity line (B9)', 'mira');
    items.update(wp, a.id, { status: 'in-progress', reason: 'test: moved' }, 'mira');
    // Resumed once already within the throttle window, so resumeOrphan returns null.
    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`orphan-resumed:${a.id}:mira`, new Date().toISOString());
    const b = story('Lower-ranked story', 'mira');
    const r = dispatch.dispatch(wp, 'mira', Date.now() + 60_000);
    assert.notEqual(r.action, 'story', 'nothing new starts');
    assert.equal(of(fake, 'mira').length, 0, 'no session for the lower-ranked story');
    assert.notEqual(items.require$(wp, b.id).status, 'in-progress');
  } finally {
    done();
  }
});

/* ---------- stale "working" with no live run (23 Oct: Anika, Dev) ---------- */

test('a person left "working" on a dead run is reset and started on their own In-progress story (23 Oct)', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const a = story('Ring flow step 14', 'mira');
    employees.assign(wp, a.id);
    await tick();
    const first = employees.openSession('mira')!;
    assert.equal(employees.stateWithReason(wp, 'mira').state, 'working');
    // The run never answers: no output, no SDK message, 25 minutes on.
    const later = Date.now() + 25 * MIN;
    const r = dispatch.sweep(wp, later);
    await tick();
    assert.ok(fake.sessions[0]!.closed, 'the dead run is closed');
    assert.equal(r.started.length, 1);
    assert.equal(r.started[0]!.itemId, a.id);
    const second = employees.openSession('mira')!;
    assert.notEqual(second.agentId, first.agentId, 'a fresh session is on the story');
    assert.equal(second.assignmentId, a.id);
  } finally {
    done();
  }
});

test('a genuinely live run is never closed: a quiet log but a ticking SDK stream is alive (control)', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const a = story('Long build', 'mira');
    employees.assign(wp, a.id);
    await tick();
    const open = employees.openSession('mira')!;
    // Control: the same run, silent past the limit, is closed.
    assert.deepEqual(employees.closeDeadRuns(wp, Date.now() + 25 * MIN), [open.agentId]);
    employees.assign(wp, a.id);
    await tick();
    const live = employees.openSession('mira')!;
    // A tool_progress tick is the run's heartbeat: 19 minutes after it, still alive.
    fake.last().events.onSdkMessage?.('system', 'tool_progress');
    assert.deepEqual(employees.closeDeadRuns(wp, Date.now() + 19 * MIN), []);
    assert.equal(employees.openSession('mira')!.agentId, live.agentId);
    // And a run waiting on an approval or between turns is not a "running" run at all.
    assert.equal(fake.sessions.at(-1)!.closed, false);
  } finally {
    done();
  }
});

test('a halted floor resets the dead run but starts nobody', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const a = story('Paused work', 'mira');
    employees.assign(wp, a.id);
    await tick();
    floor.setPaused(wp, true, 'test halt', 'owner');
    const r = dispatch.sweep(wp, Date.now() + 25 * MIN);
    await tick();
    assert.ok(fake.sessions[0]!.closed);
    assert.equal(r.started.length, 0);
    assert.equal(employees.openSession('mira'), undefined);
    assert.equal(fake.sessions.length, 1, 'no new session while the floor is paused');
    assert.notEqual(employees.stateWithReason(wp, 'mira').state, 'working');
  } finally {
    done();
  }
});

test('an idle session and a story another person already used the orphan resume on: the new assignee is still started (Anika, 23 Oct)', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const a = story('Remote-notification handler', 'mira');
    items.update(wp, a.id, { status: 'in-progress', reason: 'test: moved' }, 'mira');
    // Mira sits in a finished review session (waiting, bound to no story)...
    employees.spawn(wp, 'mira', { prompt: 'Review request: something else' });
    await tick();
    fake.last().say('Reviewed.');
    fake.last().result();
    await tick();
    assert.equal(runs.getRunAgent(employees.openSession('mira')!.agentId)!.status, 'waiting');
    // ...and the previous assignee's resume 40 s earlier consumed the story's throttle.
    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`orphan-resumed:${a.id}:tara`, new Date().toISOString());
    const r = dispatch.dispatch(wp, 'mira', Date.now() + 60_000);
    await tick();
    assert.equal(r.action, 'story');
    assert.equal(r.itemId, a.id);
    assert.ok(told(fake, 'mira').some(t => t.includes(a.id) && /assignment/i.test(t)), 'the story was handed to her session');
  } finally {
    done();
  }
});
