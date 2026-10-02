import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import type { CooItem, CooMessage, CooPresence, InboxItem, InboxOption } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as inbox from './inbox.js';
import { newId, now, rowJson, rowsJson } from './store.js';
import { BadRequest, NotFound } from '../util/errors.js';

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

function dir(wp: Workplace): string {
  const d = join(wp.config.workplaceDir, 'coo');
  mkdirSync(d, { recursive: true });
  return d;
}

const inboxFile = (wp: Workplace): string => join(dir(wp), 'inbox.jsonl');
const heartbeatFile = (wp: Workplace): string => join(dir(wp), 'heartbeat');

function appendInboxFile(wp: Workplace, entry: Record<string, unknown>): void {
  appendFileSync(inboxFile(wp), `${JSON.stringify({ id: newId('cbi'), at: now(), ...entry })}\n`, 'utf8');
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

/** The owner talking to the COO: appended to the inbox file the lead tails, and to the transcript. */
export function sendOwnerMessage(wp: Workplace, text: string): CooMessage {
  if (!text.trim()) throw new BadRequest('Nothing to send.');
  const message: CooMessage = { id: newId('com'), at: now(), from: 'owner', text: text.trim() };
  appendInboxFile(wp, { kind: 'message', text: message.text });
  return saveMessage(wp, message);
}

/**
 * The lead replying (loopback only). Chat-style: `text` is the message itself, short; `details` is
 * optional extra context behind an expand control, the same shape as every other line to the owner.
 */
export function replyFromCoo(wp: Workplace, spec: { inReplyTo: string; text: string; details?: string }): CooMessage {
  if (!spec.text.trim()) throw new BadRequest('Nothing to reply with.');
  if (!spec.inReplyTo.trim()) throw new BadRequest('Which message is this replying to?');
  const message: CooMessage = {
    id: newId('com'), at: now(), from: 'coo', text: spec.text.trim(), summary: spec.text.trim(),
    inReplyTo: spec.inReplyTo, ...(spec.details?.trim() ? { details: spec.details.trim() } : {}),
  };
  return saveMessage(wp, message);
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

/** The owner replied in the thread of an Inbox item the COO forwarded: the lead's watcher gets it. */
export function relayInboxReply(wp: Workplace, spec: { inboxId: string; title: string; text: string }): void {
  appendInboxFile(wp, { kind: 'inbox-reply', inboxId: spec.inboxId, title: spec.title, text: spec.text });
}

/** `@coo` in a Room thread: routed the same way as one of Asha's escalations. */
export function notifyMention(wp: Workplace, spec: { threadId: string; threadTitle: string; by: string; text: string }): void {
  routeEscalation(wp, {
    kind: 'mention', title: `Mentioned in "${spec.threadTitle}"`, body: spec.text, by: spec.by, threadId: spec.threadId,
    context: { threadId: spec.threadId }, links: [{ label: 'Team Room thread', href: `#/room/${spec.threadId}` }],
  });
}

/** The COO answers within its own authority: no owner Inbox item. */
export function answerItem(wp: Workplace, spec: { itemId: string; optionId: string; note?: string }): CooItem {
  const item = getItem(wp, spec.itemId);
  if (!item) throw new NotFound(`No COO item ${spec.itemId}`);
  if (item.state !== 'open') throw new BadRequest(`${spec.itemId} was already ${item.state}`);
  return updateItem(wp, { ...item, state: 'answered', answer: { optionId: spec.optionId, ...(spec.note ? { note: spec.note } : {}), at: now() } });
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
