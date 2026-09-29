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
}

/**
 * Anything Asha would raise above her own authority (a Team Room escalation, an `@coo` mention)
 * goes to the COO first. If the COO has been offline for more than 30 minutes the item still
 * reaches the owner's Inbox on its own — an urgent decision never silently waits on an absent COO.
 */
export function routeEscalation(wp: Workplace, spec: RouteEscalationSpec): { item: CooItem; ownerInboxId?: string } {
  const item: CooItem = {
    id: newId('coi'), at: now(), kind: spec.kind ?? 'escalation', title: spec.title, body: spec.body,
    options: spec.options ?? [], raisedBy: spec.by, state: 'open', ...(spec.threadId ? { threadId: spec.threadId } : {}),
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
  });
  updateItem(wp, { ...item, state: 'forwarded', forward: { inboxId: ownerItem.id, at: now(), auto, ...(recommendation ? { recommendation } : {}) } });
  return ownerItem;
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

/** Test-only: simulate the lead's heartbeat without waiting on a real process. */
export function touchHeartbeatForTest(wp: Workplace, at = new Date()): void {
  const file = heartbeatFile(wp);
  if (!existsSync(file)) appendFileSync(file, '');
  utimesSync(file, at, at);
}

export const readInboxFileForTest = (wp: Workplace): string => existsSync(inboxFile(wp)) ? readFileSync(inboxFile(wp), 'utf8') : '';
