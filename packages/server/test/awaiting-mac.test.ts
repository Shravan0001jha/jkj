import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as items from '../src/services/items.js';
import * as awaitingMac from '../src/services/awaiting-mac.js';
import * as hygiene from '../src/services/hygiene.js';
import * as lifecycle from '../src/services/lifecycle.js';
import * as floor from '../src/services/floor.js';
import * as cos from '../src/services/cos.js';
import * as halt from '../src/services/halt.js';
import * as stallChain from '../src/services/stall-chain.js';
import { rawGet } from '../src/services/v2-map.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace, withTree } from './fakes/workplace.js';

/**
 * Owner rule, 23 Oct: a story is not undone because it waits for a Mac. Done on staging, awaiting Mac check
 * (trueStatus awaiting-mac) counts as done for flow and hygiene, is listed in one Mac verification queue and is
 * closed from it. Plus the shared "the floor cannot run work now" predicate (hygiene, Asha's tick, stall chain).
 */
const runtime = installFakeRuntime();
after(() => runtime.restore());

const NOTE = 'Staging build 0.2.31 deployed; on the Mac confirm the wake word still fires after sleep/wake.';

function setup() {
  const t = testWorkplace();
  withTree(t.wp);
  const epic = items.create(t.wp, { level: 'epic', title: 'Voice' }, 'owner');
  const story = (title: string, assigneeId = 'arjun') => {
    const s = items.create(t.wp, { level: 'story', parentId: epic.id, title, assigneeId } as never, 'owner');
    items.update(t.wp, s.id, { status: 'in-progress', note: 'starting the work' }, 'owner');
    return s;
  };
  return { ...t, epic, story };
}

test('the assignee moves an in-progress story to awaiting-mac with a note; it shows apart from Done and counts as done', () => {
  const { wp, tmp, story } = setup();
  try {
    const s = story('Wake word after sleep');
    assert.throws(() => items.update(wp, s.id, { status: 'awaiting-mac', reason: 'staging is green' }, 'arjun'), /note|what the Mac/i, 'the note naming the Mac check is required');
    assert.throws(() => items.update(wp, s.id, { status: 'awaiting-mac', note: 'too short' }, 'arjun'), /note|what the Mac/i);
    const it = items.update(wp, s.id, { status: 'awaiting-mac', note: NOTE }, 'arjun');
    assert.equal(it.trueStatus, 'awaiting-mac');
    assert.equal(lifecycle.label(it.trueStatus!), 'Done on staging — awaiting Mac check');
    const w = rawGet(wp, s.id)!;
    assert.equal(w.awaitingMac?.note, NOTE);
    assert.equal(w.closedAt, undefined);
    assert.ok(lifecycle.finished(w), 'a story that starts after it may start');
  } finally { tmp.cleanup(); }
});

test('nobody else outside the tree can; a Ready story cannot jump there', () => {
  const { wp, tmp, story, epic } = setup();
  try {
    const s = story('Tree');
    assert.throws(() => items.update(wp, s.id, { status: 'awaiting-mac', note: NOTE }, 'ira'), /Forbidden/);
    const r = items.create(wp, { level: 'story', parentId: epic.id, title: 'Never started', assigneeId: 'arjun' } as never, 'owner');
    assert.throws(() => items.update(wp, r.id, { status: 'awaiting-mac', note: NOTE }, 'owner'), /cannot go|started/i);
    items.update(wp, s.id, { status: 'awaiting-mac', note: NOTE }, 'asha');
  } finally { tmp.cleanup(); }
});

test('hygiene raises nothing on it: not stalled, not unrouted, not blocked, not no-session', () => {
  const { wp, tmp, story } = setup();
  try {
    const s = story('Quiet');
    items.update(wp, s.id, { status: 'awaiting-mac', note: NOTE }, 'arjun');
    const later = Date.now() + 3 * 3600_000;
    const vs = hygiene.report(wp, later).violations.filter(v => v.itemId === s.id);
    assert.deepEqual(vs, []);
    const done = hygiene.report(wp, later);
    assert.ok(done.violations.every(v => v.itemId !== s.id));
  } finally { tmp.cleanup(); }
});

test('the Mac verification queue lists them with notes, oldest first, and not the closed ones', () => {
  const { wp, tmp, story } = setup();
  try {
    const a = story('A'); const b = story('B'); const c = story('C');
    items.update(wp, b.id, { status: 'awaiting-mac', note: `${NOTE} (b)` }, 'arjun');
    const w = rawGet(wp, a.id)!;
    items.update(wp, a.id, { status: 'awaiting-mac', note: `${NOTE} (a)` }, 'arjun');
    // make A the older one
    const rowA = rawGet(wp, a.id)!;
    wp.db.prepare('update work set json = ? where id = ?').run(JSON.stringify({ ...rowA, awaitingMac: { ...rowA.awaitingMac!, since: '2020-01-01T00:00:00.000Z' } }), a.id);
    void w; void c;
    const q = awaitingMac.list(wp);
    assert.deepEqual(q.map(x => x.id), [a.id, b.id]);
    assert.ok(q[0]!.note.endsWith('(a)'));
    assert.equal(q[0]!.title, 'A');
  } finally { tmp.cleanup(); }
});

test('closing from the queue: COO, CTO or owner pass it with evidence; the assignee and Asha cannot', () => {
  const { wp, tmp, story } = setup();
  try {
    const s = story('Close me');
    items.update(wp, s.id, { status: 'awaiting-mac', note: NOTE }, 'arjun');
    assert.throws(() => items.update(wp, s.id, { status: 'done', note: 'Looks fine to me on the Mac' }, 'arjun'), /COO|CTO|owner/);
    assert.throws(() => items.update(wp, s.id, { status: 'done', note: 'Looks fine to me on the Mac' }, 'asha'), /COO|CTO|owner/);
    assert.throws(() => awaitingMac.close(wp, s.id, { result: 'pass', note: '' }, 'coo'), /evidence/i);
    const it = awaitingMac.close(wp, s.id, { result: 'pass', note: 'Mac slot 23 Oct 14:10: wake word fired after sleep, log wake.log line 41' }, 'coo');
    assert.equal(it.trueStatus, 'done');
    const w = rawGet(wp, s.id)!;
    assert.ok(w.closedAt);
    assert.match(w.awaitingMac!.evidence!, /wake.log/);
    assert.deepEqual(awaitingMac.list(wp), []);
    const s2 = story('CTO closes');
    items.update(wp, s2.id, { status: 'awaiting-mac', note: NOTE }, 'arjun');
    assert.equal(items.update(wp, s2.id, { status: 'done', note: 'Mac check confirmed with log excerpts attached' }, 'cto').trueStatus, 'done');
  } finally { tmp.cleanup(); }
});

test('a failed Mac check sends it back to in-progress and files a bug', () => {
  const { wp, tmp, story } = setup();
  try {
    const s = story('Will fail');
    items.update(wp, s.id, { status: 'awaiting-mac', note: NOTE }, 'arjun');
    const it = awaitingMac.close(wp, s.id, { result: 'fail', note: 'Wake word did not fire after sleep; log shows mic device lost' }, 'coo');
    assert.equal(it.trueStatus, 'in-progress');
    const w = rawGet(wp, s.id)!;
    assert.equal(w.awaitingMac, undefined);
    const bugs = wp.db.prepare("select json from work").all().map(r => JSON.parse((r as { json: string }).json) as { type?: string; title: string }).filter(x => x.type === 'bug' && x.title.includes('Will fail'));
    assert.equal(bugs.length, 1);
  } finally { tmp.cleanup(); }
});

test('adopt: the COO moves listed stories (parked Mac-check stories, merged ones) with a note; bad ids are reported, not fatal', () => {
  const { wp, tmp, story } = setup();
  try {
    const a = story('Adopt A'); const b = story('Adopt B');
    const r = awaitingMac.adopt(wp, [a.id, b.id, 'as_nope'], 'Mac-slot live check still to run; moved by the COO (23 Oct rule)');
    assert.deepEqual(r.moved.sort(), [a.id, b.id].sort());
    assert.equal(r.failed.length, 1);
    assert.equal(rawGet(wp, a.id)!.awaitingMac?.by, 'coo');
  } finally { tmp.cleanup(); }
});

/* ---------- B: pause-aware checks ---------- */

test('halt: nothing when the floor can run; names a pace hold, a floor pause and an auth outage', () => {
  const { wp, tmp } = setup();
  try {
    const now = Date.now();
    assert.equal(halt.cannotRun(wp, now), null);
    wp.db.prepare("insert or replace into settings (key, value) values ('pace:until', ?)").run(new Date(now + 3600_000).toISOString());
    const h = halt.cannotRun(wp, now)!;
    assert.equal(h.kind, 'pace');
    assert.match(halt.line(h), /^Paused: weekly pace cap hold until .+ — no per-story flags\.$/);
    wp.db.prepare("delete from settings where key = 'pace:until'").run();
    floor.setPaused(wp, true, 'owner testing', 'coo');
    assert.equal(halt.cannotRun(wp, now)!.kind, 'floor');
    assert.match(halt.line(halt.cannotRun(wp, now)!), /owner testing/);
    floor.setPaused(wp, false, '', 'coo');
    wp.db.prepare("insert or replace into settings (key, value) values ('pace:probe', ?)").run(JSON.stringify({ failures: 3, lastError: '401 invalid token' }));
    assert.equal(halt.cannotRun(wp, now)!.kind, 'auth');
    wp.db.prepare("insert or replace into settings (key, value) values ('pace:probe', ?)").run(JSON.stringify({ failures: 2 }));
    assert.equal(halt.cannotRun(wp, now), null, 'two failures is a blip');
  } finally { tmp.cleanup(); }
});

test('during a pace hold hygiene raises no no-session / top-idle flag and says so once; after it, the flag returns', () => {
  const { wp, tmp, story } = setup();
  try {
    const s = story('Nobody on it');
    const later = Date.now() + 30 * 60_000;
    hygiene.sweep(wp, Date.now());
    const flagged = (t: number) => hygiene.report(wp, t).violations.filter(v => v.itemId === s.id && (v.rule === 'no-session' || v.rule === 'top-idle'));
    assert.ok(flagged(later).length > 0, 'control: flagged without a hold');
    wp.db.prepare("insert or replace into settings (key, value) values ('pace:until', ?)").run(new Date(later + 3600_000).toISOString());
    assert.deepEqual(flagged(later), []);
    const rep = hygiene.report(wp, later);
    assert.match(rep.pausedLine ?? '', /^Paused: weekly pace cap hold until .+ — no per-story flags\.$/);
    const sw = hygiene.sweep(wp, later);
    assert.deepEqual(sw.violations.filter(v => v.itemId === s.id), []);
    wp.db.prepare("delete from settings where key = 'pace:until'").run();
    assert.equal(hygiene.report(wp, later).pausedLine, undefined);
  } finally { tmp.cleanup(); }
});

test('Asha\'s board check lists no per-story no-session flags while halted, and carries the single Paused line', () => {
  const { wp, tmp, story } = setup();
  try {
    const s = story('Silent during the hold');
    const later = Date.now() + 30 * 60_000;
    hygiene.sweep(wp, Date.now());
    // an unrouted story gives the check something to send
    items.create(wp, { level: 'story', title: 'Nobody owns me', parentId: s.id ? rawGet(wp, s.id)!.parentId : undefined } as never, 'owner');
    wp.db.prepare("insert or replace into settings (key, value) values ('pace:probe', ?)").run(JSON.stringify({ failures: 5, lastError: '401' }));
    const text = cos.boardCheck(wp, later + 20 * 60_000) ?? '';
    assert.doesNotMatch(text, new RegExp(s.id), 'no per-story line for the in-progress story');
    assert.equal((text.match(/Paused:/g) ?? []).length, 1);
  } finally { tmp.cleanup(); }
});

test('the stall chain keeps its clock still during an auth outage too', () => {
  const { wp, tmp, story } = setup();
  try {
    const s = story('Stalls');
    wp.db.prepare("insert or replace into settings (key, value) values ('pace:probe', ?)").run(JSON.stringify({ failures: 4, lastError: '401' }));
    const r = stallChain.sweep(wp, Date.now() + 3 * 3600_000);
    assert.deepEqual(r.told.filter(x => x.itemId === s.id), []);
  } finally { tmp.cleanup(); }
});
