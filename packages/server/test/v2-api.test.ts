import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Area, Comment, Focus, InboxItem, InboxThread, Item, ItemDetail, PlanResponse, ReleasePost, Room, RoomDetail, StatusAnswer, Update, WorkItem, FeatureBoard,
} from '@jkj/shared';
import { WORKPLACE_API } from '@jkj/shared';
import { boot, call } from './fakes/boot.js';

/**
 * The v2 API over real HTTP (LLD §19.8), what the phone apps build against; the old routes as
 * adapters; and the relay's view (`x-via-tunnel`): every v2 route passes, the COO's lead-only
 * routes stay refused.
 */

const tunnel = async <T>(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-via-tunnel': '1' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() as T };
};

test('the plan, areas, items, comments, updates, focus, status, rooms and release posts over HTTP', async () => {
  const b = await boot();
  try {
    const area = await call<Area>(b.base, 'POST', WORKPLACE_API.areas, { title: 'Voice & audio' });
    assert.equal(area.status, 201);
    const epic = await call<ItemDetail>(b.base, 'POST', WORKPLACE_API.items(), { level: 'epic', title: 'Iris works while music plays', areaId: area.body.id, ownerId: 'asha' });
    assert.equal(epic.status, 201);
    assert.equal(epic.body.item.areaId, area.body.id);
    const story = await call<ItemDetail>(b.base, 'POST', WORKPLACE_API.items(), { level: 'story', parentId: epic.body.item.id, title: 'Mic stays live at volume 0', assigneeId: 'dev', points: 3 });
    assert.equal(story.body.parent?.id, epic.body.item.id);
    assert.equal(story.body.epic?.id, epic.body.item.id);
    assert.equal(story.body.area?.id, area.body.id);
    const sid = story.body.item.id;

    // Rework (Oct 2026): every status or assignee change says why.
    const noReason = await call<{ error: string }>(b.base, 'POST', WORKPLACE_API.item(sid), { status: 'in-progress' });
    assert.equal(noReason.status, 400);
    assert.match(noReason.body.error, /give a reason for this change/);
    const bad = await call<{ error: string }>(b.base, 'POST', WORKPLACE_API.item(sid), { status: 'in-review', reason: 'skip ahead' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /cannot go from ready to in-review/);
    const started = await call<ItemDetail>(b.base, 'POST', WORKPLACE_API.item(sid), { status: 'in-progress', reason: 'starting it' });
    assert.equal(started.status, 200);
    assert.equal(started.body.item.status, 'in-progress');
    const noReviewer = await call<{ error: string }>(b.base, 'POST', WORKPLACE_API.item(sid), { status: 'in-review', reason: 'built' });
    assert.match(noReviewer.body.error, /reviewer/i);
    await call(b.base, 'POST', WORKPLACE_API.item(sid), { status: 'in-review', reviewerId: 'nikhil', assigneeId: 'mira', reason: 'Mira owns the review fixes' });
    const done = await call<ItemDetail>(b.base, 'POST', WORKPLACE_API.item(sid), { status: 'done', reason: 'verified on device' });
    assert.equal(done.status, 200, 'the owner may close what is in review');
    assert.equal(done.body.item.assigneeId, 'mira', 'reassigned in the same request');

    const c = await call<Comment>(b.base, 'POST', WORKPLACE_API.itemComments(sid), { text: 'Nice work @dev' });
    assert.equal(c.status, 201);
    assert.equal(c.body.by, 'owner');
    const detail = await call<ItemDetail>(b.base, 'GET', WORKPLACE_API.item(sid));
    assert.equal(detail.body.comments.length, 1);
    assert.ok(detail.body.activity.length >= 4);
    assert.equal(detail.body.threadId, `th_epic_${epic.body.item.id}`);
    const epicDetail = await call<ItemDetail>(b.base, 'GET', WORKPLACE_API.item(epic.body.item.id));
    assert.deepEqual(epicDetail.body.progress, { pointsDone: 3, pointsTotal: 3, storiesDone: 1, storiesTotal: 1, pct: 100 });
    assert.equal(epicDetail.body.children.length, 1);
    assert.equal((await call(b.base, 'GET', WORKPLACE_API.item('as_nope'))).status, 404);

    const list = await call<Item[]>(b.base, 'GET', WORKPLACE_API.items({ level: 'story', status: 'done' }));
    assert.ok(list.body.some(i => i.id === sid));

    const focus = await call<Focus>(b.base, 'POST', WORKPLACE_API.focus, { epicIds: [epic.body.item.id] });
    assert.deepEqual(focus.body.epicIds, [epic.body.item.id]);
    assert.equal(focus.body.setBy, 'owner');
    const plan = await call<PlanResponse>(b.base, 'GET', WORKPLACE_API.plan());
    assert.equal(plan.status, 200);
    assert.equal(plan.body.areas[0]!.epics[0]!.inFocus, true);
    assert.ok(plan.body.unfiled.length >= 1, 'the seeded feature is an epic with no area yet');
    assert.ok((await call<PlanResponse>(b.base, 'GET', WORKPLACE_API.plan('board'))).body.board);

    const updates = await call<Update[]>(b.base, 'GET', WORKPLACE_API.updates({ limit: 10 }));
    assert.deepEqual(updates.body.slice(0, 2).map(u => u.kind), ['shipped', 'started']);
    assert.equal(updates.body[0]!.line, 'Shipped: Mic stays live at volume 0 — Mira, 3 pts');

    const st = await call<StatusAnswer>(b.base, 'GET', WORKPLACE_API.status('mic stays live'));
    assert.equal(st.body.matches[0]!.item.id, sid);

    const rooms = await call<Room[]>(b.base, 'GET', WORKPLACE_API.rooms);
    assert.deepEqual(rooms.body.map(r => r.kind), ['general', 'area', 'releases']);
    const areaRoom = await call<RoomDetail>(b.base, 'GET', WORKPLACE_API.roomDetail(`area:${area.body.id}`));
    assert.ok(areaRoom.body.threads.some(t => t.epicId === epic.body.item.id));

    const post = await call<ReleasePost>(b.base, 'POST', WORKPLACE_API.releasePosts, { version: '0.2.16', shippable: 'desktop-mac' });
    assert.equal(post.status, 201);
    assert.deepEqual(post.body.groups.map(g => g.areaTitle), ['Voice & audio']);
    assert.equal((await call<ReleasePost[]>(b.base, 'GET', WORKPLACE_API.releasePosts)).body[0]!.id, post.body.id);
    assert.equal((await call<ReleasePost>(b.base, 'GET', WORKPLACE_API.releasePost(post.body.id))).body.version, '0.2.16');

    const areas = await call<Area[]>(b.base, 'GET', WORKPLACE_API.areas);
    assert.equal(areas.body.length, 1);
    const renamed = await call<Area>(b.base, 'POST', WORKPLACE_API.area(area.body.id), { title: 'Voice' });
    assert.equal(renamed.body.title, 'Voice');
  } finally {
    await b.stop();
  }
});

test('the Inbox is a thread: GET one item with its messages, reply in free text or with an option', async () => {
  const b = await boot();
  try {
    const items = await call<InboxItem[]>(b.base, 'GET', WORKPLACE_API.inbox);
    const decision = items.body.find(i => i.kind === 'decision' && i.state === 'open')!;
    const asked = await call<InboxThread>(b.base, 'POST', WORKPLACE_API.inboxReply(decision.id), { text: 'What would you pick and why?' });
    assert.equal(asked.status, 200);
    assert.equal(asked.body.item.state, 'open');
    assert.equal(asked.body.messages[0]!.by, 'owner');
    const got = await call<InboxThread>(b.base, 'GET', WORKPLACE_API.inboxThread(decision.id));
    assert.equal(got.body.messages.length, 1);
    const answered = await call<InboxThread>(b.base, 'POST', WORKPLACE_API.inboxReply(decision.id), { optionId: decision.options[0]!.id, text: 'Fine, go.' });
    assert.equal(answered.body.item.state, 'answered');
    assert.equal((await call(b.base, 'POST', WORKPLACE_API.inboxReply(decision.id), {})).status, 400);
  } finally {
    await b.stop();
  }
});

test('the old routes keep working as adapters, and their items carry the v2 fields', async () => {
  const b = await boot();
  try {
    const work = await call<WorkItem[]>(b.base, 'GET', WORKPLACE_API.work({ kind: 'assignment' }));
    assert.equal(work.status, 200);
    assert.ok(work.body.length > 0);
    assert.ok(work.body.every(w => w.level === 'story' && typeof w.status === 'string'), 'the seeded assignments were migrated or created with v2 fields');
    const features = await call<FeatureBoard>(b.base, 'GET', WORKPLACE_API.features);
    assert.ok(features.body.features.every(f => f.level === 'epic'));
    const created = await call<WorkItem>(b.base, 'POST', '/api/work', { kind: 'assignment', title: 'Via the old route', body: 'x', employeeId: 'tara', start: false });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'ready');
    assert.equal(created.body.history[0]!.by, 'owner', 'the owner did create this one');
  } finally {
    await b.stop();
  }
});

test('through the relay: every v2 route passes; the COO\'s lead-only routes stay refused', async () => {
  const b = await boot();
  try {
    for (const path of [WORKPLACE_API.plan(), WORKPLACE_API.focus, WORKPLACE_API.items(), WORKPLACE_API.updates(), WORKPLACE_API.status('x'), WORKPLACE_API.areas, WORKPLACE_API.rooms, WORKPLACE_API.releasePosts]) {
      assert.equal((await tunnel(b.base, 'GET', path)).status, 200, path);
    }
    const area = await tunnel<Area>(b.base, 'POST', WORKPLACE_API.areas, { title: 'Memory' });
    assert.equal(area.status, 201);
    const epic = await tunnel<ItemDetail>(b.base, 'POST', WORKPLACE_API.items(), { level: 'epic', title: 'Recall', areaId: area.body.id });
    assert.equal(epic.status, 201);
    assert.equal((await tunnel(b.base, 'POST', WORKPLACE_API.itemComments(epic.body.item.id), { text: 'from the phone' })).status, 201);
    for (const [method, path] of [['POST', '/api/coo/reply'], ['GET', '/api/coo/items'], ['POST', '/api/coo/answer'], ['POST', '/api/coo/forward'], ['POST', '/api/coo/live-window']] as const) {
      const r = await tunnel<{ error: string }>(b.base, method, path, method === 'POST' ? { text: 'x' } : undefined);
      assert.equal(r.status, 400, path);
      assert.match(r.body.error, /from this Mac only/);
    }
  } finally {
    await b.stop();
  }
});
