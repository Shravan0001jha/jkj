import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEntry, TalkMessage, TalkThread, WorkplaceEvent } from '@jkj/shared';
import { boot, tick, type Booted } from './fakes/boot.js';
import * as employees from '../src/services/employees.js';
import * as runs from '../src/services/runs.js';
import * as talkStore from '../src/services/talk-store.js';
import { useTranscriber } from '../src/services/stt.js';
import { resetForTest } from '../src/services/mentions.js';

/** Talk threads, senders, receipts, typing, replies, mentions, files, voice (docs/LLD-app-fixes.md). */

const COO = { 'x-workplace-actor': 'coo' };

async function req<T>(b: Booted, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${b.base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() as T };
}

async function upload<T>(b: Booted, path: string, data: Buffer, mediaType: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${b.base}${path}`, { method: 'POST', headers: { 'content-type': mediaType }, body: new Uint8Array(data) });
  return { status: res.status, body: await res.json() as T };
}

function events(b: Booted): WorkplaceEvent[] {
  const seen: WorkplaceEvent[] = [];
  b.running.wp.on(e => seen.push(e));
  return seen;
}

type Sent = { message: TalkMessage; id: string };

async function withBoot(fn: (b: Booted) => Promise<void>): Promise<void> {
  const b = await boot();
  try { await fn(b); } finally { await b.stop(); }
}

/* ---------- 1. the sender ---------- */

test('the COO talking to an employee is recorded as the COO, not the owner, on every path', () => withBoot(async b => {
  const first = await req<Sent>(b, 'POST', '/api/employees/mira/talk', { text: 'Please look at the crash.' }, COO);
  assert.equal(first.status, 201);
  assert.equal(first.body.message.from, 'coo');
  assert.equal(first.body.message.fromName, 'Claude — COO');
  const agentId = first.body.id;
  const log = await req<LogEntry[]>(b, 'GET', `/api/agents/${agentId}/log`);
  const line = log.body.find(e => e.kind === 'user')!;
  assert.equal(line.from, 'coo', 'the transcript line is the COO\'s');
  assert.equal(line.fromName, 'Claude — COO');

  // The follow-up into the open session, and the raw agent route, too.
  const second = await req<Sent>(b, 'POST', '/api/employees/mira/talk', { text: 'And the logs.' }, COO);
  assert.equal(second.body.message.from, 'coo');
  await req(b, 'POST', `/api/agents/${agentId}/message`, { text: 'Third.' }, COO);
  const owner = await req<Sent>(b, 'POST', '/api/employees/mira/talk', { text: 'From me.' });
  assert.equal(owner.body.message.from, 'owner');
  assert.equal(owner.body.message.fromName, 'You');

  const thread = await req<TalkMessage[]>(b, 'GET', '/api/talk/threads/mira/messages');
  assert.deepEqual(thread.body.filter(m => m.direction === 'in').map(m => [m.from, m.text]), [
    ['coo', 'Please look at the crash.'], ['coo', 'And the logs.'], ['coo', 'Third.'], ['owner', 'From me.'],
  ]);
}));

test('the Workplace\'s own prompts are "workplace", never the owner (assignment, mention wake-up)', () => withBoot(async b => {
  const wp = b.running.wp;
  employees.talk(wp, 'dev', 'Team Room moderation: read the threads.', [], { autonomous: true });
  const msgs = talkStore.messages(wp, 'dev');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]!.from, 'workplace');
  assert.equal(msgs[0]!.fromName, 'Workplace');
  // A COO saying "continue" does not lift the owner's cap pause; only the owner's own words do (unchanged).
}));

test('a transcript read back from disk gets its senders back from the Talk store', () => withBoot(async b => {
  const wp = b.running.wp;
  await req(b, 'POST', '/api/employees/mira/talk', { text: 'Ship it tonight?' }, COO);
  const fromDisk: LogEntry[] = [{ id: 'x', agentId: 's', at: '2026-10-04T00:00:00Z', kind: 'user', label: '', text: 'Ship it tonight?' }, { id: 'y', agentId: 's', at: '2026-10-04T00:00:00Z', kind: 'user', label: '', text: 'unknown words' }];
  const out = talkStore.overlaySenders(wp, fromDisk);
  assert.equal(out[0]!.from, 'coo');
  assert.equal(out[1]!.from, undefined, 'a line the store never saw is left as it was');
}));

/* ---------- 3–4. receipts and typing ---------- */

test('receipts: delivered when handed over, read only when a turn consumes it (stamped by the SDK, in order)', () => withBoot(async b => {
  const seen = events(b);
  const a = await req<Sent>(b, 'POST', '/api/employees/mira/talk', { text: 'one' });
  assert.equal(a.body.message.receipt, 'delivered');
  assert.ok(a.body.message.deliveredAt);
  const s = b.fake.last();
  // A second message while the first is still queued: both delivered, neither read.
  const second = await req<Sent>(b, 'POST', '/api/employees/mira/talk', { text: 'two' });
  const third = await req<Sent>(b, 'POST', '/api/employees/mira/talk', { text: 'three' });
  assert.equal(talkStore.getMessage(b.running.wp, a.body.message.id)!.receipt, 'delivered');
  // The SDK stamps the turn with the uuid of "two": "one" (older) and "two" are read, "three" is not.
  const twoUuid = s.sent.find(x => x.text === 'two')!.uuid!;
  s.turn([twoUuid]);
  s.say('On it.');
  const get = (id: string) => talkStore.getMessage(b.running.wp, id)!;
  assert.equal(get(a.body.message.id).receipt, 'read');
  assert.equal(get(second.body.message.id).receipt, 'read');
  assert.ok(get(second.body.message.id).readAt);
  assert.equal(get(third.body.message.id).receipt, 'delivered');
  s.result();
  // The next turn without stamps (an older CLI): everything handed over is read.
  s.say('And three.');
  assert.equal(get(third.body.message.id).receipt, 'read');
  const receiptEvents = seen.filter((e): e is Extract<WorkplaceEvent, { type: 'talk.message' }> => e.type === 'talk.message' && e.message.id === a.body.message.id);
  assert.deepEqual(receiptEvents.map(e => e.message.receipt), ['delivered', 'read'], 'the change is pushed with the same message id');
}));

test('typing: only while a turn that consumed the owner\'s message runs; never while queued; cleared on result and error', () => withBoot(async b => {
  const seen = events(b);
  const typing = () => seen.filter((e): e is Extract<WorkplaceEvent, { type: 'talk.typing' }> => e.type === 'talk.typing').map(e => `${e.threadId}:${e.typing}`);
  await req(b, 'POST', '/api/employees/mira/talk', { text: 'hello' });
  await tick();
  assert.deepEqual(typing(), [], 'queued is not typing');
  const s = b.fake.last();
  s.turn(undefined);
  assert.deepEqual(typing(), ['mira:true']);
  assert.equal((await req<TalkThread>(b, 'GET', '/api/talk/threads/mira')).body.typing, true);
  s.say('Hi.');
  s.result();
  assert.deepEqual(typing(), ['mira:true', 'mira:false']);
  // A Workplace prompt's turn never types.
  employees.talk(b.running.wp, 'mira', 'Write your status.', [], { autonomous: true });
  s.say('Status written.');
  s.result();
  assert.deepEqual(typing(), ['mira:true', 'mira:false']);
  // An error ends typing too.
  await req(b, 'POST', '/api/employees/mira/talk', { text: 'again' });
  s.say('Working…');
  s.events.onError('boom');
  assert.deepEqual(typing(), ['mira:true', 'mira:false', 'mira:true', 'mira:false']);
}));

/* ---------- 2. the thread list ---------- */

test('threads: unread counts the agent\'s replies to a person, mark-read clears them, pinned first then unread then recent', () => withBoot(async b => {
  await req(b, 'POST', '/api/employees/mira/talk', { text: 'status?' });
  const s = b.fake.last();
  s.say('Two lines of status.');
  s.say('And a second message.');
  s.result();
  employees.talk(b.running.wp, 'mira', 'Write your handoff.', [], { autonomous: true });
  s.say('Handoff written.');   // narration of Workplace work: quiet, not unread
  s.result();
  await req(b, 'POST', '/api/employees/dev/talk', { text: 'hey dev' });
  const msgs = talkStore.messages(b.running.wp, 'mira');
  assert.equal(msgs.find(m => m.text === 'Handoff written.')!.quiet, true);

  let list = (await req<TalkThread[]>(b, 'GET', '/api/talk/threads')).body;
  const mira = list.find(t => t.id === 'mira')!;
  assert.equal(mira.unreadCount, 2);
  assert.equal(mira.lastMessage!.text, 'And a second message.');
  assert.ok(list.some(t => t.id === 'coo' && t.name === 'Claude — COO'));
  assert.equal(list[0]!.id, 'mira', 'unread first');
  assert.equal(list[1]!.id, 'dev', 'then the most recent');

  const read = await req<TalkThread>(b, 'POST', '/api/talk/threads/mira/read', {});
  assert.equal(read.body.unreadCount, 0);
  assert.ok(read.body.lastReadAt);
  const pin = await req<TalkThread>(b, 'POST', '/api/talk/threads/kabir/pin', { pinned: true });
  assert.equal(pin.body.pinned, true);
  list = (await req<TalkThread[]>(b, 'GET', '/api/talk/threads')).body;
  assert.equal(list[0]!.id, 'kabir', 'pinned first even with no messages');
  await req(b, 'POST', '/api/talk/threads/kabir/pin', { pinned: false });
  list = (await req<TalkThread[]>(b, 'GET', '/api/talk/threads')).body;
  assert.notEqual(list[0]!.id, 'kabir');
  assert.equal((await req(b, 'POST', '/api/talk/threads/nobody/read', {})).status, 404);
  assert.equal((await req(b, 'POST', '/api/talk/threads/mira/pin', { pinned: 'yes' })).status, 400);

  // Paging: before = an id returns what came earlier.
  const all = talkStore.messages(b.running.wp, 'mira');
  const page = (await req<TalkMessage[]>(b, 'GET', `/api/talk/threads/mira/messages?before=${all[2]!.id}&limit=1`)).body;
  assert.deepEqual(page.map(m => m.id), [all[1]!.id]);
}));

/* ---------- 5. reply-to and mentions ---------- */

test('reply-to is quoted for the app and the agent; several @mentions are kept and each tagged person is woken', () => withBoot(async b => {
  resetForTest();
  const first = await req<Sent>(b, 'POST', '/api/employees/mira/talk', { text: 'Which voice do we ship?' });
  const s = b.fake.last();
  s.say('Aria, I think.');
  s.result();
  const reply = talkStore.messages(b.running.wp, 'mira').find(m => m.direction === 'out')!;
  const sent = await req<Sent>(b, 'POST', '/api/talk/threads/mira/messages', { text: 'Agreed, check with them.', replyTo: reply.id, mentions: ['dev', 'nikhil'] });
  assert.equal(sent.status, 201);
  assert.deepEqual(sent.body.message.replyTo, { id: reply.id, from: 'mira', fromName: 'Mira', text: 'Aria, I think.' });
  assert.deepEqual(sent.body.message.mentions, ['dev', 'nikhil']);
  assert.match(s.sent.at(-1)!.text, /^> Replying to Mira: "Aria, I think\."/);
  await tick();
  const woken = b.fake.sessions.filter(x => /mentioned you in the Talk with Mira/.test(x.options.prompt));
  assert.equal(woken.length, 2, 'dev and nikhil are both woken');

  assert.equal((await req(b, 'POST', '/api/talk/threads/mira/messages', { text: 'x', replyTo: 'tm_nope' })).status, 400);
  const bad = await req<{ error: string }>(b, 'POST', '/api/talk/threads/mira/messages', { text: 'x', mentions: ['ghost'] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /@ghost/);
  const people = (await req<{ id: string; kind: string }[]>(b, 'GET', '/api/mentionable')).body;
  assert.ok(people.some(p => p.id === 'coo' && p.kind === 'coo'));
  assert.ok(people.some(p => p.id === 'mira' && p.kind === 'employee'));
  void first;
}));

test('item comments take several mentions from the app', () => withBoot(async b => {
  const epic = { body: (await req<{ item: { id: string } }>(b, 'POST', '/api/items', { level: 'epic', title: 'E' })).body.item };
  const c = await req<{ mentions: string[] }>(b, 'POST', `/api/items/${epic.body.id}/comments`, { text: 'Please both look @kabir', mentions: ['dev', 'nikhil'] });
  assert.equal(c.status, 201);
  assert.deepEqual(c.body.mentions.sort(), ['dev', 'kabir', 'nikhil']);
  assert.equal((await req(b, 'POST', `/api/items/${epic.body.id}/comments`, { text: 'x', mentions: ['ghost'] })).status, 400);
}));

/* ---------- 6. files ---------- */

test('files: upload, send, the agent gets images as images and other files by path; served only by id, with a 20 MB cap', () => withBoot(async b => {
  const pdf = await upload<{ id: string; kind: string; url: string; size: number }>(b, '/api/talk/threads/mira/attachments?name=spec.pdf', Buffer.from('%PDF-1.4 fake'), 'application/pdf');
  assert.equal(pdf.status, 201);
  assert.equal(pdf.body.kind, 'file');
  const png = await upload<{ id: string; kind: string }>(b, '/api/talk/threads/mira/attachments?name=shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png');
  assert.equal(png.body.kind, 'image');
  const sent = await req<Sent>(b, 'POST', '/api/talk/threads/mira/messages', { text: 'Look at these', attachmentIds: [pdf.body.id, png.body.id] });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message.text, 'Look at these');
  assert.equal(sent.body.message.attachments.length, 2);
  const s = b.fake.last();
  const prompt = s.options.prompt;
  assert.match(prompt, /Attached file: spec\.pdf \(application\/pdf, 13 B\) at .*attachments\/mira\/att_[a-z0-9]+-spec\.pdf — read it with the Read tool\./);
  assert.equal(s.options.images?.length, 1, 'the image travels as an image');

  const got = await fetch(`${b.base}${pdf.body.url}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await got.arrayBuffer()).toString(), '%PDF-1.4 fake');
  for (const bad of ['/api/talk/attachments/..%2F..%2Fworkplace.db', '/api/talk/attachments/att_nope', '/api/talk/attachments/%2Fetc%2Fpasswd']) {
    assert.equal((await fetch(`${b.base}${bad}`)).status, 404, bad);
  }
  const big = await upload<{ error: string }>(b, '/api/talk/threads/mira/attachments?name=big.bin', Buffer.alloc(20 * 1024 * 1024 + 1), 'application/octet-stream');
  assert.equal(big.status, 413);
  // An id from another thread is refused.
  assert.equal((await req(b, 'POST', '/api/talk/threads/dev/messages', { attachmentIds: [pdf.body.id] })).status, 400);
  // The COO thread takes text and voice only.
  const cooFile = await upload<{ id: string }>(b, '/api/talk/threads/coo/attachments?name=a.pdf', Buffer.from('x'), 'application/pdf');
  assert.equal((await req(b, 'POST', '/api/talk/threads/coo/messages', { attachmentIds: [cooFile.body.id] })).status, 400);
}));

test('send_file: an agent sends a file from its worktree or evidence; anything else is refused in one sentence', async () => {
  const b = await boot();
  try {
    const wp = b.running.wp;
    await req(b, 'POST', '/api/employees/mira/talk', { text: 'send me the report' });
    const open = employees.openSession('mira')!;
    const worktree = open.worktree.path;
    writeFileSync(join(worktree, 'report.txt'), 'all green');
    const evidence = join(wp.config.workplaceDir, 'evidence');
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, 'shot.png'), Buffer.from([1, 2, 3]));
    const outside = join(wp.config.workplaceDir, 'secret.txt');
    writeFileSync(outside, 'no');
    symlinkSync(outside, join(worktree, 'sneaky.txt'));

    const call = employees.sendFileTool(wp, 'mira', open.agentId);
    assert.match(await call({ path: join(worktree, 'report.txt'), caption: 'The report' }), /^Sent report\.txt/);
    assert.match(await call({ path: join(evidence, 'shot.png') }), /^Sent shot\.png/);
    assert.equal(await call({ path: outside }), 'Not sent: only files in your worktree or ~/iris-workplace/evidence/ can be sent.');
    assert.equal(await call({ path: join(worktree, 'sneaky.txt') }), 'Not sent: only files in your worktree or ~/iris-workplace/evidence/ can be sent.');
    assert.equal(await call({ path: join(worktree, '..', '..', 'x') }), `Not sent: ${join(worktree, '..', '..', 'x')} does not exist.`);
    const out = talkStore.messages(wp, 'mira').filter(m => m.attachments.length);
    assert.deepEqual(out.map(m => [m.from, m.direction, m.text, m.attachments[0]!.name]), [['mira', 'out', 'The report', 'report.txt'], ['mira', 'out', 'shot.png', 'shot.png']]);
    assert.equal(talkStore.thread(wp, 'mira').unreadCount, 2);
  } finally { await b.stop(); }
});

/* ---------- 7. voice ---------- */

test('voice: stored, transcribed, the agent gets the transcript marked as a voice note; failures send nothing', () => withBoot(async b => {
  useTranscriber(async (audio, type) => { assert.equal(type, 'audio/mp4'); return audio.length > 3 ? 'Ship the fix tonight' : ''; });
  try {
    const v = await upload<Sent>(b, '/api/talk/threads/mira/voice?name=note.m4a&durationMs=3200', Buffer.from('fake m4a bytes'), 'audio/mp4');
    assert.equal(v.status, 201);
    const m = v.body.message;
    assert.equal(m.text, 'Ship the fix tonight');
    assert.equal(m.voice!.transcript, 'Ship the fix tonight');
    assert.equal(m.voice!.durationMs, 3200);
    assert.equal(m.attachments[0]!.kind, 'voice');
    assert.equal(m.attachments[0]!.id, m.voice!.attachmentId);
    assert.equal(b.fake.last().options.prompt, 'Ship the fix tonight\n\n(voice note)');
    const audio = await fetch(`${b.base}${m.attachments[0]!.url}`);
    assert.equal(audio.headers.get('content-type'), 'audio/mp4');

    const before = talkStore.messages(b.running.wp, 'mira').length;
    const silent = await upload<{ error: string }>(b, '/api/talk/threads/mira/voice', Buffer.from('ab'), 'audio/mp4');
    assert.equal(silent.status, 502);
    assert.equal(talkStore.messages(b.running.wp, 'mira').length, before, 'nothing sent');
    assert.equal((await upload(b, '/api/talk/threads/mira/voice', Buffer.from('abcd'), 'video/mp4')).status, 400);
    // The COO thread takes voice too.
    const toCoo = await upload<Sent>(b, '/api/talk/threads/coo/voice', Buffer.from('fake m4a bytes'), 'audio/mp4');
    assert.equal(toCoo.status, 201);
    assert.equal(toCoo.body.message.threadId, 'coo');
  } finally { useTranscriber(null); }
  // No key configured: 503 with the next step.
  const off = await upload<{ error: string }>(b, '/api/talk/threads/mira/voice', Buffer.from('fake m4a bytes'), 'audio/mp4');
  assert.equal(off.status, 503);
  assert.match(off.body.error, /no speech-to-text key/);
}));

/* ---------- the COO thread ---------- */

test('the COO thread: the owner\'s messages and the COO\'s replies, read when the COO answers', () => withBoot(async b => {
  const sent = await req<Sent>(b, 'POST', '/api/talk/threads/coo/messages', { text: 'How is the release?' });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message.receipt, 'delivered');
  await req(b, 'POST', '/api/coo/reply', { inReplyTo: sent.body.message.id, text: 'Green; shipping tonight.' });
  const msgs = (await req<TalkMessage[]>(b, 'GET', '/api/talk/threads/coo/messages')).body;
  assert.deepEqual(msgs.map(m => [m.from, m.fromName]), [['owner', 'You'], ['coo', 'Claude — COO']]);
  assert.equal(msgs[0]!.receipt, 'read');
  assert.equal(msgs[1]!.replyTo!.id, sent.body.message.id);
  assert.equal((await req<TalkThread>(b, 'GET', '/api/talk/threads/coo')).body.unreadCount, 1);
}));

void runs;
