import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Comment, CooItem, RoomMessage } from '@jkj/shared';
import * as items from '../src/services/items.js';
import * as areas from '../src/services/areas.js';
import * as room from '../src/services/room.js';
import * as trail from '../src/services/trail.js';
import * as coo from '../src/services/coo.js';
import { boot, call } from './fakes/boot.js';

/**
 * The COO answers where it was asked (owner, 2 Oct). POST /api/room/:id/messages and
 * /api/items/:id/comments always write as the owner, and /api/coo/reply only lands in the COO chat,
 * so an @coo in an epic thread could only be answered under the owner's name. The lead now posts as
 * `coo` into a room thread or an item (loopback only), and answering a mention item posts the
 * answer's note back into the thread it came from.
 */

function epicWithThread(wp: Parameters<typeof items.create>[0]) {
  const area = areas.create(wp, { title: 'Voice & audio' }, 'owner');
  const epic = items.create(wp, { level: 'epic', title: 'Iris during music', areaId: area.id, ownerId: 'asha' }, 'owner');
  const story = items.create(wp, { level: 'story', parentId: epic.id, title: 'Mic stays live', assigneeId: 'dev' }, 'asha');
  return { epic, story, threadId: room.epicThreadId(epic.id) };
}

test('POST /api/coo/thread-reply posts as the COO into a room thread or an item, from loopback only', async () => {
  const b = await boot();
  try {
    const { story, threadId } = epicWithThread(b.running.wp);

    const inThread = await call<RoomMessage>(b.base, 'POST', '/api/coo/thread-reply', { threadId, text: 'On it: the restart flap is fixed.' });
    assert.equal(inThread.status, 201);
    assert.equal(inThread.body.by, 'coo');
    assert.equal(inThread.body.owner, false, 'never the owner');
    assert.equal(room.messages(b.running.wp, threadId).at(-1)!.by, 'coo');

    const onItem = await call<Comment>(b.base, 'POST', '/api/coo/thread-reply', { itemId: story.id, text: 'Reviewer is Nikhil.' });
    assert.equal(onItem.status, 201);
    assert.equal(onItem.body.by, 'coo');
    assert.equal(trail.comments(b.running.wp, story.id).at(-1)!.by, 'coo');

    assert.equal((await call(b.base, 'POST', '/api/coo/thread-reply', { text: 'where?' })).status, 400, 'a thread or an item is required');
    assert.equal((await call(b.base, 'POST', '/api/coo/thread-reply', { threadId: 'th_nope', text: 'x' })).status, 400);

    const tunneled = await fetch(`${b.base}/api/coo/thread-reply`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-via-tunnel': '1' }, body: JSON.stringify({ threadId, text: 'leak?' }) });
    assert.equal(tunneled.status, 400, 'refused through the tunnel, whatever a bearer token allows');
    assert.ok(!room.messages(b.running.wp, threadId).some(m => m.text === 'leak?'));
  } finally {
    await b.stop();
  }
});

test('answering an @coo mention posts the answer into the thread it came from, as the COO', async () => {
  const b = await boot();
  try {
    const wp = b.running.wp;
    coo.touchHeartbeatForTest(wp); // online: the mention waits for the COO, it does not fall back
    const { story, threadId } = epicWithThread(wp);

    room.post(wp, threadId, { text: '@coo is the P0 story still blocked?', by: 'owner' });
    const mention = coo.listItems(wp, 'open').find(i => i.kind === 'mention' && i.threadId === threadId)!;
    assert.ok(mention, 'the mention reached the COO bridge');
    const answered = await call<CooItem>(b.base, 'POST', '/api/coo/answer', { itemId: mention.id, optionId: 'answered', note: 'No: it is in review with Nikhil.' });
    assert.equal(answered.status, 200);
    const last = room.messages(wp, threadId).at(-1)!;
    assert.equal(last.by, 'coo');
    assert.equal(last.text, 'No: it is in review with Nikhil.');

    // An @coo in an item's comments: the answer lands on the item.
    trail.comment(wp, story.id, { by: 'owner', text: '@coo who reviews this?' });
    const onItem = coo.listItems(wp, 'open').find(i => i.kind === 'mention' && i.threadId === `item:${story.id}`)!;
    coo.answerItem(wp, { itemId: onItem.id, optionId: 'answered', note: 'Nikhil.' });
    assert.equal(trail.comments(wp, story.id).at(-1)!.by, 'coo');
    assert.equal(trail.comments(wp, story.id).at(-1)!.text, 'Nikhil.');

    // No note, nothing to say in the thread.
    room.post(wp, threadId, { text: '@coo fyi', by: 'owner' });
    const fyi = coo.listItems(wp, 'open').find(i => i.kind === 'mention' && i.body === '@coo fyi')!;
    const before = room.messages(wp, threadId).length;
    coo.answerItem(wp, { itemId: fyi.id, optionId: 'answered' });
    assert.equal(room.messages(wp, threadId).length, before);
  } finally {
    await b.stop();
  }
});
