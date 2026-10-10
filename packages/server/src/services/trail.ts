import type { Activity, ActivityKind, Comment, Update, UpdateKind, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as inbox from './inbox.js';
import * as room from './room.js';
import { newId, now, rowsJson } from './store.js';
import { oneLine, overCap } from './one-line.js';

/** How much of a block's reason the feed line carries. */
const BLOCKED_REASON_MAX = 100;
import { authorId, chiefOfStaffId, epicOf, isAgent, levelOf, nameOf, rawGet } from './v2-map.js';
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
    id: newId('act'), at: spec.at ?? now(), itemId: spec.itemId, by: authorId(wp, spec.by), kind: spec.kind, text: spec.text,
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

export function comment(wp: Workplace, itemId: string, given: { by: string; text: string; details?: string; mentions?: string[] }): Comment {
  const spec = { ...given, by: authorId(wp, given.by) };
  if (!rawGet(wp, itemId)) throw new BadRequest(`No item ${itemId}`);
  if (!spec.text.trim()) throw new BadRequest('An empty comment says nothing.');
  // Owner, 10 Oct: an agent's comment is capped at 1200 characters and refused above it (never cut);
  // what is accepted is stored whole. The owner, the COO and the Workplace's own notes are uncapped.
  const over = isAgent(wp, spec.by) ? overCap(spec.text) : null;
  if (over) throw new BadRequest(over);
  const details = spec.details;
  const c: Comment = {
    id: newId('cm'), itemId, at: now(), by: spec.by, text: spec.text.trim(),
    // Several people at once (owner, 4 Oct): the ids the app sends plus every @id/@Name in the text.
    ...(details ? { details } : {}), mentions: [...new Set([...(spec.mentions ?? []), ...room.mentionsIn(wp, spec.text)])],
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
  let feed: { kind: UpdateKind; line: string; details?: string } | null = null;
  let roomLine: string | null = null;
  if (next.status === 'in-progress' && (prev.status === 'ready' || prev.status === 'backlog') && level === 'story') {
    feed = { kind: 'started', line: `Started: ${next.title} — ${Who}${pts}` };
    roomLine = `${noun} '${next.title}' started — ${Who}`;
  } else if (next.status === 'done' && (next.resolution ?? 'done') === 'done' && (level === 'story' || level === 'epic')) {
    feed = { kind: 'shipped', line: `Shipped: ${next.title} — ${Who}${pts}` };
    roomLine = `${noun} '${next.title}' is done`;
  } else if (next.status === 'blocked' && level !== 'epic') {
    const waiting = nameOf(wp, next.waitingOn);
    // One sentence of the reason, ~100 chars (iOS QA, 2 Oct); the whole reason is the line's details and stays on the item.
    const reason = next.blockedReason?.trim() || 'no reason given';
    const said = oneLine(reason, BLOCKED_REASON_MAX).summary;
    feed = { kind: 'blocked', line: `Blocked: ${next.title} — waiting on ${waiting}: ${said}`, ...(said !== reason ? { details: reason } : {}) };
    roomLine = `${noun} '${next.title}' is blocked: waiting on ${waiting}`;
  } else if (prev.status === 'blocked' && next.status !== 'done' && level !== 'epic') {
    feed = { kind: 'unblocked', line: `Unblocked: ${next.title} — ${Who}` };
    roomLine = `${noun} '${next.title}' is unblocked`;
  }
  if (!feed) return;
  // Only real, new news (QA 2 Oct): an Unblocked line needs the block it ends to have been
  // announced, and an identical line for the same item inside the window is not posted again —
  // neither in the feed nor in the epic's thread, so a flapping item cannot flood either.
  if (feed.kind === 'unblocked' && lastBlockLine(wp, next.id) !== 'blocked') return;
  if (repeated(wp, next.id, feed.kind, feed.line)) return;
  postUpdate(wp, { ...feed, by: feed.kind === 'started' ? chiefOfStaffId(wp) ?? by : by, itemId: next.id });
  if (roomLine) {
    const epic = epicOf(wp, next);
    const thread = epic ? room.epicThread(wp, epic) : undefined;
    if (thread) room.postLine(wp, thread.id, { text: roomLine, kind: 'update', itemId: next.id });
  }
}

/** Run ids and session ids differ between two otherwise identical lines; they are not news. */
const sameLine = (line: string): string => line.replace(/\b(run|sess|session)_[a-z0-9]+\b/gi, '$1_*').trim();

/** The same item, kind and line posted within `updateDedupeMinutes`. */
function repeated(wp: Workplace, itemId: string, kind: UpdateKind, line: string): boolean {
  const since = new Date(Date.now() - wp.config.updateDedupeMinutes * 60_000).toISOString();
  const recent = rowsJson<Update>(wp.db.prepare('select json from updates where item_id = ? and kind = ? and at >= ? order by seq desc limit 20').all(itemId, kind, since));
  const want = sameLine(line);
  return recent.some(u => sameLine(u.line) === want);
}

/** The newest Blocked/Unblocked line posted for an item, if any. */
function lastBlockLine(wp: Workplace, itemId: string): UpdateKind | undefined {
  const row = wp.db.prepare("select kind from updates where item_id = ? and kind in ('blocked', 'unblocked') order by seq desc limit 1").get(itemId) as { kind: UpdateKind } | undefined;
  return row?.kind;
}

/** Blocked on the owner → one Inbox question with the recommendation; leaving blocked withdraws it. */
function ownerBlock(wp: Workplace, prev: WorkItem, next: WorkItem): void {
  const key = `blocked:${next.id}`;
  if (next.status === 'blocked' && next.waitingOn === 'owner') {
    // The block names an ask already in his Inbox ("filed in his Inbox (in_x)"): that ask IS this
    // block. Link it to the item and raise nothing (RCA in inbox.raiseOrReuse).
    const named = inbox.openAsksNamedIn(wp, `${next.blockedReason ?? ''}\n${next.blockedRecommendation ?? ''}`);
    if (named.length) { for (const i of named) inbox.linkToItem(wp, i.id, next.id); return; }
    inbox.raise(wp, {
      kind: 'question', title: `Blocked on you: ${next.title}`,
      body: `${next.blockedReason ?? 'Needs you.'}${next.blockedRecommendation ? `\n\nRecommendation: ${next.blockedRecommendation}` : ''}`,
      raisedBy: next.employeeId && next.employeeId !== 'owner' ? next.employeeId : 'workplace',
      context: { itemId: next.id, ...(next.blockedRecommendation ? { recommendation: next.blockedRecommendation } : {}) }, dedupeKey: key,
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
  postUpdate(wp, { kind: 'decided', line: `Decided: ${item.title} — ${option?.label ?? item.answer.optionId}`, by: item.answer.by ?? 'owner', inboxId: item.id });
});
