// Chat prefs (mute) and shared media for the mock (docs/CHAT-NOTIFY-CONTRACT.md §2, §3, §6.9).
//
//   GET  /api/chats/prefs                        -> { <threadId>: { muted, mutedUntil } }
//   PUT  /api/chats/:id/prefs {muted,mutedUntil} -> the saved pref; broadcasts chat.prefs
//   GET  /api/chats/:id/shared?kind=&before=     -> { items, next } (derived from the mock's messages)
//
// Test hooks: POST /api/_chats {on} (off: every /api/chats route 404s, as a server that predates
// the contract; --no-chats starts that way), POST /api/_chat/message {threadId, text} (a message
// from the other side, over the socket), POST /api/_chat/prefs {threadId, muted, mutedUntil}
// (another device changed the mute).

export function chatsState(args) {
  return { on: !args.includes('--no-chats'), prefs: {}, seq: 1 };
}

const PAGE = 30;
const now = () => new Date().toISOString();
const URL_RE = /https?:\/\/[^\s)\]>]+/g;
const MD_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** Every message of a chat as { id, at, text, attachments }: Talk, the COO bridge, or a room thread. */
function sourcesOf(state, id) {
  const talk = state.talk.on ? state.talk.messages[id] : undefined;
  if (talk?.length) return talk.map(m => ({ id: m.id, at: m.at, text: m.text ?? '', attachments: m.attachments ?? [] }));
  if (id === 'coo') return state.cooLog.map(m => ({ id: m.id, at: m.at, text: `${m.text ?? ''}\n${m.details ?? ''}`, attachments: m.attachments ?? [] }));
  return (state.messages[id] ?? []).map(m => ({ id: m.id, at: m.at, text: `${m.text ?? ''}\n${m.details ?? ''}`, attachments: [] }));
}

function sharedItems(sources, kind) {
  const out = [], seen = new Set();
  for (const s of [...sources].sort((a, b) => b.at.localeCompare(a.at))) {
    if (kind === 'links') {
      const titles = Object.fromEntries([...s.text.matchAll(MD_RE)].map(m => [m[2], m[1]]));
      for (const m of s.text.matchAll(URL_RE)) {
        const url = m[0].replace(/[.,;:!?]+$/, '');
        const key = url.toLowerCase().replace(/\/+$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind, messageId: s.id, at: s.at, url, name: titles[url] ?? new URL(url).host });
      }
    } else {
      for (const a of s.attachments) {
        const voice = a.kind === 'voice' || a.mediaType.startsWith('audio/');
        const media = a.kind === 'image' || a.mediaType.startsWith('image/') || a.mediaType.startsWith('video/');
        if (voice || (kind === 'media') !== media || seen.has(a.id)) continue;
        seen.add(a.id);
        out.push({ kind, messageId: s.id, at: s.at, attachmentId: a.id, url: a.url, name: a.name, mime: a.mediaType, size: a.size });
      }
    }
  }
  return out;
}

/** Returns true when it answered. */
export async function handleChats(state, { m, p, url, req, res, json, readJson, broadcast }) {
  const C = state.chats;
  if (m === 'POST' && p === '/api/_chats') { const b = await readJson(req); C.on = b?.on !== false; return json(res, 200, { ok: true, on: C.on }), true; }
  if (m === 'POST' && p === '/api/_chat/prefs') {
    const b = await readJson(req);
    const pref = { muted: !!b?.muted, mutedUntil: b?.mutedUntil ?? null };
    C.prefs[b.threadId] = pref;
    broadcast({ type: 'chat.prefs', threadId: b.threadId, ...pref });
    return json(res, 200, pref), true;
  }
  if (m === 'POST' && p === '/api/_chat/message') {
    const b = await readJson(req);
    const id = b?.threadId ?? 'coo', text = b?.text ?? 'Hello from the mock';
    const T = state.talk;
    if (T.on && T.threads[id]) {
      const t = T.threads[id];
      const msg = { id: `tm_x${C.seq++}`, threadId: id, at: now(), from: id, fromName: t.name, direction: 'out', text, mentions: [], attachments: [] };
      (T.messages[id] ??= []).push(msg);
      t.lastMessageAt = msg.at; t.unreadCount += 1;
      t.lastMessage = { id: msg.id, from: msg.from, fromName: msg.fromName, text: text.slice(0, 140) };
      broadcast({ type: 'talk.message', message: msg, thread: t });
      return json(res, 201, msg), true;
    }
    if (id === 'coo') {
      const msg = { id: `com-x${C.seq++}`, at: now(), from: 'coo', text, summary: text };
      state.cooLog.push(msg);
      broadcast({ type: 'coo.message', message: msg });
      return json(res, 201, msg), true;
    }
    const thread = state.threads.find(t => t.id === id);
    if (!thread) return json(res, 404, { error: 'No such chat.' }), true;
    const msg = { id: `m-x${C.seq++}`, threadId: id, at: now(), by: b?.by ?? 'asha', owner: false, text, mentions: [] };
    (state.messages[id] ??= []).push(msg);
    thread.messageCount += 1; thread.lastAt = msg.at;
    broadcast({ type: 'room.message', message: msg, thread });
    return json(res, 201, msg), true;
  }
  if (!p.startsWith('/api/chats/')) return false;
  if (!C.on) return json(res, 404, { error: `no route ${m} ${p}` }), true;

  if (m === 'GET' && p === '/api/chats/prefs') return json(res, 200, C.prefs), true;
  const seg = p.split('/').filter(Boolean); // api chats :id sub
  const id = decodeURIComponent(seg[2] ?? '');
  if (m === 'PUT' && seg[3] === 'prefs') {
    const b = await readJson(req);
    if (!b || typeof b.muted !== 'boolean') return json(res, 400, { error: 'muted (boolean) is required' }), true;
    const pref = { muted: b.muted, mutedUntil: b.muted ? (b.mutedUntil ?? null) : null };
    C.prefs[id] = pref;
    broadcast({ type: 'chat.prefs', threadId: id, ...pref });
    return json(res, 200, pref), true;
  }
  if (m === 'GET' && seg[3] === 'shared') {
    const kind = url.searchParams.get('kind') ?? 'media';
    if (!['media', 'files', 'links'].includes(kind)) return json(res, 400, { error: 'kind is media, files or links' }), true;
    const all = sharedItems(sourcesOf(state, id), kind);
    const start = Number(url.searchParams.get('before') ?? 0) || 0;
    const items = all.slice(start, start + PAGE);
    return json(res, 200, { items, next: start + PAGE < all.length ? String(start + PAGE) : null }), true;
  }
  return json(res, 404, { error: 'no such chats route' }), true;
}
