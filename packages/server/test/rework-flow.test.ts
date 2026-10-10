import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrRecord, WorkItem } from '@jkj/shared';
import type { WorkplaceEvent } from '../src/services/workplace.js';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as trail from '../src/services/trail.js';
import * as employees from '../src/services/employees.js';
import * as runs from '../src/services/runs.js';
import * as coo from '../src/services/coo.js';
import * as floor from '../src/services/floor.js';
import * as manager from '../src/services/manager.js';
import * as dispatch from '../src/services/dispatch.js';
import * as watch from '../src/services/watch.js';
import * as stuck from '../src/services/stuck.js';
import * as hygiene from '../src/services/hygiene.js';
import * as lifecycleWatch from '../src/services/lifecycle-watch.js';
import * as stallChain from '../src/services/stall-chain.js';
import { rawGet } from '../src/services/v2-map.js';
import { installFakeRuntime, type FakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * W2 of the October rework (docs/LLD-rework-2026-10.md): focus is priority, not a filter; one story
 * per person (a story a session leaves goes back to Ready; reassigning or merging ends the session);
 * and one stall chain (lead +10, Asha +20, COO +30, a ring to the owner +40) in place of the five
 * old detectors, which stop alerting.
 */

const MIN = 60_000;
const tick = (ms = 15) => new Promise(r => setTimeout(r, ms));
const runtime: FakeRuntime = installFakeRuntime();
after(() => runtime.restore());

type Wp = ReturnType<typeof testWorkplace>['wp'];

/** Sessions the current test started (the fake runtime is shared by the file). */
let base = 0;

function setup(env: Partial<Record<string, string>> = {}) {
  base = runtime.sessions.length;
  const t = testWorkplace(env);
  mkdirSync(join(t.tmp.dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(t.tmp.dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token-value\n');
  // An engineer in Dev's team: Dev is her lead, Asha is Dev's manager.
  const dev = t.wp.org.employees.find(e => e.id === 'dev')!;
  t.wp.org.employees.push({ ...dev, id: 'ira', name: 'Ira', roleId: 'engineer', reportsTo: 'dev', charterIds: ['conversation'], githubApp: undefined } as typeof dev);
  const epic = items.create(t.wp, { level: 'epic', title: 'Iris during music' }, 'owner');
  const other = items.create(t.wp, { level: 'epic', title: 'Not the focus' }, 'owner');
  items.setFocus(t.wp, [epic.id], 'owner');
  const story = (title: string, assigneeId: string, parentId = epic.id) => items.create(t.wp, { level: 'story', parentId, title, assigneeId }, 'owner');
  const raw = (id: string) => rawGet(t.wp, id)!;
  const patch = (id: string, p: Partial<WorkItem> | Record<string, unknown>) => work.saveQuiet(t.wp, { ...raw(id), ...p } as WorkItem);
  const rings: { text: string; itemIds: string[] }[] = [];
  const off = t.wp.on((e: WorkplaceEvent) => {
    const a = e as unknown as { type: string; level?: string; text?: string; itemIds?: string[] };
    if (a.type === 'alert' && a.level === 'ring') rings.push({ text: a.text ?? '', itemIds: a.itemIds ?? [] });
  });
  return {
    ...t, epic, other, story, raw, patch, rings,
    done: async () => { off(); await tick(30); t.tmp.cleanup(); },
  };
}

const of = (emp: string) => runtime.sessions.slice(base).filter(s => s.options.cwd.includes(`/${emp}/`));
const told = (emp: string) => of(emp).flatMap(s => [s.options.prompt, ...s.sent.map(m => m.text)]);
const toldStall = (emp: string, title: string) => told(emp).filter(t => t.startsWith('Stalled ') && t.includes(`"${title}"`));
const cooStalls = (wp: Wp, itemId: string) => coo.listItems(wp).filter(i => i.kind === 'stall' && i.itemId === itemId);
const setSuperFocus = (wp: Wp, untilMs: number) =>
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run('super-focus', JSON.stringify({ until: new Date(untilMs).toISOString() }));
const statusRows = (wp: Wp, id: string) => trail.activityFor(wp, id).filter(a => a.kind === 'status');

/* ---------- dispatch: focus is priority, not a filter ---------- */

test('dispatch 1: a Ready story outside the focus is started when there is no focus work (and with no focus at all)', async () => {
  const { wp, story, other, done } = setup();
  try {
    const side = story('Side quest', 'dev', other.id);
    assert.deepEqual(dispatch.queue(wp, 'dev').map(w => w.id), [side.id], 'queued, after the focus');
    const r = dispatch.dispatch(wp, 'dev');
    assert.equal(r.action, 'story');
    assert.equal(r.itemId, side.id);
    assert.equal(items.require$(wp, side.id).status, 'in-progress');

    // No focus set at all: ordered by rank.
    items.setFocus(wp, [], 'owner');
    const a = story('Weather line', 'mira', other.id);
    const b = story('Greeting copy', 'mira', other.id);
    items.update(wp, b.id, { rank: -5 }, 'owner');
    assert.deepEqual(dispatch.queue(wp, 'mira').map(w => w.id), [b.id, a.id]);
  } finally { await done(); }
});

test('dispatch 2: focus stories still go first; Backlog outside the focus is still never started', async () => {
  const { wp, story, other, done } = setup();
  try {
    const side = story('Side quest', 'dev', other.id);
    items.update(wp, side.id, { rank: -100 }, 'owner');
    const parked = story('Parked side', 'dev', other.id);
    items.update(wp, parked.id, { status: 'backlog', note: 'not for now' }, 'owner');
    const focus = story('Mic gate opens over music', 'dev');
    assert.deepEqual(dispatch.queue(wp, 'dev').map(w => w.id), [focus.id, side.id]);
    const r = dispatch.dispatch(wp, 'dev');
    assert.equal(r.itemId, focus.id);
  } finally { await done(); }
});

test('dispatch: a story Asha routed to a lead goes to the top of the lead\'s queue, and the start prompt says to assign it within the team', async () => {
  const { wp, story, done } = setup();
  try {
    const own = story('Lead\'s own story', 'dev');
    items.update(wp, own.id, { rank: -100 }, 'owner');
    const routed = story('Routed bug', 'asha');
    items.update(wp, routed.id, { assigneeId: 'dev', note: 'conversation charter: Dev\'s team' }, 'asha');
    assert.equal(employees.routedToLead(wp, rawGet(wp, routed.id)!), true);
    assert.equal(employees.routedToLead(wp, rawGet(wp, own.id)!), false);
    assert.deepEqual(dispatch.queue(wp, 'dev').map(w => w.id), [routed.id, own.id]);
    dispatch.dispatch(wp, 'dev');
    await tick();
    assert.match(of('dev')[0]!.options.prompt, /^Routed to your team: assign each to a team member \(item_update assigneeId \+ reason\) or keep it with a reason\./);
  } finally { await done(); }
});

/* ---------- sessions: one story per person ---------- */

test('sessions 3: a session moved to a new story puts the story it left back to Ready, with a system: reason', async () => {
  const { wp, story, done } = setup();
  try {
    const a = story('Mic gate', 'dev');
    const b = story('Dance tempo', 'dev');
    employees.assign(wp, a.id);
    await tick();
    of('dev')[0]!.result();
    await tick();
    assert.equal(items.require$(wp, a.id).status, 'in-progress');
    employees.assign(wp, b.id);
    assert.equal(employees.openSession('dev')!.assignmentId, b.id);
    assert.equal(items.require$(wp, a.id).status, 'ready', 'one story per person: the left story is Ready again');
    assert.equal(items.require$(wp, b.id).status, 'in-progress');
    const back = statusRows(wp, a.id).at(-1)!;
    assert.equal(back.to, 'ready');
    assert.equal(back.by, 'workplace');
    assert.equal(back.text, 'system: Dev moved to "Dance tempo"');
  } finally { await done(); }
});

test('sessions 3b: a send-back redirect leaves the story the session was on Ready (not only a phantom start)', async () => {
  const { wp, story, patch, done } = setup();
  try {
    const a = story('Sent back', 'dev');
    const b = story('Next one', 'dev');
    employees.assign(wp, b.id);
    await tick();
    of('dev')[0]!.result();
    await tick();
    // B was started long ago and has a plan: before the rework this stayed In progress behind the redirect.
    patch(b.id, { plan: '## Plan\n1. do it', statusSince: new Date(Date.now() - 60 * MIN).toISOString() });
    items.update(wp, a.id, { status: 'in-progress', note: 'sent back by review' }, 'owner');
    assert.equal(employees.redirectTo(wp, a.id, 'Fix the review comments'), true);
    assert.equal(employees.openSession('dev')!.assignmentId, a.id);
    assert.equal(items.require$(wp, b.id).status, 'ready');
    assert.match(statusRows(wp, b.id).at(-1)!.text, /^system: Dev moved to "Sent back"/);
  } finally { await done(); }
});

test('sessions 4: reassigning an item ends the old assignee\'s session bound to it', async () => {
  const { wp, story, done } = setup();
  const stop = dispatch.startDispatch(wp);
  try {
    const a = story('Mic gate', 'dev');
    employees.assign(wp, a.id);
    await tick();
    const s = of('dev')[0]!;
    s.result();
    await tick();
    const agentId = employees.openSession('dev')!.agentId;
    items.update(wp, a.id, { assigneeId: 'mira', note: 'experts charter owns it' }, 'owner');
    await tick();
    assert.ok(s.sent.some(m => /This session is ending/.test(m.text)), 'asked for the handoff');
    s.say('Handoff written.');
    s.result();
    await tick(40);
    assert.equal(employees.allSessions().some(x => x.agentId === agentId), false, 'Dev\'s session on it is closed');
    const row = wp.db.prepare('select status from sessions where id = ?').get(agentId) as { status: string };
    assert.equal(row.status, 'reassigned');
  } finally { stop(); await done(); }
});

test('sessions 4b: reassigning an item does not touch the old assignee\'s session on another story', async () => {
  const { wp, story, done } = setup();
  const stop = dispatch.startDispatch(wp);
  try {
    const a = story('Mic gate', 'dev');
    const b = story('Other', 'dev');
    employees.assign(wp, a.id);
    await tick();
    items.update(wp, b.id, { assigneeId: 'mira', note: 'experts charter owns it' }, 'owner');
    await tick(40);
    assert.ok(!of('dev')[0]!.sent.some(m => /This session is ending/.test(m.text)));
    assert.equal(employees.openSession('dev')!.assignmentId, a.id);
  } finally { stop(); await done(); }
});

const pr = (extra: Partial<PrRecord> = {}): PrRecord => ({ number: 7, url: 'https://github.com/o/r/pull/7', branch: 'emp/dev/x', base: 'main', headSha: 'abc123', pushedAt: '2026-10-05T10:00:00Z', evidence: 'success', tests: { state: 'success', sha: 'abc123', at: '2026-10-05T10:00:00Z', summary: 'ok' }, ...extra });

test('sessions 5: a merge ends the author\'s session when it is bound to that story', async () => {
  const { wp, story, patch, done } = setup();
  try {
    const a = story('Mic gate', 'dev');
    employees.assign(wp, a.id);
    await tick();
    const s = of('dev')[0]!;
    s.result();
    await tick();
    const agentId = employees.openSession('dev')!.agentId;
    patch(a.id, { pr: pr({ merged: { at: '2026-10-05T11:00:00Z', sha: 'm1', by: 'coo' } }) });
    lifecycleWatch.onMerged(wp, a.id);
    await tick();
    assert.ok(s.sent.some(m => /This session is ending/.test(m.text)));
    s.say('Handoff written.');
    s.result();
    await tick(40);
    assert.equal(employees.allSessions().some(x => x.agentId === agentId), false);
    assert.equal((wp.db.prepare('select status from sessions where id = ?').get(agentId) as { status: string }).status, 'merged');
  } finally { await done(); }
});

test('sessions 5b: a merge leaves the author\'s session alone when it is on another story', async () => {
  const { wp, story, patch, done } = setup();
  try {
    const a = story('Merged one', 'dev');
    const b = story('Working on', 'dev');
    employees.assign(wp, b.id);
    await tick();
    patch(a.id, { status: 'in-review', reviewerId: 'nikhil', pr: pr({ merged: { at: '2026-10-05T11:00:00Z', sha: 'm1', by: 'coo' } }) });
    lifecycleWatch.onMerged(wp, a.id);
    await tick();
    assert.ok(!of('dev')[0]!.sent.some(m => /This session is ending/.test(m.text)));
    assert.equal(employees.openSession('dev')!.assignmentId, b.id);
  } finally { await done(); }
});

test('sessions 6: resumeOrphan does not resume when the person\'s session is bound to another unfinished story', async () => {
  const { wp, story, patch, done } = setup();
  try {
    const orphan = story('Orphan', 'dev');
    const a = story('On it', 'dev');
    patch(orphan.id, { status: 'in-progress', statusSince: new Date().toISOString() });
    wp.db.prepare("update work set status = 'in-progress' where id = ?").run(orphan.id);
    employees.assign(wp, a.id);
    await tick();
    of('dev')[0]!.result();
    await tick();
    const r = dispatch.dispatch(wp, 'dev');
    assert.notEqual(r.action, 'story');
    assert.equal(employees.openSession('dev')!.assignmentId, a.id, 'the session stays on its story');
    assert.ok(!trail.activityFor(wp, orphan.id).some(x => /Resumed/.test(x.text)));
  } finally { await done(); }
});

/* ---------- the stall chain ---------- */

test('stall 7 + 8: 9 min is nothing; the lead at 10, Asha at 20, the COO bridge at 30, one ring at 40; each exactly once', async () => {
  const { wp, story, rings, done } = setup();
  try {
    const s = story('Tempo follows the beat', 'ira');
    const t0 = Date.now();
    stallChain.sweep(wp, t0);
    stallChain.sweep(wp, t0 + 9 * MIN);
    assert.deepEqual(toldStall('dev', s.title), []);
    assert.deepEqual(toldStall('asha', s.title), []);
    assert.equal(cooStalls(wp, s.id).length, 0);
    assert.equal(rings.length, 0);

    stallChain.sweep(wp, t0 + 10 * MIN);
    await tick();
    const lead = toldStall('dev', s.title);
    assert.equal(lead.length, 1, 'the lead is told at 10');
    assert.match(lead[0]!, /^Stalled 10 min: "Tempo follows the beat" \(Ira\) — .+\. Get it moving or say why\.$/);
    assert.deepEqual(toldStall('asha', s.title), []);
    assert.ok(trail.comments(wp, s.id).some(c => c.by === 'workplace' && /Stalled 10 min/.test(c.text)), 'a comment on the item too');
    stallChain.sweep(wp, t0 + 11 * MIN);
    stallChain.sweep(wp, t0 + 15 * MIN);
    await tick();
    assert.equal(toldStall('dev', s.title).length, 1);

    stallChain.sweep(wp, t0 + 20 * MIN);
    await tick();
    assert.equal(toldStall('asha', s.title).length, 1, 'Asha at 20');
    assert.equal(cooStalls(wp, s.id).length, 0);

    stallChain.sweep(wp, t0 + 30 * MIN);
    assert.equal(cooStalls(wp, s.id).length, 1, 'the COO bridge at 30');
    assert.match(coo.readInboxFileForTest(wp), /stall/);
    assert.equal(rings.length, 0);

    stallChain.sweep(wp, t0 + 40 * MIN);
    assert.equal(rings.length, 1, 'the owner is rung at 40');
    assert.deepEqual(rings[0]!.itemIds, [s.id]);
    assert.match(rings[0]!.text, /Tempo follows the beat/);

    stallChain.sweep(wp, t0 + 41 * MIN);
    stallChain.sweep(wp, t0 + 60 * MIN);
    await tick();
    assert.equal(rings.length, 1);
    assert.equal(cooStalls(wp, s.id).length, 1);
    assert.equal(toldStall('dev', s.title).length, 1);
    assert.equal(toldStall('asha', s.title).length, 1);
    assert.deepEqual(JSON.parse((wp.db.prepare('select value from settings where key = ?').get(`stall-chain:${s.id}`) as { value: string }).value).notified, 4);
  } finally { await done(); }
});

test('stall: a lead\'s own stalled story goes to their manager at level 1 (never to themselves)', async () => {
  const { wp, story, done } = setup();
  try {
    const s = story('Lead story', 'dev');
    const t0 = Date.now();
    stallChain.sweep(wp, t0);
    stallChain.sweep(wp, t0 + 10 * MIN);
    await tick();
    assert.equal(toldStall('asha', s.title).length, 1, 'Dev\'s manager');
    assert.deepEqual(toldStall('dev', s.title), []);
    stallChain.sweep(wp, t0 + 20 * MIN);
    await tick();
    assert.equal(toldStall('asha', s.title).length, 1, 'Asha is not told twice');
    stallChain.sweep(wp, t0 + 30 * MIN);
    assert.equal(cooStalls(wp, s.id).length, 1);
  } finally { await done(); }
});

test('stall: an idle session bound to the story counts once it has been idle 10 min; a working one never does', async () => {
  const { wp, story, done } = setup();
  try {
    const s = story('Bound story', 'ira');
    employees.assign(wp, s.id);
    await tick();
    const t0 = Date.now();
    stallChain.sweep(wp, t0 + 30 * MIN);
    assert.equal(stallChain.record(wp, s.id), undefined, 'a running turn is never a stall');
    of('ira')[0]!.result();
    await tick();
    const t1 = Date.now();
    stallChain.sweep(wp, t1 + 5 * MIN);
    assert.equal(stallChain.record(wp, s.id), undefined, 'idle 5 min: not yet');
    stallChain.sweep(wp, t1 + 10 * MIN + 5_000);
    await tick();
    assert.ok(stallChain.record(wp, s.id), 'idle 10 min: stalled, and already at level 1');
    assert.equal(toldStall('dev', s.title).length, 1);
  } finally { await done(); }
});

test('stall 9: the ring is held in quiet hours and rings once they end; super focus rings through them', async () => {
  const { wp, story, rings, done } = setup({ WORKPLACE_PUSH_QUIET: '0-24' });
  try {
    const s = story('Night stall', 'ira');
    const t0 = Date.now();
    for (const m of [0, 10, 20, 30, 40, 45]) stallChain.sweep(wp, t0 + m * MIN);
    assert.equal(cooStalls(wp, s.id).length, 1, 'the COO still hears at night');
    assert.equal(rings.length, 0, 'no ring in quiet hours');
    (wp.config as { pushQuiet?: string }).pushQuiet = undefined;
    stallChain.sweep(wp, t0 + 46 * MIN);
    assert.equal(rings.length, 1, 'retried on the first sweep after quiet hours');
    assert.deepEqual(rings[0]!.itemIds, [s.id]);

    (wp.config as { pushQuiet?: string }).pushQuiet = '0-24';
    const n = story('Focus stall', 'ira');
    const t1 = t0 + 50 * MIN;
    setSuperFocus(wp, t1 + 120 * MIN);
    for (const m of [0, 10, 20, 30, 40]) stallChain.sweep(wp, t1 + m * MIN);
    assert.equal(rings.length, 2, 'super focus rings in quiet hours');
    assert.deepEqual(rings[1]!.itemIds, [n.id]);
  } finally { await done(); }
});

test('stall 10: two stories at level 4 in the same sweep produce one ring listing both', async () => {
  const { wp, story, rings, done } = setup();
  try {
    const a = story('First stall', 'ira');
    const b = story('Second stall', 'mira');
    const t0 = Date.now();
    for (const m of [0, 10, 20, 30, 40]) stallChain.sweep(wp, t0 + m * MIN);
    assert.equal(rings.length, 1);
    assert.deepEqual([...rings[0]!.itemIds].sort(), [a.id, b.id].sort());
    assert.match(rings[0]!.text, /First stall/);
    assert.match(rings[0]!.text, /Second stall/);
  } finally { await done(); }
});

test('stall 11: with the floor paused nothing fires, and the clock starts again when the pause lifts', async () => {
  const { wp, story, rings, done } = setup();
  try {
    const s = story('Paused stall', 'ira');
    const t0 = Date.now();
    stallChain.sweep(wp, t0);
    floor.setPaused(wp, true, 'owner is away', 'owner');
    for (const m of [10, 20, 30, 40]) stallChain.sweep(wp, t0 + m * MIN);
    await tick();
    assert.deepEqual(toldStall('dev', s.title), []);
    assert.equal(cooStalls(wp, s.id).length, 0);
    assert.equal(rings.length, 0);
    assert.equal(stallChain.record(wp, s.id), undefined);
    floor.setPaused(wp, false, 'back', 'owner');
    stallChain.sweep(wp, t0 + 41 * MIN);
    stallChain.sweep(wp, t0 + 50 * MIN);
    await tick();
    assert.deepEqual(toldStall('dev', s.title), [], 'only 9 min since the resume');
    stallChain.sweep(wp, t0 + 51 * MIN);
    await tick();
    assert.equal(toldStall('dev', s.title).length, 1);
  } finally { await done(); }
});

test('stall 12: parked, waiting-on-owner and blocked stories never count as stalled', async () => {
  const { wp, story, patch, rings, done } = setup();
  try {
    const parked = story('Parked one', 'ira');
    const waiting = story('Waiting on owner', 'ira');
    const blocked = story('Blocked one', 'ira');
    const since = new Date().toISOString();
    patch(parked.id, { status: 'parked', parked: { reason: 'after the release', resumeWhen: 'release ships', by: 'asha', since } });
    patch(waiting.id, { status: 'waiting', waiting: { on: 'owner', reason: 'needs his call', since } });
    items.update(wp, blocked.id, { status: 'blocked', waitingOn: 'external', blockedReason: 'Apple review', note: 'Apple review' }, 'owner');
    const t0 = Date.now();
    for (const m of [0, 10, 20, 30, 40]) stallChain.sweep(wp, t0 + m * MIN);
    await tick();
    for (const id of [parked.id, waiting.id, blocked.id]) assert.equal(stallChain.record(wp, id), undefined, id);
    assert.deepEqual(told('dev').filter(t => t.startsWith('Stalled')), []);
    assert.equal(rings.length, 0);
  } finally { await done(); }
});

test('stall 13: an assignee busy on another story keeps their own Ready story from counting as stalled', async () => {
  const { wp, story, done } = setup();
  try {
    const on = story('Working on', 'ira');
    const next = story('Next up', 'ira');
    employees.assign(wp, on.id);
    await tick();
    of('ira')[0]!.result();
    await tick();
    const t0 = Date.now();
    for (const m of [0, 10, 20]) stallChain.sweep(wp, t0 + m * MIN);
    assert.equal(stallChain.record(wp, next.id), undefined, 'queued behind her own work, not stalled');
    // Her session on the other story went idle long ago: that story is the stall, not this one.
    assert.ok(stallChain.record(wp, on.id));
    assert.equal(runs.getRunAgent(employees.openSession('ira')!.agentId)!.status, 'waiting');
  } finally { await done(); }
});

/* ---------- the old detectors stop alerting ---------- */

test('old detectors 14: the watch idle and not-started rules, the stuck sweep, the dispatcher\'s idle alert and hygiene send nothing to the manager', async () => {
  const { wp, story, raw, done } = setup();
  try {
    const idle = story('Idle story', 'tara');
    items.update(wp, idle.id, { status: 'in-progress', note: 'started by hand' }, 'owner');
    const ready = story('Never started', 'kabir');
    const t0 = Date.now();
    watch.check(wp, idle.id, t0 + 60 * MIN);
    watch.check(wp, ready.id, t0 + 60 * MIN);
    assert.equal(items.require$(wp, ready.id).status, 'ready', 'never auto-assigned or parked by the watcher');
    assert.equal(employees.openSession('kabir'), undefined, 'and never started by it');
    stuck.sweep(wp, t0);
    stuck.sweep(wp, t0 + 11 * MIN);
    dispatch.idleAlerts(wp, t0);
    dispatch.idleAlerts(wp, t0 + 60 * MIN);
    const h = hygiene.sweep(wp, t0 + 30 * MIN);
    assert.equal(h.asha, null, 'hygiene stops telling Asha');
    assert.ok(Array.isArray(hygiene.report(wp).violations), 'the COO endpoint still computes');
    assert.deepEqual(manager.list(wp).map(a => a.key), [], 'nothing went to the manager');
    assert.equal(raw(idle.id).status, 'in-progress');
  } finally { await done(); }
});

test('old detectors: the manager no longer escalates an old stall alert to the COO', async () => {
  const { wp, story, raw, done } = setup();
  try {
    const s = story('Old alert', 'tara');
    const t0 = Date.now();
    const w = raw(s.id);
    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`mgr-alert:stuck:${s.id}:x`, JSON.stringify({
      key: `stuck:${s.id}:x`, itemId: s.id, title: 'Stuck', body: 'b', at: new Date(t0 + 1000).toISOString(), state: 'delivered',
      statusAt: `${w.status ?? ''}:${w.statusSince ?? ''}`, assigneeAt: 'tara',
    }));
    assert.deepEqual(manager.escalate(wp, t0 + 60 * MIN), []);
    assert.equal(cooStalls(wp, s.id).length, 0);
  } finally { await done(); }
});
