import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RoomThread } from '@jkj/shared';
import * as items from '../src/services/items.js';
import * as areas from '../src/services/areas.js';
import * as room from '../src/services/room.js';
import { migrateV2 } from '../src/services/migrate-v2.js';
import { testWorkplace } from './fakes/workplace.js';
import { boot, call } from './fakes/boot.js';

/**
 * QA, 2 Oct: Asha resolved the P0 epic's thread (th_epic_ft_mummakwyuew19) because it was full of
 * automated update lines; the lines kept coming into a resolved thread and the owner could no
 * longer post there. Rule (LLD §19.4): an epic's thread — like an area's own channel, General and
 * Releases — is a standing channel and cannot be resolved; one already resolved is reopened by the
 * boot migration; the Workplace's own update lines never wake the moderator.
 */

function setup(wp: ReturnType<typeof testWorkplace>['wp']) {
  const area = areas.create(wp, { title: 'Voice & audio' }, 'owner');
  const epic = items.create(wp, { level: 'epic', title: 'Iris during music', areaId: area.id, ownerId: 'asha' }, 'owner');
  const story = items.create(wp, { level: 'story', parentId: epic.id, title: 'Mic stays live', assigneeId: 'dev' }, 'asha');
  return { area, epic, story, thread: room.getThread(wp, room.epicThreadId(epic.id))! };
}

test('an epic thread, an area channel, General and Releases cannot be resolved; a topic thread still can', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { area, thread } = setup(wp);
    room.ensureGeneral(wp);
    room.ensureReleases(wp);
    for (const id of [thread.id, room.areaThreadId(area.id), room.GENERAL_THREAD_ID, room.RELEASES_THREAD_ID]) {
      assert.throws(() => room.resolve(wp, id, { summary: 'noise', by: 'asha' }), /channel|cannot be resolved/i, id);
      assert.equal(room.getThread(wp, id)!.state, 'open');
    }
    const topic = room.createThread(wp, { title: 'Who owns app.py?', text: 'x', by: 'asha' }).thread;
    assert.equal(room.resolve(wp, topic.id, { summary: 'experts', by: 'asha' }).thread.state, 'resolved');
  } finally {
    tmp.cleanup();
  }
});

test('the owner route refuses to resolve an epic thread with 400, and the owner can always post there', async () => {
  const srv = await boot();
  try {
    const { thread } = setup(srv.running.wp);
    assert.equal((await call(srv.base, 'POST', `/api/room/${thread.id}/resolve`, { summary: 'done' })).status, 400);
    assert.equal((await call(srv.base, 'POST', `/api/room/${thread.id}/messages`, { text: 'How is this going?' })).status, 201);
  } finally {
    await srv.stop();
  }
});

test('the boot migration reopens an epic thread resolved before the rule, idempotently, and update lines keep it open', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { thread, story } = setup(wp);
    // As Asha left it live: resolved with a summary.
    const resolved: RoomThread = { ...room.getThread(wp, thread.id)!, state: 'resolved', summary: 'All auto pairs; closing.', headline: 'All auto pairs; closing.' };
    wp.db.prepare('update threads set state = ?, json = ? where id = ?').run('resolved', JSON.stringify(resolved), thread.id);
    migrateV2(wp);
    const reopened = room.getThread(wp, thread.id)!;
    assert.equal(reopened.state, 'open');
    assert.equal(reopened.summary, undefined);
    migrateV2(wp);
    assert.equal(room.getThread(wp, thread.id)!.state, 'open');

    items.update(wp, story.id, { status: 'in-progress', reason: 'test: moved' }, 'dev');
    assert.equal(room.getThread(wp, thread.id)!.state, 'open');
    assert.equal(room.messages(wp, thread.id).at(-1)!.kind, 'update');
  } finally {
    tmp.cleanup();
  }
});

test('the Workplace\'s own update lines do not hand a thread to the moderator; a person\'s message does', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { thread, story } = setup(wp);
    room.markSeen(wp, 'asha', new Date(Date.now() - 1000).toISOString());
    items.update(wp, story.id, { status: 'in-progress', reason: 'test: moved' }, 'dev');
    assert.ok(!room.needsModeration(wp, 'asha').some(t => t.id === thread.id), 'an update line is not a conversation');
    room.post(wp, thread.id, { text: '@asha is this on track?', by: 'owner' });
    assert.ok(room.needsModeration(wp, 'asha').some(t => t.id === thread.id));
  } finally {
    tmp.cleanup();
  }
});
