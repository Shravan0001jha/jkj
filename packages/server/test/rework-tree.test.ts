import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as items from '../src/services/items.js';
import * as trail from '../src/services/trail.js';
import * as inbox from '../src/services/inbox.js';
import * as coo from '../src/services/coo.js';
import { workplaceTools } from '../src/services/employees.js';
import { ancestors, isAbove, leadOfCharter, managerOf, subtree, teamMembers, teamOf } from '../src/services/org.js';
import { rawGet } from '../src/services/v2-map.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace, withTree } from './fakes/workplace.js';

/** W1 of the October 2026 rework (docs/TDD-rework-2026-10.md): the org tree, the item model, the audit. */

type Wp = ReturnType<typeof testWorkplace>['wp'];

function treeWorkplace() {
  const t = testWorkplace();
  withTree(t.wp);
  return t;
}

function story(wp: Wp, assigneeId: string, title = 'Greeting context contract'): string {
  const epic = items.create(wp, { level: 'epic', title: `Epic for ${title}` }, 'owner');
  return items.create(wp, { level: 'story', parentId: epic.id, title, assigneeId }, 'owner').id;
}

async function toolsFor(wp: Wp, employeeId: string, assignmentId?: string) {
  const server = workplaceTools(wp, employeeId, () => ({ agentId: 'a', employeeId, ...(assignmentId ? { assignmentId } : {}), startedAt: '', seen: {}, planCaptured: false }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(st);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => JSON.stringify((await client.callTool({ name, arguments: args })).content);
  return { client, call };
}

const FORBIDDEN = /Forbidden: only Arjun or someone above them can change this story/;
const NO_REASON = /give a reason for this change/;

/* ---------- tree helpers (1–4) ---------- */

test('tree helpers: isAbove, teamOf, leadOfCharter, subtree, managerOf', () => {
  const { wp, tmp } = treeWorkplace();
  try {
    const org = wp.org;
    assert.equal(isAbove(org, 'asha', 'dev'), true, 'Asha is above a lead');
    assert.equal(isAbove(org, 'asha', 'arjun'), true, 'Asha is above an engineer');
    assert.equal(isAbove(org, 'asha', 'cto'), false, 'the CTO is a peer of Asha, not under her');
    assert.equal(isAbove(org, 'dev', 'ira'), false, 'a lead is not above another team');
    assert.equal(isAbove(org, 'coo', 'cto'), true);
    assert.equal(isAbove(org, 'owner', 'coo'), true, 'the owner is above everyone');
    assert.equal(isAbove(org, 'arjun', 'arjun'), false);
    assert.equal(teamOf(org, 'arjun'), 'dev');
    assert.equal(teamOf(org, 'dev'), 'dev', 'a lead is their own team');
    assert.equal(teamOf(org, 'zoya'), 'nikhil', 'a QA member (role qa) is in the QA lead\'s team');
    assert.equal(teamOf(org, 'aditi'), 'nikhil');
    assert.equal(teamOf(org, 'nikhil'), 'nikhil', 'the QA lead heads a team');
    assert.deepEqual(teamMembers(org, 'nikhil').sort(), ['aditi', 'nikhil', 'zoya']);
    assert.equal(leadOfCharter(org, 'conversation'), 'dev');
    assert.equal(leadOfCharter(org, 'experts'), 'mira');
    assert.equal(managerOf(org, 'arjun'), 'dev');
    assert.equal(managerOf(org, 'asha'), 'coo');
    assert.deepEqual(ancestors(org, 'arjun'), ['dev', 'asha', 'coo']);
    assert.deepEqual(subtree(org, 'dev').sort(), ['arjun', 'sameer']);
    assert.ok(subtree(org, 'asha').includes('ira') && !subtree(org, 'asha').includes('cto'));
    assert.deepEqual(teamMembers(org, 'dev').sort(), ['arjun', 'dev', 'sameer']);
  } finally { tmp.cleanup(); }
});

/* ---------- who can change a story (5–9) ---------- */

test('who can change a story: the assignee and anyone above them, nobody else', () => {
  const { wp, tmp } = treeWorkplace();
  try {
    const id = story(wp, 'arjun');
    assert.equal(items.update(wp, id, { status: 'in-progress', reason: 'starting the build' }, 'arjun').status, 'in-progress', 'own story, with a reason');
    assert.throws(() => items.update(wp, id, { status: 'ready', reason: 'not his' }, 'sameer'), FORBIDDEN, 'a different engineer');
    assert.throws(() => items.update(wp, id, { points: 3 }, 'sameer'), FORBIDDEN, 'any field change, not only status');
    assert.equal(items.update(wp, id, { status: 'ready', reason: 'back in the queue for now' }, 'dev').status, 'ready', 'their lead');
    assert.equal(items.update(wp, id, { status: 'backlog', reason: 'not this week' }, 'asha').status, 'backlog', 'Asha');
    const cto = story(wp, 'cto', 'Architecture review');
    assert.throws(() => items.update(wp, cto, { status: 'backlog', reason: 'not now' }, 'asha'), /Forbidden: only Vikram or someone above them can change this story/, 'Asha cannot move the CTO\'s story');
    assert.equal(items.update(wp, cto, { status: 'backlog', reason: 'not now' }, 'coo').status, 'backlog', 'the COO can');
  } finally { tmp.cleanup(); }
});

test('the current reviewer may send back or pass a story in review', () => {
  const { wp, tmp } = treeWorkplace();
  try {
    const id = story(wp, 'arjun');
    items.update(wp, id, { status: 'in-progress', reason: 'starting' }, 'arjun');
    items.update(wp, id, { status: 'in-review', reviewerId: 'ira', reason: 'built, please review' }, 'arjun');
    assert.equal(items.update(wp, id, { status: 'in-progress', reason: 'missing the empty case' }, 'ira').status, 'in-progress');
  } finally { tmp.cleanup(); }
});

/* ---------- reasons (10–11) ---------- */

test('reasons: a status or assignee change without one is refused; the Workplace itself is exempt', () => {
  const { wp, tmp } = treeWorkplace();
  try {
    const id = story(wp, 'arjun');
    assert.throws(() => items.update(wp, id, { status: 'in-progress' }, 'arjun'), NO_REASON);
    assert.throws(() => items.update(wp, id, { status: 'in-progress', reason: 'ok' }, 'arjun'), NO_REASON, 'at least 3 characters');
    assert.throws(() => items.update(wp, id, { assigneeId: 'sameer' }, 'dev'), NO_REASON);
    assert.throws(() => items.update(wp, id, { status: 'in-progress' }, 'owner'), NO_REASON, 'the owner gives reasons too');
    assert.equal(items.update(wp, id, { status: 'in-progress', note: 'note is the alias' }, 'arjun').status, 'in-progress');
    assert.equal(items.update(wp, id, { status: 'ready' }, 'workplace').status, 'ready', 'workplace is exempt');
    assert.equal(items.update(wp, id, { points: 2 }, 'arjun').points, 2, 'a field change needs no reason');
  } finally { tmp.cleanup(); }
});

/* ---------- who can reassign (12–14) ---------- */

test('who can reassign: within your subtree or up to your manager; Asha routes to leads only', () => {
  const { wp, tmp } = treeWorkplace();
  try {
    const id = story(wp, 'arjun');
    assert.equal(items.update(wp, id, { assigneeId: 'sameer', reason: 'Sameer knows this code' }, 'dev').assigneeId, 'sameer', 'a lead to their own engineer');
    assert.equal(items.update(wp, id, { assigneeId: 'asha', reason: 'needs routing elsewhere' }, 'dev').assigneeId, 'asha', 'a lead to their manager');
    const other = story(wp, 'arjun', 'Second story');
    assert.throws(() => items.update(wp, other, { assigneeId: 'ira', reason: 'Ira is free' }, 'dev'), /Forbidden/, 'a lead to another team');
    assert.throws(() => items.update(wp, other, { assigneeId: 'ira', reason: 'Ira is free' }, 'asha'), /route to the charter lead; the lead assigns within the team/, 'Asha to another team\'s engineer (within one team she may move it: dry run #16)');
    assert.equal(items.update(wp, other, { assigneeId: 'mira', reason: 'it is an experts story' }, 'asha').assigneeId, 'mira', 'Asha to a lead');
    assert.throws(() => items.update(wp, other, { assigneeId: 'zoya', reason: 'QA it' }, 'asha'), /route to the charter lead/, 'Asha to a QA member (role qa under the QA lead)');
    assert.equal(items.update(wp, other, { assigneeId: 'nikhil', reason: 'QA first' }, 'asha').assigneeId, 'nikhil', 'Asha to the QA lead');
    assert.throws(() => items.update(wp, other, { assigneeId: 'sameer', reason: 'help' }, 'arjun'), /Forbidden/, 'an engineer to a peer');
  } finally { tmp.cleanup(); }
});

/* ---------- waiting and parked (15–18) ---------- */

test('a wait on a teammate tells them, once per new wait (17 Oct: a doc sat Waiting on Asha 5 h after she had finished)', () => {
  const { wp, tmp } = treeWorkplace();
  try {
    const id = story(wp, 'arjun');
    items.update(wp, id, { status: 'in-progress', reason: 'starting' }, 'arjun');
    items.update(wp, id, { status: 'waiting', waitingOn: 'sameer', reason: 'needs his schema change merged' }, 'arjun');
    const told = trail.comments(wp, id).filter(c => (c.mentions ?? []).includes('sameer'));
    assert.equal(told.length, 1, 'the teammate waited on is @mentioned');
    assert.match(told[0]!.text, /needs his schema change merged/);
    // Same wait, reason reworded: no second ping.
    items.update(wp, id, { status: 'waiting', waitingOn: 'sameer', reason: 'still needs the schema change' }, 'arjun');
    assert.equal(trail.comments(wp, id).filter(c => (c.mentions ?? []).includes('sameer')).length, 1);
    // A wait on the COO reaches the COO's queue.
    const c = story(wp, 'arjun', 'Coo one');
    items.update(wp, c, { status: 'in-progress', reason: 'starting' }, 'arjun');
    items.update(wp, c, { status: 'waiting', waitingOn: 'coo', reason: 'needs a staging deploy' }, 'arjun');
    assert.ok(coo.listItems(wp).some(x => x.kind === 'stall' && /needs a staging deploy/.test(x.body)), 'the COO is told');
    // A wait on the owner goes to his Inbox, not a mention.
    const o = story(wp, 'arjun', 'Owner one');
    items.update(wp, o, { status: 'in-progress', reason: 'starting' }, 'arjun');
    items.update(wp, o, { status: 'waiting', waitingOn: 'owner', reason: 'his call on scope', recommendation: 'ship the small one' }, 'arjun');
    assert.equal(trail.comments(wp, o).filter(c => (c.mentions ?? []).length).length, 0);
  } finally { tmp.cleanup(); }
});

test('waiting on a teammate stays waiting without kind; a legacy block on a person maps to waiting', () => {
  const { wp, tmp } = treeWorkplace();
  try {
    const id = story(wp, 'arjun');
    items.update(wp, id, { status: 'in-progress', reason: 'starting' }, 'arjun');
    const w = items.update(wp, id, { status: 'waiting', waitingOn: 'sameer', reason: 'needs his schema change merged' }, 'arjun');
    assert.equal(w.status, 'waiting');
    assert.equal(w.assigneeId, 'arjun', 'not handed over');
    assert.equal(w.waiting?.on, 'sameer');
    assert.equal(w.waiting?.reason, 'needs his schema change merged');
    assert.equal(w.trueStatus, 'waiting');
    assert.throws(() => items.update(wp, story(wp, 'arjun', 'No one'), { status: 'waiting', reason: 'waiting on something' }, 'arjun'), /set waitingOn/);
    assert.throws(() => items.update(wp, story(wp, 'arjun', 'Bad one'), { status: 'waiting', waitingOn: 'nobody-here', reason: 'waiting on them' }, 'arjun'), /who it waits on/);

    const legacy = story(wp, 'arjun', 'Legacy block');
    const l = items.update(wp, legacy, { status: 'blocked', waitingOn: 'ira', blockedReason: 'Ira owns the expert registry change' }, 'arjun');
    assert.equal(l.status, 'waiting', 'a person in waitingOn is a wait, not a block');
    assert.equal(l.waiting?.on, 'ira');
    assert.equal(l.assigneeId, 'arjun');

    const external = story(wp, 'arjun', 'External block');
    assert.equal(items.update(wp, external, { status: 'blocked', waitingOn: 'external', blockedReason: 'Apple review' }, 'arjun').status, 'blocked');

    // With kind, the explicit rewrite still happens.
    const handed = story(wp, 'arjun', 'Handed over');
    const h = items.update(wp, handed, { status: 'blocked', waitingOn: 'sameer', blockedReason: 'his part first', kind: 'work' }, 'arjun');
    assert.equal(h.assigneeId, 'sameer');
    assert.equal(h.handoff?.fromId, 'arjun');

    // From waiting back to work.
    assert.equal(items.update(wp, id, { status: 'in-progress', reason: 'Sameer merged it' }, 'arjun').status, 'in-progress');
    assert.equal(rawGet(wp, id)!.waiting, undefined, 'leaving waiting clears it');
  } finally { tmp.cleanup(); }
});

test('waiting on the owner needs a recommendation and raises his Inbox item', () => {
  const { wp, tmp } = treeWorkplace();
  try {
    const id = story(wp, 'arjun');
    assert.throws(() => items.update(wp, id, { status: 'waiting', waitingOn: 'owner', reason: 'which voice ships?' }, 'arjun'), /recommendation/);
    items.update(wp, id, { status: 'waiting', waitingOn: 'owner', reason: 'which voice ships?', recommendation: 'Nova' }, 'arjun');
    assert.ok(inbox.list(wp, 'open').some(i => i.context['itemId'] === id), 'the owner is asked');
  } finally { tmp.cleanup(); }
});

test('parked needs a reason and resumeWhen, and goes back to ready', () => {
  const { wp, tmp } = treeWorkplace();
  try {
    const id = story(wp, 'arjun');
    assert.throws(() => items.update(wp, id, { status: 'parked', reason: 'budget this week' }, 'dev'), /resumeWhen/);
    const p = items.update(wp, id, { status: 'parked', reason: 'budget this week', resumeWhen: 'after the 0.2.22 release' }, 'dev');
    assert.equal(p.status, 'parked');
    assert.equal(p.trueStatus, 'parked');
    assert.deepEqual({ ...p.parked, since: undefined }, { reason: 'budget this week', resumeWhen: 'after the 0.2.22 release', by: 'dev', since: undefined });
    assert.equal(items.update(wp, id, { status: 'ready', reason: 'released, resuming' }, 'dev').status, 'ready');
    assert.equal(rawGet(wp, id)!.parked, undefined);
    items.update(wp, id, { status: 'parked', reason: 'budget again', resumeWhen: 'later' }, 'dev');
    assert.throws(() => items.update(wp, id, { status: 'in-review', reviewerId: 'sameer', reason: 'skip ahead' }, 'dev'), /cannot go from parked to in-review/);
  } finally { tmp.cleanup(); }
});

test('a new hold parks the item; hold false lifts it back to backlog', () => {
  const { wp, tmp } = treeWorkplace();
  try {
    const id = story(wp, 'arjun');
    const p = items.update(wp, id, { hold: true, note: 'parked for budget' }, 'asha');
    assert.equal(p.status, 'parked');
    assert.equal(p.parked?.reason, 'parked for budget');
    assert.ok(p.parked?.resumeWhen);
    const lifted = items.update(wp, id, { hold: false, note: 'budget is back' }, 'asha');
    assert.equal(lifted.status, 'backlog');
  } finally { tmp.cleanup(); }
});

/* ---------- audit, chain, charter (19–22) ---------- */

test('audit on a migrated-style item: created by, assigned to, and a status with no recorded reason', () => {
  const { wp, tmp } = treeWorkplace();
  try {
    const id = story(wp, 'arjun');
    // Old rows: the auto-generated texts, as the live store has them.
    trail.record(wp, { itemId: id, by: 'asha', kind: 'assigned', from: 'arjun', to: 'sameer', text: 'Assigned to Sameer' });
    trail.record(wp, { itemId: id, by: 'sameer', kind: 'status', from: 'ready', to: 'in-progress', text: 'ready → in-progress' });
    const audit = items.audit(wp, id);
    assert.deepEqual(audit.map(a => a.kind), ['created', 'assigned', 'status']);
    assert.equal(audit[0]!.by, 'owner');
    assert.equal(audit[0]!.to, 'arjun', 'created, assigned to');
    assert.equal(audit[0]!.reason, undefined);
    assert.equal(audit[1]!.to, 'sameer');
    assert.equal(audit[1]!.reason, undefined, 'an auto-generated text is not a reason');
    assert.deepEqual([audit[2]!.from, audit[2]!.to, audit[2]!.reason], ['ready', 'in-progress', undefined]);
  } finally { tmp.cleanup(); }
});

test('audit: a new status or assign row carries its reason; reopen, reviewer and parked rows are kept', () => {
  const { wp, tmp } = treeWorkplace();
  try {
    const id = story(wp, 'arjun');
    items.update(wp, id, { status: 'in-progress', reason: 'starting the build' }, 'arjun');
    items.update(wp, id, { assigneeId: 'sameer', reason: 'Sameer knows this code' }, 'dev');
    items.update(wp, id, { reviewerId: 'dev' }, 'sameer');
    items.update(wp, id, { status: 'parked', reason: 'budget', resumeWhen: 'Monday' }, 'dev');
    const audit = items.audit(wp, id);
    const status = audit.find(a => a.kind === 'status')!;
    assert.deepEqual([status.by, status.from, status.to, status.reason], ['arjun', 'ready', 'in-progress', 'starting the build']);
    const assigned = audit.find(a => a.kind === 'assigned')!;
    assert.deepEqual([assigned.by, assigned.from, assigned.to, assigned.reason], ['dev', 'arjun', 'sameer', 'Sameer knows this code']);
    assert.equal(audit.find(a => a.kind === 'reviewer')?.to, 'dev');
    const parked = audit.find(a => a.kind === 'parked')!;
    assert.equal(parked.reason, 'budget');
    const detail = items.detail(wp, id);
    assert.deepEqual(detail.audit, audit, 'GET /api/items/:id carries the audit');
    assert.ok(detail.chain, 'and the chain');
  } finally { tmp.cleanup(); }
});

test('chain: developer, lead, chief of staff, CTO and charter', () => {
  const { wp, tmp } = treeWorkplace();
  try {
    const id = story(wp, 'arjun');
    const c = items.chain(wp, rawGet(wp, id)!);
    assert.equal(c.developer, 'arjun');
    assert.equal(c.lead, 'dev');
    assert.equal(c.chiefOfStaff, 'asha');
    assert.equal(c.cto, 'cto');
    assert.equal(c.charterId, 'conversation');
    assert.equal(c.charterTitle, wp.org.charters.get('conversation')!.title);
    assert.equal(c.devReviewer, 'dev', 'an engineer\'s developer approver is their lead');
    assert.deepEqual(c.extraReviewers, []);
    const pr = { number: 7, url: 'u', branch: 'b', base: 'main', headSha: 'h', pushedAt: 'now', evidence: 'pending' as const, devReviewer: 'sameer', qaReviewer: 'zoya', extraReviewers: [{ id: 'mira', files: ['a.ts'] }] };
    const withPr = items.chain(wp, { ...rawGet(wp, id)!, pr });
    assert.deepEqual([withPr.devReviewer, withPr.qa, withPr.extraReviewers], ['sameer', 'zoya', ['mira']]);
    const leadStory = items.chain(wp, rawGet(wp, story(wp, 'dev', 'Lead story'))!);
    assert.ok(leadStory.devReviewer && ['arjun', 'sameer'].includes(leadStory.devReviewer), 'a lead\'s approver is a team member');
  } finally { tmp.cleanup(); }
});

test('reassigning keeps the charter an item already has', () => {
  const { wp, tmp } = treeWorkplace();
  try {
    const id = story(wp, 'ira');
    assert.equal(rawGet(wp, id)!.charterId, 'experts');
    items.update(wp, id, { assigneeId: 'asha', reason: 'misrouted; Asha re-routes it' }, 'mira');
    assert.equal(rawGet(wp, id)!.charterId, 'experts', 'a misroute leaves the charter alone');
  } finally { tmp.cleanup(); }
});

/* ---------- creating items (23–24) ---------- */

test('item_create: an engineer\'s bug goes to the QA lead, a story to their manager', async () => {
  const { wp, tmp } = treeWorkplace();
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Wake word' }, 'owner');
    const arjun = await toolsFor(wp, 'arjun');
    const bug = await arjun.call('item_create', { level: 'story', parentId: epic.id, type: 'bug', title: 'Wake word misses Indian English' });
    const bugId = /Created (as_\w+)/.exec(bug)![1]!;
    assert.equal(rawGet(wp, bugId)!.employeeId, 'nikhil', 'a bug goes to the QA lead first');
    assert.equal(rawGet(wp, bugId)!.type, 'bug');
    const s = await arjun.call('item_create', { level: 'story', parentId: epic.id, title: 'Add a wake word metric', assigneeId: 'sameer' });
    const storyId = /Created (as_\w+)/.exec(s)![1]!;
    const row = rawGet(wp, storyId)!;
    assert.equal(row.employeeId, 'dev', 'a story filed by an engineer goes to their manager');
    assert.equal(row.status, 'ready');
    assert.equal(items.audit(wp, storyId)[0]!.reason, 'filed by Arjun');
    const rca = await arjun.call('item_create', { level: 'story', parentId: epic.id, type: 'rca', title: 'Why the wake word regressed' });
    assert.match(rca, /Created as_/);
    assert.match(await arjun.call('item_create', { level: 'epic', title: 'Mine' }), /Only the Chief of Staff creates epics/);
    await arjun.client.close();
  } finally { tmp.cleanup(); }
});

test('a bug filed with its five-part RCA skips QA: Asha routes it by charter, QA gets an escape-review ticket (owner, 11 Oct)', () => {
  const { wp, tmp } = treeWorkplace();
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Security' }, 'owner');
    const rca = '## RCA\nSymptom: the STT relay meters zero for a bad sample_rate\nRoot cause: float() throws before _meter\nWhy it escaped: no test sends a malformed rate\nFix: validate the rate before accept\nRegression: a test with sample_rate=16000%26model=x';
    const bug = items.create(wp, { level: 'story', parentId: epic.id, type: 'bug', title: 'STT meter bypass', body: `From the security review.\n\n${rca}` }, 'cto');
    const row = rawGet(wp, bug.id)!;
    assert.equal(row.employeeId, undefined, 'not sent to QA: unassigned, so Asha routes it by charter');
    assert.ok(row.rca, 'the RCA is recorded, so code is unlocked for whoever gets it');
    const escape = items.list(wp, { parentId: epic.id }).find(c => c.id !== bug.id);
    assert.ok(escape, 'a QA escape-review ticket is filed beside it');
    const e = rawGet(wp, escape!.id)!;
    assert.equal(e.type, 'rca');
    assert.equal(e.employeeId, 'nikhil', 'the escape review goes to the QA lead');
    assert.match(e.title, /STT meter bypass/);

    const partial = items.create(wp, { level: 'story', parentId: epic.id, type: 'bug', title: 'Half an RCA', body: '## RCA\nSymptom: x\nRoot cause: y' }, 'cto');
    assert.equal(rawGet(wp, partial.id)!.employeeId, 'nikhil', 'an incomplete RCA still goes to QA first');
    assert.equal(rawGet(wp, partial.id)!.rca, undefined);
  } finally { tmp.cleanup(); }
});

test('item_update takes reason, waitingOn, resumeWhen and the new statuses', async () => {
  const { wp, tmp } = treeWorkplace();
  try {
    const id = story(wp, 'arjun');
    const arjun = await toolsFor(wp, 'arjun', id);
    assert.match(await arjun.call('item_update', { itemId: id, status: 'in-progress' }), /give a reason/);
    assert.match(await arjun.call('item_update', { itemId: id, status: 'in-progress', reason: 'starting' }), /in-progress/);
    assert.match(await arjun.call('item_update', { itemId: id, status: 'waiting', waitingOn: 'sameer', reason: 'his schema first' }), /waiting/);
    assert.match(await arjun.call('item_update', { itemId: id, status: 'parked', reason: 'budget', resumeWhen: 'Monday' }), /cannot go from waiting to parked/);
    assert.match(await arjun.call('item_update', { itemId: id, status: 'in-progress', reason: 'schema landed' }), /in-progress/);
    const dev = await toolsFor(wp, 'dev');
    assert.match(await dev.call('item_update', { itemId: id, status: 'parked', reason: 'budget', resumeWhen: 'Monday' }), /parked/);
    assert.match(await dev.call('item_update', { itemId: id, assigneeId: 'sameer', reason: 'Sameer is free' }), /parked/);
    assert.equal(rawGet(wp, id)!.employeeId, 'sameer', 'a lead reassigns within the team with the tool');
    await arjun.client.close(); await dev.client.close();
  } finally { tmp.cleanup(); }
});

/* ---------- escalate and ask_owner (25–26) ---------- */

test('escalate from an engineer messages their manager and records a comment', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp } = treeWorkplace();
  try {
    const id = story(wp, 'arjun');
    const arjun = await toolsFor(wp, 'arjun', id);
    const out = await arjun.call('escalate', { itemId: id, title: 'Need a decision', body: 'Two schemas conflict; which wins?', recommendation: 'Keep v2' });
    assert.match(out, /Escalated to Dev/);
    await new Promise(r => setTimeout(r, 20));
    const s = fake.last();
    assert.match(s.options.prompt, /Two schemas conflict; which wins\?/);
    assert.match(s.options.prompt, new RegExp(id));
    assert.ok(trail.comments(wp, id).some(c => c.by === 'arjun' && /Escalated to Dev/.test(c.text)), 'a comment on the item');
    await arjun.client.close();
  } finally { fake.restore(); tmp.cleanup(); }
});

test('ask_owner: refused for an engineer, allowed for Asha', async () => {
  const { wp, tmp } = treeWorkplace();
  try {
    const arjun = await toolsFor(wp, 'arjun');
    assert.match(await arjun.call('ask_owner', { title: 'Which voice?', body: 'Two voices', recommendation: 'Nova' }), /Ask your manager: owner decisions go up the chain \(escalate\)\./);
    const asha = await toolsFor(wp, 'asha');
    assert.match(await asha.call('ask_owner', { title: 'Which voice?', body: 'Two voices', recommendation: 'Nova' }), /Filed as/);
    await arjun.client.close(); await asha.client.close();
  } finally { tmp.cleanup(); }
});

test('a story\'s type: owner, COO, Chief of Staff or QA can mark it a bug or an RCA ticket; nobody else', () => {
  const { wp, tmp } = treeWorkplace();
  try {
  const id = story(wp, 'arjun');
  assert.throws(() => items.update(wp, id, { type: 'bug' }, 'arjun'), /only the owner, the COO, the Chief of Staff or QA/);
  items.update(wp, id, { type: 'bug' }, 'coo');
  assert.equal(rawGet(wp, id)!.type, 'bug');
  items.update(wp, id, { type: 'rca' }, 'asha');
  assert.equal(rawGet(wp, id)!.type, 'rca');
  items.update(wp, id, { type: null }, 'owner');
  assert.equal(rawGet(wp, id)!.type, undefined);
  assert.throws(() => items.update(wp, id, { type: 'feature' as never }, 'coo'), /type must be bug, rca or null/);
  } finally { tmp.cleanup(); }
});
