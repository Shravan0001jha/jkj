import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Workplace } from '../src/services/workplace.js';
import * as employees from '../src/services/employees.js';
import * as items from '../src/services/items.js';
import * as coo from '../src/services/coo.js';
import * as cooPickup from '../src/services/coo-pickup.js';
import { rawGet } from '../src/services/v2-map.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/** Dry run, 4 Oct: the fixes found in the night's practice stories (#11, #17, #19, #20, #22, #23). */

const runtime = installFakeRuntime();
after(() => runtime.restore());

function withOauth(dir: string): void {
  mkdirSync(join(dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token-value\n');
}

async function toolsFor(wp: Workplace, employeeId: string, assignmentId?: string) {
  const server = employees.workplaceTools(wp, employeeId, () => ({ agentId: 'a', employeeId, ...(assignmentId ? { assignmentId } : {}), startedAt: '', seen: {}, planCaptured: false }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(st);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(ct);
  return async (name: string, args: Record<string, unknown>) => JSON.stringify((await client.callTool({ name, arguments: args })).content);
}

test('#11: every employee session runs with WORKPLACE_EMPLOYEE=<its id>, so pre-pr.sh records who ran it', () => {
  const { wp, tmp } = testWorkplace();
  withOauth(tmp.dir);
  try {
    employees.talk(wp, 'tara', 'hello', [], { autonomous: true });
    const env = runtime.last().options.env!;
    assert.equal(env['WORKPLACE_EMPLOYEE'], 'tara');
    assert.equal(employees.childEnv(wp)['WORKPLACE_EMPLOYEE'], undefined, 'never inherited from the server');
  } finally { tmp.cleanup(); }
});

test('#19: item_handback is refused while the story is In review (or its PR waits on review); allowed once it is back in progress', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Practice' }, 'owner');
    const story = items.create(wp, { level: 'story', parentId: epic.id, title: 'About screen version', assigneeId: 'nikhil' }, 'asha');
    items.update(wp, story.id, { status: 'in-progress' }, 'nikhil');
    items.update(wp, story.id, { status: 'blocked', blockedReason: 'Needs the footer built.', waitingOn: 'dev', kind: 'work' }, 'nikhil');
    assert.equal(rawGet(wp, story.id)!.handoff?.fromId, 'nikhil');
    items.update(wp, story.id, { status: 'in-review', reviewerId: 'kabir' }, 'dev');
    const dev = await toolsFor(wp, 'dev', story.id);
    const refused = await dev('item_handback', { itemId: story.id, note: 'Done' });
    assert.match(refused, /The story is in review; post progress as a comment \(item_comment\) instead of handing it back\./);
    assert.equal(rawGet(wp, story.id)!.status, 'in-review', 'left in review');

    // An open PR pushed for review counts too, whatever the status says.
    const w = rawGet(wp, story.id)!;
    assert.equal(employees.awaitingReview({ ...w, status: 'in-progress', pr: { number: 1, url: '', branch: 'b', base: 't', headSha: 'abc', pushedAt: '2026-10-04T10:00:00Z', evidence: 'pending' } }), true);
    assert.equal(employees.awaitingReview({ ...w, status: 'in-progress', pr: { number: 1, url: '', branch: 'b', base: 't', headSha: 'abc', pushedAt: '2026-10-04T10:00:00Z', evidence: 'pending', sendBack: { by: 'nikhil', at: '2026-10-04T10:05:00Z', note: 'fix' } } }), false, 'sent back: work again');

    items.update(wp, story.id, { status: 'in-progress', note: 'back to work' }, 'kabir');
    assert.match(await dev('item_handback', { itemId: story.id, note: 'Built the footer' }), /Handed .* back to Nikhil/);
  } finally { tmp.cleanup(); }
});

test('#17: a story assigned to the Chief of Staff starts a routing session, not the builder prompt; she routes it with item_update', async () => {
  const { wp, tmp } = testWorkplace();
  withOauth(tmp.dir);
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Practice' }, 'owner');
    const story = items.create(wp, { level: 'story', parentId: epic.id, title: 'About screen version', assigneeId: 'asha' }, 'owner');
    employees.assign(wp, story.id);
    const prompt = runtime.last().options.prompt;
    assert.match(prompt, /^Route this: assign it to the right developer by the ownership map/);
    assert.doesNotMatch(prompt, /Take assignment|## Plan/);

    const built = items.create(wp, { level: 'story', parentId: epic.id, title: 'Footer', assigneeId: 'tara' }, 'owner');
    employees.assign(wp, built.id);
    assert.match(runtime.last().options.prompt, /Take assignment .*## Plan/s, 'a developer still gets the builder prompt');

    assert.match(await (await toolsFor(wp, 'dev'))('item_update', { itemId: story.id, assigneeId: 'tara' }), /only the Chief of Staff routes/);
    assert.match(await (await toolsFor(wp, 'asha', story.id))('item_update', { itemId: story.id, assigneeId: 'tara' }), /is /);
    assert.equal(rawGet(wp, story.id)!.employeeId, 'tara');
  } finally { tmp.cleanup(); }
});

test('#22: an owner message or @coo mention with no COO response in 15 min raises one push; answered ones and system kinds do not', async () => {
  const { wp, tmp } = testWorkplace();
  const alerts: { title: string; level: string }[] = [];
  const off = wp.on(e => { if (e.type === 'alert') alerts.push({ title: e.title, level: e.level }); });
  try {
    coo.touchHeartbeatForTest(wp);
    const epic = items.create(wp, { level: 'epic', title: 'Practice' }, 'owner');
    const story = items.create(wp, { level: 'story', parentId: epic.id, title: 'About screen version', assigneeId: 'tara' }, 'owner');
    coo.notifyMention(wp, { threadId: `item:${story.id}`, threadTitle: story.title, by: 'owner', text: '@coo seems like an operational issue here' });
    coo.notifyStall(wp, { itemId: 'floor', by: 'owner', title: 'The floor is paused', body: 'x' });
    coo.notifyMention(wp, { threadId: `item:${story.id}`, threadTitle: story.title, by: 'dev', text: '@coo fyi' });
    const t0 = Date.now();
    assert.deepEqual(cooPickup.check(wp, t0 + 10 * 60_000), [], 'not before 15 min');
    const late = cooPickup.check(wp, t0 + 16 * 60_000);
    assert.equal(late.length, 1, 'only the owner\'s mention; the stall and an agent\'s mention are not his');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.level, 'needs-you');
    assert.equal(alerts[0]!.title, 'The COO hasn\'t picked up your message on "About screen version"');
    assert.deepEqual(cooPickup.check(wp, t0 + 30 * 60_000), [], 'once');
    assert.equal(alerts.length, 1);

    // Answered: a COO post on the story, or a /api/coo/reply on the chat, means picked up.
    coo.notifyMention(wp, { threadId: `item:${story.id}`, threadTitle: story.title, by: 'owner', text: '@coo again' });
    coo.threadReply(wp, { itemId: story.id, text: 'COO: on it.' });
    const msg = coo.sendOwnerMessage(wp, 'are you there?');
    coo.replyFromCoo(wp, { inReplyTo: msg.id, text: 'Yes.' });
    assert.deepEqual(cooPickup.check(wp, Date.now() + 16 * 60_000), []);
    assert.equal(alerts.length, 1);

    await new Promise(r => setTimeout(r, 5));
    coo.sendOwnerMessage(wp, 'hello?');
    assert.equal(cooPickup.check(wp, Date.now() + 16 * 60_000).length, 1);
    assert.match(alerts.at(-1)!.title, /your message on the COO chat/);
  } finally { off(); tmp.cleanup(); }
});
