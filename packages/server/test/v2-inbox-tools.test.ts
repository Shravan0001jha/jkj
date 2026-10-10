import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as inbox from '../src/services/inbox.js';
import * as items from '../src/services/items.js';
import * as trail from '../src/services/trail.js';
import * as runs from '../src/services/runs.js';
import * as employees from '../src/services/employees.js';
import { workplaceTools, WORKPLACE_TOOLS } from '../src/services/employees.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/** Decisions are conversations (HLD D23, LLD §19.5) and the agents' v2 tools (LLD §19.12). */

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

async function toolsFor(wp: ReturnType<typeof testWorkplace>['wp'], employeeId: string, assignmentId?: string) {
  const server = workplaceTools(wp, employeeId, () => ({ agentId: 'a', employeeId, ...(assignmentId ? { assignmentId } : {}), startedAt: '', seen: {}, planCaptured: false }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(st);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => JSON.stringify((await client.callTool({ name, arguments: args })).content);
  return { client, call };
}

test('a free-text reply keeps the decision open and reaches the asker, who answers in the same thread', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp } = testWorkplace();
  try {
    const item = inbox.raise(wp, { kind: 'decision', title: 'Which TTS voice ships?', body: 'Two candidates.', raisedBy: 'mira', options: [{ id: 'aria', label: 'Aria', recommended: true }, { id: 'nova', label: 'Nova' }], urgency: 'high' });
    assert.equal(item.options[0]!.recommended, true);
    assert.equal(item.urgency, 'high');

    let thread = inbox.reply(wp, item.id, { by: 'owner', text: 'What does Nova cost per month?' });
    assert.equal(thread.item.state, 'open');
    assert.equal(thread.item.messageCount, 1);
    assert.deepEqual(thread.messages.map(m => [m.by, m.text]), [['owner', 'What does Nova cost per month?']]);
    await tick();
    const s = fake.last();
    assert.match(s.options.prompt, /The owner replied on "Which TTS voice ships\?"/);
    assert.match(s.options.prompt, /What does Nova cost per month\?/);
    const entry = runs.getRunTranscript(employees.openSession('mira')!.agentId)!.find(e => e.kind === 'user')!;
    assert.equal(entry.from, 'workplace', 'the relay prompt is not the owner\'s words');

    const mira = await toolsFor(wp, 'mira');
    assert.match(await mira.call('inbox_reply', { inboxId: item.id, text: 'About $20 a month at our volume.' }), /Replied/);
    thread = inbox.thread(wp, item.id);
    assert.deepEqual(thread.messages.map(m => m.by), ['owner', 'mira']);

    thread = inbox.reply(wp, item.id, { by: 'owner', text: 'Go with Nova then.', optionId: 'nova' });
    assert.equal(thread.item.state, 'answered');
    assert.equal(thread.item.answer?.optionId, 'nova');
    assert.equal(thread.item.answer?.note, 'Go with Nova then.');
    assert.equal(thread.messages.length, 3);
    const decided = trail.updates(wp).find(u => u.kind === 'decided')!;
    assert.equal(decided.line, 'Decided: Which TTS voice ships? — Nova');
    assert.equal(decided.inboxId, item.id);
    assert.equal(decided.href, `inbox/${item.id}`);

    assert.throws(() => inbox.reply(wp, item.id, { by: 'owner', text: 'again', optionId: 'aria' }), /already answered/);
    assert.throws(() => inbox.reply(wp, item.id, { by: 'owner' }), /Nothing to send/);
    const listed = inbox.ownerList(wp).find(i => i.id === item.id)!;
    assert.equal(listed.messageCount, 3);
    assert.ok(listed.lastMessageAt);
    await mira.client.close();
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('the agents\' v2 tools: one story per outcome, tasks by the story owner, no self-done, comments, status', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Iris works while music plays', ownerId: 'asha' }, 'owner');
    const asha = await toolsFor(wp, 'asha');
    const made = await asha.call('item_create', { level: 'story', parentId: epic.id, title: 'Greeting context contract', assigneeId: 'dev', points: 3 });
    const storyId = /Created (as_\w+)/.exec(made)![1]!;
    const dup = await asha.call('item_create', { level: 'story', parentId: epic.id, title: '  greeting CONTEXT contract ', assigneeId: 'mira' });
    assert.match(dup, new RegExp(`Already exists as ${storyId}`), 'the fifth copy of the same story is refused');

    const mira = await toolsFor(wp, 'mira');
    // Rework (Oct 2026): anyone files a story; one filed by a lead goes to her manager (Asha), Ready.
    assert.match(await mira.call('item_create', { level: 'story', parentId: epic.id, title: 'Mira\'s own story' }), /Created as_\w+ \(story, ready, with Asha\)/);
    const epicMade = await asha.call('item_create', { level: 'epic', title: 'Alpha testers site', targetDate: '2026-10-07' });
    assert.match(epicMade, /Created ft_\w+ \(epic\)/);
    assert.match(await mira.call('item_create', { level: 'epic', title: 'Mira\'s epic' }), /Only the Chief of Staff creates epics/);
    assert.match(await asha.call('item_create', { level: 'story', title: 'No parent' }), /needs its epic/);
    assert.match(await mira.call('item_create', { level: 'task', parentId: storyId, title: 'A task' }), /Only the story's assignee/);
    const dev = await toolsFor(wp, 'dev', storyId);
    const t = await dev.call('item_create', { level: 'task', parentId: storyId, title: 'Write the schema', assigneeId: 'mira' });
    assert.match(t, /Created as_/);

    assert.match(await dev.call('item_update', { itemId: storyId, status: 'in-progress', reason: 'starting the schema' }), /in-progress/);
    assert.match(await dev.call('item_update', { itemId: storyId, status: 'in-review', reviewerId: 'nikhil', reason: 'schema is written' }), /in-review/);
    assert.match(await dev.call('item_update', { itemId: storyId, status: 'done', reason: 'I think it is done' }), /Not changed/);
    assert.equal(items.require$(wp, storyId).status, 'in-review');
    const nikhil = await toolsFor(wp, 'nikhil');
    assert.match(await nikhil.call('item_update', { itemId: storyId, status: 'done', reason: 'verified the schema' }), /done/);

    assert.match(await dev.call('item_comment', { itemId: storyId, text: 'Schema is in contracts/greeting.json' }), /Commented/);
    assert.equal(trail.comments(wp, storyId).at(-1)!.by, 'dev');
    const status = await asha.call('status_of', { q: 'greeting context' });
    assert.match(status, /Greeting context contract/);
    assert.match(status, /Done/);
    assert.match(status, new RegExp(`\\[${storyId}\\]`), 'each answer carries its id');
    assert.match(await asha.call('status_of', { q: storyId }), /Greeting context contract/, 'an id is answered');
    for (const c of [asha, mira, dev, nikhil]) await c.client.close();
  } finally {
    tmp.cleanup();
  }
});

test('the new tools are in the always-allowed list', () => {
  for (const name of ['item_create', 'item_update', 'item_comment', 'flag_stall', 'item_handback', 'inbox_reply', 'status_of']) {
    assert.ok((WORKPLACE_TOOLS as readonly string[]).includes(name), name);
  }
});

test('item_update hold: the Chief of Staff parks an item (parked) and the dispatcher leaves it; nobody else can', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp } = testWorkplace();
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Music' }, 'owner');
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Stream-first playback', assigneeId: 'mira' }, 'asha');
    items.update(wp, s.id, { status: 'in-progress', reason: 'test: moved' }, 'mira');
    const mira = await toolsFor(wp, 'mira');
    assert.match(await mira.call('item_update', { itemId: s.id, status: 'backlog', hold: true }), /only the Chief of Staff/);
    const asha = await toolsFor(wp, 'asha');
    await asha.call('item_update', { itemId: s.id, hold: true, note: 'after launch work' });
    // Rework (Oct 2026): a new hold parks the item; lifting it puts it back in Backlog.
    const raw = items.require$(wp, s.id);
    assert.equal(raw.status, 'parked');
    assert.equal(raw.parked?.reason, 'after launch work');
    await asha.call('item_update', { itemId: s.id, hold: false, note: 'launch work is done' });
    const lifted = items.require$(wp, s.id);
    assert.equal(lifted.status, 'backlog');
    assert.equal(lifted.hold ?? false, false);
    await mira.client.close(); await asha.client.close();
  } finally { fake.restore(); tmp.cleanup(); }
});
