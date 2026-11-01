import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TalkMessage } from '@jkj/shared';
import { Push, type PushIntent } from '../src/services/push.js';
import * as prefs from '../src/services/chat-prefs.js';
import * as room from '../src/services/room.js';
import { testWorkplace } from './fakes/workplace.js';

/** Owner, 1 Nov (CHAT-NOTIFY-CONTRACT §1-3): Telegram-style chat pushes, per-chat mute, shared items. */

const T0 = Date.parse('2026-11-01T06:00:00Z');   // 11:30 IST, outside any quiet hours

function harness() {
  const { wp, tmp } = testWorkplace();
  const sent: PushIntent[] = [];
  let t = T0;
  const push = new Push(wp, { send: i => { sent.push(i); return true; }, now: () => t });
  return { wp, tmp, sent, push, tick: (ms: number) => { t += ms; }, now: () => t };
}

let seq = 0;
const talk = (over: Partial<TalkMessage> = {}): TalkMessage => ({
  id: `tm_${++seq}`, threadId: 'dev', at: new Date(T0).toISOString(), from: 'dev' as never, fromName: 'Dev',
  direction: 'out', text: 'The build is green.', mentions: [], attachments: [], ...over,
});
const talkEvent = (m: TalkMessage) => ({ type: 'talk.message' as const, message: m, thread: { id: m.threadId } as never });

test('prefs: defaults are COO and Talk unmuted, rooms muted; every thread is listed', () => {
  const { wp, tmp } = harness();
  try {
    const t = room.createThread(wp, { title: 'Alarms', text: 'hi', by: 'dev' }).thread;
    const all = prefs.all(wp, T0);
    assert.equal(all['coo']?.muted, false);
    assert.equal(all['dev']?.muted, false);
    assert.equal(all[t.id]?.muted, true);
  } finally { tmp.cleanup(); }
});

test('prefs: set round-trips, emits chat.prefs, an expired mutedUntil reads as unmuted, unknown thread throws', () => {
  const { wp, tmp } = harness();
  try {
    const events: unknown[] = [];
    wp.on(e => { if (e.type === 'chat.prefs') events.push(e); });
    const until = new Date(T0 + 3_600_000).toISOString();
    assert.deepEqual(prefs.set(wp, 'dev', { muted: true, mutedUntil: until }, T0), { muted: true, mutedUntil: until });
    assert.equal(events.length, 1);
    assert.equal(prefs.isMuted(wp, 'dev', T0 + 1000), true);
    assert.equal(prefs.isMuted(wp, 'dev', T0 + 3_600_001), false);
    assert.throws(() => prefs.set(wp, 'nope', { muted: true, mutedUntil: null }, T0), /No chat/);
    assert.throws(() => prefs.set(wp, 'dev', { muted: true, mutedUntil: 'tomorrow' }, T0), /mutedUntil/);
  } finally { tmp.cleanup(); }
});

test('push: an agent Talk message pushes the text; the owner, quiet narration and repeats do not', () => {
  const h = harness();
  try {
    const m = talk({ text: 'The build is green.\n\nTwo tests were flaky.' });
    const p = h.push.handle(talkEvent(m))!;
    assert.equal(p.category, 'WP_CHAT');
    assert.equal(p.title, 'Dev');
    assert.equal(p.body, 'The build is green. Two tests were flaky.');
    assert.equal(p.threadId, 'chat:dev');
    assert.equal(p.collapseId, `chat:${m.id}`);
    assert.deepEqual(p.data, { link: 'chat/dev', threadId: 'dev', employeeId: 'dev' });
    assert.equal(h.push.handle(talkEvent({ ...m, receipt: 'read' })), null, 'the same message re-published (receipt) does not push again');
    assert.equal(h.push.handle(talkEvent(talk({ direction: 'in', from: 'owner' as never }))), null);
    assert.equal(h.push.handle(talkEvent(talk({ quiet: true }))), null);
  } finally { h.tmp.cleanup(); }
});

test('push: the COO thread links to chat/coo; the coo.message event itself never pushes (its Talk mirror does)', () => {
  const h = harness();
  try {
    const p = h.push.handle(talkEvent(talk({ threadId: 'coo', from: 'coo' as never, fromName: 'Claude — COO' })))!;
    assert.deepEqual(p.data, { link: 'chat/coo', threadId: 'coo' });
    assert.equal(p.threadId, 'chat:coo');
    assert.equal(h.push.handle({ type: 'coo.message', message: { id: 'c1', at: '', from: 'coo', text: 'hi' } }), null);
  } finally { h.tmp.cleanup(); }
});

test('push: muted threads send nothing; rooms are muted until the owner unmutes them', () => {
  const h = harness();
  try {
    prefs.set(h.wp, 'dev', { muted: true, mutedUntil: null }, T0);
    assert.equal(h.push.handle(talkEvent(talk())), null);
    const t = room.createThread(h.wp, { title: 'Alarms', text: 'start', by: 'dev' }).thread;
    const msg = { id: 'rm1', threadId: t.id, at: '', by: 'dev', owner: false, text: 'Repeat alarms merged.', mentions: [] };
    assert.equal(h.push.handle({ type: 'room.message', message: msg, thread: t }), null);
    prefs.set(h.wp, t.id, { muted: false, mutedUntil: null }, T0);
    const p = h.push.handle({ type: 'room.message', message: msg, thread: t })!;
    assert.equal(p.title.endsWith('· Alarms'), true);
    assert.deepEqual(p.data, { link: `room/${t.id}`, threadId: t.id });
    assert.equal(h.push.handle({ type: 'room.message', message: { ...msg, id: 'rm2', by: 'workplace', kind: 'update' as const }, thread: t }), null);
  } finally { h.tmp.cleanup(); }
});

test('push: body capped at 1000; attachment-only label; secrets scrubbed; long thread ids hashed to 32', async () => {
  const { chatBody, apnsThread } = await import('../src/services/push.js');
  assert.equal(chatBody(talk({ text: 'x '.repeat(900) })).length, 1000);
  assert.equal(chatBody(talk({ text: '', attachments: [{ id: 'a', name: 'shot.png', kind: 'image', mediaType: 'image/png', size: 1 } as never] })), '📷 Photo');
  assert.equal(chatBody(talk({ text: '', attachments: [{ id: 'a', name: 'plan.pdf', kind: 'file', mediaType: 'application/pdf', size: 1 } as never] })), '📄 plan.pdf');
  assert.equal(chatBody(talk({ text: 'token = abc123' })), 'Open the app for details');
  assert.equal(apnsThread('coo'), 'chat:coo');
  const long = apnsThread('th_' + 'a'.repeat(60));
  assert.equal(long.length, 32);
  assert.equal(long, apnsThread('th_' + 'a'.repeat(60)), 'deterministic');
});

test('push: more than 4 messages a minute from one thread fold into one "N new messages" push when the minute ends', () => {
  const h = harness();
  try {
    const out = [];
    for (let i = 0; i < 10; i++) { out.push(h.push.handle(talkEvent(talk()))); h.tick(1000); }
    assert.equal(out.filter(Boolean).length, 4, 'the first 4 send as they come');
    h.tick(51_000);   // the thread's minute window (from its first message) has ended
    const flushed = h.push.flushChats();
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0]!.body, '6 new messages');
    assert.equal(flushed[0]!.threadId, 'chat:dev');
    assert.equal(flushed[0]!.data.link, 'chat/dev');
    assert.equal(h.push.flushChats().length, 0, 'nothing held twice');
    h.tick(1000);
    assert.equal(h.push.handle(talkEvent(talk({ text: 'after the window' })))?.body, 'after the window');
  } finally { h.tmp.cleanup(); }
});

test('routes: GET /api/chats/prefs lists effective prefs; PUT saves; unknown chat 404; bad body 400', async () => {
  const { boot, call } = await import('./fakes/boot.js');
  const b = await boot();
  try {
    const all = await call<Record<string, { muted: boolean }>>(b.base, 'GET', '/api/chats/prefs');
    assert.equal(all.status, 200);
    assert.equal(all.body['coo']?.muted, false);
    const put = await call<{ muted: boolean; mutedUntil: string | null }>(b.base, 'PUT', '/api/chats/coo/prefs', { muted: true, mutedUntil: null });
    assert.equal(put.status, 200);
    assert.equal(put.body.muted, true);
    assert.equal((await call<Record<string, { muted: boolean }>>(b.base, 'GET', '/api/chats/prefs')).body['coo']?.muted, true);
    assert.equal((await call(b.base, 'PUT', '/api/chats/nope/prefs', { muted: true, mutedUntil: null })).status, 404);
    assert.equal((await call(b.base, 'PUT', '/api/chats/coo/prefs', { muted: 'yes' })).status, 400);
  } finally { await b.stop(); }
});

test('shared: media, files and links come out separately, newest first; pages of 50 with a cursor', async () => {
  const store = await import('../src/services/talk-store.js');
  const { shared, PAGE } = await import('../src/services/chat-shared.js');
  const { wp, tmp } = harness();
  try {
    const att = (id: string, kind: 'image' | 'file' | 'voice', name: string) => ({ id, name, mediaType: kind === 'image' ? 'image/png' : 'application/pdf', size: 10, kind, url: `/api/talk/attachments/${id}` });
    store.insert(wp, talk({ id: 's1', at: '2026-11-01T06:00:01Z', text: 'see https://dash.irisforu.com/ and https://example.com/a?b=1.', attachments: [att('a1', 'image', 'shot.png')] }));
    store.insert(wp, talk({ id: 's2', at: '2026-11-01T06:00:02Z', text: '', attachments: [att('a2', 'file', 'plan.pdf'), att('v1', 'voice', 'note.m4a')] }));
    assert.deepEqual(shared(wp, 'dev', 'media').items.map(i => i.attachmentId), ['a1']);
    assert.deepEqual(shared(wp, 'dev', 'files').items.map(i => i.name), ['plan.pdf'], 'voice notes are not files');
    assert.deepEqual(shared(wp, 'dev', 'links').items.map(i => i.url), ['https://dash.irisforu.com/', 'https://example.com/a?b=1']);
    for (let i = 0; i < PAGE + 5; i++) store.insert(wp, talk({ id: `p${i}`, at: new Date(Date.parse('2026-11-01T07:00:00Z') + i * 1000).toISOString(), text: `link https://x.test/${i}` }));
    const p1 = shared(wp, 'dev', 'links');
    assert.equal(p1.items.length, PAGE);
    assert.ok(p1.next);
    const p2 = shared(wp, 'dev', 'links', p1.next);
    assert.equal(p2.items.length, 7);   // 5 more pages-worth links + the 2 from s1
    assert.equal(p2.next, null);
    const t = room.createThread(wp, { title: 'Links', text: 'spec at https://notion.so/x', by: 'dev' }).thread;
    assert.deepEqual(shared(wp, t.id, 'links').items.map(i => i.url), ['https://notion.so/x']);
    assert.deepEqual(shared(wp, t.id, 'media').items, []);
    assert.throws(() => shared(wp, 'nope', 'links'), /No chat/);
    assert.throws(() => shared(wp, 'dev', 'pics'), /kind must be/);
  } finally { tmp.cleanup(); }
});
