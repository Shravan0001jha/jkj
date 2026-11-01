import type { InboxKind, TalkMessage } from '@jkj/shared';
import { createHash } from 'node:crypto';
import type { Workplace, WorkplaceEvent } from './workplace.js';
import * as inbox from './inbox.js';
import * as chatPrefs from './chat-prefs.js';
import { superFocusActive } from './focus.js';
import { log } from '../util/logger.js';

export { superFocusActive } from './focus.js';

/**
 * Push intents for the owner's phone (LLD-workplace-push §3, §4).
 *
 * This module decides *what* reaches the phone while the app is closed and
 * shapes it into a short, safe frame. Delivery is the relay's: it holds the
 * device tokens and the APNs key; the Mac holds neither. Nothing here ever
 * blocks a Workplace event.
 *
 * What pushes (rework W4; owner, 10 Oct: "only what needs the owner"): an
 * owner Inbox item (an `alert` with `inboxId`, after the COO's 15-minute hold),
 * alerts at `needs-you` (a tool approval, the COO pickup alarm) / `blocked` (a
 * failed release) / `cap`, and a stall's `ring` (critical sound, never held by
 * quiet hours: the stall chain already decided it may ring). What never pushes:
 * `info`, answered items, Updates, Team Room mentions, anything while the tunnel
 * is down or push is off.
 */

export type PushLevel = 'needs-you' | 'blocked' | 'cap' | 'mention' | 'update' | 'ring' | 'info';
export type PushCategory = 'WP_INBOX' | 'WP_ROOM' | 'WP_ALERT' | 'WP_UPDATE' | 'WP_CHAT';

export interface PushIntent {
  id: string;
  title: string;
  body: string;
  collapseId: string;
  /** APNs thread-id: 'inbox' | 'alerts' | 'room' | 'updates', or `chat:<id>` for a chat (CHAT-NOTIFY-CONTRACT §1). */
  threadId: string;
  level: PushLevel;
  category: PushCategory;
  /** Ids and the deep link only; never content. */
  data: { link: string; inboxId?: string; threadId?: string; employeeId?: string; itemId?: string };
  /** A ring: the relay asks APNs for a critical alert sound where the app is entitled to it, else the default. */
  sound?: 'critical';
}

export interface PushResult { id: string; sent: number; dropped: number; failed: number }

export interface PushDeps {
  /** Hands the intent to the tunnel; false when nothing is connected (the intent is dropped, not queued). */
  send: (intent: PushIntent) => boolean;
  now?: () => number;
}

export interface PushStatus {
  enabled: boolean;
  sentToday: number;
  suppressedToday: number;
  last?: PushResult & { at: string };
}

export const TITLE_MAX = 80;
export const BODY_MAX = 120;
export const DEDUPE_MS = 10 * 60_000;
export const BURST_PER_MINUTE = 6;
/** Chat pushes (owner, 1 Nov): Telegram-style text, up to 1000 chars; more than 4 a minute per chat fold into one. */
export const CHAT_BODY_MAX = 1000;
export const CHAT_PER_MINUTE = 4;
const APNS_THREAD_MAX = 32;
const DEDUPE_KEEP = 500;

const KIND_LABEL: Record<InboxKind, string> = {
  approval: 'Approval', decision: 'Decision', question: 'Question', cap: 'Budget cap', 'org-change': 'Org change', release: 'Release',
};

/** A body that looks like it carries a credential is not sent; the app has the real thing. */
const SECRET_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{8,}/, /\bghp_[A-Za-z0-9]{8,}/, /\bgithub_pat_[A-Za-z0-9_]{8,}/, /\bAKIA[A-Z0-9]{12,}/,
  /\btoken\s*[=:]/i, /\bpassword\b/i, /\bBearer\s+\S+/, /\bsecret\s*[=:]/i, /-----BEGIN /,
  /\b[0-9a-f]{32,}\b/i,
];
/** A 40+ character run mixing letters and digits with no separator: an API key, not a word or a path. */
const KEY_RUN = /(?:^|[^A-Za-z0-9_-])((?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,})(?![A-Za-z0-9_-])/;
const GENERIC_BODY = 'Open the app for details';
const TOOL_APPROVAL_BODY = 'Open the employee page to allow or deny.';

export function oneLine(text: string, limit: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length <= limit ? s : `${s.slice(0, limit - 1)}…`;
}

export function scrub(body: string, max = BODY_MAX): string {
  const line = oneLine(body, max);
  if (!line) return GENERIC_BODY;
  return SECRET_SHAPES.some(re => re.test(line)) || KEY_RUN.test(line) ? GENERIC_BODY : line;
}

export function ownerMentionPattern(handles: string[]): RegExp {
  const alts = handles.map(h => h.trim()).filter(Boolean).map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(^|[^A-Za-z0-9_])@(${alts.join('|') || 'owner'})(?![A-Za-z0-9_-])`, 'i');
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'alert';

/** Pure: the intent an event calls for, or null. */
export function intentFor(wp: Workplace, event: WorkplaceEvent, _handles: string[]): PushIntent | null {
  if (event.type === 'alert') {
    if (event.level === 'info') return null;
    if (event.inboxId) {
      const item = inbox.get(wp, event.inboxId);
      if (item && item.state !== 'open') return null;
      // Still held for the COO (rework W4): its push comes when the hold ends.
      if (item?.cooHold && Date.parse(item.cooHold.until) > Date.now()) return null;
      const raiser = item ? nameOf(wp, item.raisedBy) : '';
      const body = item ? `${KIND_LABEL[item.kind] ?? 'Needs you'}${raiser ? ` · from ${raiser}` : ''}` : GENERIC_BODY;
      return {
        id: newId(), title: oneLine(item?.title ?? event.title, TITLE_MAX), body,
        collapseId: `inbox:${event.inboxId}`, threadId: 'inbox', level: 'needs-you', category: 'WP_INBOX',
        data: { link: `inbox/${event.inboxId}`, inboxId: event.inboxId },
      };
    }
    const itemId = event.itemIds?.[0];
    if (event.level === 'ring') {
      return {
        id: newId(), title: oneLine(event.title, TITLE_MAX), body: scrub(event.body),
        collapseId: `ring:${slug(event.title)}`, threadId: 'alerts', level: 'ring', category: 'WP_ALERT', sound: 'critical',
        data: itemId ? { link: `item/${itemId}`, itemId } : { link: 'office' },
      };
    }
    const employee = wp.org.employees.find(e => event.title.startsWith(`${e.name} `) || event.title.startsWith(`${e.id} `));
    const toolApproval = /waiting for a tool approval/i.test(event.title);
    return {
      id: newId(), title: oneLine(event.title, TITLE_MAX), body: toolApproval ? TOOL_APPROVAL_BODY : scrub(event.body),
      collapseId: `alert:${slug(event.title)}`, threadId: 'alerts', level: event.level, category: 'WP_ALERT',
      // Owner, 1 Nov: an alert about a story opens that story.
      data: itemId ? { link: `item/${itemId}`, itemId, ...(employee ? { employeeId: employee.id } : {}) }
        : { link: employee ? `employee/${employee.id}` : 'office', ...(employee ? { employeeId: employee.id } : {}) },
    };
  }
  // Rework W4: Updates and Team Room mentions no longer push; the owner reads them in the app.
  return null;
}

/* ---------- chat pushes (CHAT-NOTIFY-CONTRACT §1; LLD-chat-notify §3) ---------- */

/** `chat:<id>`, hashed deterministically when longer than the relay's 32-char thread-id cap. */
export function apnsThread(id: string): string {
  const t = `chat:${id}`;
  return t.length <= APNS_THREAD_MAX ? t : `chat:${createHash('sha1').update(id).digest('hex').slice(0, APNS_THREAD_MAX - 5)}`;
}

/** The message text (scrubbed, at most 1000 chars), or a label for an attachment-only message. */
export function chatBody(m: Pick<TalkMessage, 'text' | 'attachments' | 'voice'>): string {
  if (m.text && m.text.trim()) return scrub(m.text, CHAT_BODY_MAX);
  if (m.voice) return '🎤 Voice message';
  const a = m.attachments?.[0];
  if (!a) return GENERIC_BODY;
  return a.kind === 'image' ? '📷 Photo' : `📄 ${oneLine(a.name, 60)}`;
}

/** The chat a push is for, or null: only agent messages in a chat the owner has not muted. */
export function chatIntentFor(wp: Workplace, event: WorkplaceEvent, now: number): (PushIntent & { chatId: string; messageId: string }) | null {
  if (event.type === 'talk.message') {
    const m = event.message;
    if (m.direction !== 'out' || m.quiet) return null;
    if (chatPrefs.isMuted(wp, m.threadId, now)) return null;
    const isCoo = m.threadId === 'coo';
    return {
      id: newId(), chatId: m.threadId, messageId: m.id,
      title: oneLine(m.fromName || (isCoo ? 'Claude — COO' : m.threadId), TITLE_MAX), body: chatBody(m),
      collapseId: `chat:${m.id}`, threadId: apnsThread(m.threadId), level: 'info', category: 'WP_CHAT',
      data: isCoo ? { link: 'chat/coo', threadId: 'coo' } : { link: `chat/${m.threadId}`, threadId: m.threadId, employeeId: m.threadId },
    };
  }
  if (event.type === 'room.message') {
    const m = event.message;
    if (m.owner || m.by === 'workplace' || (m.kind && m.kind !== 'message')) return null;
    if (chatPrefs.isMuted(wp, m.threadId, now)) return null;
    return {
      id: newId(), chatId: m.threadId, messageId: m.id,
      title: oneLine(`${nameOf(wp, m.by)} · ${event.thread.title}`, TITLE_MAX), body: scrub(m.details ?? m.text, CHAT_BODY_MAX),
      collapseId: `chat:${m.id}`, threadId: apnsThread(m.threadId), level: 'info', category: 'WP_CHAT',
      data: { link: `room/${m.threadId}`, threadId: m.threadId },
    };
  }
  return null;
}

/**
 * "23-07": IST hours during which needs-you pushes are not sent (cap, blocked and ring still are).
 * With a Workplace, super focus switches quiet hours off while it lasts (rework W4).
 */
export function inQuietHours(spec: string | undefined, at: number, wp?: Workplace): boolean {
  if (wp && superFocusActive(wp, at)) return false;
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(spec ?? '');
  if (!m) return false;
  const from = Number(m[1]) % 24, to = Number(m[2]) % 24;
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date(at))) % 24;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

export class Push {
  private readonly seen = new Map<string, { at: number; title: string }>();
  private readonly window: number[] = [];
  private suppressed = 0;
  private lastSummaryAt = 0;
  private sentToday = 0;
  private suppressedToday = 0;
  private day = '';
  private last: PushStatus['last'];
  private detach: (() => void) | null = null;
  /** Per chat: send times inside the current minute, and what is held for the "N new messages" push. */
  private readonly chatWin = new Map<string, { start: number; sent: number; held: number; last: PushIntent }>();
  private readonly chatSent = new Set<string>();
  private chatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly wp: Workplace, private readonly deps: PushDeps) {}

  get enabled(): boolean { return this.wp.config.push; }

  attach(): void {
    if (this.detach) return;
    this.detach = this.wp.on(event => { try { this.handle(event); } catch (err) { log.warn('push', String(err)); } });
    this.chatTimer = setInterval(() => { try { this.flushChats(); } catch (err) { log.warn('push', String(err)); } }, 10_000);
    this.chatTimer.unref?.();
  }

  stop(): void { this.detach?.(); this.detach = null; if (this.chatTimer) clearInterval(this.chatTimer); this.chatTimer = null; }

  /** One event in; at most one frame out. Returns what was sent (for tests and the log). */
  handle(event: WorkplaceEvent): PushIntent | null {
    if (!this.enabled) return null;
    if (event.type === 'talk.message' || event.type === 'room.message') return this.handleChat(event);
    const intent = intentFor(this.wp, event, this.wp.config.ownerHandles);
    if (!intent) return null;
    const now = this.now();
    this.rollDay(now);
    if ((intent.level === 'needs-you' || intent.level === 'mention' || intent.level === 'update') && inQuietHours(this.wp.config.pushQuiet, now, this.wp)) return null;
    const prior = this.seen.get(intent.collapseId);
    if (prior && now - prior.at < DEDUPE_MS && prior.title === intent.title) return null;
    while (this.window.length && now - this.window[0]! >= 60_000) this.window.shift();
    // A ring is never folded into a burst summary: it is the one push that must sound.
    if (intent.level !== 'ring' && this.window.length >= BURST_PER_MINUTE) {
      this.suppressed += 1;
      this.suppressedToday += 1;
      if (now - this.lastSummaryAt < 60_000) return null;
      const summary: PushIntent = {
        id: newId(), title: `${this.suppressed} more thing${this.suppressed === 1 ? '' : 's'} need${this.suppressed === 1 ? 's' : ''} you`, body: 'Open the Inbox',
        collapseId: 'summary', threadId: 'inbox', level: 'needs-you', category: 'WP_INBOX', data: { link: 'inbox' },
      };
      if (!this.deps.send(summary)) return null;
      this.lastSummaryAt = now;
      this.suppressed = 0;
      this.sentToday += 1;
      return summary;
    }
    if (!this.deps.send(intent)) return null;           // the Mac is not published right now: dropped, not queued
    this.window.push(now);
    this.sentToday += 1;
    this.remember(intent.collapseId, now, intent.title);
    return intent;
  }

  /**
   * Chat pushes: no quiet hours, no Inbox burst budget, no title dedupe. One push per message id; past 4 in a
   * minute per chat, the rest are held and go out as one "N new messages" push when that minute ends.
   */
  private handleChat(event: WorkplaceEvent): PushIntent | null {
    const now = this.now();
    const intent = chatIntentFor(this.wp, event, now);
    if (!intent || this.chatSent.has(intent.messageId)) return null;
    this.rollDay(now);
    this.chatSent.add(intent.messageId);
    while (this.chatSent.size > DEDUPE_KEEP) this.chatSent.delete(this.chatSent.values().next().value as string);
    const { chatId, messageId: _m, ...frame } = intent;
    let w = this.chatWin.get(chatId);
    if (!w || now - w.start >= 60_000) { this.flushChat(chatId, now); w = { start: now, sent: 0, held: 0, last: frame }; this.chatWin.set(chatId, w); }
    w.last = frame;
    if (w.sent >= CHAT_PER_MINUTE) { w.held += 1; return null; }
    if (!this.deps.send(frame)) return null;
    w.sent += 1;
    this.sentToday += 1;
    return frame;
  }

  /** Sends the held "N new messages" pushes whose minute has ended. Returns what was sent (tests call it directly). */
  flushChats(): PushIntent[] {
    const now = this.now();
    const out: PushIntent[] = [];
    for (const id of [...this.chatWin.keys()]) {
      const w = this.chatWin.get(id)!;
      if (now - w.start < 60_000) continue;
      const p = this.flushChat(id, now);
      if (p) out.push(p);
      this.chatWin.delete(id);
    }
    return out;
  }

  private flushChat(id: string, _now: number): PushIntent | null {
    const w = this.chatWin.get(id);
    if (!w || !w.held) return null;
    const summary: PushIntent = { ...w.last, id: newId(), body: `${w.held} new message${w.held === 1 ? '' : 's'}`, collapseId: `chat:${id}:more:${newId()}` };
    w.held = 0;
    if (!this.deps.send(summary)) return null;
    this.sentToday += 1;
    return summary;
  }

  /** The relay's answer, for the health line and the log. */
  result(r: PushResult): void {
    this.last = { ...r, at: new Date(this.now()).toISOString() };
    if (r.failed || r.dropped) log.warn('push', `${r.id}: sent ${r.sent}, dropped ${r.dropped}, failed ${r.failed}`);
  }

  status(): PushStatus {
    this.rollDay(this.now());
    return { enabled: this.enabled, sentToday: this.sentToday, suppressedToday: this.suppressedToday, ...(this.last ? { last: this.last } : {}) };
  }

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  private rollDay(now: number): void {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) { this.day = day; this.sentToday = 0; this.suppressedToday = 0; }
  }

  private remember(key: string, at: number, title: string): void {
    this.seen.delete(key);
    this.seen.set(key, { at, title });
    while (this.seen.size > DEDUPE_KEEP) this.seen.delete(this.seen.keys().next().value as string);
  }
}

function nameOf(wp: Workplace, id: string): string {
  if (id === 'owner') return 'You';
  if (id === 'workplace') return 'The Workplace';
  return wp.org.employees.find(e => e.id === id)?.name ?? id;
}

let counter = 0;
function newId(): string {
  counter = (counter + 1) % 1_000_000;
  return `p${Date.now().toString(36)}${counter.toString(36)}`;
}
