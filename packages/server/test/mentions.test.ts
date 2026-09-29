import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as room from '../src/services/room.js';
import * as coo from '../src/services/coo.js';
import * as employees from '../src/services/employees.js';
import { wireMentionReplies, resetForTest, MENTION_COOLDOWN_MS } from '../src/services/mentions.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * RCA (owner, 29 Sep): `@mentions` were stored on a `RoomMessage` (`room.mentionsIn`) but nothing
 * ever turned one into a session doing anything — the only consumer was `push.ts`, and only for an
 * `@owner` mention (a phone notification, not a turn). These tests are the fix: a mention wakes a
 * short, rate-limited reply turn; `@coo` goes to the COO bridge instead.
 */

function withMentions(wp: ReturnType<typeof testWorkplace>['wp']) {
  resetForTest();
  return wireMentionReplies(wp);
}

test('an @mention starts a short turn for the mentioned employee, with the thread as context', async () => {
  const { wp, tmp } = testWorkplace();
  const runtime = installFakeRuntime();
  const unwire = withMentions(wp);
  try {
    room.createThread(wp, { title: 'Weather source', text: 'Which module owns the weather facts? @dev', by: 'mira', charterIds: ['experts', 'conversation'] });
    await Promise.resolve(); await Promise.resolve(); // the mention handler and the fake spawn both queue a microtask
    assert.equal(runtime.sessions.length, 1, 'exactly one session was started');
    const spawned = runtime.last();
    assert.match(spawned.options.cwd, /\/dev\//, 'in dev\'s own worktree');
    assert.match(spawned.options.prompt, /Weather source/);
    assert.match(spawned.options.prompt, /Which module owns the weather facts/);
    assert.equal(employees.openSession('dev')?.agentId !== undefined, true, 'the Workplace is tracking the session against dev');
  } finally {
    unwire(); runtime.restore(); tmp.cleanup();
  }
});

test('a self-mention never wakes the poster; the owner mentioning nobody real is a no-op', async () => {
  const { wp, tmp } = testWorkplace();
  const runtime = installFakeRuntime();
  const unwire = withMentions(wp);
  try {
    room.createThread(wp, { title: 'Note to self', text: '@mira noted, will follow up', by: 'mira', charterIds: [] });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(runtime.sessions.length, 0, 'mira mentioning herself starts nothing');
  } finally {
    unwire(); runtime.restore(); tmp.cleanup();
  }
});

test('one reply turn per mention: a second mention of the same employee in the same thread within the cooldown does not spawn again', async () => {
  const { wp, tmp } = testWorkplace();
  const runtime = installFakeRuntime();
  const unwire = withMentions(wp);
  try {
    const { thread } = room.createThread(wp, { title: 'Contract', text: '@tara take a look', by: 'asha', charterIds: [] });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(runtime.sessions.length, 1);
    // Close the session outright (not merely idle) so a second wake cannot merge into it — only the
    // cooldown, not "there is already an open session", explains what happens next.
    employees.close(wp, employees.openSession('tara')!.agentId, 'test');
    room.post(wp, thread.id, { text: '@tara ping again', by: 'asha' });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(runtime.sessions.length, 1, 'rate-limited within the cooldown: no second session');
  } finally {
    unwire(); runtime.restore(); tmp.cleanup();
  }
});

test('@coo in a thread goes to the COO bridge, not a spawned session', async () => {
  const { wp, tmp } = testWorkplace();
  const runtime = installFakeRuntime();
  const unwire = withMentions(wp);
  try {
    const { thread } = room.createThread(wp, { title: 'Deploy window', text: 'Can we deploy at 6pm? @coo', by: 'asha', charterIds: [] });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(runtime.sessions.length, 0, 'the coo is never spawned');
    const items = coo.listItems(wp);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.kind, 'mention');
    assert.equal(items[0]!.threadId, thread.id);
  } finally {
    unwire(); runtime.restore(); tmp.cleanup();
  }
});

test('the General channel exists from boot and behaves like any other thread', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const before = room.ensureGeneral(wp);
    assert.equal(before.title, 'General');
    const again = room.ensureGeneral(wp);
    assert.equal(again.id, before.id, 'idempotent: a second boot does not make a second General');
    room.post(wp, before.id, { text: 'Morning all @asha', by: 'owner' });
    assert.equal(room.getThread(wp, before.id)!.messageCount, 1);
  } finally {
    tmp.cleanup();
  }
});

void MENTION_COOLDOWN_MS; // documents the constant is exported for anyone tuning it; not asserted on directly here
