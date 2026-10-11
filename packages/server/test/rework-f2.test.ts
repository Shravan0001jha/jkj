import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkItem } from '@jkj/shared';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as inbox from '../src/services/inbox.js';
import * as employees from '../src/services/employees.js';
import * as floor from '../src/services/floor.js';
import * as manager from '../src/services/manager.js';
import * as dispatch from '../src/services/dispatch.js';
import * as hygiene from '../src/services/hygiene.js';
import * as delivery from '../src/services/reply-delivery.js';
import * as coo from '../src/services/coo.js';
import { rawGet } from '../src/services/v2-map.js';
import { installFakeRuntime, type FakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * Fixes from the 10 Oct live dry run (rework/f2):
 * - #10 hygiene: a story the Chief of Staff holds in her own (non-routing) charter is routed;
 * - #13 hygiene top-idle: focus-first like the dispatcher, Ready behind the person's In-progress story
 *   is waiting its turn, and the fix never says "switch" (one story per person);
 * - #2 resuming the floor does not wake every agent with an owner reply queued at once;
 * - #9 a manager alert or digest composed earlier never reaches Asha about a story that is now In
 *   progress with a live session on it.
 */

const MIN = 60_000;
const tick = (ms = 15) => new Promise(r => setTimeout(r, ms));
const runtime: FakeRuntime = installFakeRuntime();
after(() => runtime.restore());

let base = 0;

function setup() {
  base = runtime.sessions.length;
  runtime.onStart = undefined;
  runtime.onSend = undefined;
  const t = testWorkplace();
  mkdirSync(join(t.tmp.dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(t.tmp.dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token-value\n');
  const focus = items.create(t.wp, { level: 'epic', title: 'In focus' }, 'owner');
  const other = items.create(t.wp, { level: 'epic', title: 'Not the focus' }, 'owner');
  items.setFocus(t.wp, [focus.id], 'owner');
  const story = (title: string, assigneeId?: string, parentId = focus.id) =>
    items.create(t.wp, { level: 'story', parentId, title, ...(assigneeId ? { assigneeId } : {}) }, 'owner');
  const raw = (id: string) => rawGet(t.wp, id)!;
  const patch = (id: string, p: Partial<WorkItem> | Record<string, unknown>) => work.saveQuiet(t.wp, { ...raw(id), ...p } as WorkItem);
  return { ...t, focus, other, story, raw, patch, done: async () => { await tick(100); t.tmp.cleanup(); } };
}

const mine = () => runtime.sessions.slice(base);
const of = (emp: string) => mine().filter(s => s.options.cwd.includes(`/${emp}/`));
const told = (emp: string) => of(emp).flatMap(s => [s.options.prompt, ...s.sent.map(m => m.text)]);
const topIdle = (r: hygiene.SweepResult, id: string) => r.violations.find(v => v.rule === 'top-idle' && v.itemId === id);

/* ---------- #10: the Chief of Staff's own charter work is routed ---------- */

test('#10 hygiene: a story with Asha inside a charter she holds (product-and-business) is routed, not "top of her routing queue"', async () => {
  const { wp, story, patch, done } = setup();
  try {
    const own = story('Data safety answers for Google Play (draft)', 'asha');
    patch(own.id, { charterId: 'product-and-business' });
    items.update(wp, own.id, { status: 'in-progress', reason: 'test: Asha drafts it' }, 'asha');
    employees.assign(wp, own.id);
    await tick();
    const t0 = Date.now();
    hygiene.sweep(wp, t0);
    let r = hygiene.sweep(wp, t0 + 11 * MIN);
    assert.equal(topIdle(r, own.id), undefined, 'her own charter work, with her session on it, is not unrouted');
    assert.ok(!r.violations.some(v => v.itemId === own.id), 'and no other rule flags it');

    // A story merely parked with her for routing still is the top of her routing queue.
    const route = story('Needs a developer', 'asha');
    hygiene.sweep(wp, t0 + 12 * MIN);
    r = hygiene.sweep(wp, t0 + 23 * MIN);
    assert.match(topIdle(r, route.id)?.what ?? '', /Asha's routing queue, not routed/);
    assert.equal(topIdle(r, own.id), undefined);
  } finally { await done(); }
});

test('#10 hygiene: Asha idle on Ready work in her own charter is told as her own queue (start it), not as routing', async () => {
  const { wp, story, patch, done } = setup();
  try {
    const own = story('Play listing copy', 'asha');
    patch(own.id, { charterId: 'product-and-business' });
    const t0 = Date.now();
    hygiene.sweep(wp, t0);
    const v = topIdle(hygiene.sweep(wp, t0 + 11 * MIN), own.id);
    assert.ok(v, 'still a top-idle: nobody is on it');
    assert.doesNotMatch(v.what, /routing/);
    assert.match(v.what, /top of Asha's queue \(Ready\), and Asha is idle/);
  } finally { await done(); }
});

/* ---------- #13: top-idle is focus-first, one story per person, never "switch" ---------- */

test('#13 hygiene top-idle: Ready work queued behind the person\'s own In-progress story is waiting its turn, and nothing says "switch"', async () => {
  const { wp, story, other, patch, done } = setup();
  try {
    const onIt = story('Mira\'s P0 (outside the focus)', 'tara', other.id);
    items.update(wp, onIt.id, { status: 'in-progress', reason: 'test: started' }, 'tara');
    employees.assign(wp, onIt.id);
    await tick();
    const queued = story('Focus story ranked first', 'tara');
    patch(queued.id, { rank: -100 });
    const t0 = Date.now();
    for (const m of [0, 11, 30]) {
      const r = hygiene.sweep(wp, t0 + m * MIN);
      assert.equal(topIdle(r, queued.id), undefined, `not a top-idle at ${m} min`);
      assert.equal(topIdle(r, onIt.id), undefined, 'she is on her story');
      assert.ok(!r.violations.some(v => /switch/i.test(`${v.what} ${v.fix}`)), 'never suggests switching her');
    }
  } finally { await done(); }
});

test('#13 hygiene top-idle: the queue is ranked focus-first, in the dispatcher\'s order', async () => {
  const { wp, story, other, patch, done } = setup();
  try {
    const outside = story('Outside the focus, best rank', 'tara', other.id);
    patch(outside.id, { rank: -100 });
    const inFocus = story('In the focus, worse rank', 'tara');
    patch(inFocus.id, { rank: 100 });
    assert.equal(dispatch.queue(wp, 'tara')[0]!.id, inFocus.id, 'the dispatcher takes the focus story first');
    assert.equal(hygiene.personQueue(wp, 'tara')[0]!.id, inFocus.id, 'and so does hygiene');
    const t0 = Date.now();
    hygiene.sweep(wp, t0);
    const r = hygiene.sweep(wp, t0 + 11 * MIN);
    assert.ok(topIdle(r, inFocus.id));
    assert.equal(topIdle(r, outside.id), undefined);
  } finally { await done(); }
});

test('#13 hygiene top-idle: on a lower-ranked In-progress story, the fix is re-rank or wait, never "switch"', async () => {
  const { wp, story, other, done } = setup();
  try {
    const top = story('Focus story, also In progress', 'tara');
    items.update(wp, top.id, { status: 'in-progress', reason: 'test: started' }, 'tara');
    const lower = story('Lower story she is on', 'tara', other.id);
    items.update(wp, lower.id, { status: 'in-progress', reason: 'test: started' }, 'tara');
    employees.assign(wp, lower.id);
    await tick();
    const t0 = Date.now();
    hygiene.sweep(wp, t0);
    const v = topIdle(hygiene.sweep(wp, t0 + 11 * MIN), top.id);
    assert.ok(v, 'two stories In progress for one person is still told');
    assert.match(v.what, /Tara is on lower-ranked "Lower story she is on"/);
    assert.doesNotMatch(v.fix, /switch/i);
    assert.match(v.fix, /re-rank/);
    assert.match(v.fix, /finish/);
  } finally { await done(); }
});

/* ---------- #2: resuming the floor does not wake everyone with a reply queued ---------- */

test('#2 resume: owner replies queued while paused are not delivered by spawning a session each at once', async () => {
  const { wp, story, done } = setup();
  try {
    floor.setPaused(wp, true, 'dry run', 'owner');
    const people = ['dev', 'mira', 'kabir', 'rohan', 'nikhil', 'tara'];
    const asks = people.map(p => inbox.raise(wp, { kind: 'decision', title: `${p}'s question`, body: 'Which way?', raisedBy: p, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }));
    const msgs = asks.map(a => inbox.reply(wp, a.id, { by: 'owner', text: `Go with A, ${a.raisedBy}.` }).messages.filter(m => m.by === 'owner').at(-1)!);
    await tick();
    assert.equal(mine().length, 0, 'paused: nothing starts');
    for (const m of msgs) {
      const d = delivery.get(wp, m.id)!;
      assert.equal(d.deliveredAt, undefined);
      assert.equal(d.attempts, 0, 'held, not a failed attempt');
    }
    // Tara has queued work: the dispatcher starts her on it; her reply rides into that session.
    const tStory = story('Tara\'s next story', 'tara');

    // Thirty minutes of pause, then the resume.
    for (const m of msgs) {
      const d = delivery.get(wp, m.id)!;
      wp.db.prepare('update inbox_deliveries set at = ?, json = ? where message_id = ?')
        .run(new Date(Date.now() - 30 * MIN).toISOString(), JSON.stringify({ ...d, at: new Date(Date.now() - 30 * MIN).toISOString() }), m.id);
    }
    floor.setPaused(wp, false, 'resume', 'owner');
    const t0 = Date.now();
    dispatch.sweep(wp, t0);
    await tick();
    assert.equal(of('tara').length, 1, 'Tara: one session, on her story');
    assert.equal(employees.openSession('tara')!.assignmentId, tStory.id);
    assert.ok(told('tara').some(t => /Go with A, tara/.test(t)), 'her reply went into it');
    const noWork = people.filter(p => p !== 'tara');
    const started = () => noWork.filter(p => of(p).length > 0).length;
    assert.ok(started() <= delivery.SPAWNS_PER_SWEEP, `at most ${delivery.SPAWNS_PER_SWEEP} new sessions per sweep (got ${started()})`);
    assert.ok(started() >= 1, 'but delivery does start');
    assert.equal(manager.list(wp).filter(r => r.key.startsWith('inbox-reply:')).length, 0, 'no "not answered" alerts at the resume');
    assert.equal(coo.listItems(wp).filter(i => /not answered/.test(i.title)).length, 0);

    // Staggered over the next sweeps until all are delivered; one session each, never two.
    for (let i = 1; i <= 5; i++) { dispatch.sweep(wp, t0 + i * 2 * MIN); await tick(); }
    for (const p of noWork) {
      assert.equal(of(p).length, 1, `${p}: one session`);
      assert.ok(told(p).some(t => new RegExp(`Go with A, ${p}`).test(t)), `${p}: delivered`);
    }
  } finally { await done(); }
});

test('#2 resume: a reply to someone with queued work is delivered to themselves (bounded): never stuck if the dispatcher cannot start them', async () => {
  const { wp, story, done } = setup();
  try {
    floor.setPaused(wp, true, 'dry run', 'owner');
    const ask = inbox.raise(wp, { kind: 'decision', title: 'Rohan\'s question', body: 'Which way?', raisedBy: 'rohan', options: [{ id: 'a', label: 'A' }] });
    const m = inbox.reply(wp, ask.id, { by: 'owner', text: 'A, Rohan.' }).messages.filter(x => x.by === 'owner').at(-1)!;
    const s = story('Rohan\'s story, held back', 'rohan');
    // Ready, but it starts after an unfinished item: the dispatcher will not start him.
    const dep = story('Unfinished dependency', 'dev');
    items.update(wp, s.id, { startsAfter: dep.id }, 'owner');
    floor.setPaused(wp, false, 'resume', 'owner');
    const t0 = Date.now();
    dispatch.sweep(wp, t0);
    await tick();
    for (let i = 1; i <= 6 && !delivery.get(wp, m.id)!.deliveredAt; i++) { dispatch.sweep(wp, t0 + i * 2 * MIN); await tick(); }
    assert.ok(delivery.get(wp, m.id)!.deliveredAt, 'delivered within the deferral bound');
    assert.ok(told('rohan').some(t => /A, Rohan\./.test(t)));
  } finally { await done(); }
});

/* ---------- #9: a story In progress with a live session never alerts ---------- */

test('#9 manager: a digest composed while Asha was busy is told from the state at delivery: a story now In progress with a session on it is not "waiting"', async () => {
  const { wp, story, done } = setup();
  try {
    // Asha is mid-turn on something else.
    const other = story('Another story', 'kabir');
    manager.alert(wp, { key: `idle:${other.id}:t0`, itemId: other.id, title: 'Stalled: Another story', body: 'x', subjectId: 'kabir' });
    await tick();
    const ashaSession = of('asha')[0]!;
    assert.ok(ashaSession);

    const p0 = story('[P0 security] Voice errands can read the whole home folder', 'dev');
    items.update(wp, p0.id, { status: 'in-progress', reason: 'test: started' }, 'dev');
    items.update(wp, p0.id, { status: 'blocked', blockedReason: 'Held by the owner\'s pause.', waitingOn: 'external', reason: 'test: held' }, 'dev');
    // An alert about the block, and the digest listing it, both wait for her turn to end.
    manager.alert(wp, { key: `blocked:${p0.id}:t1`, itemId: p0.id, title: `Blocked: ${p0.title}`, body: 'Dev is blocked on it.', subjectId: 'dev' });
    const text = manager.digest(wp, Date.now() + 61 * MIN)!;
    assert.match(text, /Voice errands can read/);
    assert.ok(manager.list(wp).some(r => r.key.startsWith('digest:') && r.state === 'queued'));

    // The restart: the COO unblocks it and Dev's session starts on it.
    items.update(wp, p0.id, { status: 'in-progress', reason: 'COO: the pause is over' }, 'coo');
    employees.assign(wp, p0.id);
    await tick();
    assert.ok(employees.sessionOn('dev', p0.id));

    ashaSession.result();
    await tick(30);
    manager.deliver(wp, Date.now() + 62 * MIN);
    await tick(30);
    const heard = told('asha').join('\n---\n');
    assert.doesNotMatch(heard, /Voice errands can read/, 'Asha is never told the In-progress story is waiting or blocked');
    assert.equal(manager.list(wp).filter(r => r.state === 'queued' && !r.resolved).length, 0, 'nothing left queued about it');
  } finally { await done(); }
});
