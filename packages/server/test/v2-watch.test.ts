import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as trail from '../src/services/trail.js';
import * as watch from '../src/services/watch.js';
import * as coo from '../src/services/coo.js';
import * as cos from '../src/services/cos.js';
import * as inbox from '../src/services/inbox.js';
import * as employees from '../src/services/employees.js';
import * as manager from '../src/services/manager.js';
import { workplaceTools } from '../src/services/employees.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * The event-driven stall watcher (HLD D21, LLD §19.6): no sweep. Each rule is evaluated for one
 * item at a given instant; the timers only decide when to look. Since the October rework it alerts
 * nobody and moves nothing (LLD-rework-2026-10 W2 §6); flag_stall is unchanged.
 */

const MIN = 60_000;
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
/** Everything Asha was handed (LLD §19.6e: alerts go to her first). */
const toldAsha = (fake: { sessions: { options: { cwd: string; prompt: string }; sent: { text: string }[] }[] }) =>
  fake.sessions.filter(s => s.options.cwd.includes('/asha/')).flatMap(s => [s.options.prompt, ...s.sent.map(m => m.text)]);
const alertsFor = (wp: Parameters<typeof manager.list>[0], itemId: string) => manager.list(wp).filter(r => r.itemId === itemId);

function setup() {
  const t = testWorkplace();
  const epic = items.create(t.wp, { level: 'epic', title: 'Iris works while music plays' }, 'owner');
  return { ...t, epic };
}

// Since the October rework (LLD-rework-2026-10 W2 §2, §6) the watcher alerts nobody and moves nothing:
// no auto-start, no parking, no resume in a fresh session. The stall chain (stall-chain.ts) tells people.

test('Ready for 15 minutes, in focus, assignee free: the watcher neither starts it nor alerts anyone (the dispatcher and the stall chain own it)', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp, epic } = setup();
  try {
    items.setFocus(wp, [epic.id], 'owner');
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Mic stays live', assigneeId: 'dev' }, 'asha');
    assert.equal(watch.check(wp, s.id, Date.now() + 14 * MIN), null, 'not yet');
    const r = watch.check(wp, s.id, Date.now() + 16 * MIN)!;
    assert.equal(r.rule, 'not-started');
    assert.equal(r.action, 'noted');
    await tick();
    assert.equal(fake.sessions.length, 0, 'never started by the watcher');
    assert.equal(items.require$(wp, s.id).status, 'ready');
    assert.equal(alertsFor(wp, s.id).length, 0, 'no alert for Asha');
    assert.equal(coo.listItems(wp).filter(i => i.itemId === s.id).length, 0);
    assert.equal(inbox.ownerList(wp, 'open').filter(i => i.context['itemId'] === s.id).length, 0, 'never the owner\'s Inbox');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('Ready for 15 minutes outside the focus stays Ready (focus is priority, not a filter); Backlog is never started by anything', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp, epic } = setup();
  try {
    const other = items.create(wp, { level: 'epic', title: 'Not the focus' }, 'owner');
    items.setFocus(wp, [epic.id], 'owner');
    const s = items.create(wp, { level: 'story', parentId: other.id, title: 'Side quest', assigneeId: 'mira' }, 'asha');
    const r = watch.check(wp, s.id, Date.now() + 16 * MIN)!;
    assert.equal(r.action, 'noted');
    assert.equal(items.require$(wp, s.id).status, 'ready', 'not parked in Backlog');
    assert.equal(fake.sessions.length, 0);
    assert.equal(alertsFor(wp, s.id).length, 0);

    // The old Chief-of-Staff routine must not resume a parked item either.
    const old = work.create(wp, { kind: 'assignment', title: 'Old parked', body: 'x', employeeId: 'kabir' });
    items.update(wp, old.id, { status: 'backlog', note: 'parked by the COO' }, 'coo');
    const tickResult = cos.tick(wp, Date.now() + 600 * MIN);
    assert.ok(!tickResult.resumed.includes(old.id));
    assert.ok(!tickResult.queued.includes(old.id));
    await tick(30); // what the Chief-of-Staff routine started settles before the database closes
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('Ready for 15 minutes with the assignee busy stays Ready, queued for them (never Backlog), naming the work it is busy on; no notice', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp, epic } = setup();
  try {
    items.setFocus(wp, [epic.id], 'owner');
    const busy = items.create(wp, { level: 'story', parentId: epic.id, title: 'Already building', assigneeId: 'dev' }, 'asha');
    employees.assign(wp, busy.id);
    await tick();
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Waiting', assigneeId: 'dev' }, 'asha');
    const r = watch.check(wp, s.id, Date.now() + 16 * MIN)!;
    assert.equal(r.action, 'queued');
    const it = items.require$(wp, s.id);
    assert.equal(it.status, 'ready');
    assert.equal(it.queuedFor, 'dev');
    assert.equal(it.hold, undefined);
    assert.ok(trail.activityFor(wp, s.id).some(a => /Queued for Dev: busy on Already building/.test(a.text)));
    assert.equal(alertsFor(wp, s.id).length, 0, 'no notice for Asha');
    assert.equal(coo.listItems(wp).filter(i => i.itemId === s.id).length, 0);
    assert.equal(fake.sessions.length, 1);
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('In progress with no activity for 10 minutes: a trail line, once per episode; no alert to Asha or the COO', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp, epic } = setup();
  try {
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Duck music', assigneeId: 'mira' }, 'asha');
    items.update(wp, s.id, { status: 'in-progress', note: 'started by hand' }, 'mira');
    assert.equal(watch.check(wp, s.id, Date.now() + 9 * MIN), null);
    const r = watch.check(wp, s.id, Date.now() + 11 * MIN)!;
    assert.equal(r.rule, 'idle');
    assert.equal(r.action, 'noted');
    await tick();
    assert.deepEqual(toldAsha(fake), [], 'Asha is not told');
    assert.equal(alertsFor(wp, s.id).length, 0);
    assert.equal(coo.listItems(wp).filter(i => i.itemId === s.id).length, 0);
    assert.ok(trail.activityFor(wp, s.id).some(a => a.kind === 'stall' && /No activity for 10 min/.test(a.text)));
    assert.equal(inbox.ownerList(wp, 'open').length, 0, 'the owner hears nothing about a stall');
    assert.equal(fake.sessions.length, 0, 'nobody is resumed, whatever the COO\'s presence');
    assert.equal(watch.check(wp, s.id, Date.now() + 25 * MIN), null, 'same episode: once');
    trail.comment(wp, s.id, { by: 'mira', text: 'still on it' });
    assert.equal(watch.check(wp, s.id, Date.now() + 5 * MIN), null);
    assert.equal(watch.check(wp, s.id, Date.now() + 12 * MIN)!.rule, 'idle', 'a new episode after new activity');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('idle with the agent\'s session open: it is asked to flag its own stall; with the COO offline and no session, nothing is resumed', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp, epic } = setup();
  try {
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Duck music', assigneeId: 'mira' }, 'asha');
    employees.assign(wp, s.id);
    await tick();
    const mira = () => fake.sessions.find(x => x.options.cwd.includes('/mira/'))!;
    mira().result(); // the turn ended; the session sits idle
    await tick();
    const r = watch.check(wp, s.id, Date.now() + 11 * MIN)!;
    assert.equal(r.rule, 'idle');
    assert.equal(r.action, 'notified');
    assert.ok(mira().sent.some(m => /flag_stall/.test(m.text)), 'the agent is asked to flag itself');

    const t = items.create(wp, { level: 'story', parentId: epic.id, title: 'Resume me', assigneeId: 'kabir' }, 'asha');
    items.update(wp, t.id, { status: 'in-progress', note: 'started by hand' }, 'kabir');
    const kabir = () => fake.sessions.filter(x => x.options.cwd.includes('/kabir/')).length;
    const r2 = watch.check(wp, t.id, Date.now() + 11 * MIN)!;
    assert.equal(r2.action, 'noted');
    await tick();
    assert.equal(kabir(), 0, 'the watcher never moves or starts a session');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('In review for 30 minutes untouched: a trail line naming the reviewer; no alert', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp, epic } = setup();
  try {
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Review me', assigneeId: 'dev' }, 'asha');
    items.update(wp, s.id, { status: 'in-progress', note: 'started by hand' }, 'dev');
    items.update(wp, s.id, { status: 'in-review', reviewerId: 'nikhil', note: 'ready for review' }, 'dev');
    assert.equal(watch.check(wp, s.id, Date.now() + 29 * MIN), null);
    const r = watch.check(wp, s.id, Date.now() + 31 * MIN)!;
    assert.equal(r.rule, 'unreviewed');
    await tick();
    assert.deepEqual(toldAsha(fake), []);
    assert.equal(alertsFor(wp, s.id).length, 0);
    assert.ok(trail.activityFor(wp, s.id).some(a => a.kind === 'stall' && /nothing from Nikhil/.test(a.text)));
    assert.equal(items.toItem(wp, work.get(wp, s.id)!, Date.now() + 31 * MIN).stall?.rule, 'unreviewed');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('the timers fire on their own (event-driven, no sweep)', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp } = testWorkplace({ WORKPLACE_STALL_READY_MIN: '0.002' });
  const stop = watch.startWatch(wp);
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Elsewhere' }, 'owner');
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Unfocused', assigneeId: 'tara' }, 'asha');
    for (let i = 0; i < 50 && !wp.db.prepare('select 1 from settings where key = ?').get(`stall:${s.id}`); i++) await tick(20);
    assert.match((wp.db.prepare('select value from settings where key = ?').get(`stall:${s.id}`) as { value: string }).value, /^not-started:/);
    assert.equal(items.require$(wp, s.id).status, 'ready', 'checked, and nothing moved');
  } finally {
    stop();
    fake.restore();
    tmp.cleanup();
  }
});

test('an agent flags its own stall the moment it happens: Asha hears at once', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp, epic } = setup();
  try {
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Needs Rohan', assigneeId: 'dev' }, 'asha');
    items.update(wp, s.id, { status: 'in-progress' }, 'dev');
    const server = workplaceTools(wp, 'dev', () => ({ agentId: 'a', employeeId: 'dev', assignmentId: s.id, startedAt: '', seen: {}, planCaptured: false }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(st);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(ct);
    const out = await client.callTool({ name: 'flag_stall', arguments: { reason: 'the Speaker has no one-sentence primitive', waitingOn: 'external' } });
    assert.match(JSON.stringify(out.content), /Flagged/);
    await tick();
    assert.ok(toldAsha(fake).some(t => /Flagged: Needs Rohan/.test(t) && /one-sentence/.test(t)));
    assert.equal(coo.listItems(wp).filter(i => i.itemId === s.id).length, 0, 'Asha first');
    const b = items.require$(wp, s.id);
    assert.equal(b.status, 'blocked');
    assert.equal(b.blocked?.waitingOn, 'external');
    await client.close();
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});
