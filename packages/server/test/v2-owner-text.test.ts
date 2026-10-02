import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InboxItem, InboxThread, RoomDetail, RoomThread } from '@jkj/shared';
import * as items from '../src/services/items.js';
import * as trail from '../src/services/trail.js';
import * as inbox from '../src/services/inbox.js';
import * as room from '../src/services/room.js';
import * as employees from '../src/services/employees.js';
import { writeEmployeeFile } from '../src/services/org.js';
import { humanizeIds } from '../src/services/id-names.js';
import { testWorkplace } from './fakes/workplace.js';
import { boot, call } from './fakes/boot.js';

/**
 * iOS QA, 2 Oct: (1) GET /api/inbox was 88 KB for 45 items, nearly all answered — `?state=open` and
 * paging (`limit`, `before`), the default unchanged; (2) a Blocked feed line carried the whole
 * multi-sentence reason — one sentence, ~100 chars, the full reason stays on the item; (3)
 * owner-facing text (Inbox summaries, an employee's last report, Room headlines) showed raw ids
 * (th_…, as_…) — known ids read as their titles.
 */

test('(1) GET /api/inbox: unchanged by default; ?state=open filters; limit and before page it', async () => {
  const b = await boot();
  try {
    const wp = b.running.wp;
    const made = Array.from({ length: 5 }, (_, i) => inbox.raise(wp, { kind: 'decision', title: `Decision ${i}`, body: 'x', raisedBy: 'asha', options: [{ id: 'ok', label: 'OK' }] }));
    for (const m of made.slice(0, 3)) inbox.answer(wp, m.id, 'ok', undefined, 'web');
    const all = await call<InboxItem[]>(b.base, 'GET', '/api/inbox');
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.map(i => i.id), inbox.ownerList(wp).map(i => i.id), 'the default is every owner-facing item, as before');
    assert.ok(all.body.some(i => i.state === 'answered'));

    const open = await call<InboxItem[]>(b.base, 'GET', '/api/inbox?state=open');
    assert.ok(open.body.length > 0 && open.body.every(i => i.state === 'open'));
    assert.deepEqual(open.body.map(i => i.id), inbox.ownerList(wp, 'open').map(i => i.id));

    const first = await call<InboxItem[]>(b.base, 'GET', '/api/inbox?limit=2');
    assert.deepEqual(first.body.map(i => i.id), all.body.slice(0, 2).map(i => i.id));
    const next = await call<InboxItem[]>(b.base, 'GET', `/api/inbox?limit=2&before=${first.body[1]!.id}`);
    assert.deepEqual(next.body.map(i => i.id), all.body.slice(2, 4).map(i => i.id));
    const openPage = await call<InboxItem[]>(b.base, 'GET', '/api/inbox?state=open&limit=1');
    assert.deepEqual(openPage.body.map(i => i.id), open.body.slice(0, 1).map(i => i.id));

    assert.equal((await call(b.base, 'GET', '/api/inbox?state=bogus')).status, 400);
    assert.equal((await call(b.base, 'GET', '/api/inbox?before=in_nothere')).status, 400);
  } finally {
    await b.stop();
  }
});

test('(2) a Blocked feed line carries one sentence of the reason (about 100 chars); the item keeps it all', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Iris during music' }, 'owner');
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'QA the music bundle', assigneeId: 'nikhil' }, 'asha');
    items.update(wp, s.id, { status: 'in-progress' }, 'nikhil');
    const reason = 'Dev\'s ducking build is not on the branch yet, so there is nothing to run the AC5 checks against on the real Mac. ' +
      'I also need the low-confidence fixtures from Mira. Once both land I can finish in about an hour.';
    items.update(wp, s.id, { status: 'blocked', blockedReason: reason, waitingOn: 'external' }, 'nikhil');
    const line = trail.updates(wp).find(u => u.kind === 'blocked' && u.itemId === s.id)!;
    const said = line.line.replace(/^Blocked: QA the music bundle — waiting on someone outside the team: /, '');
    assert.ok(said.length <= 101, `short: ${said}`);
    assert.ok(!said.includes('fixtures from Mira'), 'one sentence only');
    assert.ok(reason.startsWith(said.replace(/…$/, '')), 'the start of the reason, cut at a word');
    assert.equal(line.details, reason, 'the full reason behind the line');
    assert.equal(items.require$(wp, s.id).blocked!.reason, reason, 'the item keeps every word');

    const brief = items.create(wp, { level: 'story', parentId: epic.id, title: 'Short one', assigneeId: 'mira' }, 'asha');
    items.update(wp, brief.id, { status: 'in-progress' }, 'mira');
    items.update(wp, brief.id, { status: 'blocked', blockedReason: 'needs the API key', waitingOn: 'external' }, 'mira');
    assert.equal(trail.updates(wp).find(u => u.kind === 'blocked' && u.itemId === brief.id)!.line, 'Blocked: Short one — waiting on someone outside the team: needs the API key');
  } finally {
    tmp.cleanup();
  }
});

test('(3) known ids read as titles: humanizeIds', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Iris during music' }, 'owner');
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Duck music under speech', assigneeId: 'dev' }, 'asha');
    const { thread } = room.createThread(wp, { title: 'Speaker API', text: 'x', by: 'dev' });
    const asked = inbox.raise(wp, { kind: 'decision', title: 'Which voice?', body: 'x', raisedBy: 'mira' });
    assert.equal(humanizeIds(wp, `Blocked on ${s.id} until ${thread.id} settles (see ${asked.id}).`),
      `Blocked on "Duck music under speech" until "Speaker API" settles (see "Which voice?").`);
    assert.equal(humanizeIds(wp, `Epic thread ${room.epicThreadId(epic.id)} and epic ${epic.id}`), `Epic thread "Iris during music" and epic "Iris during music"`);
    assert.equal(humanizeIds(wp, 'as_unknown123 and run_abc stay as they are'), 'as_unknown123 and run_abc stay as they are');
  } finally {
    tmp.cleanup();
  }
});

test('(3) Inbox summaries, an employee\'s last report and Room headlines show titles, not ids, to the owner', async () => {
  const b = await boot();
  try {
    const wp = b.running.wp;
    const epic = items.create(wp, { level: 'epic', title: 'Iris during music' }, 'owner');
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Duck music under speech', assigneeId: 'dev' }, 'asha');
    const { thread } = room.createThread(wp, { title: 'Speaker API', text: 'x', by: 'dev', headline: `Waiting on ${s.id}` });
    const raised = inbox.raise(wp, { kind: 'decision', title: `Ship ${s.id}?`, body: `Decide in ${thread.id} whether ${s.id} ships.`, raisedBy: 'mira' });

    const list = await call<InboxItem[]>(b.base, 'GET', '/api/inbox');
    const mine = list.body.find(i => i.id === raised.id)!;
    assert.equal(mine.title, 'Ship "Duck music under speech"?');
    assert.equal(mine.summary, 'Decide in "Speaker API" whether "Duck music under speech" ships.');
    const one = await call<InboxThread>(b.base, 'GET', `/api/inbox/${raised.id}`);
    assert.equal(one.body.item.summary, mine.summary);
    assert.equal(inbox.get(wp, raised.id)!.summary.includes(s.id), true, 'stored as raised; only the owner\'s view changes');

    writeEmployeeFile(wp.org, 'dev', 'status.md', `doing: ${s.id}\ndone: -\nblocked: -\n`);
    assert.equal(employees.card(wp, 'dev').lastReport, 'doing: "Duck music under speech"\ndone: -\nblocked: -');

    const headline = room.listThreads(wp).find(t => t.id === thread.id)!.headline;
    assert.equal(headline, 'Waiting on "Duck music under speech"');
    const viaApi = await call<{ thread: RoomThread }>(b.base, 'GET', `/api/room/${thread.id}`);
    assert.equal(viaApi.body.thread.headline, headline);
    const rooms = await call<RoomDetail>(b.base, 'GET', '/api/rooms/general');
    assert.equal(rooms.body.threads.find(t => t.id === thread.id)!.headline, headline);
  } finally {
    await b.stop();
  }
});
