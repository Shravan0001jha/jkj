import type { InboxItem, InboxMessage } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as inbox from './inbox.js';
import * as employees from './employees.js';
import * as manager from './manager.js';
import * as coo from './coo.js';
import { chiefOfStaffId, isAgent, nameOf, rawGet } from './v2-map.js';
import { now, rowJson, rowsJson } from './store.js';
import { log } from '../util/logger.js';

/**
 * Durable delivery of the owner's Inbox replies (LLD §19.14; owner, 3 Oct 01:05 UTC).
 *
 * The owner replied in free text on Rohan's Windows decision. The relay prompt went into Rohan's open
 * session while it was mid-turn, so it sat in the SDK's in-memory input queue; 90 s later the
 * Workplace restarted for an org change, the session was shut down, and the queued message died with
 * it. Nothing had recorded that the reply still needed an answer, so nothing tried again.
 *
 * Now each owner reply is a row in `inbox_deliveries` with `deliveredAt` / `ackedAt`:
 * - it is delivered to the raiser: its open session, else a short session (`employees.talk`,
 *   autonomous); a COO item goes to the COO bridge (`coo/inbox.jsonl`, kind `inbox-reply`), which is
 *   a durable file, so it counts as acknowledged once written;
 * - the raiser acknowledges by answering in the thread (`inbox_reply`) or by any activity of theirs on
 *   the work item the Inbox item is about;
 * - unacknowledged, it is delivered again when the session it went to is gone (a restart, a close) —
 *   on boot (the dispatcher's first sweep, after the staggered resumes) and on every sweep;
 * - unacknowledged after 10 minutes, Asha is told (manager.ts); after 20, the COO;
 * - the owner's reply on a decision is also copied to the COO bridge, so the timeline owner knows.
 */

const MIN = 60_000;
export const ASHA_AFTER_MS = 10 * MIN;
export const COO_AFTER_MS = 20 * MIN;
/** Deliveries to a session that then vanished; past this only the escalations act. */
export const MAX_ATTEMPTS = 5;

export interface ReplyDelivery {
  messageId: string;
  inboxId: string;
  /** An employee id, or `coo` for the COO bridge. */
  target: string;
  /** When the owner replied. */
  at: string;
  text: string;
  deliveredAt?: string;
  /** The run it was last handed to (an employee target). */
  agentId?: string;
  attempts: number;
  lastError?: string;
  ackedAt?: string;
  ackedBy?: 'thread' | 'activity' | 'bridge';
  ashaAt?: string;
  cooAt?: string;
}

function save(wp: Workplace, d: ReplyDelivery): ReplyDelivery {
  wp.db.prepare('insert or replace into inbox_deliveries (message_id, inbox_id, target, at, acked_at, json) values (?, ?, ?, ?, ?, ?)')
    .run(d.messageId, d.inboxId, d.target, d.at, d.ackedAt ?? null, JSON.stringify(d));
  return d;
}

export const get = (wp: Workplace, messageId: string): ReplyDelivery | undefined =>
  rowJson<ReplyDelivery>(wp.db.prepare('select json from inbox_deliveries where message_id = ?').get(messageId));

export const list = (wp: Workplace): ReplyDelivery[] =>
  rowsJson<ReplyDelivery>(wp.db.prepare('select json from inbox_deliveries order by at, rowid').all());

export const pending = (wp: Workplace): ReplyDelivery[] =>
  rowsJson<ReplyDelivery>(wp.db.prepare('select json from inbox_deliveries where acked_at is null order by at, rowid').all());

/** Who must answer the owner: the raiser if the Workplace runs them, the COO for its items, else the Chief of Staff. */
export function targetOf(wp: Workplace, item: InboxItem): string {
  if (item.raisedBy === coo.COO_ID) return coo.COO_ID;
  if (isAgent(wp, item.raisedBy)) return item.raisedBy;
  const cos = chiefOfStaffId(wp);
  return cos && isAgent(wp, cos) ? cos : coo.COO_ID;
}

/** The work items an Inbox item is about: its context ids, and ids named in its title or body. */
function linkedItems(wp: Workplace, item: InboxItem): string[] {
  const ids = new Set<string>();
  for (const k of ['itemId', 'assignmentId']) if (typeof item.context[k] === 'string') ids.add(item.context[k] as string);
  for (const m of `${item.title}\n${item.body}`.matchAll(/\b[a-z]{2}_[a-z0-9]{6,}\b/g)) ids.add(m[0]);
  return [...ids].filter(id => rawGet(wp, id));
}

function prompt(item: InboxItem, d: ReplyDelivery): string {
  const again = d.attempts > 0 ? '\n\n(Sent again: the first delivery was lost when the session it went to ended.)' : '';
  return `The owner replied on "${item.title}" (${item.id}): "${d.text}"\n\nAnswer in the same thread with inbox_reply, in a few short lines. ` +
    `The item is ${item.state === 'open' ? 'still open' : item.state}${item.options.length ? `; its options are ${item.options.map(o => o.label).join(', ')}` : ''}.${again}`;
}

/** Hand it over once: the COO bridge, or the employee's open session, else a short session. */
function deliver(wp: Workplace, d: ReplyDelivery, nowMs = Date.now()): ReplyDelivery {
  const item = inbox.get(wp, d.inboxId);
  if (!item) return save(wp, { ...d, ackedAt: new Date(nowMs).toISOString(), ackedBy: 'thread', lastError: 'the Inbox item is gone' });
  const at = new Date(nowMs).toISOString();
  if (d.target === coo.COO_ID) {
    coo.relayInboxReply(wp, { inboxId: item.id, title: item.title, text: d.text, messageId: d.messageId });
    return save(wp, { ...d, deliveredAt: at, attempts: d.attempts + 1, ackedAt: at, ackedBy: 'bridge' });
  }
  try {
    const agent = employees.talk(wp, d.target, prompt(item, d), [], { autonomous: true });
    const { lastError: _e, ...rest } = d;
    log.info('inbox', `owner reply ${d.messageId} on ${d.inboxId} delivered to ${d.target} (${agent.id}, attempt ${d.attempts + 1})`);
    return save(wp, { ...rest, deliveredAt: at, agentId: agent.id, attempts: d.attempts + 1 });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    log.warn('inbox', `owner reply ${d.messageId} to ${d.target}: ${why}`);
    return save(wp, { ...d, lastError: why });
  }
}

/** The owner replied in a thread: record it, copy a decision reply to the COO, deliver it. */
export function onOwnerReply(wp: Workplace, item: InboxItem, message: InboxMessage, nowMs = Date.now()): ReplyDelivery {
  const target = targetOf(wp, item);
  const d = save(wp, { messageId: message.id, inboxId: item.id, target, at: message.at, text: message.text, attempts: 0 });
  // The timeline owner always knows what the owner said on a decision (or on an item it forwarded).
  if (target !== coo.COO_ID && (item.kind === 'decision' || typeof item.context['cooItemId'] === 'string')) {
    try { coo.relayInboxReply(wp, { inboxId: item.id, title: item.title, text: message.text, messageId: message.id, copy: true, raisedBy: item.raisedBy }); }
    catch (err) { log.warn('inbox', `COO copy of ${message.id}: ${err instanceof Error ? err.message : err}`); }
  }
  return deliver(wp, d, nowMs);
}

/** Acknowledged: the target answered in the thread, or did something on the linked work, since the reply. */
function ackOf(wp: Workplace, d: ReplyDelivery): ReplyDelivery['ackedBy'] | null {
  const said = wp.db.prepare('select 1 from inbox_messages where inbox_id = ? and by = ? and at >= ? limit 1').get(d.inboxId, d.target, d.at);
  if (said) return 'thread';
  const item = inbox.get(wp, d.inboxId);
  const linked = item ? linkedItems(wp, item) : [];
  if (!linked.length) return null;
  const did = wp.db.prepare(`select 1 from activity where item_id in (${linked.map(() => '?').join(',')}) and by = ? and at > ? and kind != 'stall' limit 1`).get(...linked, d.target, d.at);
  return did ? 'activity' : null;
}

/** Mark every open delivery acknowledged that now is. Returns their message ids. */
export function checkAcks(wp: Workplace, nowMs = Date.now()): string[] {
  const out: string[] = [];
  for (const d of pending(wp)) {
    const by = ackOf(wp, d);
    if (!by) continue;
    save(wp, { ...d, ackedAt: new Date(nowMs).toISOString(), ackedBy: by });
    manager.resolve(wp, ashaKey(d));
    out.push(d.messageId);
  }
  return out;
}

const ashaKey = (d: ReplyDelivery): string => `inbox-reply:${d.messageId}`;

/** Not acknowledged and the session it went to is gone (or it never got there): hand it over again. */
function needsRedelivery(d: ReplyDelivery): boolean {
  if (d.ackedAt || d.target === coo.COO_ID && d.deliveredAt) return false;
  if (!d.deliveredAt || !d.agentId) return true;
  return !employees.isLive(d.agentId) && d.attempts < MAX_ATTEMPTS;
}

/**
 * One pass (boot and every dispatcher sweep): acknowledgements first, then re-delivery, then the
 * 10-minute alert to Asha and the 20-minute alert to the COO, once each.
 */
export function sweep(wp: Workplace, nowMs = Date.now()): { acked: string[]; redelivered: string[]; asha: string[]; coo: string[] } {
  const acked = checkAcks(wp, nowMs);
  const out = { acked, redelivered: [] as string[], asha: [] as string[], coo: [] as string[] };
  for (let d of pending(wp)) {
    if (needsRedelivery(d)) {
      const before = d.attempts;
      d = deliver(wp, d, nowMs);
      if (d.attempts > before) out.redelivered.push(d.messageId);
    }
    if (d.ackedAt) continue;
    const age = nowMs - Date.parse(d.at);
    const item = inbox.get(wp, d.inboxId);
    const title = item?.title ?? d.inboxId;
    const who = nameOf(wp, d.target);
    const mins = Math.round(age / MIN);
    if (age >= ASHA_AFTER_MS && !d.ashaAt) {
      manager.alert(wp, {
        // The Inbox id, not a work item: manager.escalate leaves it alone; the COO step is ours, at 20 min.
        key: ashaKey(d), itemId: d.inboxId, by: 'workplace', subjectId: d.target,
        title: `Owner's reply not answered: ${title}`,
        body: `${who} has not answered the owner's reply in ${mins} min.`,
        text: `The owner replied on "${title}" (${d.inboxId}) ${mins} min ago and ${who} has not answered: "${d.text}". ` +
          `Make sure ${who} has it and answers in the thread with inbox_reply (or answer it yourself with inbox_reply if ${who} cannot).`,
      }, nowMs);
      d = save(wp, { ...d, ashaAt: new Date(nowMs).toISOString() });
      out.asha.push(d.messageId);
    }
    if (age >= COO_AFTER_MS && !d.cooAt) {
      const linked = item ? linkedItems(wp, item)[0] : undefined;
      coo.notifyStall(wp, {
        itemId: linked ?? d.inboxId, by: 'workplace',
        title: `Owner's reply not answered: ${title}`,
        body: `The owner replied on ${d.inboxId} ${mins} min ago and ${who} has not answered (delivered ${d.attempts} time${d.attempts === 1 ? '' : 's'}${d.lastError ? `; last error: ${d.lastError}` : ''}). Asha was told at 10 min. The reply: "${d.text}"`,
      });
      d = save(wp, { ...d, cooAt: new Date(nowMs).toISOString() });
      out.coo.push(d.messageId);
    }
  }
  return out;
}

/* ---------- wiring ---------- */

inbox.onReply((wp, item, message) => {
  if (message.by === 'owner') { onOwnerReply(wp, item, message); return; }
  // The target answering in the thread acknowledges every earlier reply to it at once.
  const at = now();
  for (const d of pending(wp)) {
    if (d.inboxId !== item.id || d.target !== message.by) continue;
    save(wp, { ...d, ackedAt: at, ackedBy: 'thread' });
    manager.resolve(wp, ashaKey(d));
  }
});
