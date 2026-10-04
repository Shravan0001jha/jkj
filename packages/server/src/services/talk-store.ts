import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep, isAbsolute } from 'node:path';
import type { LogEntry, TalkAttachment, TalkFrom, TalkMessage, TalkQuote, TalkThread } from '@jkj/shared';
import { COO_NAME, senderName } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as runs from './runs.js';
import { newId, now, rowJson, rowsJson } from './store.js';
import { BadRequest, NotFound, TooLarge } from '../util/errors.js';
import { log } from '../util/logger.js';

/**
 * Talk threads (docs/LLD-app-fixes.md §2–4, §6): the owner's chats as stored messages with a real
 * sender, receipts, typing, read/pin state and files. One thread per employee (id = employee id)
 * and the COO's ('coo').
 *
 * Messages are recorded from the run register's own events (every user and assistant line already
 * flows through `runs.append`), so every path that talks to an agent — the owner's Talk, the COO,
 * the Workplace's prompts — lands here with the sender it was sent with. Extra fields that only the
 * Talk routes know (reply-to, mentions, attachments, voice, the owner's text before file lines) are
 * staged under the message id just before the send (`stage`) and picked up when the line appears.
 * Nothing here imports employees.ts, so the agents' tools can use it without a cycle.
 */

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const COO_THREAD = 'coo';
const ONE_LINE = 140;

/* ---------- names ---------- */

export function namesOf(wp: Workplace): Map<string, string> {
  return new Map(wp.org.employees.map(e => [e.id, e.id === COO_THREAD ? COO_NAME : e.name]));
}

export const nameOf = (wp: Workplace, from: string): string => senderName(from, namesOf(wp));

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > ONE_LINE ? `${flat.slice(0, ONE_LINE - 1)}…` : flat;
};

export const quoteOf = (m: TalkMessage): TalkQuote => ({ id: m.id, from: m.from, fromName: m.fromName, text: oneLine(m.text || m.attachments[0]?.name || '') });

/** Thread ids the owner can see: every employee the Workplace runs, and the COO. */
export function threadIds(wp: Workplace): string[] {
  return [...wp.org.employees.filter(e => !e.virtual).map(e => e.id), COO_THREAD];
}

export function requireThread(wp: Workplace, id: string): string {
  if (id === COO_THREAD || wp.org.employees.some(e => e.id === id && !e.virtual)) return id;
  throw new NotFound(`No Talk thread ${id}: use an employee id or coo.`);
}

/* ---------- messages ---------- */

/** Messages that count toward unread: from the agent, not quiet narration. */
const counts = (m: TalkMessage): boolean => m.direction === 'out' && !m.quiet;
const textKey = (text: string): string => createHash('sha1').update(text.trim()).digest('hex');

export function getMessage(wp: Workplace, id: string): TalkMessage | undefined {
  return rowJson<TalkMessage>(wp.db.prepare('select json from talk_messages where id = ?').get(id));
}

function save(wp: Workplace, m: TalkMessage, agentText?: string): void {
  wp.db.prepare(`insert into talk_messages (id, thread_id, at, from_who, direction, counts, agent_id, text_key, json) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set counts = excluded.counts, json = excluded.json`)
    .run(m.id, m.threadId, m.at, m.from, m.direction, counts(m) ? 1 : 0, m.agentId ?? null, textKey(agentText ?? m.text), JSON.stringify(m));
}

function publish(wp: Workplace, m: TalkMessage): void {
  wp.emit({ type: 'talk.message', message: m, thread: thread(wp, m.threadId) });
}

export function insert(wp: Workplace, m: TalkMessage, agentText?: string): TalkMessage {
  save(wp, m, agentText);
  publish(wp, m);
  return m;
}

function patch(wp: Workplace, id: string, fn: (m: TalkMessage) => TalkMessage | null): TalkMessage | undefined {
  const m = getMessage(wp, id);
  if (!m) return undefined;
  const next = fn(m);
  if (!next) return m;
  save(wp, next);
  publish(wp, next);
  return next;
}

export function markRead(wp: Workplace, id: string, at = now()): TalkMessage | undefined {
  return patch(wp, id, m => (m.direction !== 'in' || m.receipt === 'read' ? null : { ...m, receipt: 'read', readAt: at }));
}

export function messages(wp: Workplace, threadId: string, q: { limit?: number; before?: string } = {}): TalkMessage[] {
  requireThread(wp, threadId);
  const limit = Math.min(Math.max(1, q.limit ?? 100), 500);
  if (q.before) {
    const pivot = wp.db.prepare('select at, rowid from talk_messages where id = ? and thread_id = ?').get(q.before, threadId) as { at: string; rowid: number } | undefined;
    if (!pivot) throw new BadRequest(`No message ${q.before} in this thread.`);
    const rows = wp.db.prepare('select json from talk_messages where thread_id = ? and (at < ? or (at = ? and rowid < ?)) order by at desc, rowid desc limit ?').all(threadId, pivot.at, pivot.at, pivot.rowid, limit);
    return rowsJson<TalkMessage>(rows).reverse();
  }
  return rowsJson<TalkMessage>(wp.db.prepare('select json from talk_messages where thread_id = ? order by at desc, rowid desc limit ?').all(threadId, limit)).reverse();
}

/* ---------- threads ---------- */

interface ThreadState { pinnedAt?: string; lastReadAt?: string }

const stateOf = (wp: Workplace, id: string): ThreadState =>
  rowJson<ThreadState>(wp.db.prepare('select json from talk_threads where id = ?').get(id)) ?? {};

function setState(wp: Workplace, id: string, state: ThreadState): void {
  wp.db.prepare('insert into talk_threads (id, json) values (?, ?) on conflict(id) do update set json = excluded.json').run(id, JSON.stringify(state));
}

const typingNow = new Map<string, boolean>();

export function thread(wp: Workplace, id: string): TalkThread {
  requireThread(wp, id);
  const emp = wp.org.employees.find(e => e.id === id);
  const role = emp ? wp.org.roles.find(r => r.id === emp.roleId)?.title : undefined;
  const st = stateOf(wp, id);
  // The preview: the newest line a person wrote (the Workplace's own prompts and quiet narration fold away).
  const last = rowJson<TalkMessage>(wp.db.prepare("select json from talk_messages where thread_id = ? and from_who != 'workplace' and not (direction = 'out' and counts = 0) order by at desc, rowid desc limit 1").get(id));
  const unread = (wp.db.prepare('select count(*) as n from talk_messages where thread_id = ? and counts = 1 and at > ?').get(id, st.lastReadAt ?? '') as { n: number }).n;
  return {
    id, employeeId: id,
    name: id === COO_THREAD ? COO_NAME : emp?.name ?? id,
    ...(id === COO_THREAD ? { role: 'COO' } : role ? { role } : {}),
    ...(last ? { lastMessageAt: last.at, lastMessage: quoteOf(last) } : {}),
    unreadCount: unread,
    ...(st.lastReadAt ? { lastReadAt: st.lastReadAt } : {}),
    pinned: !!st.pinnedAt,
    ...(st.pinnedAt ? { pinnedAt: st.pinnedAt } : {}),
    typing: typingNow.get(id) === true,
  };
}

/** Pinned first (newest pin first), then unread, then the most recent; never-used threads last by name. */
export function threads(wp: Workplace): TalkThread[] {
  return threadIds(wp).map(id => thread(wp, id)).sort((a, b) =>
    Number(b.pinned) - Number(a.pinned)
    || (a.pinned && b.pinned ? (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? '') : 0)
    || Number(b.unreadCount > 0) - Number(a.unreadCount > 0)
    || (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')
    || a.name.localeCompare(b.name));
}

/** The owner opened the thread: everything up to `upTo` (default: the newest message) is read. */
export function markThreadRead(wp: Workplace, id: string, upTo?: string): TalkThread {
  requireThread(wp, id);
  let at: string;
  if (upTo) {
    const m = getMessage(wp, upTo);
    if (!m || m.threadId !== id) throw new BadRequest(`No message ${upTo} in this thread.`);
    at = m.at;
  } else {
    const row = wp.db.prepare('select max(at) as at from talk_messages where thread_id = ?').get(id) as { at: string | null };
    at = row.at ?? now();
  }
  const st = stateOf(wp, id);
  if (!st.lastReadAt || at > st.lastReadAt) setState(wp, id, { ...st, lastReadAt: at });
  const t = thread(wp, id);
  wp.emit({ type: 'talk.thread', thread: t });
  return t;
}

export function setPinned(wp: Workplace, id: string, pinned: boolean): TalkThread {
  requireThread(wp, id);
  const { pinnedAt: _p, ...rest } = stateOf(wp, id);
  setState(wp, id, pinned ? { ...rest, pinnedAt: now() } : rest);
  const t = thread(wp, id);
  wp.emit({ type: 'talk.thread', thread: t });
  return t;
}

export function setTyping(wp: Workplace, threadId: string, typing: boolean): void {
  if ((typingNow.get(threadId) === true) === typing) return;
  if (typing) typingNow.set(threadId, true); else typingNow.delete(threadId);
  wp.emit({ type: 'talk.typing', threadId, employeeId: threadId, typing, at: now() });
}

/* ---------- attachments ---------- */

interface StoredAttachment extends TalkAttachment { threadId: string; at: string; path: string }

const root = (wp: Workplace): string => join(wp.config.workplaceDir, 'attachments');

const safeName = (name: string): string => basename(name).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'file';

const kindOf = (mediaType: string): TalkAttachment['kind'] =>
  mediaType.startsWith('image/') ? 'image' : mediaType.startsWith('audio/') ? 'voice' : 'file';

export function saveAttachment(wp: Workplace, threadId: string, file: { name: string; mediaType: string; data: Buffer; kind?: TalkAttachment['kind'] }): TalkAttachment {
  requireThread(wp, threadId);
  if (file.data.byteLength === 0) throw new BadRequest(`${file.name || 'That file'} is empty.`);
  if (file.data.byteLength > MAX_FILE_BYTES) throw new TooLarge('That file is over 20 MB; send a smaller one or a link.');
  const id = newId('att');
  const dir = join(root(wp), threadId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}-${safeName(file.name)}`);
  writeFileSync(path, file.data, { mode: 0o600 });
  const att: StoredAttachment = {
    id, name: basename(file.name) || 'file', mediaType: file.mediaType || 'application/octet-stream', size: file.data.byteLength,
    kind: file.kind ?? kindOf(file.mediaType), url: `/api/talk/attachments/${id}`, threadId, at: now(), path,
  };
  wp.db.prepare('insert into talk_attachments (id, thread_id, at, path, json) values (?, ?, ?, ?, ?)').run(id, threadId, att.at, path, JSON.stringify(att));
  return publicAttachment(att);
}

const publicAttachment = ({ threadId: _t, at: _a, path: _p, ...a }: StoredAttachment): TalkAttachment => a;

export function attachment(wp: Workplace, id: string): (TalkAttachment & { threadId: string; path: string }) | undefined {
  if (!/^att_[a-z0-9]+$/.test(id)) return undefined;
  const a = rowJson<StoredAttachment>(wp.db.prepare('select json from talk_attachments where id = ?').get(id));
  return a ? { ...publicAttachment(a), threadId: a.threadId, path: a.path } : undefined;
}

/** The bytes of an attachment, only from inside the attachments root (path-traversal safe by construction and by check). */
export function attachmentBytes(wp: Workplace, id: string): { meta: TalkAttachment; data: Buffer } {
  const a = attachment(wp, id);
  if (!a) throw new NotFound('No such attachment.');
  const base = realpathSync(root(wp));
  let real: string;
  try { real = realpathSync(a.path); } catch { throw new NotFound('That attachment is no longer on the Mac.'); }
  const rel = relative(base, real);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new NotFound('No such attachment.');
  return { meta: publicAttachment({ ...a, at: '' } as StoredAttachment), data: readFileSync(real) };
}

/** An agent's file, copied in (send_file): the path must resolve inside one of `allowedRoots`. */
export function copyInFromAgent(wp: Workplace, threadId: string, path: string, allowedRoots: string[]): TalkAttachment {
  let real: string;
  try { real = realpathSync(resolve(path)); } catch { throw new BadRequest(`Not sent: ${path} does not exist.`); }
  const inside = allowedRoots.some(r => {
    let base: string;
    try { base = realpathSync(r); } catch { return false; }
    return real === base || real.startsWith(base.endsWith(sep) ? base : base + sep);
  });
  if (!inside) throw new BadRequest('Not sent: only files in your worktree or ~/iris-workplace/evidence/ can be sent.');
  const st = statSync(real);
  if (!st.isFile()) throw new BadRequest('Not sent: that is not a file.');
  if (st.size > MAX_FILE_BYTES) throw new BadRequest('Not sent: the file is over 20 MB; send a smaller one or put it in a doc.');
  return saveAttachment(wp, threadId, { name: basename(real), mediaType: mediaTypeOf(real), data: readFileSync(real) });
}

const MEDIA: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml',
  pdf: 'application/pdf', json: 'application/json', txt: 'text/plain', md: 'text/markdown', log: 'text/plain', csv: 'text/csv', html: 'text/html',
  zip: 'application/zip', mp4: 'video/mp4', mov: 'video/quicktime', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'audio/webm',
};
export const mediaTypeOf = (path: string): string => MEDIA[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';


/* ---------- staging (fields only the Talk routes know) ---------- */

export type Staged = Partial<Pick<TalkMessage, 'text' | 'replyTo' | 'mentions' | 'attachments' | 'voice'>>;
const staged = new Map<string, Staged>();
export const stage = (talkId: string, s: Staged): void => void staged.set(talkId, s);
export const unstage = (talkId: string): void => void staged.delete(talkId);
let nextCoo: { talkId: string; staged: Staged } | null = null;
export const stageCoo = (talkId: string, s: Staged): void => { nextCoo = { talkId, staged: s }; };

/* ---------- wiring: run lines and COO lines become Talk messages ---------- */

/** Turns that consumed a message from a person (the owner or the COO): their prose counts, and they type. */
const humanTurn = new Map<string, string>(); // agentId -> threadId

export function wireTalk(wp: Workplace): () => void {
  backfillCoo(wp);
  runs.setSenderNames(from => nameOf(wp, from));
  const offRuns = runs.onRunEvent(({ entry, turn }) => {
    try {
      if (entry) onEntry(wp, entry);
      if (turn) onTurn(wp, turn);
    } catch (err) { log.warn('talk', `run event: ${err instanceof Error ? err.message : err}`); }
  });
  const offWp = wp.on(event => {
    if (event.type !== 'coo.message') return;
    try { onCooMessage(wp, event.message); } catch (err) { log.warn('talk', `coo message: ${err instanceof Error ? err.message : err}`); }
  });
  return () => { offRuns(); offWp(); runs.setSenderNames(null); humanTurn.clear(); typingNow.clear(); };
}

function threadOfRun(wp: Workplace, agentId: string): string | undefined {
  const id = runs.getRunAgent(agentId)?.employeeId;
  return id && wp.org.employees.some(e => e.id === id && !e.virtual) ? id : undefined;
}

function onEntry(wp: Workplace, entry: LogEntry): void {
  if (!entry.talkId || (entry.kind !== 'user' && entry.kind !== 'assistant')) return;
  const threadId = threadOfRun(wp, entry.agentId);
  if (!threadId) return;
  if (entry.kind === 'user') {
    const s = staged.get(entry.talkId) ?? {};
    staged.delete(entry.talkId);
    const from = (entry.from ?? 'owner') as TalkFrom;
    insert(wp, {
      id: entry.talkId, threadId, at: entry.at, from, fromName: nameOf(wp, from), direction: 'in',
      text: s.text ?? entry.text, mentions: s.mentions ?? [], attachments: s.attachments ?? [],
      ...(s.replyTo ? { replyTo: s.replyTo } : {}), ...(s.voice ? { voice: s.voice } : {}),
      receipt: 'delivered', deliveredAt: entry.at, agentId: entry.agentId,
    }, entry.text);
    return;
  }
  const quiet = humanTurn.get(entry.agentId) !== threadId;
  insert(wp, {
    id: entry.talkId, threadId, at: entry.at, from: threadId, fromName: nameOf(wp, threadId), direction: 'out',
    text: entry.text, mentions: [], attachments: [], agentId: entry.agentId, ...(quiet ? { quiet: true } : {}),
  });
}

function onTurn(wp: Workplace, turn: runs.TurnEvent): void {
  const threadId = threadOfRun(wp, turn.agentId);
  if (turn.state === 'end') {
    const was = humanTurn.get(turn.agentId);
    humanTurn.delete(turn.agentId);
    if (was) setTyping(wp, was, false);
    return;
  }
  let human = false;
  for (const c of turn.consumed) {
    if (!c.talkId) continue;
    const m = markRead(wp, c.talkId);
    if (m && (m.from === 'owner' || m.from === 'coo')) human = true;
  }
  if (!threadId) return;
  if (human) { humanTurn.set(turn.agentId, threadId); setTyping(wp, threadId, true); }
}

/** Closing a run without a turn end (a crash) must not leave a thread typing forever. */
export function clearTyping(wp: Workplace, threadId: string): void { setTyping(wp, threadId, false); }

interface CooLine { id: string; at: string; from: 'owner' | 'coo'; text: string; inReplyTo?: string }

function cooMessage(wp: Workplace, c: CooLine, s: Staged = {}): TalkMessage {
  return {
    id: c.id, threadId: COO_THREAD, at: c.at, from: c.from, fromName: nameOf(wp, c.from),
    direction: c.from === 'owner' ? 'in' : 'out', text: s.text ?? c.text, mentions: s.mentions ?? [], attachments: s.attachments ?? [],
    ...(s.replyTo ? { replyTo: s.replyTo } : {}), ...(s.voice ? { voice: s.voice } : {}),
    ...(c.from === 'owner' ? { receipt: 'delivered' as const, deliveredAt: c.at } : {}),
  };
}

function onCooMessage(wp: Workplace, c: CooLine): void {
  if (getMessage(wp, c.id)) return;
  const s = nextCoo?.staged ?? {};
  nextCoo = null;
  const m = cooMessage(wp, c, s);
  if (c.from === 'coo' && c.inReplyTo) {
    const asked = getMessage(wp, c.inReplyTo);
    if (asked) m.replyTo = quoteOf(asked);
  }
  insert(wp, m);
  // The COO answered: every earlier message of the owner's in that thread has been read.
  if (c.from === 'coo') {
    const unread = rowsJson<TalkMessage>(wp.db.prepare("select json from talk_messages where thread_id = ? and direction = 'in' and at <= ?").all(COO_THREAD, c.at)).filter(x => x.receipt !== 'read');
    for (const x of unread) markRead(wp, x.id, c.at);
  }
}

/** COO lines from before Talk threads existed (the coo_messages table) appear in the thread, read. */
function backfillCoo(wp: Workplace): void {
  const rows = rowsJson<CooLine>(wp.db.prepare('select json from coo_messages order by at').all());
  for (const c of rows) {
    if (getMessage(wp, c.id)) continue;
    const m = cooMessage(wp, c);
    save(wp, c.from === 'owner' ? { ...m, receipt: 'read', readAt: c.at } : m);
  }
}

/**
 * A transcript read back from disk has lost who wrote each line (the SDK file keeps only "user").
 * Lines the Talk store recorded get their sender back; others are left as they are.
 */
export function overlaySenders(wp: Workplace, entries: LogEntry[]): LogEntry[] {
  const find = wp.db.prepare("select id, from_who from talk_messages where text_key = ? and direction = 'in' order by at desc limit 1");
  return entries.map(e => {
    if (e.kind !== 'user' || e.from) return e;
    const row = find.get(textKey(e.text)) as { id: string; from_who: string } | undefined;
    return row ? { ...e, from: row.from_who, fromName: nameOf(wp, row.from_who), talkId: row.id } : e;
  });
}

/* ---------- agent → owner ---------- */

/** send_file: an employee's file appears in its own thread, with the caption as the text. */
export function sendFileFromAgent(wp: Workplace, employeeId: string, spec: { path: string; caption?: string; allowedRoots: string[]; agentId?: string }): TalkMessage {
  requireThread(wp, employeeId);
  const att = copyInFromAgent(wp, employeeId, spec.path, spec.allowedRoots);
  return insert(wp, {
    id: runs.newTalkId(), threadId: employeeId, at: now(), from: employeeId, fromName: nameOf(wp, employeeId),
    direction: 'out', text: spec.caption?.trim() || att.name, mentions: [], attachments: [att], ...(spec.agentId ? { agentId: spec.agentId } : {}),
  });
}
