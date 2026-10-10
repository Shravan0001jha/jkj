import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as items from '../src/services/items.js';
import * as areas from '../src/services/areas.js';
import * as room from '../src/services/room.js';
import * as posts from '../src/services/release-posts.js';
import * as releases from '../src/services/releases.js';
import * as inbox from '../src/services/inbox.js';
import { statusOf } from '../src/util/errors.js';
import { testWorkplace } from './fakes/workplace.js';

/** Areas (≤ 5 active), rooms per area with a thread per epic, and the Releases room (LLD §19.1, §19.8). */

test('at most five areas are active; a sixth is a conflict until one is archived', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const made = ['Voice & audio', 'Character & greeting', 'Memory', 'Mac & mobile apps', 'Security patching'].map(title => areas.create(wp, { title }, 'owner'));
    assert.equal(areas.list(wp).filter(a => a.state === 'active').length, 5);
    assert.deepEqual(made.map(a => a.rank), [1, 2, 3, 4, 5]);
    assert.equal(made[0]!.ownerId, 'owner');
    assert.equal(made[0]!.roomId, `area:${made[0]!.id}`);
    let err: unknown;
    try { areas.create(wp, { title: 'Growth' }, 'owner'); } catch (e) { err = e; }
    assert.equal(statusOf(err), 409);
    assert.match(String((err as Error).message), /5 active areas/);
    areas.update(wp, made[4]!.id, { state: 'archived' });
    const growth = areas.create(wp, { title: 'Growth' }, 'owner');
    assert.equal(growth.state, 'active');
    let again: unknown;
    try { areas.update(wp, made[4]!.id, { state: 'active' }); } catch (e) { again = e; }
    assert.equal(statusOf(again), 409);
    assert.throws(() => areas.create(wp, { title: ' ' }, 'owner'), /title/i);
    const renamed = areas.update(wp, growth.id, { title: 'Growth & pricing', rank: 0.5 });
    assert.equal(renamed.title, 'Growth & pricing');
    assert.equal(areas.list(wp)[0]!.id, growth.id, 'listed in rank order');
  } finally {
    tmp.cleanup();
  }
});

test('rooms: General, one per active area (its channel plus a thread per epic), and Releases', () => {
  const { wp, tmp } = testWorkplace();
  try {
    room.ensureGeneral(wp);
    const voice = areas.create(wp, { title: 'Voice & audio' }, 'owner');
    const epic = items.create(wp, { level: 'epic', title: 'Iris works while music plays', areaId: voice.id }, 'owner');
    const later = items.create(wp, { level: 'epic', title: 'Wake word v2' }, 'owner');
    assert.equal(room.getThread(wp, `th_epic_${later.id}`), undefined, 'no area, no room thread yet');
    items.update(wp, later.id, { areaId: voice.id }, 'owner');

    const rooms = room.listRooms(wp);
    assert.deepEqual(rooms.map(r => r.kind), ['general', 'area', 'releases']);
    const voiceRoom = rooms.find(r => r.kind === 'area')!;
    assert.equal(voiceRoom.id, `area:${voice.id}`);
    assert.equal(voiceRoom.title, 'Voice & audio');
    assert.deepEqual(new Set(voiceRoom.threadIds), new Set([voice.threadId, `th_epic_${epic.id}`, `th_epic_${later.id}`]));
    const detail = room.roomDetail(wp, voiceRoom.id);
    assert.equal(detail.threads.find(t => t.epicId === epic.id)!.title, 'Iris works while music plays');
    assert.ok(room.roomDetail(wp, 'general').threads.some(t => t.id === room.GENERAL_THREAD_ID));
    assert.throws(() => room.roomDetail(wp, 'area:nope'), /No room/);

    areas.update(wp, voice.id, { state: 'archived' });
    assert.ok(!room.listRooms(wp).some(r => r.id === voiceRoom.id), 'an archived area has no live room');
  } finally {
    tmp.cleanup();
  }
});

test('a release post lists every story and fix that shipped, grouped by area, once', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const voice = areas.create(wp, { title: 'Voice & audio' }, 'owner');
    const mem = areas.create(wp, { title: 'Memory' }, 'owner');
    const e1 = items.create(wp, { level: 'epic', title: 'Music', areaId: voice.id }, 'owner');
    const e2 = items.create(wp, { level: 'epic', title: 'Recall', areaId: mem.id }, 'owner');
    const ship = (parentId: string, title: string, assigneeId: string) => {
      const s = items.create(wp, { level: 'story', parentId, title, assigneeId }, 'asha');
      items.update(wp, s.id, { status: 'in-progress', reason: 'test: moved' }, assigneeId);
      items.update(wp, s.id, { status: 'in-review', reviewerId: 'nikhil', reason: 'test: moved' }, assigneeId);
      return items.update(wp, s.id, { status: 'done', reason: 'test: moved' }, 'nikhil');
    };
    const a = ship(e1.id, 'Mic stays live at volume 0', 'dev');
    const b = ship(e2.id, 'Fix: recall drops the last fact', 'kabir');
    const open = items.create(wp, { level: 'story', parentId: e1.id, title: 'Not done yet', assigneeId: 'dev' }, 'asha');

    const post = posts.create(wp, { version: '0.2.16', shippable: 'desktop-mac' }, 'nikhil');
    assert.equal(post.version, '0.2.16');
    assert.deepEqual(post.groups.map(g => g.areaTitle), ['Voice & audio', 'Memory']);
    assert.deepEqual(post.groups[0]!.items.map(i => [i.id, i.kind]), [[a.id, 'story']]);
    assert.deepEqual(post.groups[1]!.items.map(i => i.title), ['Fix: recall drops the last fact']);
    assert.ok(!post.groups.flatMap(g => g.items).some(i => i.id === open.id));
    assert.equal(items.require$(wp, a.id).releasedIn, post.id);
    assert.equal(post.threadId, room.RELEASES_THREAD_ID);
    const msg = room.messages(wp, room.RELEASES_THREAD_ID).at(-1)!;
    assert.equal(msg.kind, 'release');
    assert.match(msg.text, /0\.2\.16/);
    assert.match(msg.text, /Mic stays live at volume 0/);

    const second = posts.create(wp, { version: '0.2.17' }, 'nikhil');
    assert.equal(second.groups.flatMap(g => g.items).length, 0, 'nothing ships twice');
    assert.deepEqual(posts.list(wp).map(p => p.id), [second.id, post.id]);
    assert.equal(posts.get(wp, post.id)!.id, post.id);
    assert.ok(b);
  } finally {
    tmp.cleanup();
  }
});

test('a release run that finishes posts in the Releases room on its own', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    releases.useSpawner(async (_spec, onLine) => { onLine('uploaded'); return { code: 0 }; });
    const voice = areas.create(wp, { title: 'Voice & audio' }, 'owner');
    const e1 = items.create(wp, { level: 'epic', title: 'Music', areaId: voice.id }, 'owner');
    const s = items.create(wp, { level: 'story', parentId: e1.id, title: 'Mic stays live', assigneeId: 'dev' }, 'asha');
    items.update(wp, s.id, { status: 'done', resolution: 'done', reason: 'test: moved' }, 'owner');
    const rel = releases.propose(wp, 'desktop-mac', '0.2.16', 'nikhil');
    inbox.answer(wp, rel.inboxId, 'approve', undefined, 'web');
    await releases.run(wp, rel.id);
    const post = posts.list(wp)[0]!;
    assert.equal(post.releaseId, rel.id);
    assert.equal(post.shippable, 'desktop-mac');
    assert.deepEqual(post.groups.flatMap(g => g.items).map(i => i.id), [s.id]);
  } finally {
    releases.useSpawner(null);
    tmp.cleanup();
  }
});
