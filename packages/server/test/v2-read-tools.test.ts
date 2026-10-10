import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as inbox from '../src/services/inbox.js';
import * as items from '../src/services/items.js';
import * as trail from '../src/services/trail.js';
import * as readTools from '../src/services/read-tools.js';
import { workplaceTools, WORKPLACE_TOOLS } from '../src/services/employees.js';
import { testWorkplace } from './fakes/workplace.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';

/** item_read / inbox_read: the reviewer reads the evidence before bouncing a story (LLD §19.13). */

type WP = ReturnType<typeof testWorkplace>['wp'];

async function toolsFor(wp: WP, employeeId: string) {
  const server = workplaceTools(wp, employeeId, () => ({ agentId: 'a', employeeId, startedAt: '', seen: {}, planCaptured: false }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(st);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return (r.content as { type: string; text: string }[]).map(c => c.text).join('\n');
  };
  return { client, call };
}

function seed(wp: WP) {
  const epic = items.create(wp, { level: 'epic', title: 'Iris greets you by name', ownerId: 'asha' }, 'owner');
  const story = items.create(wp, { level: 'story', parentId: epic.id, title: 'Decide the greeting voice', assigneeId: 'mira', acceptance: ['A voice is chosen by the owner', 'The decision is recorded'], body: 'No code: a decision for the owner.' }, 'asha');
  const task = items.create(wp, { level: 'task', parentId: story.id, title: 'Shortlist two voices', assigneeId: 'mira' }, 'mira');
  const decision = inbox.raise(wp, { kind: 'decision', title: 'Which greeting voice?', body: 'Aria or Nova.', raisedBy: 'mira', context: { itemId: story.id }, options: [{ id: 'aria', label: 'Aria' }, { id: 'nova', label: 'Nova' }], recommendation: 'aria' });
  trail.comment(wp, story.id, { by: 'mira', text: `Filed the decision for the owner as ${decision.id}.` });
  return { epic, story, task, decision };
}

test('item_read: title, status, people, acceptance, body, children, comments, activity and linked Inbox items', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { story, task, decision } = seed(wp);
    items.update(wp, story.id, { status: 'in-progress', reason: 'test: moved' }, 'mira');
    items.update(wp, story.id, { status: 'in-review', reviewerId: 'nikhil', reason: 'test: moved' }, 'mira');
    const nikhil = await toolsFor(wp, 'nikhil');
    const out = await nikhil.call('item_read', { itemId: story.id });
    assert.match(out, /Decide the greeting voice/);
    assert.match(out, new RegExp(story.id));
    assert.match(out, /In review/);
    assert.match(out, /Assignee: Mira/i);
    assert.match(out, /Reviewer: Nikhil/i);
    assert.match(out, /A voice is chosen by the owner/);
    assert.match(out, /No code: a decision for the owner\./);
    assert.match(out, /Shortlist two voices/);
    assert.match(out, new RegExp(task.id), 'children carry their ids');
    assert.match(out, /Filed the decision for the owner as "Which greeting voice\?" \(in_/, 'ids in text read as titles, with the id kept');
    assert.match(out, new RegExp(`${decision.id}.*open.*Which greeting voice`), 'the linked Inbox decision is listed');
    assert.match(out, /Activity/);
    assert.match(out, /status/);
    await nikhil.client.close();
  } finally {
    tmp.cleanup();
  }
});

test('item_read resolves ids like status_of: exact, inside the text, merged; unknown ids say so', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { epic, story } = seed(wp);
    const twin = items.create(wp, { level: 'story', parentId: epic.id, title: 'Pick the greeting voice', assigneeId: 'dev' }, 'asha');
    items.merge(wp, twin.id, story.id, 'owner');
    assert.equal(readTools.readItem(wp, story.id).split('\n')[0]!.includes('Decide the greeting voice'), true);
    assert.match(readTools.readItem(wp, `please review ${story.id} for me`), /Decide the greeting voice/);
    const merged = readTools.readItem(wp, twin.id);
    assert.match(merged, new RegExp(`${twin.id} was merged into ${story.id}`));
    assert.match(merged, /Decide the greeting voice/);
    assert.match(readTools.readItem(wp, 'as_nothinghere1'), /No item as_nothinghere1/);
    const byTitle = readTools.readItem(wp, 'Decide the greeting voice');
    assert.match(byTitle, /No item id in/);
    assert.match(byTitle, new RegExp(story.id), 'a title offers candidates with ids');
  } finally {
    tmp.cleanup();
  }
});

test('item_read stays within ~8 KB: long texts are clipped, oldest comments and activity dropped first', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { story } = seed(wp);
    const long = 'x'.repeat(5000);
    for (let i = 0; i < 60; i++) trail.comment(wp, story.id, { by: 'mira', text: `Comment ${i}: evidence`, details: long });
    for (let i = 0; i < 80; i++) trail.record(wp, { itemId: story.id, by: 'mira', kind: 'note', text: `Note ${i} ${long}` });
    const out = readTools.readItem(wp, story.id);
    assert.ok(out.length <= readTools.MAX_CHARS, `${out.length} chars`);
    assert.ok(!out.includes('x'.repeat(2100)), 'no long text survives whole (details up to 2000)');
    assert.match(out, /Comment 59: evidence/, 'the newest comment is kept');
    assert.ok(!out.includes('Comment 0: evidence'), 'the oldest comment is dropped');
    assert.match(out, /older comments? omitted/);
    assert.match(out, /Decide the greeting voice/, 'the head is always kept');
  } finally {
    tmp.cleanup();
  }
});

test('item_read keeps at most the last 30 activity entries and a short children list', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { story } = seed(wp);
    for (let i = 0; i < 40; i++) trail.record(wp, { itemId: story.id, by: 'mira', kind: 'note', text: `Step ${i}` });
    for (let i = 0; i < 20; i++) items.create(wp, { level: 'task', parentId: story.id, title: `Task number ${i}`, assigneeId: 'mira' }, 'mira');
    const out = readTools.readItem(wp, story.id);
    assert.match(out, /Step 39/);
    assert.ok(!/Step 9\b/.test(out), 'only the last 30 entries');
    assert.match(out, /\+\d+ more/);
  } finally {
    tmp.cleanup();
  }
});

test('inbox_read: one item with its thread, answer and recommendation; never changes it', async () => {
  const fake = installFakeRuntime(); // the owner's reply wakes the asker; never a real session
  const { wp, tmp } = testWorkplace();
  try {
    const { decision } = seed(wp);
    inbox.reply(wp, decision.id, { by: 'owner', text: 'What does Nova sound like?' });
    inbox.reply(wp, decision.id, { by: 'mira', text: 'Warmer, a little slower.' });
    inbox.reply(wp, decision.id, { by: 'owner', text: 'Aria it is.', optionId: 'aria' });
    const before = JSON.stringify(inbox.thread(wp, decision.id));
    const nikhil = await toolsFor(wp, 'nikhil');
    const out = await nikhil.call('inbox_read', { itemId: decision.id });
    assert.match(out, /Which greeting voice\?/);
    assert.match(out, /answered/);
    assert.match(out, /Answer: Aria/);
    assert.match(out, /Aria it is\./);
    assert.match(out, /Recommendation: Aria/);
    assert.match(out, /owner .*What does Nova sound like\?/);
    assert.match(out, /Mira \(mira\) .*Warmer, a little slower\./);
    assert.match(out, /Decide the greeting voice/, 'the linked work item is named');
    assert.equal(JSON.stringify(inbox.thread(wp, decision.id)), before, 'reading changed nothing');
    assert.match(await nikhil.call('inbox_read', { itemId: 'in_nothinghere1' }), /No Inbox item in_nothinghere1/);
    await nikhil.client.close();
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('inbox_read lists open and recently answered items; filters by state; by work item id lists its decisions', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { story, decision } = seed(wp);
    const other = inbox.raise(wp, { kind: 'question', title: 'Ship on Friday?', body: 'Release timing.', raisedBy: 'asha', recommendation: 'yes' });
    inbox.answer(wp, decision.id, 'nova', 'Nova', 'web');
    const dev = await toolsFor(wp, 'dev');
    const list = await dev.call('inbox_read', {});
    assert.match(list, new RegExp(`${other.id}.*open.*Ship on Friday`));
    assert.match(list, new RegExp(`${decision.id}.*answered.*Which greeting voice.*Nova`));
    const open = await dev.call('inbox_read', { state: 'open' });
    assert.ok(!open.includes(decision.id));
    assert.match(open, /Ship on Friday/);
    const linked = await dev.call('inbox_read', { itemId: story.id });
    assert.match(linked, new RegExp(decision.id));
    assert.ok(!linked.includes(other.id));
    assert.equal(inbox.get(wp, other.id)!.state, 'open', 'listing changed nothing');
    await dev.client.close();
  } finally {
    tmp.cleanup();
  }
});

test('both read tools are in the always-allowed list and every session lists them', async () => {
  for (const name of ['item_read', 'inbox_read']) assert.ok((WORKPLACE_TOOLS as readonly string[]).includes(name), name);
  const { wp, tmp } = testWorkplace();
  try {
    const t = await toolsFor(wp, 'dev');
    const names = (await t.client.listTools()).tools.map(x => x.name);
    assert.ok(names.includes('item_read') && names.includes('inbox_read'));
    await t.client.close();
  } finally {
    tmp.cleanup();
  }
});
