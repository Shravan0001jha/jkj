import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InboxItem, InboxThread } from '@jkj/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as inbox from '../src/services/inbox.js';
import * as items from '../src/services/items.js';
import * as room from '../src/services/room.js';
import * as coo from '../src/services/coo.js';
import { workplaceTools } from '../src/services/employees.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';
import { boot, call } from './fakes/boot.js';

/**
 * QA, 2 Oct (Android): GET /api/inbox and GET /api/inbox/:id never carried messageCount, urgency or a
 * recommended option, though the v2 contract (LLD §19.5) defines them. They are now always set:
 * messageCount (0 when no reply), urgency from the kind and the level of the work it is about, and the
 * raiser's recommendation marked on its option. The raising tools require a recommendation.
 */

async function toolsFor(wp: ReturnType<typeof testWorkplace>['wp'], employeeId: string, assignmentId?: string) {
  const server = workplaceTools(wp, employeeId, () => ({ agentId: 'a', employeeId, ...(assignmentId ? { assignmentId } : {}), startedAt: '', seen: {}, planCaptured: false }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(st);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(ct);
  return async (name: string, args: Record<string, unknown>) => JSON.stringify((await client.callTool({ name, arguments: args })).content);
}

test('GET /api/inbox and /api/inbox/:id carry messageCount, urgency and the recommended option', async () => {
  const srv = await boot();
  try {
    const wp = srv.running.wp;
    const plain = inbox.raise(wp, { kind: 'decision', title: 'Which TTS voice ships?', body: 'Two candidates.', raisedBy: 'mira', options: [{ id: 'aria', label: 'Aria' }, { id: 'nova', label: 'Nova' }], recommendation: 'Nova' });
    const cap = inbox.raise(wp, { kind: 'cap', title: 'Daily cap reached', body: 'Real money hit the cap.', raisedBy: 'workplace', recommendation: 'keep' });
    inbox.reply(wp, plain.id, { by: 'owner', text: 'Why Nova?' });

    const list = (await call<InboxItem[]>(srv.base, 'GET', '/api/inbox')).body;
    const p = list.find(i => i.id === plain.id)!;
    assert.equal(p.messageCount, 1);
    assert.ok(p.lastMessageAt);
    assert.equal(p.urgency, 'normal');
    assert.deepEqual(p.options.map(o => [o.id, o.recommended ?? false]), [['aria', false], ['nova', true]]);
    const c = list.find(i => i.id === cap.id)!;
    assert.equal(c.messageCount, 0, 'present, and 0, with no replies');
    assert.equal(c.urgency, 'urgent', 'a cap stops work: urgent');
    assert.equal(c.options.find(o => o.id === 'keep')!.recommended, true);

    const t = (await call<InboxThread>(srv.base, 'GET', `/api/inbox/${cap.id}`)).body;
    assert.equal(t.item.messageCount, 0);
    assert.equal(t.item.urgency, 'urgent');
    assert.equal(t.item.options.find(o => o.id === 'keep')!.recommended, true);
  } finally {
    await srv.stop();
  }
});

test('urgency follows the kind and the level: cap urgent; approval and release high; blocked on you high for a story', () => {
  const { wp, tmp } = testWorkplace();
  try {
    assert.equal(inbox.raise(wp, { kind: 'approval', title: 'Run npm publish?', body: 'x', raisedBy: 'dev' }).urgency, 'high');
    assert.equal(inbox.raise(wp, { kind: 'release', title: 'Ship 0.2.16?', body: 'x', raisedBy: 'nikhil' }).urgency, 'high');
    assert.equal(inbox.raise(wp, { kind: 'org-change', title: 'Hire a designer?', body: 'x', raisedBy: 'asha' }).urgency, 'normal');
    assert.equal(inbox.raise(wp, { kind: 'decision', title: 'Pick one', body: 'x', raisedBy: 'asha', urgency: 'urgent' }).urgency, 'urgent', 'a raiser\'s own urgency wins');

    const epic = items.create(wp, { level: 'epic', title: 'Iris during music' }, 'owner');
    const story = items.create(wp, { level: 'story', parentId: epic.id, title: 'Mic stays live', assigneeId: 'dev' }, 'asha');
    items.update(wp, story.id, { status: 'in-progress', reason: 'test: moved' }, 'dev');
    items.update(wp, story.id, { status: 'blocked', blockedReason: 'which TTS voice?', waitingOn: 'owner', recommendation: 'Keep Aria', reason: 'test: moved' }, 'dev');
    const q = inbox.ownerList(wp, 'open').find(i => i.context['itemId'] === story.id)!;
    assert.equal(q.urgency, 'high', 'a story waits on the owner');
    assert.equal(q.context['recommendation'], 'Keep Aria');

    // An item raised before urgency existed reads with it.
    const legacy = inbox.raise(wp, { kind: 'cap', title: 'Old cap', body: 'x', raisedBy: 'workplace' });
    const { urgency: _u, ...bare } = legacy;
    wp.db.prepare('update inbox set json = ? where id = ?').run(JSON.stringify(bare), legacy.id);
    assert.equal(inbox.get(wp, legacy.id)!.urgency, 'urgent');
  } finally {
    tmp.cleanup();
  }
});

test('a recommendation that names no option is kept on the item and shown in its body', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const q = inbox.raise(wp, { kind: 'question', title: 'Which port for the relay?', body: 'Two are free.', raisedBy: 'rohan', recommendation: 'Use 8443; 443 is taken by the proxy.' });
    assert.equal(q.context['recommendation'], 'Use 8443; 443 is taken by the proxy.');
    assert.match(q.body, /Recommendation: Use 8443/);
    assert.ok(!q.options.some(o => o.recommended));
  } finally {
    tmp.cleanup();
  }
});

test('ask_owner and escalate require a recommendation and pass it through to the option', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp } = testWorkplace();
  try {
    // Rework (Oct 2026): only the Chief of Staff and the CTO ask the owner; a lead goes up the chain.
    const mira = await toolsFor(wp, 'mira');
    assert.match(await mira('ask_owner', { title: 'Which TTS voice ships?', body: 'Two candidates.', options: ['Aria', 'Nova'], recommendation: 'Nova' }), /Ask your manager/);
    const cos = await toolsFor(wp, 'asha');
    assert.match(await cos('ask_owner', { title: 'Which TTS voice ships?', body: 'Two candidates.', options: ['Aria', 'Nova'] }), /recommendation/i, 'refused without one');
    assert.match(await cos('ask_owner', { title: 'Which TTS voice ships?', body: 'Two candidates.', options: ['Aria', 'Nova'], recommendation: 'Nova' }), /Filed as/);
    const asked = inbox.ownerList(wp, 'open').find(i => i.title === 'Which TTS voice ships?')!;
    assert.equal(asked.options.find(o => o.label === 'Nova')!.recommended, true);

    const thread = room.createThread(wp, { title: 'Who owns app.py?', text: 'x', by: 'asha' }).thread;
    const asha = await toolsFor(wp, 'asha');
    assert.match(await asha('escalate', { threadId: thread.id, title: 'Who owns app.py?', body: 'Three owners.', options: ['experts', 'character'] }), /recommendation/i);
    assert.match(await asha('escalate', { threadId: thread.id, title: 'Who owns app.py?', body: 'Three owners.', options: ['experts', 'character'], recommendation: 'experts' }), /Escalated/);
    // The COO is offline: it falls back to the owner's Inbox with the recommendation marked.
    const fell = inbox.ownerList(wp, 'open').find(i => i.title === 'Who owns app.py?')!;
    assert.equal(fell.options.find(o => o.id === 'experts')!.recommended, true);
    assert.equal(coo.listItems(wp).find(i => i.title === 'Who owns app.py?')!.options.find(o => o.id === 'experts')!.recommended, true);

    // Blocked on the owner, from an agent: a recommendation is required too.
    const epic = items.create(wp, { level: 'epic', title: 'E' }, 'owner');
    const story = items.create(wp, { level: 'story', parentId: epic.id, title: 'S', assigneeId: 'dev' }, 'asha');
    items.update(wp, story.id, { status: 'in-progress', reason: 'test: moved' }, 'dev');
    const dev = await toolsFor(wp, 'dev', story.id);
    assert.match(await dev('item_update', { itemId: story.id, status: 'blocked', blockedReason: 'which voice?', waitingOn: 'owner' }), /recommendation/i);
    assert.match(await dev('flag_stall', { reason: 'which voice?', waitingOn: 'owner' }), /recommendation/i);
    assert.match(await dev('item_update', { itemId: story.id, status: 'blocked', blockedReason: 'which voice?', waitingOn: 'owner', recommendation: 'Aria' }), /blocked/);
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});
