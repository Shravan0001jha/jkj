import type { Activity, ActivityKind, Comment, Update, UpdateKind, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as inbox from './inbox.js';
import * as room from './room.js';
import { newId, now, rowsJson } from './store.js';
import { short } from './one-line.js';
import { chiefOfStaffId, epicOf, levelOf, nameOf, rawGet } from './v2-map.js';
import { BadRequest } from '../util/errors.js';

/**
 * The trail of every item (HLD D22, LLD §19.4): the activity log (one row per change, and every
 * system or COO note — never Talk), comments, and the owner's Updates feed with the named lines
 * each area room posts. `afterChange` is the one place a write turns into rows, so the old engine
 * and the v2 routes produce the same history.
 */

/* ---------- activity ---------- */

export function record(wp: Workplace, spec: { itemId: string | null; by: string; kind: ActivityKind; text: string; from?: string; to?: string; link?: string; at?: string }): Activity {
  const a: Activity = {
    id: newId('act'), at: spec.at ?? now(), itemId: spec.itemId, by: spec.by, kind: spec.kind, text: spec.text,
    ...(spec.from !== undefined ? { from: spec.from } : {}), ...(spec.to !== undefined ? { to: spec.to } : {}), ...(spec.link ? { link: spec.link } : {}),
  };
  wp.db.prepare('insert into activity (id, at, item_id, by, kind, json) values (?, ?, ?, ?, ?, ?)').run(a.id, a.at, a.itemId, a.by, a.kind, JSON.stringify(a));
  wp.emit({ type: 'activity.recorded', activity: a });
  return a;
}

export function activityFor(wp: Workplace, itemId: string): Activity[] {
  return rowsJson<Activity>(wp.db.prepare('select json from activity where item_id = ? order by seq').all(itemId));
}

/** The newest real activity on an item, in ms (0 when none). The watcher's own stall notes do not count. */
export function lastActivityAt(wp: Workplace, itemId: string): number {
  const row = wp.db.prepare("select at from activity where item_id = ? and kind != 'stall' order by seq desc limit 1").get(itemId) as { at: string } | undefined;
  const c = wp.db.prepare('select at from comments where item_id = ? order by at desc limit 1').get(itemId) as { at: string } | undefined;
  return Math.max(row ? Date.parse(row.at) : 0, c ? Date.parse(c.at) : 0);
}

export function activitySince(wp: Workplace, sinceIso: string, kind?: ActivityKind): Activity[] {
  const rows = kind
    ? wp.db.prepare('select json from activity where at >= ? and kind = ? order by seq').all(sinceIso, kind)
    : wp.db.prepare('select json from activity where at >= ? order by seq').all(sinceIso);
  return rowsJson<Activity>(rows);
}

/* ---------- comments ---------- */

export function comment(wp: Workplace, itemId: string, spec: { by: string; text: string; details?: string }): Comment {
  if (!rawGet(wp, itemId)) throw new BadRequest(`No item ${itemId}`);
  if (!spec.text.trim()) throw new BadRequest('An empty comment says nothing.');
  const authored = spec.by === 'owner' || spec.by === 'workplace' ? { text: spec.text.trim() } : short(spec.text);
  const details = spec.details ?? authored.details;
  const c: Comment = {
    id: newId('cm'), itemId, at: now(), by: spec.by, text: authored.text,
    ...(details ? { details } : {}), mentions: room.mentionsIn(wp, spec.text),
  };
  wp.db.prepare('insert into comments (id, item_id, at, by, json) values (?, ?, ?, ?, ?)').run(c.id, itemId, c.at, c.by, JSON.stringify(c));
  record(wp, { itemId, by: spec.by, kind: 'comment', text: c.text.split('\n')[0]!.slice(0, 120) });
  wp.emit({ type: 'item.comment', comment: c });
  return c;
}

export function comments(wp: Workplace, itemId: string): Comment[] {
  return rowsJson<Comment>(wp.db.prepare('select json from comments where item_id = ? order by at, rowid').all(itemId));
}

/* ---------- the Updates feed ---------- */

const PUSHED: ReadonlySet<UpdateKind> = new Set(['started', 'blocked', 'brief', 'review']);

export function postUpdate(wp: Workplace, spec: { kind: UpdateKind; line: string; by: string; details?: string; itemId?: string; inboxId?: string; href?: string; at?: string }): Update {
  const u: Update = {
    id: newId('up'), at: spec.at ?? now(), kind: spec.kind, line: spec.line, by: spec.by,
    ...(spec.details ? { details: spec.details } : {}),
    ...(spec.itemId ? { itemId: spec.itemId } : {}),
    ...(spec.inboxId ? { inboxId: spec.inboxId } : {}),
    href: spec.href ?? (spec.itemId ? `item/${spec.itemId}` : spec.inboxId ? `inbox/${spec.inboxId}` : 'plan'),
    push: PUSHED.has(spec.kind),
  };
  wp.db.prepare('insert into updates (id, at, kind, item_id, json) values (?, ?, ?, ?, ?)').run(u.id, u.at, u.kind, u.itemId ?? null, JSON.stringify(u));
  wp.emit({ type: 'update.posted', update: u });
  return u;
}

/** Newest first. `before` is an update id (exclusive); `limit` ≤ 200, default 50. */
export function updates(wp: Workplace, q: { limit?: number; before?: string } = {}): Update[] {
  const limit = Math.min(Math.max(1, q.limit ?? 50), 200);
  const beforeSeq = q.before ? (wp.db.prepare('select seq from updates where id = ?').get(q.before) as { seq: number } | undefined)?.seq : undefined;
  const rows = beforeSeq !== undefined
    ? wp.db.prepare('select json from updates where seq < ? order by seq desc limit ?').all(beforeSeq, limit)
    : wp.db.prepare('select json from updates order by seq desc limit ?').all(limit);
  return rowsJson<Update>(rows);
}

/* ---------- one change → its rows ---------- */

const FIELDS: (keyof WorkItem)[] = ['title', 'body', 'targetDate', 'areaId', 'parentId', 'ownerId', 'rank', 'acceptance'];

/**
 * Record what changed between two versions of an item (prev null = created), post the feed line
 * and the room line a status move calls for, and keep the "blocked on the owner" Inbox item in step.
 */
export function afterChange(wp: Workplace, prev: WorkItem | null, next: WorkItem, by: string, note?: string): void {
  const id = next.id;
  if (!prev) {
    record(wp, { itemId: id, by, kind: 'created', text: `${levelOf(next)} created${next.employeeId ? `, assigned to ${nameOf(wp, next.employeeId)}` : ''}`, to: next.status });
    return;
  }
  if (prev.employeeId !== next.employeeId) record(wp, { itemId: id, by, kind: 'assigned', from: prev.employeeId ?? '', to: next.employeeId ?? '', text: `Assigned to ${nameOf(wp, next.employeeId)}` });
  if (prev.reviewerId !== next.reviewerId) record(wp, { itemId: id, by, kind: 'reviewer', from: prev.reviewerId ?? '', to: next.reviewerId ?? '', text: `Reviewer: ${nameOf(wp, next.reviewerId)}` });
  if (prev.points !== next.points) record(wp, { itemId: id, by, kind: 'points', from: String(prev.points ?? ''), to: String(next.points ?? ''), text: next.points ? `${next.points} points` : 'Points cleared' });
  for (const f of FIELDS) {
    if (JSON.stringify(prev[f] ?? null) !== JSON.stringify(next[f] ?? null)) {
      record(wp, { itemId: id, by, kind: 'field', from: fieldText(prev[f]), to: fieldText(next[f]), text: `${String(f)} changed` });
    }
  }
  if (next.evidence && JSON.stringify(prev.evidence ?? null) !== JSON.stringify(next.evidence)) {
    const e = next.evidence;
    record(wp, { itemId: id, by, kind: 'test', text: `Tests: ${e.tests.passed} passed, ${e.tests.failed} failed${e.tests.command ? ` (${e.tests.command})` : ''}` });
    if (e.commits.length) record(wp, { itemId: id, by, kind: 'commit', text: `Commits: ${e.commits.join(', ')}` });
  }
  if (prev.status !== next.status && next.status) {
    const reopen = prev.status === 'done' && next.status !== 'done';
    record(wp, { itemId: id, by, kind: reopen ? 'reopen' : 'status', from: prev.status ?? '', to: next.status, text: note ?? (reopen ? 'Reopened' : `${prev.status ?? '—'} → ${next.status}`) });
    announce(wp, prev, next, by);
    ownerBlock(wp, prev, next);
  }
}

const fieldText = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v.slice(0, 200) : JSON.stringify(v).slice(0, 200));

/** The feed line and the epic room's named line for a status move (never a count). */
function announce(wp: Workplace, prev: WorkItem, next: WorkItem, by: string): void {
  const level = levelOf(next);
  const who = nameOf(wp, level === 'epic' ? next.ownerId ?? next.employeeId : next.employeeId);
  const Who = who === 'you' ? 'You' : who;
  const pts = next.points ? `, ${next.points} pts` : '';
  const noun = level === 'epic' ? 'Epic' : level === 'task' ? 'Task' : 'Story';
  let feed: { kind: UpdateKind; line: string } | null = null;
  let roomLine: string | null = null;
  if (next.status === 'in-progress' && (prev.status === 'ready' || prev.status === 'backlog') && level === 'story') {
    feed = { kind: 'started', line: `Started: ${next.title} — ${Who}${pts}` };
    roomLine = `${noun} '${next.title}' started — ${Who}`;
  } else if (next.status === 'done' && (next.resolution ?? 'done') === 'done' && (level === 'story' || level === 'epic')) {
    feed = { kind: 'shipped', line: `Shipped: ${next.title} — ${Who}${pts}` };
    roomLine = `${noun} '${next.title}' is done`;
  } else if (next.status === 'blocked' && level !== 'epic') {
    const waiting = nameOf(wp, next.waitingOn);
    feed = { kind: 'blocked', line: `Blocked: ${next.title} — waiting on ${waiting}: ${next.blockedReason ?? 'no reason given'}` };
    roomLine = `${noun} '${next.title}' is blocked: waiting on ${waiting}`;
  } else if (prev.status === 'blocked' && next.status !== 'done' && level !== 'epic') {
    feed = { kind: 'unblocked', line: `Unblocked: ${next.title} — ${Who}` };
    roomLine = `${noun} '${next.title}' is unblocked`;
  }
  if (feed) postUpdate(wp, { ...feed, by: feed.kind === 'started' ? chiefOfStaffId(wp) ?? by : by, itemId: next.id });
  if (roomLine) {
    const epic = epicOf(wp, next);
    const thread = epic ? room.epicThread(wp, epic) : undefined;
    if (thread) room.postLine(wp, thread.id, { text: roomLine, kind: 'update', itemId: next.id });
  }
}

/** Blocked on the owner → one Inbox question with the recommendation; leaving blocked withdraws it. */
function ownerBlock(wp: Workplace, prev: WorkItem, next: WorkItem): void {
  const key = `blocked:${next.id}`;
  if (next.status === 'blocked' && next.waitingOn === 'owner') {
    inbox.raise(wp, {
      kind: 'question', title: `Blocked on you: ${next.title}`,
      body: `${next.blockedReason ?? 'Needs you.'}${next.blockedRecommendation ? `\n\nRecommendation: ${next.blockedRecommendation}` : ''}`,
      raisedBy: next.employeeId && next.employeeId !== 'owner' ? next.employeeId : 'workplace',
      context: { itemId: next.id }, dedupeKey: key,
      links: [{ label: 'The item', href: `#/item/${next.id}` }],
    });
  } else if (prev.status === 'blocked') {
    for (const i of inbox.list(wp, 'open').filter(x => x.context['dedupeKey'] === key)) inbox.expire(wp, i.id, 'Unblocked.');
  }
}

/* ---------- decisions land in the feed ---------- */

inbox.onAnswer((wp, item) => {
  if (!inbox.isOwnerFacing(item) || !item.answer || item.answer.via === 'workplace') return;
  const option = item.options.find(o => o.id === item.answer!.optionId);
  postUpdate(wp, { kind: 'decided', line: `Decided: ${item.title} — ${option?.label ?? item.answer.optionId}`, by: 'owner', inboxId: item.id });
});
