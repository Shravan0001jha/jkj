import { appendFileSync, existsSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import type { Comment, CooItem, CooMessage, CooPresence, InboxItem, InboxOption, RoomMessage, TalkAttachment } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as inbox from './inbox.js';
import * as room from './room.js';
import * as trail from './trail.js';
import { newId, now, rowJson, rowsJson } from './store.js';
import { BadRequest, NotFound } from '../util/errors.js';
import { appendBridgeLine, bridgeDir, bridgeFile } from './coo-bridge.js';

/**
 * The COO bridge (owner, 29 Sep).
 *
 * "Claude — COO" is not an Agent SDK employee: it is the lead's own terminal session on this Mac.
 * The Workplace never spawns it (`employees.ts` refuses `talk`/`assign`/`spawn` for a `virtual`
 * employee) and never shows its tool calls or thinking — no mirroring. What the owner sees is a
 * small, honest chat: what he sent to `coo`, and what the lead sent back through
 * `POST /api/coo/reply`. The two sides meet at files under `<workplaceDir>/coo/`:
 *
 *   inbox.jsonl   write-only from here; the lead tails it (owner messages, escalations, mentions).
 *   heartbeat     written by the lead every 60s; read-only from here (presence).
 *
 * The transcript itself (both directions) and escalation/mention items are the Workplace's own
 * operational data (HLD D2), so they live in SQLite (`coo_messages`, `coo_items`), not in the
 * inbox file — the file is an outbound integration artifact for the lead's watcher, not the UI's
 * source of truth.
 */

export const COO_ID = 'coo';
const ONLINE_MS = 3 * 60_000;
export const OFFLINE_FALLBACK_MS = 30 * 60_000;

export const isCoo = (id: string): boolean => id === COO_ID;

const inboxFile = bridgeFile;
const heartbeatFile = (wp: Workplace): string => join(bridgeDir(wp), 'heartbeat');

function appendInboxFile(wp: Workplace, entry: Record<string, unknown>): void {
  appendBridgeLine(wp, entry);
}

/* ---------- presence ---------- */

/** Online when the lead touched `coo/heartbeat` within `thresholdMs` (the card: within 3 minutes). */
export function presence(wp: Workplace, thresholdMs = ONLINE_MS): CooPresence {
  const file = heartbeatFile(wp);
  if (!existsSync(file)) return { online: false, lastHeartbeat: null };
  const at = statSync(file).mtime;
  return { online: Date.now() - at.getTime() < thresholdMs, lastHeartbeat: at.toISOString() };
}

const isOffline = (wp: Workplace, thresholdMs: number): boolean => !presence(wp, thresholdMs).online;

const PRESENCE_KEY = 'coo-presence-online';

/**
 * Called on a timer (index.ts, every 30 s, next to the stall check): the server never learns of a
 * heartbeat write directly (the lead's own process touches the file; nothing here watches it), so
 * presence is polled. Emits `coo.presence` only when online ↔ offline actually flips — not on every
 * tick — to every authenticated owner socket (`ws/hub.ts`; unlike `coo.item` this is not local-only,
 * the owner reaches the Workplace only through the tunnel). State lives in `settings`, not a module
 * variable, so it is per-workplace and never leaks between tests.
 */
export function pollPresence(wp: Workplace): CooPresence {
  const p = presence(wp);
  const prev = (wp.db.prepare('select value from settings where key = ?').get(PRESENCE_KEY) as { value: string } | undefined)?.value;
  const onlineFlag = p.online ? '1' : '0';
  if (prev !== onlineFlag) {
    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(PRESENCE_KEY, onlineFlag);
    if (prev !== undefined) wp.emit({ type: 'coo.presence', presence: p }); // the first poll only seeds; nothing "flipped" yet
  }
  return p;
}

/* ---------- the owner's Talk with the COO ---------- */

export function transcript(wp: Workplace): CooMessage[] {
  return rowsJson<CooMessage>(wp.db.prepare('select json from coo_messages order by at, rowid').all());
}

function saveMessage(wp: Workplace, message: CooMessage): CooMessage {
  wp.db.prepare('insert into coo_messages (id, at, from_who, json) values (?, ?, ?, ?)')
    .run(message.id, message.at, message.from, JSON.stringify(message));
  wp.emit({ type: 'coo.message', message });
  return message;
}

/** A message from the COO to the owner that answers nothing in particular (the usage ping). */
export function messageOwner(wp: Workplace, text: string): CooMessage {
  if (!text.trim()) throw new BadRequest('Nothing to send.');
  const message: CooMessage = { id: newId('com'), at: now(), from: 'coo', text: text.trim(), summary: text.trim() };
  return saveMessage(wp, message);
}

/** The owner talking to the COO: appended to the inbox file the lead tails, and to the transcript. */
export function sendOwnerMessage(wp: Workplace, text: string, files: { attachment: TalkAttachment; path: string }[] = []): CooMessage {
  if (!text.trim() && !files.length) throw new BadRequest('Nothing to send.');
  const message: CooMessage = { id: newId('com'), at: now(), from: 'owner', text: text.trim(), ...(files.length ? { attachments: files.map(f => f.attachment) } : {}) };
  // The bridge line names each file's absolute path on this Mac, so the COO can open it.
  appendInboxFile(wp, { kind: 'message', text: message.text, ...(files.length ? { attachments: files.map(f => ({ id: f.attachment.id, name: f.attachment.name, mime: f.attachment.mediaType, size: f.attachment.size, path: f.path })) } : {}) });
  return saveMessage(wp, message);
}

/**
 * The lead replying (loopback only). Chat-style: `text` is the message itself, short; `details` is
 * optional extra context behind an expand control, the same shape as every other line to the owner.
 */
export function replyFromCoo(wp: Workplace, spec: { inReplyTo: string; text: string; details?: string; attachments?: TalkAttachment[] }): CooMessage {
  const files = spec.attachments ?? [];
  const text = spec.text.trim() || files.map(f => f.name).join(', ');
  if (!text) throw new BadRequest('Nothing to reply with.');
  if (!spec.inReplyTo.trim()) throw new BadRequest('Which message is this replying to?');
  const message: CooMessage = {
    id: newId('com'), at: now(), from: 'coo', text, summary: text,
    inReplyTo: spec.inReplyTo, ...(spec.details?.trim() ? { details: spec.details.trim() } : {}),
    ...(files.length ? { attachments: files } : {}),
  };
  const saved = saveMessage(wp, message);
  // RCA (7 Oct): a COO reply to a mention or stall went only to the COO chat, never to the story or
  // Team Room thread the agent watches, so Zoya, Rohan and Asha re-asked questions already answered.
  // Mirror it where the conversation actually is.
  try {
    const where = threadOf(wp, spec.inReplyTo);
    if (where && text) threadReply(wp, { ...where, text });
  } catch { /* the chat reply stands even if the mirror fails */ }
  return saved;
}

/** The story or Team Room thread a bridge entry (cbi_…) came from, via its COO item, if any. */
function threadOf(wp: Workplace, bridgeId: string): { itemId?: string; threadId?: string } | undefined {
  if (!bridgeId.startsWith('cbi_') || !existsSync(inboxFile(wp))) return undefined;
  const line = readFileSync(inboxFile(wp), 'utf8').split('\n').reverse().find(l => l.includes(`"id":"${bridgeId}"`));
  if (!line) return undefined;
  const entry = JSON.parse(line) as { coiId?: string; itemId?: string };
  const coiId = entry.coiId ?? (entry.itemId?.startsWith('coi_') ? entry.itemId : undefined);
  const item = coiId ? getItem(wp, coiId) : undefined;
  if (item?.itemId) return { itemId: item.itemId };
  if (item?.threadId) return { threadId: item.threadId };
  return undefined;
}

/* ---------- escalation and mention routing ---------- */

function saveItem(wp: Workplace, item: CooItem): CooItem {
  wp.db.prepare('insert into coo_items (id, kind, state, created_at, json) values (?, ?, ?, ?, ?)')
    .run(item.id, item.kind, item.state, item.at, JSON.stringify(item));
  wp.emit({ type: 'coo.item', item });
  return item;
}

function updateItem(wp: Workplace, item: CooItem): CooItem {
  wp.db.prepare('update coo_items set state = ?, json = ? where id = ?').run(item.state, JSON.stringify(item), item.id);
  wp.emit({ type: 'coo.item', item });
  return item;
}

export function getItem(wp: Workplace, id: string): CooItem | undefined {
  return rowJson<CooItem>(wp.db.prepare('select json from coo_items where id = ?').get(id));
}

export function listItems(wp: Workplace, state?: CooItem['state']): CooItem[] {
  const rows = state
    ? wp.db.prepare('select json from coo_items where state = ? order by created_at desc').all(state)
    : wp.db.prepare('select json from coo_items order by created_at desc').all();
  return rowsJson<CooItem>(rows);
}

export interface RouteEscalationSpec {
  kind?: 'escalation' | 'mention';
  title: string;
  body: string;
  by: string;
  threadId?: string;
  options?: InboxOption[];
  /** Passed through to the owner's Inbox item if this falls back (or is forwarded) — never lost. */
  context?: Record<string, unknown>;
  links?: { label: string; href: string }[];
  /** The raiser's recommendation: an option id or label (marked on it), else kept as text. */
  recommendation?: string;
}

/**
 * Anything Asha would raise above her own authority (a Team Room escalation, an `@coo` mention)
 * goes to the COO first. If the COO has been offline for more than 30 minutes the item still
 * reaches the owner's Inbox on its own — an urgent decision never silently waits on an absent COO.
 */
export function routeEscalation(wp: Workplace, spec: RouteEscalationSpec): { item: CooItem; ownerInboxId?: string } {
  const item: CooItem = {
    id: newId('coi'), at: now(), kind: spec.kind ?? 'escalation', title: spec.title, body: spec.body,
    options: inbox.markRecommended(spec.options ?? [], spec.recommendation).options, raisedBy: spec.by, state: 'open', ...(spec.threadId ? { threadId: spec.threadId } : {}),
  };
  saveItem(wp, item);
  appendInboxFile(wp, { kind: item.kind, itemId: item.id, title: item.title, body: item.body, options: item.options });

  if (isOffline(wp, OFFLINE_FALLBACK_MS)) {
    const ownerItem = raiseToOwner(wp, item, spec, 'The COO has been offline for more than 30 minutes; this reached you directly.', true);
    return { item: getItem(wp, item.id)!, ownerInboxId: ownerItem.id };
  }
  return { item };
}

function raiseToOwner(wp: Workplace, item: CooItem, spec: RouteEscalationSpec, note: string, auto: boolean, recommendation?: string): InboxItem {
  const ownerItem = inbox.raise(wp, {
    kind: 'decision', title: item.title, body: `${item.body}\n\n${recommendation ? `The COO's recommendation: ${recommendation}` : note}`,
    raisedBy: item.raisedBy, options: item.options.length ? item.options : undefined,
    context: { ...(spec.context ?? {}), cooItemId: item.id }, ...(spec.links ? { links: spec.links } : {}),
    ...(recommendation ?? spec.recommendation ? { recommendation: recommendation ?? spec.recommendation } : {}),
  });
  updateItem(wp, { ...item, state: 'forwarded', forward: { inboxId: ownerItem.id, at: now(), auto, ...(recommendation ? { recommendation } : {}) } });
  return ownerItem;
}

/**
 * A stall (HLD D21): the COO hears of it at once — a `coo_items` row and a line in the bridge file —
 * and it never falls back to the owner's Inbox (stalls are the COO's to clear; Asha covers routine
 * resumes while the COO is offline, in watch.ts).
 */
export function notifyStall(wp: Workplace, spec: { itemId: string; title: string; body: string; by: string }): CooItem {
  const item: CooItem = {
    id: newId('coi'), at: now(), kind: 'stall', title: spec.title, body: spec.body, options: [],
    raisedBy: spec.by, state: 'open', itemId: spec.itemId,
  };
  saveItem(wp, item);
  appendInboxFile(wp, { kind: 'stall', itemId: spec.itemId, coiId: item.id, title: item.title, body: item.body });
  return item;
}

/**
 * The hygiene monitor's hourly summary (docs/HLD-jira-lifecycle.md §4): a bridge item of kind
 * `hygiene` and a line in the bridge file. Never falls back to the owner's Inbox.
 */
export function notifyHygiene(wp: Workplace, spec: { title: string; body: string }): CooItem {
  const item: CooItem = { id: newId('coi'), at: now(), kind: 'hygiene', title: spec.title, body: spec.body, options: [], raisedBy: 'workplace', state: 'open' };
  saveItem(wp, item);
  appendInboxFile(wp, { kind: 'hygiene', coiId: item.id, title: item.title, body: item.body });
  return item;
}

/**
 * The owner replied in an Inbox thread the COO must hear (LLD §19.14): an item the COO raised or
 * forwarded (the COO answers it), or — `copy: true` — any decision, so the timeline owner knows what
 * the owner said even though the raiser answers it.
 */
export function relayInboxReply(wp: Workplace, spec: { inboxId: string; title: string; text: string; messageId?: string; copy?: boolean; raisedBy?: string }): void {
  appendInboxFile(wp, {
    kind: 'inbox-reply', inboxId: spec.inboxId, title: spec.title, text: spec.text,
    ...(spec.messageId ? { messageId: spec.messageId } : {}), ...(spec.copy ? { copy: true } : {}), ...(spec.raisedBy ? { raisedBy: spec.raisedBy } : {}),
  });
}

/** `@coo` in a Room thread: routed the same way as one of Asha's escalations. */
export function notifyMention(wp: Workplace, spec: { threadId: string; threadTitle: string; by: string; text: string }): void {
  routeEscalation(wp, {
    kind: 'mention', title: `Mentioned in "${spec.threadTitle}"`, body: spec.text, by: spec.by, threadId: spec.threadId,
    context: { threadId: spec.threadId }, links: [{ label: 'Team Room thread', href: `#/room/${spec.threadId}` }],
  });
}

/**
 * The COO answers within its own authority: no owner Inbox item. An answer to an `@coo` mention
 * with a note is also posted where the mention was made (owner, 2 Oct), as the COO.
 */
export function answerItem(wp: Workplace, spec: { itemId: string; optionId: string; note?: string }): CooItem {
  const item = getItem(wp, spec.itemId);
  if (!item) throw new NotFound(`No COO item ${spec.itemId}`);
  if (item.state !== 'open') throw new BadRequest(`${spec.itemId} was already ${item.state}`);
  const answered = updateItem(wp, { ...item, state: 'answered', answer: { optionId: spec.optionId, ...(spec.note ? { note: spec.note } : {}), at: now() } });
  // A mention or an escalation answered with a note: the answer lands where it was asked, so the asker sees it.
  if ((item.kind === 'mention' || item.kind === 'escalation') && item.threadId && spec.note?.trim()) threadReply(wp, { threadId: item.threadId, text: spec.note });
  return answered;
}

/**
 * The COO posting as itself (owner, 2 Oct): into a Room thread (`threadId`), or on an item
 * (`itemId`, or a mention's `item:<id>` thread). The owner's routes always write as `owner`; this is
 * the lead's own path (POST /api/coo/thread-reply, loopback only) and the mention answer's.
 */
export function threadReply(wp: Workplace, spec: { threadId?: string; itemId?: string; text: string }): RoomMessage | Comment {
  const text = spec.text?.trim() ?? '';
  if (!text) throw new BadRequest('Nothing to post.');
  const itemId = spec.itemId ?? (spec.threadId?.startsWith('item:') ? spec.threadId.slice('item:'.length) : undefined);
  if (itemId) return trail.comment(wp, itemId, { by: COO_ID, text });
  if (!spec.threadId) throw new BadRequest('Give a threadId or an itemId.');
  return room.post(wp, spec.threadId, { by: COO_ID, text });
}

/** The COO forwards it to the owner with a recommendation: becomes an owner Inbox item. */
export function forwardItem(wp: Workplace, spec: { itemId: string; recommendation: string }): InboxItem {
  const item = getItem(wp, spec.itemId);
  if (!item) throw new NotFound(`No COO item ${spec.itemId}`);
  if (item.state !== 'open') throw new BadRequest(`${spec.itemId} was already ${item.state}`);
  if (!spec.recommendation.trim()) throw new BadRequest('A forward needs a recommendation.');
  return raiseToOwner(wp, item, { title: item.title, body: item.body, by: item.raisedBy, ...(item.threadId ? { threadId: item.threadId } : {}) }, '', false, spec.recommendation.trim());
}

/* ---------- the approved live-check window ---------- */

const LIVE_WINDOW_KEY = (employeeId: string): string => `live-window:${employeeId}`;

/**
 * POST /api/coo/live-window: the owner (loopback only, like every other COO-only route) opens a
 * time-boxed exception that lets one employee's session run a host command on the real Mac
 * instead of being denied by the guard (guards.ts HOST_COMMANDS). Off by default; nothing opens
 * it on its own.
 */
export function openLiveWindow(wp: Workplace, employeeId: string, minutes: number): { employeeId: string; until: string } {
  if (!Number.isFinite(minutes) || minutes <= 0) throw new BadRequest('minutes must be a positive number.');
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(LIVE_WINDOW_KEY(employeeId), until);
  return { employeeId, until };
}

/** The window ends now (mac-queue: a release, an expiry, a grant taken over): the setting is removed. */
export function closeLiveWindow(wp: Workplace, employeeId: string): void {
  wp.db.prepare('delete from settings where key = ?').run(LIVE_WINDOW_KEY(employeeId));
}

/** Every window still open now, by employee (mac-queue: a COO-opened window holds the Mac too). */
export function openLiveWindows(wp: Workplace, nowMs = Date.now()): { employeeId: string; until: number }[] {
  const rows = wp.db.prepare("select key, value from settings where key like 'live-window:%'").all() as { key: string; value: string }[];
  return rows
    .map(r => ({ employeeId: r.key.slice('live-window:'.length), until: Date.parse(r.value) }))
    .filter(w => Number.isFinite(w.until) && w.until > nowMs);
}

/** The window's expiry as an absolute ms timestamp, or null when none is set. */
export function liveWindowUntil(wp: Workplace, employeeId: string): number | null {
  const row = wp.db.prepare('select value from settings where key = ?').get(LIVE_WINDOW_KEY(employeeId)) as { value: string } | undefined;
  if (!row) return null;
  const t = Date.parse(row.value);
  return Number.isFinite(t) ? t : null;
}

export function isLiveWindowOpen(wp: Workplace, employeeId: string, nowMs = Date.now()): boolean {
  const until = liveWindowUntil(wp, employeeId);
  return until !== null && nowMs < until;
}

/** Test-only: simulate the lead's heartbeat without waiting on a real process. */
export function touchHeartbeatForTest(wp: Workplace, at = new Date()): void {
  const file = heartbeatFile(wp);
  if (!existsSync(file)) appendFileSync(file, '');
  utimesSync(file, at, at);
}

export const readInboxFileForTest = (wp: Workplace): string => existsSync(inboxFile(wp)) ? readFileSync(inboxFile(wp), 'utf8') : '';
