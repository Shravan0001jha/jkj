import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as items from '../src/services/items.js';
import * as trail from '../src/services/trail.js';
import { intentFor } from '../src/services/push.js';
import { wireMentionReplies, resetForTest } from '../src/services/mentions.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/** Updates reach the phone as pushes (start, block, brief, review — the owner's choice); a comment mention wakes the employee. */

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

test('a pushed update becomes a push intent with ids and the deep link only; shipped is feed-only', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Music' }, 'owner');
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Mic stays live', assigneeId: 'dev', points: 3 }, 'asha');
    items.update(wp, s.id, { status: 'in-progress' }, 'dev');
    const started = trail.updates(wp)[0]!;
    const intent = intentFor(wp, { type: 'update.posted', update: started }, ['owner'])!;
    assert.equal(intent.title, 'Started: Mic stays live — Dev, 3 pts');
    assert.equal(intent.category, 'WP_UPDATE');
    assert.equal(intent.level, 'update');
    assert.equal(intent.collapseId, `update:${s.id}`);
    assert.deepEqual(intent.data, { link: `item/${s.id}`, itemId: s.id });

    items.update(wp, s.id, { status: 'blocked', blockedReason: 'needs the Speaker API', waitingOn: 'external' }, 'dev');
    const blocked = intentFor(wp, { type: 'update.posted', update: trail.updates(wp)[0]! }, ['owner'])!;
    assert.equal(blocked.level, 'blocked', 'a block is pushed even in quiet hours');

    items.update(wp, s.id, { status: 'in-progress' }, 'dev');
    items.update(wp, s.id, { status: 'in-review', reviewerId: 'nikhil' }, 'dev');
    items.update(wp, s.id, { status: 'done' }, 'nikhil');
    const shipped = trail.updates(wp)[0]!;
    assert.equal(shipped.kind, 'shipped');
    assert.equal(intentFor(wp, { type: 'update.posted', update: shipped }, ['owner']), null);
  } finally {
    tmp.cleanup();
  }
});

test('an @mention in an item comment wakes that employee with the item as context', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp } = testWorkplace();
  const off = wireMentionReplies(wp);
  try {
    resetForTest();
    const epic = items.create(wp, { level: 'epic', title: 'Music' }, 'owner');
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Mic stays live', assigneeId: 'dev' }, 'asha');
    trail.comment(wp, s.id, { by: 'owner', text: '@mira can you pair with Dev on this?' });
    await tick();
    assert.equal(fake.sessions.length, 1);
    assert.match(fake.last().options.prompt, /mentioned you on .*Mic stays live/);
    assert.match(fake.last().options.prompt, /item_comment/);
  } finally {
    off();
    fake.restore();
    tmp.cleanup();
  }
});
