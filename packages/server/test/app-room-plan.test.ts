import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as room from '../src/services/room.js';
import * as items from '../src/services/items.js';
import { workplaceTools } from '../src/services/employees.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/** Room posts are short (§8) and the plan's order and filters (§9), docs/LLD-app-fixes.md. */

type WP = ReturnType<typeof testWorkplace>['wp'];

async function toolsFor(wp: WP, employeeId: string) {
  const server = workplaceTools(wp, employeeId, () => ({ agentId: 'a', employeeId, startedAt: '', seen: {}, planCaptured: false }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(st);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(ct);
  return async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text;
}

test('room_post refuses a post over 600 characters with the next step; at 600 it posts', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp } = testWorkplace();
  try {
    const general = room.ensureGeneral(wp);
    const call = await toolsFor(wp, 'mira');
    assert.equal(await call('room_post', { threadId: general.id, text: 'x'.repeat(601) }), 'Not posted: Room posts are short: put the detail on the item or in a doc and link it.');
    assert.equal(await call('room_post', { title: 'New', text: 'y'.repeat(700) }), 'Not posted: Room posts are short: put the detail on the item or in a doc and link it.');
    assert.equal(room.messages(wp, general.id).length, 0);
    assert.match(await call('room_post', { threadId: general.id, text: 'z'.repeat(600) }), /^Posted msg_/);
  } finally { tmp.cleanup(); fake.restore(); }
});

test('a cut Room message says so: truncated, and details holds the full text', () => {
  const fake = installFakeRuntime();
  const { wp, tmp } = testWorkplace();
  try {
    const general = room.ensureGeneral(wp);
    const long = Array.from({ length: 8 }, (_, i) => `line ${i} of the detail`).join('\n');
    const m = room.post(wp, general.id, { text: long, by: 'mira' });
    assert.equal(m.truncated, true);
    assert.equal(m.details, long);
    const short = room.post(wp, general.id, { text: 'short', by: 'mira' });
    assert.equal(short.truncated, undefined);
    const owner = room.post(wp, general.id, { text: long, by: 'owner' });
    assert.equal(owner.truncated, undefined, 'the owner is never cut');
  } finally { tmp.cleanup(); fake.restore(); }
});

test('plan: a finished epic sorts below every unfinished one, even with a stale owner flag', () => {
  const fake = installFakeRuntime();
  const { wp, tmp } = testWorkplace();
  try {
    const done = items.create(wp, { level: 'epic', title: 'Done epic' }, 'owner');
    const s = items.create(wp, { level: 'story', parentId: done.id, title: 'Only story', assigneeId: 'dev' }, 'asha');
    items.update(wp, s.id, { status: 'in-progress', reason: 'test: moved' }, 'dev');
    items.update(wp, s.id, { status: 'blocked', blockedReason: 'needs you', waitingOn: 'owner', recommendation: 'go', reason: 'test: moved' }, 'dev');
    const open = items.create(wp, { level: 'epic', title: 'Open epic' }, 'owner');
    items.create(wp, { level: 'story', parentId: open.id, title: 'Open story', assigneeId: 'dev' }, 'asha');
    // The epic is closed while its story still carries the owner flag.
    items.update(wp, done.id, { status: 'done', reason: 'test: moved' }, 'owner');
    const titles = items.plan(wp).unfiled.map(c => c.epic.title);
    assert.deepEqual(titles, ['Open epic', 'Done epic']);
  } finally { tmp.cleanup(); fake.restore(); }
});

test('items list: text search, owner, several statuses, sort and finished last', () => {
  const fake = installFakeRuntime();
  const { wp, tmp } = testWorkplace();
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Windows' }, 'owner');
    const a = items.create(wp, { level: 'story', parentId: epic.id, title: 'Sign the installer', body: 'Authenticode', assigneeId: 'rohan' }, 'asha');
    const b = items.create(wp, { level: 'story', parentId: epic.id, title: 'Auto-update channel', assigneeId: 'rohan' }, 'asha');
    const c = items.create(wp, { level: 'story', parentId: epic.id, title: 'Crash reporter', assigneeId: 'dev' }, 'asha');
    items.update(wp, b.id, { status: 'in-progress', reason: 'test: moved' }, 'rohan');
    items.update(wp, c.id, { status: 'done', reason: 'test: moved' }, 'owner');

    assert.deepEqual(items.list(wp, { q: 'authenticode' }).map(i => i.id), [a.id]);
    assert.deepEqual(items.list(wp, { q: 'INSTALLER' }).map(i => i.id), [a.id]);
    assert.deepEqual(items.list(wp, { ownerId: 'rohan', sort: 'title' }).map(i => i.id), [b.id, a.id]);
    assert.deepEqual(new Set(items.list(wp, { level: 'story', status: 'in-progress,done' }).map(i => i.id)), new Set([b.id, c.id]));
    const finishedLast = items.list(wp, { level: 'story', sort: 'title', finishedLast: true }).map(i => i.id);
    assert.deepEqual(finishedLast, [b.id, a.id, c.id]);
    const desc = items.list(wp, { level: 'story', sort: 'title', order: 'desc' }).map(i => i.id);
    assert.deepEqual(desc, [a.id, c.id, b.id]);
  } finally { tmp.cleanup(); fake.restore(); }
});
