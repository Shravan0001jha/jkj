import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TalkMessage } from '@jkj/shared';
import * as inbox from '../src/services/inbox.js';
import * as coo from '../src/services/coo.js';
import * as cooPickup from '../src/services/coo-pickup.js';
import * as ownerInbox from '../src/services/owner-inbox.js';
import * as delivery from '../src/services/reply-delivery.js';
import * as focus from '../src/services/focus.js';
import * as retention from '../src/services/retention.js';
import * as talkStore from '../src/services/talk-store.js';
import * as items from '../src/services/items.js';
import { Push, inQuietHours, intentFor, type PushIntent } from '../src/services/push.js';
import { Telegram } from '../src/services/telegram.js';
import type { WorkplaceEvent } from '../src/services/workplace.js';
import { installFakeRuntime, type FakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * W4 of the October rework (TDD-rework-2026-10.md): the COO is copied on and works down the owner's
 * Inbox (a 15-minute hold before the push), pushes only for what needs the owner (decisions,
 * approvals, a stall's ring), super focus lifts quiet hours, agent Talk older than 3 days is deleted,
 * and the Plan marks finished epics.
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOON_IST = Date.parse('2026-10-10T06:30:00Z');
const NIGHT_IST = Date.parse('2026-10-10T18:30:00Z'); // 00:00 IST
const tick = (ms = 15) => new Promise(r => setTimeout(r, ms));
type Wp = ReturnType<typeof testWorkplace>['wp'];

function withOauth(dir: string): void {
  mkdirSync(join(dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token-value\n');
}

const bridge = (wp: Wp) => coo.readInboxFileForTest(wp).trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);

function setup(overrides: Partial<Record<string, string>> = {}) {
  const t = testWorkplace(overrides);
  const fake = installFakeRuntime();
  withOauth(t.tmp.dir);
  const events: WorkplaceEvent[] = [];
  const off = t.wp.on(e => { events.push(e); });
  const needsYou = () => events.filter(e => e.type === 'alert' && e.level === 'needs-you');
  const decision = (raisedBy = 'asha') => inbox.raise(t.wp, {
    kind: 'decision', title: 'Ship the Windows beta?', body: 'Cert, test rig, beta-1 scope.', raisedBy,
    options: [{ id: 'approve', label: 'Approve' }, { id: 'hold', label: 'Hold' }],
  });
  return { ...t, fake, events, needsYou, decision, done: () => { off(); fake.restore(); t.tmp.cleanup(); } };
}

function pushHarness(wp: Wp, at: number) {
  const sent: PushIntent[] = [];
  const push = new Push(wp, { send: i => { sent.push(i); return true; }, now: () => at });
  push.attach();
  return { sent, push };
}

/* ---------- the COO hold ---------- */

test('1. an agent-raised owner decision writes an owner-inbox bridge line and emits no needs-you', () => {
  const s = setup();
  try {
    const item = s.decision('asha');
    assert.equal(s.needsYou().length, 0, 'held for the COO');
    assert.ok(item.cooHold, 'the item carries the hold');
    assert.ok(Math.abs(Date.parse(item.cooHold!.until) - (Date.now() + 15 * MIN)) < 5_000);
    const line = bridge(s.wp).find(l => l['kind'] === 'owner-inbox');
    assert.ok(line, 'copied to the COO bridge');
    assert.equal(line!['inboxId'], item.id);
    assert.equal(line!['title'], item.title);
    assert.equal(line!['raisedBy'], 'asha');
    assert.equal(line!['summary'], item.summary);
    // The owner still sees it in his Inbox while it is held; only the push waits.
    assert.ok(inbox.ownerList(s.wp, 'open').some(i => i.id === item.id));
    // GET /api/coo/owner-inbox: the open owner items, held ones included.
    assert.ok(ownerInbox.list(s.wp).some(i => i.id === item.id && i.cooHold));
  } finally { s.done(); }
});

test('1b. the COO\'s own items and routine housekeeping are not held', () => {
  const s = setup();
  try {
    const mine = s.decision('coo');
    assert.equal(mine.cooHold, undefined);
    assert.deepEqual(s.needsYou().map(e => (e as { inboxId?: string }).inboxId), [mine.id], 'the COO\'s item pushes at once');
    const routine = inbox.raise(s.wp, { kind: 'question', title: 'Stall note', body: 'x', raisedBy: 'asha', ownerFacing: false });
    assert.equal(routine.cooHold, undefined);
    assert.equal(bridge(s.wp).filter(l => l['kind'] === 'owner-inbox').length, 0, 'nothing copied for the COO\'s own or routine items');
  } finally { s.done(); }
});

test('2. after 15 minutes the sweep emits needs-you once and clears the hold', () => {
  const s = setup();
  try {
    const item = s.decision();
    assert.deepEqual(ownerInbox.releaseHolds(s.wp, Date.now() + 14 * MIN), [], 'not yet');
    assert.equal(s.needsYou().length, 0);
    assert.deepEqual(ownerInbox.releaseHolds(s.wp, Date.now() + 15 * MIN + 1_000), [item.id]);
    assert.deepEqual(s.needsYou().map(e => (e as { inboxId?: string }).inboxId), [item.id]);
    assert.equal(inbox.get(s.wp, item.id)!.cooHold, undefined, 'the hold is cleared');
    assert.deepEqual(ownerInbox.releaseHolds(s.wp, Date.now() + 30 * MIN), [], 'once only');
    assert.equal(s.needsYou().length, 1);
  } finally { s.done(); }
});

test('3. resolve answers it by the COO, delivers the reply to the raiser, and never pushes', async () => {
  const s = setup();
  try {
    const p = pushHarness(s.wp, NOON_IST);
    const item = s.decision('asha');
    const answered = ownerInbox.resolve(s.wp, item.id, { text: 'Hold it: no cert until Q4. I decided this within my rights.', optionId: 'hold' });
    assert.equal(answered.state, 'answered');
    assert.equal(answered.answer?.optionId, 'hold');
    assert.equal(answered.answer?.by, 'coo');
    assert.equal(answered.cooHold, undefined);
    await tick();
    // Delivered through reply-delivery, to the raiser.
    const d = delivery.list(s.wp).find(x => x.inboxId === item.id);
    assert.ok(d, 'a delivery row');
    assert.equal(d!.target, 'asha');
    assert.match(d!.text, /no cert until Q4/);
    assert.ok(d!.deliveredAt, 'handed to Asha\'s session');
    const toAsha = s.fake.sessions.filter(x => x.options.cwd.includes('/asha/')).flatMap(x => [x.options.prompt, ...x.sent.map(m => m.text)]);
    assert.ok(toAsha.some(t => /The COO answered .*Ship the Windows beta\?.*no cert until Q4/s.test(t)), toAsha.join('\n---\n'));
    // Never pushed, not even when the hold would have run out.
    ownerInbox.releaseHolds(s.wp, Date.now() + 20 * MIN);
    assert.equal(s.needsYou().length, 0);
    assert.equal(p.sent.length, 0);
    p.push.stop();
    // The COO pickup alarm does not fire for an item the COO resolved.
    assert.deepEqual(cooPickup.check(s.wp, Date.now() + 20 * MIN), []);
    // Twice is a conflict.
    assert.throws(() => ownerInbox.resolve(s.wp, item.id, { text: 'again' }), /already answered/);
  } finally { s.done(); }
});

test('3b. resolve without an option on a question records the text as its answer; a missing text is refused', () => {
  const s = setup();
  try {
    const q = inbox.raise(s.wp, { kind: 'question', title: 'Which voice for Nova?', body: 'x', raisedBy: 'asha' });
    assert.throws(() => ownerInbox.resolve(s.wp, q.id, { text: '  ' }), /needs a text/);
    assert.throws(() => ownerInbox.resolve(s.wp, q.id, { text: 'x', optionId: 'nope' }), /not one of the options/);
    const a = ownerInbox.resolve(s.wp, q.id, { text: 'The warm one, as in the brief.' });
    assert.equal(a.answer?.optionId, 'answered');
    assert.equal(a.answer?.note, 'The warm one, as in the brief.');
    assert.equal(a.answer?.by, 'coo');
  } finally { s.done(); }
});

test('4. needs-you with a note pushes immediately and stores cooNote', () => {
  const s = setup();
  try {
    const p = pushHarness(s.wp, NOON_IST);
    const item = s.decision('asha');
    assert.equal(p.sent.length, 0, 'held');
    const next = ownerInbox.needsYou(s.wp, item.id, { text: 'Needs you because it spends ₹4k a month.' });
    assert.equal(next.cooNote?.text, 'Needs you because it spends ₹4k a month.');
    assert.ok(next.cooNote?.at);
    assert.equal(next.cooHold, undefined);
    assert.equal(p.sent.length, 1);
    assert.equal(p.sent[0]!.category, 'WP_INBOX');
    assert.equal(p.sent[0]!.data.inboxId, item.id);
    assert.equal(inbox.get(s.wp, item.id)!.cooNote?.text, 'Needs you because it spends ₹4k a month.', 'stored');
    // The sweep does not push it a second time.
    assert.deepEqual(ownerInbox.releaseHolds(s.wp, Date.now() + 20 * MIN), []);
    assert.equal(p.sent.length, 1);
    assert.throws(() => ownerInbox.needsYou(s.wp, item.id, { text: '' }), /needs a text/);
    p.push.stop();
  } finally { s.done(); }
});

test('4b. the COO pickup alarm does not fire for an owner message about an item the COO resolved or flagged', () => {
  const s = setup();
  try {
    const a = s.decision('asha');
    const b = inbox.raise(s.wp, { kind: 'question', title: 'Which voice?', body: 'x', raisedBy: 'mira' });
    const c = inbox.raise(s.wp, { kind: 'question', title: 'Which port?', body: 'x', raisedBy: 'kabir' });
    coo.sendOwnerMessage(s.wp, `What about ${a.id}?`);
    coo.sendOwnerMessage(s.wp, `And ${b.id}, please.`);
    coo.sendOwnerMessage(s.wp, `And ${c.id}?`);
    ownerInbox.resolve(s.wp, a.id, { text: 'Hold until Q4.', optionId: 'hold' });
    ownerInbox.needsYou(s.wp, b.id, { text: 'Needs you: it is your voice call.' });
    const late = cooPickup.check(s.wp, Date.now() + 16 * MIN);
    assert.equal(late.length, 1, 'only the message about the item the COO did not touch');
    const lines = bridge(s.wp).filter(l => l['kind'] === 'message');
    assert.equal(late[0], lines.find(l => String(l['text']).includes(c.id))!['id']);
  } finally { s.done(); }
});

/* ---------- push ---------- */

test('5. intentFor: an update is null and a Team Room mention is null', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const update = { type: 'update.posted', update: { id: 'up_1', at: new Date().toISOString(), kind: 'blocked', line: 'Blocked: x', by: 'asha', href: 'plan', push: true } } as unknown as WorkplaceEvent;
    assert.equal(intentFor(wp, update, ['owner']), null);
    const mention = { type: 'room.message', message: { id: 'm1', threadId: 't1', at: new Date().toISOString(), by: 'asha', text: '@owner your call?' }, thread: { id: 't1', title: 'Repo split' } } as unknown as WorkplaceEvent;
    assert.equal(intentFor(wp, mention, ['owner']), null);
  } finally { tmp.cleanup(); }
});

test('6. a ring gives WP_ALERT with the critical sound, even in quiet hours; Telegram hears only cap and ring', async () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_PUSH_QUIET: '23-07' });
  try {
    const ring = { type: 'alert', level: 'ring', title: 'Stalled 40 min: Mic stays live', body: '2 stories stalled' } as WorkplaceEvent;
    const intent = intentFor(wp, ring, ['owner']);
    assert.equal(intent?.category, 'WP_ALERT');
    assert.equal(intent?.level, 'ring');
    assert.equal(intent?.sound, 'critical');
    const p = pushHarness(wp, NIGHT_IST);
    wp.emit({ type: 'alert', level: 'needs-you', title: 'Tara is waiting for a tool approval', body: 'Bash' });
    wp.emit(ring);
    assert.deepEqual(p.sent.map(x => x.level), ['ring'], 'quiet hours drop the tool approval, never the ring');
    p.push.stop();

    const texts: string[] = [];
    const tg = new Telegram(wp, { send: async t => { texts.push(t); return true; } });
    (wp.config as { telegram: boolean }).telegram = true;
    tg.attach();
    wp.emit({ type: 'alert', level: 'needs-you', title: 'A decision', body: 'x', inboxId: 'in_x' });
    wp.emit({ type: 'alert', level: 'blocked', title: 'Release failed', body: 'x' });
    wp.emit({ type: 'alert', level: 'cap', title: 'Cap reached: company', body: '₹5000 of ₹5000' });
    wp.emit(ring);
    await tick();
    assert.equal(texts.length, 2, texts.join('\n'));
    assert.match(texts[0]!, /₹5000/);
    assert.match(texts[1]!, /2 stories stalled/);
  } finally { tmp.cleanup(); }
});

/* ---------- super focus ---------- */

test('7. super focus on makes inQuietHours false, until it runs out or is cleared', () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_PUSH_QUIET: '23-07' });
  try {
    assert.deepEqual(focus.getSuperFocus(wp), { until: null });
    assert.equal(focus.superFocusActive(wp, NIGHT_IST), false);
    assert.equal(inQuietHours('23-07', NIGHT_IST, wp), true);
    const on = focus.setSuperFocus(wp, { hours: 3, by: 'owner' }, NIGHT_IST - MIN);
    assert.equal(on.until, new Date(NIGHT_IST - MIN + 3 * 60 * MIN).toISOString());
    assert.deepEqual(focus.getSuperFocus(wp), on);
    assert.equal(focus.superFocusActive(wp, NIGHT_IST), true);
    assert.equal(inQuietHours('23-07', NIGHT_IST, wp), false);
    assert.equal(inQuietHours('23-07', NIGHT_IST + 4 * 60 * MIN, wp), true, 'it runs out');
    // The push follows: a needs-you at night goes out during super focus.
    const p = pushHarness(wp, NIGHT_IST);
    inbox.raise(wp, { kind: 'decision', title: 'Night call', body: 'x', raisedBy: 'coo' });
    assert.equal(p.sent.length, 1);
    p.push.stop();
    assert.deepEqual(focus.setSuperFocus(wp, { hours: 0, by: 'coo' }, NIGHT_IST), { until: null });
    assert.equal(focus.superFocusActive(wp, NIGHT_IST), false);
    assert.equal(inQuietHours('23-07', NIGHT_IST, wp), true);
  } finally { tmp.cleanup(); }
});

test('8. only the owner and the COO can set super focus; hours must be a sane number', () => {
  const { wp, tmp } = testWorkplace();
  try {
    assert.throws(() => focus.setSuperFocus(wp, { hours: 2, by: 'asha' }), /owner or the COO/);
    assert.throws(() => focus.setSuperFocus(wp, { hours: 2, by: 'vikram' }), /owner or the COO/);
    assert.throws(() => focus.setSuperFocus(wp, { hours: -1, by: 'owner' }), /hours/);
    assert.throws(() => focus.setSuperFocus(wp, { hours: Number.NaN, by: 'owner' }), /hours/);
    assert.throws(() => focus.setSuperFocus(wp, { hours: 100, by: 'owner' }), /hours/);
    assert.deepEqual(focus.getSuperFocus(wp), { until: null }, 'nothing was set');
    assert.ok(focus.setSuperFocus(wp, { hours: 1, by: 'coo' }).until);
  } finally { tmp.cleanup(); }
});

/* ---------- retention ---------- */

function message(wp: Wp, m: Partial<TalkMessage> & Pick<TalkMessage, 'threadId' | 'from' | 'direction' | 'at'>): TalkMessage {
  return talkStore.insert(wp, { id: `talk_${Math.random().toString(36).slice(2, 10)}`, fromName: m.from, text: 'x', mentions: [], attachments: [], ...m });
}

test('9–11. retention deletes agent out messages older than 3 days and their files; keeps the rest', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const att = talkStore.saveAttachment(wp, 'mira', { name: 'shot.png', mediaType: 'image/png', data: Buffer.from('png-bytes') });
    const attPath = talkStore.attachment(wp, att.id)!.path;
    assert.ok(existsSync(attPath));
    const old = message(wp, { threadId: 'mira', from: 'mira', direction: 'out', at: iso(now - 4 * DAY), attachments: [att], text: 'Done with the gate.' });
    const recent = message(wp, { threadId: 'mira', from: 'mira', direction: 'out', at: iso(now - 2 * DAY) });
    const ownerOld = message(wp, { threadId: 'mira', from: 'owner', direction: 'in', at: iso(now - 5 * DAY) });
    const cooOld = message(wp, { threadId: 'coo', from: 'coo', direction: 'out', at: iso(now - 9 * DAY) });
    const ownerToCoo = message(wp, { threadId: 'coo', from: 'owner', direction: 'in', at: iso(now - 9 * DAY) });
    const workplaceOld = message(wp, { threadId: 'mira', from: 'workplace', direction: 'in', at: iso(now - 6 * DAY) });
    // An owner attachment on a kept message is never touched.
    const ownerAtt = talkStore.saveAttachment(wp, 'mira', { name: 'brief.pdf', mediaType: 'application/pdf', data: Buffer.from('%PDF') });
    message(wp, { threadId: 'mira', from: 'owner', direction: 'in', at: iso(now - 7 * DAY), attachments: [ownerAtt] });

    const r = retention.sweep(wp, now);
    assert.equal(r.messages, 1);
    assert.equal(r.attachments, 1);
    // 9: the 4-day-old agent message is gone.
    assert.equal(talkStore.getMessage(wp, old.id), undefined);
    // 10: the rest are kept.
    for (const m of [recent, ownerOld, cooOld, ownerToCoo, workplaceOld]) assert.ok(talkStore.getMessage(wp, m.id), `${m.from} ${m.threadId} kept`);
    // 11: its attachment row and file are gone; the owner's file stays.
    assert.equal(talkStore.attachment(wp, att.id), undefined);
    assert.equal(existsSync(attPath), false);
    assert.ok(talkStore.attachment(wp, ownerAtt.id));
    assert.ok(existsSync(talkStore.attachment(wp, ownerAtt.id)!.path));
    // Running again deletes nothing more.
    assert.deepEqual(retention.sweep(wp, now), { messages: 0, attachments: 0 });
  } finally { tmp.cleanup(); }
});

test('retention runs once per IST day from the rhythm tick', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const now = Date.now();
    message(wp, { threadId: 'mira', from: 'mira', direction: 'out', at: new Date(now - 4 * DAY).toISOString() });
    assert.deepEqual(retention.maybeRun(wp, now), { messages: 1, attachments: 0 });
    message(wp, { threadId: 'mira', from: 'mira', direction: 'out', at: new Date(now - 4 * DAY).toISOString() });
    assert.equal(retention.maybeRun(wp, now + MIN), null, 'already ran today');
    assert.deepEqual(retention.maybeRun(wp, now + DAY), { messages: 1, attachments: 0 }, 'the next day');
  } finally { tmp.cleanup(); }
});

/* ---------- plan ---------- */

test('12. plan() reports finished epics with finished: true', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const shipped = items.create(wp, { level: 'epic', title: 'Shipped epic' }, 'owner');
    items.create(wp, { level: 'story', parentId: shipped.id, title: 'Only story', assigneeId: 'dev' }, 'asha');
    items.update(wp, shipped.id, { status: 'done', resolution: 'done', note: 'shipped in 0.2.21' }, 'owner');
    const open = items.create(wp, { level: 'epic', title: 'Open epic' }, 'owner');
    items.create(wp, { level: 'story', parentId: open.id, title: 'Open story', assigneeId: 'dev' }, 'asha');
    const cards = items.plan(wp).unfiled;
    assert.deepEqual(cards.map(c => [c.epic.title, c.finished]), [['Open epic', false], ['Shipped epic', true]]);
  } finally { tmp.cleanup(); }
});
