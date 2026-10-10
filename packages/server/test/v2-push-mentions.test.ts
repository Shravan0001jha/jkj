import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as items from '../src/services/items.js';
import * as trail from '../src/services/trail.js';
import { intentFor } from '../src/services/push.js';
import { wireMentionReplies, resetForTest, setCooldownForTest } from '../src/services/mentions.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/** Updates no longer reach the phone (rework W4: only what needs the owner pushes); a comment mention wakes the employee. */

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

test('no Update becomes a push intent (rework W4), not even a start or a block', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Music' }, 'owner');
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Mic stays live', assigneeId: 'dev', points: 3 }, 'asha');
    items.update(wp, s.id, { status: 'in-progress', reason: 'test: moved' }, 'dev');
    const started = trail.updates(wp)[0]!;
    assert.equal(started.line, 'Started: Mic stays live — Dev, 3 pts');
    assert.equal(intentFor(wp, { type: 'update.posted', update: started }, ['owner']), null);

    items.update(wp, s.id, { status: 'blocked', blockedReason: 'needs the Speaker API', waitingOn: 'external', reason: 'test: moved' }, 'dev');
    assert.equal(intentFor(wp, { type: 'update.posted', update: trail.updates(wp)[0]! }, ['owner']), null);

    items.update(wp, s.id, { status: 'in-progress', reason: 'test: moved' }, 'dev');
    items.update(wp, s.id, { status: 'in-review', reviewerId: 'nikhil', reason: 'test: moved' }, 'dev');
    items.update(wp, s.id, { status: 'done', reason: 'test: moved' }, 'nikhil');
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
    setCooldownForTest(10 * 60_000);
  }
});

test('a long comment reaches the mentioned employee whole, not its shortened line', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp } = testWorkplace();
  const off = wireMentionReplies(wp);
  try {
    resetForTest();
    const epic = items.create(wp, { level: 'epic', title: 'Voice' }, 'owner');
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Ack latency', assigneeId: 'dev' }, 'asha');
    const long = `@dev ${'numbers from the four scripted runs. '.repeat(20)}CAVEAT-AT-THE-END`;
    const c = trail.comment(wp, s.id, { by: 'nikhil', text: long });
    assert.equal(c.text, long.trim(), 'stored whole (rework W3: no short line plus details)');
    await tick();
    assert.match(fake.last().options.prompt, /CAVEAT-AT-THE-END/);
  } finally {
    off();
    fake.restore();
    tmp.cleanup();
    setCooldownForTest(10 * 60_000);
  }
});

test('a mention inside the cooldown is held and delivered when it ends; the COO and the owner are never held', async () => {
  setCooldownForTest(300);
  const fake = installFakeRuntime();
  const { wp, tmp } = testWorkplace();
  const off = wireMentionReplies(wp);
  try {
    resetForTest();
    const epic = items.create(wp, { level: 'epic', title: 'Voice' }, 'owner');
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Ack latency', assigneeId: 'dev' }, 'asha');
    trail.comment(wp, s.id, { by: 'nikhil', text: '@dev first' });
    await tick();
    const heard = () => fake.sessions.flatMap(x => [String(x.options.prompt), ...x.sent.map(m => m.text)]).join('\n---\n');
    trail.comment(wp, s.id, { by: 'mira', text: '@dev second, inside the cooldown' });
    await tick();
    assert.doesNotMatch(heard(), /second, inside the cooldown/, 'held, not delivered yet');
    trail.comment(wp, s.id, { by: 'coo', text: '@dev your live window is open' });
    await tick();
    assert.match(heard(), /live window is open/, 'the COO is never held');
    await new Promise(r => setTimeout(r, 400));
    await tick();
    assert.match(heard(), /second, inside the cooldown/, 'the held one arrives when the window ends');
  } finally {
    off();
    fake.restore();
    tmp.cleanup();
    setCooldownForTest(10 * 60_000);
  }
});
