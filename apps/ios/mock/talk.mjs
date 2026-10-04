// Talk threads for the mock (docs/LLD-app-fixes.md §2–§7), opt-in with --talk-threads (or
// POST /api/_talk {on:true}): without it every /api/talk/threads route answers 404, like a
// Workplace that predates the contract, so the app's fallback stays exercised.
//
// Scripted like the real server: a sent message is 'delivered' at once, 'read' ~1 s later
// (talk.message with the same id), typing starts only when the reply is being written
// (talk.typing true) and stops when it lands.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(readFileSync(join(here, '..', 'fixtures', `${n}.json`), 'utf8'));
const asset = (n) => readFileSync(join(here, 'assets', n));

export function talkState(cards) {
  const threads = Object.fromEntries(fixture('talk-threads').map(t => [t.id, t]));
  for (const c of cards) {
    const id = c.employee.virtual ? 'coo' : c.employee.id;
    if (!threads[id]) threads[id] = { id, employeeId: id, name: c.employee.name, unreadCount: 0, pinned: false, typing: false };
  }
  return {
    on: false,
    threads,
    messages: { asha: fixture('talk-messages-asha'), coo: fixture('talk-messages-coo') },
    files: {
      att_img1: { type: 'image/png', name: 'greeting.png', data: asset('greeting.png') },
      att_pdf1: { type: 'application/pdf', name: 'evidence.pdf', data: asset('evidence.pdf') },
      att_voice1: { type: 'audio/mp4', name: 'voice.m4a', data: asset('voice.m4a') },
    },
    mentionable: fixture('mentionable'),
    seq: 100,
  };
}

const readBytes = (req) => new Promise((resolve) => { const parts = []; req.on('data', c => parts.push(c)); req.on('end', () => resolve(Buffer.concat(parts))); });
const now = () => new Date().toISOString();

/** Returns true when it answered. */
export async function handleTalk(T, { m, p, url, req, res, json, readJson, broadcast }) {
  if (m === 'POST' && p === '/api/_talk') { const b = await readJson(req); T.on = b?.on !== false; return json(res, 200, { ok: true, on: T.on }), true; }
  const isTalk = p.startsWith('/api/talk/threads') || p.startsWith('/api/talk/attachments/') || p === '/api/mentionable';
  if (!isTalk) return false;
  if (!T.on) return json(res, 404, { error: `no route ${m} ${p}` }), true;

  const seg = p.split('/').filter(Boolean); // api talk threads :id sub
  const list = () => Object.values(T.threads).sort((a, b) => {
    const bucket = t => t.pinned ? 0 : t.unreadCount > 0 ? 1 : 2;
    if (bucket(a) !== bucket(b)) return bucket(a) - bucket(b);
    return (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '') || a.name.localeCompare(b.name);
  });
  const emit = (msg) => {
    const t = T.threads[msg.threadId];
    t.lastMessageAt = msg.at;
    t.lastMessage = { id: msg.id, from: msg.from, fromName: msg.fromName, text: (msg.voice?.transcript ?? msg.text).slice(0, 140) };
    broadcast({ type: 'talk.message', message: msg, thread: t });
  };
  const ownerMessage = (threadId, fields) => {
    const msg = { id: `tm_${T.seq++}`, threadId, at: now(), from: 'owner', fromName: 'You', direction: 'in', text: '', mentions: [], attachments: [], receipt: 'delivered', deliveredAt: now(), ...fields };
    (T.messages[threadId] ??= []).push(msg);
    emit(msg);
    // Read when the agent's turn takes it in; typing only while the reply is written.
    setTimeout(() => { msg.receipt = 'read'; msg.readAt = now(); emit(msg); }, 1000);
    setTimeout(() => {
      T.threads[threadId].typing = true;
      broadcast({ type: 'talk.typing', threadId, employeeId: threadId, typing: true, at: now() });
    }, 1600);
    setTimeout(() => {
      const t = T.threads[threadId];
      const reply = { id: `tm_${T.seq++}`, threadId, at: now(), from: threadId, fromName: t.name, direction: 'out',
        text: `Got it. Details: [the plan](https://work.irisforu.com/#/plan) and https://github.com/irisforu/jkj/pulls`,
        replyTo: { id: msg.id, from: 'owner', fromName: 'You', text: (msg.voice?.transcript ?? msg.text).slice(0, 140) || 'Attachment' },
        mentions: [], attachments: [] };
      T.messages[threadId].push(reply);
      t.typing = false;
      t.unreadCount += 1;
      broadcast({ type: 'talk.typing', threadId, employeeId: threadId, typing: false, at: now() });
      emit(reply);
    }, 4000);
    return msg;
  };

  if (m === 'GET' && p === '/api/mentionable') return json(res, 200, T.mentionable), true;
  if (m === 'GET' && seg[2] === 'attachments' && seg[3]) {
    const f = T.files[decodeURIComponent(seg[3])];
    if (!f) return json(res, 404, { error: 'That file is no longer on the server.' }), true;
    res.writeHead(200, { 'content-type': f.type, 'content-length': f.data.length, 'content-disposition': `inline; filename="${f.name}"` });
    res.end(f.data);
    return true;
  }
  if (m === 'GET' && p === '/api/talk/threads') return json(res, 200, list()), true;
  const id = seg[3] ? decodeURIComponent(seg[3]) : undefined;
  const t = id ? T.threads[id] : undefined;
  if (!t) return json(res, 404, { error: 'No such thread.' }), true;
  const sub = seg[4];
  if (m === 'GET' && !sub) return json(res, 200, t), true;
  if (m === 'GET' && sub === 'messages') return json(res, 200, T.messages[id] ?? []), true;
  if (m === 'POST' && sub === 'read') {
    t.unreadCount = 0; t.lastReadAt = now();
    broadcast({ type: 'talk.thread', thread: t });
    return json(res, 200, t), true;
  }
  if (m === 'POST' && sub === 'pin') {
    const b = await readJson(req);
    t.pinned = !!b?.pinned; t.pinnedAt = t.pinned ? now() : undefined;
    broadcast({ type: 'talk.thread', thread: t });
    return json(res, 200, t), true;
  }
  if (m === 'POST' && sub === 'attachments') {
    const data = await readBytes(req);
    if (data.length > 20 * 1024 * 1024) return json(res, 413, { error: 'That file is over 20 MB; send a smaller one or a link.' }), true;
    const type = req.headers['content-type'] ?? 'application/octet-stream';
    const name = url.searchParams.get('name') ?? 'file';
    const attId = `att_${T.seq++}`;
    T.files[attId] = { type, name, data };
    return json(res, 201, { id: attId, name, mediaType: type, size: data.length, kind: type.startsWith('image/') ? 'image' : 'file', url: `/api/talk/attachments/${attId}` }), true;
  }
  if (m === 'POST' && sub === 'voice') {
    const data = await readBytes(req);
    const name = url.searchParams.get('name') ?? 'voice.m4a';
    const attId = `att_${T.seq++}`;
    T.files[attId] = { type: req.headers['content-type'] ?? 'audio/mp4', name, data };
    const durationMs = Number(url.searchParams.get('durationMs')) || undefined;
    const transcript = `(mock transcript of a ${Math.round((durationMs ?? 0) / 1000)} s voice note)`;
    const replyId = url.searchParams.get('replyTo');
    const r = replyId && T.messages[id]?.find(x => x.id === replyId);
    const msg = ownerMessage(id, {
      text: transcript,
      attachments: [{ id: attId, name, mediaType: 'audio/mp4', size: data.length, kind: 'voice', url: `/api/talk/attachments/${attId}` }],
      voice: { attachmentId: attId, transcript, durationMs },
      ...(r ? { replyTo: { id: r.id, from: r.from, fromName: r.fromName, text: r.text.slice(0, 140) } } : {}),
    });
    return json(res, 201, { message: msg }), true;
  }
  if (m === 'POST' && sub === 'messages') {
    const b = await readJson(req);
    const text = (b?.text ?? '').trim();
    const ids = b?.attachmentIds ?? [];
    if (!text && !ids.length) return json(res, 400, { error: 'Nothing to send.' }), true;
    const r = b?.replyTo && T.messages[id]?.find(x => x.id === b.replyTo);
    if (b?.replyTo && !r) return json(res, 400, { error: 'replyTo is not a message in this thread.' }), true;
    const atts = ids.map(a => { const f = T.files[a]; return f && { id: a, name: f.name, mediaType: f.type, size: f.data.length, kind: f.type.startsWith('image/') ? 'image' : 'file', url: `/api/talk/attachments/${a}` }; }).filter(Boolean);
    const msg = ownerMessage(id, { text, mentions: b?.mentions ?? [], attachments: atts,
      ...(r ? { replyTo: { id: r.id, from: r.from, fromName: r.fromName, text: (r.voice?.transcript ?? r.text).slice(0, 140) } } : {}) });
    return json(res, 201, { message: msg }), true;
  }
  return json(res, 404, { error: 'no such talk route' }), true;
}
