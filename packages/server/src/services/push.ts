import type { InboxKind, RoomMessage, RoomThread } from '@jkj/shared';
import type { Workplace, WorkplaceEvent } from './workplace.js';
import * as inbox from './inbox.js';
import { log } from '../util/logger.js';

/**
 * Push intents for the owner's phone (LLD-workplace-push §3, §4).
 *
 * This module decides *what* reaches the phone while the app is closed and
 * shapes it into a short, safe frame. Delivery is the relay's: it holds the
 * device tokens and the APNs key; the Mac holds neither. Nothing here ever
 * blocks a Workplace event.
 *
 * What pushes: every Inbox item (an `alert` with `inboxId`), alerts at
 * `needs-you` / `blocked` / `cap` without one, and Team Room messages that
 * @mention the owner. What never pushes: `info`, answered items, the owner's
 * own messages, anything while the tunnel is down or push is off.
 */

export type PushLevel = 'needs-you' | 'blocked' | 'cap' | 'mention' | 'update';
export type PushCategory = 'WP_INBOX' | 'WP_ROOM' | 'WP_ALERT' | 'WP_UPDATE';

export interface PushIntent {
  id: string;
  title: string;
  body: string;
  collapseId: string;
  threadId: 'inbox' | 'alerts' | 'room' | 'updates';
  level: PushLevel;
  category: PushCategory;
  /** Ids and the deep link only; never content. */
  data: { link: string; inboxId?: string; threadId?: string; employeeId?: string; itemId?: string };
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

export function scrub(body: string): string {
  const line = oneLine(body, BODY_MAX);
  if (!line) return GENERIC_BODY;
  return SECRET_SHAPES.some(re => re.test(line)) || KEY_RUN.test(line) ? GENERIC_BODY : line;
}

export function ownerMentionPattern(handles: string[]): RegExp {
  const alts = handles.map(h => h.trim()).filter(Boolean).map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(^|[^A-Za-z0-9_])@(${alts.join('|') || 'owner'})(?![A-Za-z0-9_-])`, 'i');
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'alert';

/** Pure: the intent an event calls for, or null. */
export function intentFor(wp: Workplace, event: WorkplaceEvent, handles: string[]): PushIntent | null {
  if (event.type === 'alert') {
    if (event.level === 'info') return null;
    if (event.inboxId) {
      const item = inbox.get(wp, event.inboxId);
      if (item && item.state !== 'open') return null;
      const raiser = item ? nameOf(wp, item.raisedBy) : '';
      const body = item ? `${KIND_LABEL[item.kind] ?? 'Needs you'}${raiser ? ` · from ${raiser}` : ''}` : GENERIC_BODY;
      return {
        id: newId(), title: oneLine(item?.title ?? event.title, TITLE_MAX), body,
        collapseId: `inbox:${event.inboxId}`, threadId: 'inbox', level: 'needs-you', category: 'WP_INBOX',
        data: { link: `inbox/${event.inboxId}`, inboxId: event.inboxId },
      };
    }
    const employee = wp.org.employees.find(e => event.title.startsWith(`${e.name} `) || event.title.startsWith(`${e.id} `));
    const toolApproval = /waiting for a tool approval/i.test(event.title);
    return {
      id: newId(), title: oneLine(event.title, TITLE_MAX), body: toolApproval ? TOOL_APPROVAL_BODY : scrub(event.body),
      collapseId: `alert:${slug(event.title)}`, threadId: 'alerts', level: event.level, category: 'WP_ALERT',
      data: { link: employee ? `employee/${employee.id}` : 'office', ...(employee ? { employeeId: employee.id } : {}) },
    };
  }
  // v2 (HLD D22): the Updates the owner chose to be pushed — start, block, the brief, the review.
  if (event.type === 'update.posted') {
    const u = event.update;
    if (!u.push) return null;
    return {
      id: newId(), title: oneLine(u.line, TITLE_MAX), body: u.kind === 'brief' ? 'Your morning brief' : u.kind === 'review' ? 'The weekly review' : 'Updates',
      collapseId: `update:${u.itemId ?? u.kind}`, threadId: 'updates', level: u.kind === 'blocked' ? 'blocked' : 'update', category: 'WP_UPDATE',
      data: { link: u.href, ...(u.itemId ? { itemId: u.itemId } : {}), ...(u.inboxId ? { inboxId: u.inboxId } : {}) },
    };
  }
  if (event.type === 'room.message') {
    const { message, thread } = event as { message: RoomMessage; thread: RoomThread };
    if (message.owner || message.by === 'owner') return null;
    if (!ownerMentionPattern(handles).test(message.text)) return null;
    return {
      id: newId(), title: oneLine(`${nameOf(wp, message.by)} mentioned you in "${thread.title}"`, TITLE_MAX),
      body: scrub(message.text.split('\n').find(l => l.trim()) ?? ''),
      collapseId: `room:${thread.id}`, threadId: 'room', level: 'mention', category: 'WP_ROOM',
      data: { link: `room/${thread.id}`, threadId: thread.id },
    };
  }
  return null;
}

/** "23-07": IST hours during which needs-you and mentions are not sent (cap and blocked still are). */
export function inQuietHours(spec: string | undefined, at: number): boolean {
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

  constructor(private readonly wp: Workplace, private readonly deps: PushDeps) {}

  get enabled(): boolean { return this.wp.config.push; }

  attach(): void {
    if (this.detach) return;
    this.detach = this.wp.on(event => { try { this.handle(event); } catch (err) { log.warn('push', String(err)); } });
  }

  stop(): void { this.detach?.(); this.detach = null; }

  /** One event in; at most one frame out. Returns what was sent (for tests and the log). */
  handle(event: WorkplaceEvent): PushIntent | null {
    if (!this.enabled) return null;
    const intent = intentFor(this.wp, event, this.wp.config.ownerHandles);
    if (!intent) return null;
    const now = this.now();
    this.rollDay(now);
    if ((intent.level === 'needs-you' || intent.level === 'mention' || intent.level === 'update') && inQuietHours(this.wp.config.pushQuiet, now)) return null;
    const prior = this.seen.get(intent.collapseId);
    if (prior && now - prior.at < DEDUPE_MS && prior.title === intent.title) return null;
    while (this.window.length && now - this.window[0]! >= 60_000) this.window.shift();
    if (this.window.length >= BURST_PER_MINUTE) {
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
