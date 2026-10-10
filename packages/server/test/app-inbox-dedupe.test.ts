import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as inbox from '../src/services/inbox.js';
import * as items from '../src/services/items.js';
import { workplaceTools } from '../src/services/employees.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * RCA (owner, 4 Oct: "a question AND a decision asking the same thing"). Live data: five pairs, e.g.
 * in_mutouze546paz (decision, ask_owner) + in_mutov5srivxoj ("Blocked on you", 8 s later). The agent
 * files ask_owner (no link to the work item), then blocks the item on the owner, and trail.ownerBlock
 * raises a second question with a different dedupe key. One thing must reach the owner once.
 * (Rework, Oct 2026: only the Chief of Staff and the CTO ask the owner, so Asha files the asks here.)
 */

type WP = ReturnType<typeof testWorkplace>['wp'];

async function toolsFor(wp: WP, employeeId: string, assignmentId?: string) {
  const server = workplaceTools(wp, employeeId, () => ({ agentId: 'a', employeeId, ...(assignmentId ? { assignmentId } : {}), startedAt: '', seen: {}, planCaptured: false }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(st);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(ct);
  return async (name: string, args: Record<string, unknown>) => JSON.stringify((await client.callTool({ name, arguments: args })).content);
}

function story(wp: WP, assigneeId = 'rohan') {
  const epic = items.create(wp, { level: 'epic', title: 'Windows launch' }, 'owner');
  const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Installer is unsigned', assigneeId }, 'asha');
  items.update(wp, s.id, { status: 'in-progress', reason: 'test: moved' }, assigneeId);
  return s;
}

const ownerOpen = (wp: WP) => inbox.ownerList(wp, 'open').filter(i => i.kind === 'question' || i.kind === 'decision');

test('ask_owner then block on the owner (the live pattern): one Inbox item, the decision, linked to the item', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp } = testWorkplace();
  try {
    const s = story(wp);
    const call = await toolsFor(wp, 'asha', s.id);
    const filed = await call('ask_owner', { title: 'Sign the installer or ship unsigned?', body: 'SmartScreen warns.', options: ['Sign', 'Ship unsigned'], recommendation: 'Ship unsigned' });
    const decisionId = /in_[a-z0-9]+/.exec(filed)![0];
    items.update(wp, s.id, { status: 'blocked', blockedReason: `Decision filed in his Inbox (${decisionId})`, waitingOn: 'owner', recommendation: 'Ship unsigned', reason: 'test: moved' }, 'rohan');
    const open = ownerOpen(wp);
    assert.deepEqual(open.map(i => i.id), [decisionId]);
    assert.equal(open[0]!.context['itemId'], s.id, 'the decision is linked to the item (session assignment)');
  } finally { tmp.cleanup(); fake.restore(); }
});

test('another employee asks (Asha for Kabir) and the block names that Inbox id: still one item', () => {
  const fake = installFakeRuntime();
  const { wp, tmp } = testWorkplace();
  try {
    const s = story(wp, 'kabir');
    const d = inbox.raise(wp, { kind: 'decision', title: 'Approve deploying GET /admin/testers', body: 'Read-only endpoint.', raisedBy: 'asha', recommendation: 'Approve' });
    items.update(wp, s.id, { status: 'blocked', blockedReason: `Deploy approval pending in owner's Inbox (${d.id})`, waitingOn: 'owner', recommendation: 'Approve the deploy', reason: 'test: moved' }, 'kabir');
    assert.deepEqual(ownerOpen(wp).map(i => i.id), [d.id]);
    assert.equal(inbox.get(wp, d.id)!.context['itemId'], s.id, 'the block links the existing decision to the item');
  } finally { tmp.cleanup(); fake.restore(); }
});

test('block first, then ask_owner about the same item: the decision replaces the "Blocked on you" question', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp } = testWorkplace();
  try {
    const s = story(wp);
    items.update(wp, s.id, { status: 'blocked', blockedReason: 'Needs a signing decision', waitingOn: 'owner', recommendation: 'Ship unsigned', reason: 'test: moved' }, 'rohan');
    const q = ownerOpen(wp);
    assert.equal(q.length, 1);
    assert.match(q[0]!.title, /^Blocked on you/);
    const call = await toolsFor(wp, 'asha');
    const filed = await call('ask_owner', { title: 'Sign or ship unsigned?', body: 'Details.', recommendation: 'Ship unsigned', itemId: s.id });
    const decisionId = /in_[a-z0-9]+/.exec(filed)![0];
    assert.deepEqual(ownerOpen(wp).map(i => i.id), [decisionId]);
    assert.equal(inbox.get(wp, q[0]!.id)!.state, 'expired');
    // Unblocking does not withdraw the owner's decision.
    items.update(wp, s.id, { status: 'in-progress', reason: 'test: moved' }, 'rohan');
    assert.equal(inbox.get(wp, decisionId)!.state, 'open');
  } finally { tmp.cleanup(); fake.restore(); }
});

test('a second ask about the same item returns the open one instead of raising another', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp } = testWorkplace();
  try {
    const s = story(wp);
    const call = await toolsFor(wp, 'asha', s.id);
    const first = /in_[a-z0-9]+/.exec(await call('ask_owner', { title: 'Sign it?', body: 'x', recommendation: 'No' }))![0];
    const again = await call('ask_owner', { title: 'Should we sign the installer?', body: 'y', recommendation: 'No' });
    assert.match(again, new RegExp(`Not filed: ${first} is already in the owner.s Inbox`));
    assert.equal(ownerOpen(wp).length, 1);
    // A raise from any other path with the same item (a COO forward) also reuses it.
    const forwarded = inbox.raise(wp, { kind: 'decision', title: 'Sign?', body: 'z', raisedBy: 'rohan', context: { itemId: s.id } });
    assert.equal(forwarded.id, first);
  } finally { tmp.cleanup(); fake.restore(); }
});

test('asks about different items, and routine items, are untouched', () => {
  const fake = installFakeRuntime();
  const { wp, tmp } = testWorkplace();
  try {
    const a = story(wp);
    const b = story(wp);
    inbox.raise(wp, { kind: 'decision', title: 'A?', body: 'a', raisedBy: 'rohan', context: { itemId: a.id } });
    inbox.raise(wp, { kind: 'decision', title: 'B?', body: 'b', raisedBy: 'rohan', context: { itemId: b.id } });
    inbox.raise(wp, { kind: 'question', title: 'Review requested', body: 'c', raisedBy: 'rohan', context: { itemId: a.id }, ownerFacing: false });
    assert.equal(ownerOpen(wp).length, 2);
    assert.equal(inbox.list(wp, 'open').length, 3);
  } finally { tmp.cleanup(); fake.restore(); }
});

test('cleanup of duplicates raised before the fix: the live pairs are found, the decision is kept', () => {
  const base = { state: 'open', options: [], affects: [], onApprove: '', onDeny: '', createdAt: '2026-10-04T10:39:15Z', summary: '' };
  const live = [
    { ...base, id: 'in_mutouze546paz', kind: 'decision', title: 'Windows installer unsigned', body: 'Sign or not', raisedBy: 'rohan', context: {} },
    { ...base, id: 'in_mutov5srivxoj', kind: 'question', title: 'Blocked on you: installer', body: 'filed in his Inbox (in_mutouze546paz) with recommendation.', raisedBy: 'rohan', context: { itemId: 'as_mutnd9d62koh4', dedupeKey: 'blocked:as_mutnd9d62koh4' } },
    { ...base, id: 'in_other00001', kind: 'question', title: 'Blocked on you: other', body: 'needs you', raisedBy: 'dev', context: { itemId: 'as_x', dedupeKey: 'blocked:as_x' } },
  ] as unknown as Parameters<typeof inbox.duplicateAsks>[0];
  assert.deepEqual(inbox.duplicateAsks(live), [{ keep: 'in_mutouze546paz', drop: 'in_mutov5srivxoj', itemId: 'as_mutnd9d62koh4' }]);
});
