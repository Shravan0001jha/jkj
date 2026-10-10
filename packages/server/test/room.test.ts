import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as room from '../src/services/room.js';
import * as work from '../src/services/work.js';
import * as inbox from '../src/services/inbox.js';
import * as employees from '../src/services/employees.js';
import * as cos from '../src/services/cos.js';
import { workplaceTools } from '../src/services/employees.js';
import { assembleContext } from '../src/services/context-layers.js';
import { seedFeature } from '../src/services/features.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/** The Team Room (HLD D3b). */

const tick = () => new Promise(r => setTimeout(r, 5));

async function toolsFor(wp: ReturnType<typeof testWorkplace>['wp'], employeeId: string) {
  const server = workplaceTools(wp, employeeId, () => ({ agentId: 'a', employeeId, startedAt: '', seen: {}, planCaptured: false }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(st);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(ct);
  return client;
}

test('threads and messages persist, @mentions resolve, the owner is marked, and each employee sees what concerns it', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const events: string[] = [];
    wp.on(e => { if (e.type === 'room.thread' || e.type === 'room.message') events.push(e.type); });
    const { thread } = room.createThread(wp, { title: 'Daily greeting: weather source contract', text: 'Which module publishes the weather facts? @Dev @kabir', by: 'mira', charterIds: ['experts', 'conversation'] });
    assert.deepEqual(room.messages(wp, thread.id)[0]!.mentions.sort(), ['dev', 'kabir']);
    assert.deepEqual(room.getThread(wp, thread.id)!.participants.sort(), ['dev', 'kabir', 'mira']);
    const m = room.post(wp, thread.id, { text: 'Keep it in context/weather.py; nobody else writes weather.', by: 'owner' });
    assert.equal(m.owner, true);
    assert.equal(room.getThread(wp, thread.id)!.messageCount, 2);
    assert.ok(events.includes('room.message') && events.includes('room.thread'));

    assert.deepEqual(room.threadsFor(wp, 'kabir').map(t => t.id), [thread.id], 'mentioned');
    assert.deepEqual(room.threadsFor(wp, 'dev').map(t => t.id), [thread.id], 'holds conversation');
    assert.deepEqual(room.threadsFor(wp, 'tara'), [], 'not concerned');
    const ctx = assembleContext(wp.org, wp.org.employees.find(e => e.id === 'dev')!, { room: room.contextFor(wp, 'dev') });
    assert.ok(ctx.append.includes('## Team Room'));
    assert.ok(ctx.append.includes('OWNER (') && ctx.append.includes('nobody else writes weather'));
  } finally {
    tmp.cleanup();
  }
});

test('employees post through the tools; only the Chief of Staff resolves with follow-ups or escalates; escalations are Inbox items linked to the thread', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const mira = await toolsFor(wp, 'mira');
    const opened = await mira.callTool({ name: 'room_post', arguments: { title: 'app.py hunk needs sign-off', text: 'The _presence_tick hunk is yours, @dev.', charterIds: ['experts', 'character'] } });
    const threadId = /Opened thread (th_\w+)/.exec(JSON.stringify(opened.content))![1]!;
    const listed = await mira.callTool({ name: 'room_read', arguments: {} });
    assert.match(JSON.stringify(listed.content), /app\.py hunk needs sign-off/);
    const refused = await mira.callTool({ name: 'room_resolve', arguments: { threadId, summary: 'done' } });
    assert.match(JSON.stringify(refused.content), /Only the Chief of Staff/);
    // Rework (Oct 2026): anyone escalates, to their manager (Mira → Asha); only the Chief of Staff and the CTO go to the COO.
    assert.match(JSON.stringify(await mira.callTool({ name: 'escalate', arguments: { threadId, title: 'x', body: 'y' } }).then(r => r.content)), /Escalated to Asha/);

    const asha = await toolsFor(wp, 'asha');
    const esc = await asha.callTool({ name: 'escalate', arguments: { threadId, title: 'Who owns app.py?', body: 'Three owners for one file.', options: ['experts', 'character'], recommendation: 'experts' } });
    const itemId = /Inbox \(the COO is offline\) as (in_\w+)/.exec(JSON.stringify(esc.content))![1]!;
    const item = inbox.get(wp, itemId)!;
    assert.equal(item.context['threadId'], threadId);
    assert.deepEqual(item.links, [{ label: 'Team Room thread', href: `#/room/${threadId}` }]);
    assert.ok(item.affects.includes('mira') && item.affects.includes('dev'), 'the charters the thread touches');
    assert.deepEqual(room.getThread(wp, threadId)!.escalations, [itemId]);

    const resolved = await asha.callTool({ name: 'room_resolve', arguments: { threadId, summary: 'Experts keeps greeting.py; Dev reviews the app.py hunk.', followUps: [{ employeeId: 'dev', title: 'Review the greeting hunk', body: 'The _presence_tick change in Mira\'s branch.' }] } });
    assert.match(JSON.stringify(resolved.content), /follow-ups as_/);
    const t = room.getThread(wp, threadId)!;
    assert.equal(t.state, 'resolved');
    assert.equal(t.summary, 'Experts keeps greeting.py; Dev reviews the app.py hunk.');
    const follow = work.list(wp, { kind: 'assignment', employeeId: 'dev' })[0]!;
    assert.equal(follow.title, 'Review the greeting hunk');
    assert.match(follow.body, /From the Team Room thread/);
    assert.deepEqual(room.threadsFor(wp, 'mira'), [], 'resolved threads leave the context');
    await mira.close(); await asha.close();
  } finally {
    tmp.cleanup();
  }
});

test('the routine hands threads with new messages to the Chief of Staff once, free', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    mkdirSync(join(tmp.dir, 'ops', 'workplace'), { recursive: true });
    writeFileSync(join(tmp.dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=x\n');
    const { thread } = room.createThread(wp, { title: 'Handoff: errand contract', text: 'Who owns /v1/errands? @asha', by: 'tara', charterIds: ['server', 'mobile'] });
    const r = cos.tick(wp);
    assert.deepEqual(r.moderated, [thread.id]);
    await tick();
    assert.ok(fake.last().options.prompt.includes('Team Room moderation'));
    assert.ok(fake.last().options.prompt.includes(thread.id));
    assert.deepEqual(cos.tick(wp).moderated, [], 'seen');
    room.post(wp, thread.id, { text: 'Server side is mine; the phone contract is Tara\'s.', by: 'kabir' });
    assert.deepEqual(cos.tick(wp).moderated, [thread.id], 'a new message brings it back');
    employees.closeAll(wp, 'test');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('the seed threads come from the real 27 Sep plans and mention the right people', () => {
  const { wp, tmp } = testWorkplace();
  try {
    assert.deepEqual(room.seedThreads(wp), [], 'no plans, no invented threads');
    const f = seedFeature(wp)!;
    // Stand in the four real plans (their substance, as recorded on 27 Sep).
    const g = work.create(wp, { kind: 'feature', title: 'Daily greeting, weather-aware', body: 'x', platformIds: ['mac'] });
    const set = (employeeId: string, plan: string) => { const a = work.list(wp, { kind: 'assignment', employeeId, featureId: g.id })[0]; if (a) work.attachPlan(wp, a.id, plan, employeeId); };
    work.transition(wp, g.id, { to: 'specced', by: 'asha', spec: 'AC1..AC10' });
    for (const [emp, charter] of [['kabir', 'memory'], ['mira', 'experts'], ['rohan', 'desktop-mac']] as const) work.create(wp, { kind: 'assignment', title: `Daily greeting — ${charter}`, body: 'x', charterId: charter, featureId: g.id });
    set('kabir', 'Charter-fit finding — this is not a Memory feature. Recommendation: re-route.');
    set('mira', 'Build greeting.py as a pure module; get Dev\'s explicit sign-off on the app.py hunk. Screen-share detector genuinely does not exist.');
    set('rohan', 'Ownership flag: app.py is outside desktop-mac\'s ownership map. AC8 screen-share is blocked. AC9 needs the Speaker contract.');
    void f;
    const made = room.seedThreads(wp);
    const titles = made.map(t => t.title);
    assert.ok(titles.some(t => /memory piece is misrouted/.test(t)));
    assert.ok(titles.some(t => /sign-off/.test(t)));
    assert.ok(titles.some(t => /AC8/.test(t)), JSON.stringify({ titles, plans: work.list(wp, { kind: 'assignment', featureId: g.id }).map(a => [a.employeeId, (a.plan ?? '').slice(0, 40)]) }));
    assert.ok(titles.some(t => /AC9/.test(t)));
    assert.ok(titles.some(t => /Who owns services\/agent-svc\/app\.py/.test(t)));
    const misrouted = made.find(t => /misrouted/.test(t.title))!;
    assert.ok(misrouted.participants.includes('asha') && misrouted.participants.includes('dev') && misrouted.participants.includes('kabir'));
    assert.deepEqual(room.seedThreads(wp), [], 'once');
  } finally {
    tmp.cleanup();
  }
});
