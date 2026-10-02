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
import { workplaceTools } from '../src/services/employees.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * The event-driven stall detector (HLD D21, LLD §19.6): no sweep. Each rule is evaluated for one
 * item at a given instant; the timers only decide when to look.
 */

const MIN = 60_000;
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

function setup() {
  const t = testWorkplace();
  const epic = items.create(t.wp, { level: 'epic', title: 'Iris works while music plays' }, 'owner');
  return { ...t, epic };
}

test('Ready for 15 minutes, in focus, assignee free: Asha starts it, and the COO hears of it', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp, epic } = setup();
  try {
    items.setFocus(wp, [epic.id], 'owner');
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Mic stays live', assigneeId: 'dev' }, 'asha');
    assert.equal(watch.check(wp, s.id, Date.now() + 14 * MIN), null, 'not yet');
    const r = watch.check(wp, s.id, Date.now() + 16 * MIN)!;
    assert.equal(r.rule, 'not-started');
    assert.equal(r.action, 'started');
    await tick();
    assert.equal(fake.sessions.length, 1);
    assert.equal(employees.openSession('dev')?.assignmentId, s.id);
    assert.ok(trail.activityFor(wp, s.id).some(a => a.kind === 'stall' && /Started by Asha/.test(a.text)));
    assert.ok(coo.listItems(wp).some(i => i.kind === 'stall' && i.itemId === s.id));
    assert.equal(inbox.ownerList(wp, 'open').filter(i => i.context['itemId'] === s.id).length, 0, 'never the owner\'s Inbox');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('Ready for 15 minutes outside the focus goes to Backlog with the reason; Backlog is never started by anything', () => {
  const fake = installFakeRuntime();
  const { wp, tmp, epic } = setup();
  try {
    const other = items.create(wp, { level: 'epic', title: 'Not the focus' }, 'owner');
    items.setFocus(wp, [epic.id], 'owner');
    const s = items.create(wp, { level: 'story', parentId: other.id, title: 'Side quest', assigneeId: 'mira' }, 'asha');
    const r = watch.check(wp, s.id, Date.now() + 16 * MIN)!;
    assert.equal(r.action, 'backlog');
    const parked = items.require$(wp, s.id);
    assert.equal(parked.status, 'backlog');
    assert.ok(trail.activityFor(wp, s.id).some(a => a.kind === 'stall' && /not in focus/i.test(a.text)));
    assert.equal(fake.sessions.length, 0);
    assert.equal(watch.check(wp, s.id, Date.now() + 600 * MIN), null, 'a parked item is not stalled');

    // The old Chief-of-Staff routine must not resume a parked item either.
    const old = work.create(wp, { kind: 'assignment', title: 'Old parked', body: 'x', employeeId: 'kabir' });
    items.update(wp, old.id, { status: 'backlog' }, 'coo');
    const tickResult = cos.tick(wp, Date.now() + 600 * MIN);
    assert.ok(!tickResult.resumed.includes(old.id));
    assert.ok(!tickResult.queued.includes(old.id));
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('Ready for 15 minutes with the assignee busy goes to Backlog naming the work it is busy on', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp, epic } = setup();
  try {
    items.setFocus(wp, [epic.id], 'owner');
    const busy = items.create(wp, { level: 'story', parentId: epic.id, title: 'Already building', assigneeId: 'dev' }, 'asha');
    employees.assign(wp, busy.id);
    await tick();
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Waiting', assigneeId: 'dev' }, 'asha');
    const r = watch.check(wp, s.id, Date.now() + 16 * MIN)!;
    assert.equal(r.action, 'backlog');
    assert.ok(trail.activityFor(wp, s.id).some(a => /Dev is busy/.test(a.text)));
    assert.equal(fake.sessions.length, 1);
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('In progress with no activity for 10 minutes: the COO is told at once, once per episode; new activity starts a new one', () => {
  const fake = installFakeRuntime();
  const { wp, tmp, epic } = setup();
  try {
    coo.touchHeartbeatForTest(wp); // the COO is online: no fallback resume
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Duck music', assigneeId: 'mira' }, 'asha');
    items.update(wp, s.id, { status: 'in-progress' }, 'mira');
    assert.equal(watch.check(wp, s.id, Date.now() + 9 * MIN), null);
    const r = watch.check(wp, s.id, Date.now() + 11 * MIN)!;
    assert.equal(r.rule, 'idle');
    assert.equal(r.action, 'coo-notified');
    const notes = coo.listItems(wp).filter(i => i.kind === 'stall' && i.itemId === s.id);
    assert.equal(notes.length, 1);
    assert.match(coo.readInboxFileForTest(wp), /"kind":"stall"/);
    assert.ok(trail.activityFor(wp, s.id).some(a => a.kind === 'stall' && /No activity for 10 min/.test(a.text)));
    assert.equal(inbox.ownerList(wp, 'open').length, 0, 'the owner hears nothing about a stall');
    assert.equal(fake.sessions.length, 0, 'the COO is online: it decides');

    assert.equal(watch.check(wp, s.id, Date.now() + 25 * MIN), null, 'same episode: once');
    trail.comment(wp, s.id, { by: 'mira', text: 'still on it' });
    assert.equal(watch.check(wp, s.id, Date.now() + 5 * MIN), null);
    assert.equal(watch.check(wp, s.id, Date.now() + 12 * MIN)!.action, 'coo-notified', 'a new episode after new activity');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('idle with the agent\'s session open: it is asked to flag its own stall; with the COO offline and no session, Asha resumes it', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp, epic } = setup();
  try {
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Duck music', assigneeId: 'mira' }, 'asha');
    employees.assign(wp, s.id);
    await tick();
    items.update(wp, s.id, { status: 'in-progress' }, 'mira');
    fake.last().result(); // the turn ended; the session sits idle
    await tick();
    const r = watch.check(wp, s.id, Date.now() + 11 * MIN)!;
    assert.equal(r.rule, 'idle');
    assert.ok(fake.last().sent.some(m => /flag_stall/.test(m.text)), 'the agent is asked to flag itself');

    const t = items.create(wp, { level: 'story', parentId: epic.id, title: 'Resume me', assigneeId: 'kabir' }, 'asha');
    items.update(wp, t.id, { status: 'in-progress' }, 'kabir');
    const before = fake.sessions.length;
    const r2 = watch.check(wp, t.id, Date.now() + 11 * MIN)!;
    assert.equal(r2.action, 'resumed');
    await tick();
    assert.equal(fake.sessions.length, before + 1);
    assert.ok(trail.activityFor(wp, t.id).some(a => /COO is offline/.test(a.text)));
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('In review for 30 minutes untouched: the COO is told, naming the reviewer', () => {
  const { wp, tmp, epic } = setup();
  try {
    coo.touchHeartbeatForTest(wp);
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Review me', assigneeId: 'dev' }, 'asha');
    items.update(wp, s.id, { status: 'in-progress' }, 'dev');
    items.update(wp, s.id, { status: 'in-review', reviewerId: 'nikhil' }, 'dev');
    assert.equal(watch.check(wp, s.id, Date.now() + 29 * MIN), null);
    const r = watch.check(wp, s.id, Date.now() + 31 * MIN)!;
    assert.equal(r.rule, 'unreviewed');
    assert.match(coo.listItems(wp).find(i => i.itemId === s.id)!.body, /Nikhil/);
    assert.equal(items.toItem(wp, work.get(wp, s.id)!, Date.now() + 31 * MIN).stall?.rule, 'unreviewed');
  } finally {
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
    for (let i = 0; i < 50 && items.require$(wp, s.id).status !== 'backlog'; i++) await tick(20);
    assert.equal(items.require$(wp, s.id).status, 'backlog');
  } finally {
    stop();
    fake.restore();
    tmp.cleanup();
  }
});

test('an agent flags its own stall the moment it happens', async () => {
  const { wp, tmp, epic } = setup();
  try {
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Needs Rohan', assigneeId: 'dev' }, 'asha');
    items.update(wp, s.id, { status: 'in-progress' }, 'dev');
    const server = workplaceTools(wp, 'dev', () => ({ agentId: 'a', employeeId: 'dev', assignmentId: s.id, startedAt: '', seen: {}, planCaptured: false }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(st);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(ct);
    const out = await client.callTool({ name: 'flag_stall', arguments: { reason: 'the Speaker has no one-sentence primitive', waitingOn: 'rohan' } });
    assert.match(JSON.stringify(out.content), /Flagged/);
    assert.ok(coo.listItems(wp).some(i => i.kind === 'stall' && i.itemId === s.id && /one-sentence/.test(i.body)));
    const b = items.require$(wp, s.id);
    assert.equal(b.status, 'blocked');
    assert.equal(b.blocked?.waitingOn, 'rohan');
    await client.close();
  } finally {
    tmp.cleanup();
  }
});
