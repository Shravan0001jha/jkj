import type { InboxAnswer, InboxItem, InboxKind, InboxMessage, InboxOption, InboxThread } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import { oneLine, overCap } from './one-line.js';
import { newId, now, rowJson, rowsJson } from './store.js';
import { humanizeIds } from './id-names.js';
import { isAgent, levelOf, rawGet } from './v2-map.js';
import { BadRequest, Conflict, NotFound } from '../util/errors.js';
import { appendBridgeLine } from './coo-bridge.js';
import { log } from '../util/logger.js';

/**
 * The Inbox: every decision or approval that needs the owner, with context
 * and one-tap answers. Employees raise items; only the owner answers them
 * (from the web, the phone or a Telegram reply). Answering is what the gates
 * in approvals.ts look for.
 */

export interface RaiseOptions {
  kind: InboxKind;
  title: string;
  body: string;
  context?: Record<string, unknown>;
  options?: InboxOption[];
  raisedBy: string;
  /** Reuse an open item with the same dedupe key instead of raising a second one. */
  dedupeKey?: string;
  /** Employees the item concerns, beyond what the context implies. */
  affects?: string[];
  onApprove?: string;
  onDeny?: string;
  links?: { label: string; href: string }[];
  /** One line for the owner (D16). Derived from the body when absent. */
  summary?: string;
  details?: string;
  /** False for routine housekeeping that must never reach the owner's Inbox (see InboxItem). */
  ownerFacing?: boolean;
  /**
   * Push to the owner at once, skipping the rework-W4 15-minute COO hold. Only for an item the COO
   * has already been told about and must not triage (the weekly pace trip, COO 17 Oct).
   */
  skipCooHold?: boolean;
  /** v2: shown by colour and label. Derived from the kind and the level of the work when absent (`urgencyOf`). */
  urgency?: InboxItem['urgency'];
  /**
   * v2 (the handbook: raise every decision "with your recommendation"): an option id or label, which
   * is marked `recommended` on that option; any other text is kept as `context.recommendation` and
   * added to the body as "Recommendation: …".
   */
  recommendation?: string;
}

/**
 * Urgency (LLD §19.5) from the kind and the level of the work the item is about: a cap stops work
 * (urgent); an approval or a release holds a session or a ship (high); a question or decision about
 * a blocked epic is urgent, about a story high, about a task normal; everything else normal.
 */
export function urgencyOf(wp: Workplace, kind: InboxKind, context: Record<string, unknown> = {}): NonNullable<InboxItem['urgency']> {
  if (kind === 'cap') return 'urgent';
  if (kind === 'approval' || kind === 'release') return 'high';
  const itemId = typeof context['itemId'] === 'string' ? context['itemId'] : typeof context['assignmentId'] === 'string' ? context['assignmentId'] : undefined;
  const w = itemId ? rawGet(wp, itemId) : undefined;
  if (w && (kind === 'question' || kind === 'decision') && w.status === 'blocked') {
    const level = levelOf(w);
    return level === 'epic' ? 'urgent' : level === 'story' ? 'high' : 'normal';
  }
  return 'normal';
}

const slugOf = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Mark the option the raiser recommends (by id or label); `matched` is false when none is named. */
export function markRecommended(options: InboxOption[], recommendation: string | undefined): { options: InboxOption[]; matched: boolean } {
  const rec = recommendation?.trim();
  if (!rec) return { options, matched: options.some(o => o.recommended) };
  const want = slugOf(rec);
  const hit = options.find(o => o.id === rec || slugOf(o.id) === want || slugOf(o.label) === want);
  if (!hit) return { options, matched: false };
  return { options: options.map(o => (o.id === hit.id ? { ...o, recommended: true } : (({ recommended: _r, ...rest }) => rest)(o))), matched: true };
}

/** True unless the raiser explicitly marked the item routine (a stall notice, a dead-session note). */
export const isOwnerFacing = (i: Pick<InboxItem, 'ownerFacing'>): boolean => i.ownerFacing !== false;

/**
 * Who an item concerns (HLD D7b): the raiser, the assignee of the work it is about, the holders
 * of the charters it touches, the scope of a cap, and always the Chief of Staff. It shows on each
 * of their pages with its options.
 */
export function affectsOf(wp: Workplace, spec: { raisedBy: string; context?: Record<string, unknown>; affects?: string[] }): string[] {
  const ids = new Set<string>(spec.affects ?? []);
  const employees = wp.org.employees;
  const is = (id: unknown) => typeof id === 'string' && employees.some(e => e.id === id);
  if (is(spec.raisedBy)) ids.add(spec.raisedBy);
  const ctx = spec.context ?? {};
  if (is(ctx['employeeId'])) ids.add(ctx['employeeId'] as string);
  if (typeof ctx['scope'] === 'string' && ctx['scope'].startsWith('employee:')) ids.add(ctx['scope'].slice('employee:'.length));
  if (typeof ctx['scope'] === 'string' && ctx['scope'].startsWith('unit:')) for (const e of employees) if (e.unitId === ctx['scope'].slice('unit:'.length)) ids.add(e.id);
  if (typeof ctx['assignmentId'] === 'string') {
    const row = wp.db.prepare('select employee_id from work where id = ?').get(ctx['assignmentId']) as { employee_id: string | null } | undefined;
    if (row?.employee_id) ids.add(row.employee_id);
  }
  const charters = [ctx['charterId'], ...(Array.isArray(ctx['charterIds']) ? ctx['charterIds'] : [])].filter((c): c is string => typeof c === 'string');
  const params = ctx['params'] && typeof ctx['params'] === 'object' ? ctx['params'] as Record<string, unknown> : {};
  charters.push(...[params['charterId'], ...(Array.isArray(params['charterIds']) ? params['charterIds'] : [])].filter((c): c is string => typeof c === 'string'));
  for (const key of ['toEmployeeId', 'fromEmployeeId', 'employeeId', 'successorId', 'reportsTo']) if (is(params[key])) ids.add(params[key] as string);
  if (typeof ctx['proposalId'] === 'string') {
    const p = wp.db.prepare('select json from proposals where id = ?').get(ctx['proposalId']) as { json: string } | undefined;
    if (p) { const pp = (JSON.parse(p.json) as { params: Record<string, unknown> }).params; charters.push(...[pp['charterId'], ...(Array.isArray(pp['charterIds']) ? pp['charterIds'] : [])].filter((c): c is string => typeof c === 'string')); if (is(pp['toEmployeeId'])) ids.add(pp['toEmployeeId'] as string); if (is(pp['employeeId'])) ids.add(pp['employeeId'] as string); }
  }
  for (const c of charters) for (const e of employees) if (e.charterIds.includes(c)) ids.add(e.id);
  const cos = employees.find(e => e.charterIds.includes('chief-of-staff')) ?? employees.find(e => e.level === 0);
  if (cos) ids.add(cos.id);
  return [...ids];
}

const DEFAULT_EFFECT: Record<InboxKind, { onApprove: string; onDeny: string }> = {
  approval: { onApprove: 'the action runs', onDeny: 'the action does not run; the raiser is told why' },
  decision: { onApprove: 'the first option is taken and recorded', onDeny: 'the other option is taken and recorded' },
  question: { onApprove: 'your answer goes to the employee', onDeny: 'nothing changes' },
  cap: { onApprove: 'the cap for today is raised', onDeny: 'the cap stays until tomorrow' },
  'org-change': { onApprove: 'the org files are written and committed; routing and context change on the next session', onDeny: 'nothing changes; the proposal is kept with your reason' },
  release: { onApprove: 'the release script may run when started', onDeny: 'nothing ships' },
};

const DEFAULT_OPTIONS: Record<InboxKind, InboxOption[]> = {
  approval: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject', danger: true }],
  decision: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }, { id: 'later', label: 'Later' }],
  question: [{ id: 'answered', label: 'Answer', needsNote: true }],
  cap: [{ id: 'raise-today', label: 'Raise today\'s cap', needsNote: true }, { id: 'keep', label: 'Keep the cap' }],
  'org-change': [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject', danger: true }],
  release: [{ id: 'approve', label: 'Approve release' }, { id: 'reject', label: 'Reject', danger: true }],
};

export function raise(wp: Workplace, spec: RaiseOptions): InboxItem {
  return raiseOrReuse(wp, spec).item;
}

/**
 * One thing reaches the owner once (RCA, 4 Oct: a "question" AND a "decision" about the same work).
 * An agent filed ask_owner, then blocked its item on the owner, and the block raised a second
 * "Blocked on you" question under another dedupe key. So, besides the dedupe key: while an open
 * owner-facing question or decision exists for a work item (`context.itemId`), another one for the
 * same item is not raised — the open one is returned (`reused`). The single exception is a real
 * decision arriving while only the Workplace's own "Blocked on you" question is open: the decision
 * is the richer ask (options, recommendation), so it replaces the question.
 */
export function raiseOrReuse(wp: Workplace, spec: RaiseOptions): { item: InboxItem; reused: boolean } {
  if (spec.dedupeKey) {
    const open = list(wp, 'open').find(i => i.context['dedupeKey'] === spec.dedupeKey);
    if (open) return { item: open, reused: true };
  }
  const itemId = typeof spec.context?.['itemId'] === 'string' ? spec.context['itemId'] : undefined;
  if (itemId && isAsk(spec.kind) && spec.ownerFacing !== false) {
    const existing = openAskFor(wp, itemId);
    if (existing) {
      const blockQuestion = typeof existing.context['dedupeKey'] === 'string' && existing.context['dedupeKey'].startsWith('blocked:');
      const blockRaise = typeof spec.dedupeKey === 'string' && spec.dedupeKey.startsWith('blocked:');
      if (!(blockQuestion && !blockRaise && spec.kind === 'decision')) return { item: existing, reused: true };
      expireRaw(wp, existing.id, 'Replaced by a decision about the same item.');
    }
  }
  return { item: insert(wp, spec), reused: false };
}

const isAsk = (kind: InboxKind): boolean => kind === 'question' || kind === 'decision';

/** The open owner-facing question or decision about a work item, if any (the newest). */
export function openAskFor(wp: Workplace, itemId: string): InboxItem | undefined {
  return list(wp, 'open').find(i => isAsk(i.kind) && isOwnerFacing(i) && i.context['itemId'] === itemId);
}

/** Open owner-facing questions/decisions named by id (in_…) in a text: "filed in his Inbox (in_x)". */
export function openAsksNamedIn(wp: Workplace, text: string): InboxItem[] {
  const ids = new Set(text.match(/\bin_[a-z0-9]{6,}\b/g) ?? []);
  if (ids.size === 0) return [];
  return list(wp, 'open').filter(i => ids.has(i.id) && isAsk(i.kind) && isOwnerFacing(i));
}

/** Tie an Inbox item to the work item it is about (when it was raised without one). */
export function linkToItem(wp: Workplace, id: string, itemId: string): InboxItem | undefined {
  const item = get(wp, id);
  if (!item || typeof item.context['itemId'] === 'string') return item;
  const next: InboxItem = { ...item, context: { ...item.context, itemId } };
  wp.db.prepare('update inbox set json = ? where id = ?').run(JSON.stringify(next), id);
  wp.emit({ type: 'inbox.updated', item: next });
  return next;
}

function insert(wp: Workplace, spec: RaiseOptions): InboxItem {
  const recommendation = spec.recommendation?.trim();
  const marked = markRecommended(spec.options ?? DEFAULT_OPTIONS[spec.kind], recommendation);
  const body = recommendation && !marked.matched && !spec.body.includes(recommendation) ? `${spec.body.trimEnd()}\n\nRecommendation: ${recommendation}` : spec.body;
  const context = { ...(spec.context ?? {}), ...(spec.dedupeKey ? { dedupeKey: spec.dedupeKey } : {}), ...(recommendation ? { recommendation } : {}) };
  const item: InboxItem = {
    id: newId('in'),
    kind: spec.kind,
    title: spec.title,
    body,
    ...ownerLine({ ...spec, body }),
    context,
    options: marked.options,
    state: 'open',
    raisedBy: spec.raisedBy,
    createdAt: now(),
    affects: affectsOf(wp, spec),
    onApprove: spec.onApprove ?? DEFAULT_EFFECT[spec.kind].onApprove,
    onDeny: spec.onDeny ?? DEFAULT_EFFECT[spec.kind].onDeny,
    ...(spec.links ? { links: spec.links } : {}),
    ...(spec.ownerFacing === false ? { ownerFacing: false } : {}),
    urgency: spec.urgency ?? urgencyOf(wp, spec.kind, context),
    messageCount: 0,
  };
  // Rework W4: the COO is copied on everything an agent sends the owner, and the push waits 15 min
  // for him to triage it (resolve it, or say why it needs the owner). If the copy cannot be written
  // the item is not held: the owner is never left waiting on a COO who was not told.
  if (isOwnerFacing(item) && heldForCoo(item) && !spec.skipCooHold) {
    try {
      appendBridgeLine(wp, { kind: 'owner-inbox', inboxId: item.id, title: item.title, raisedBy: item.raisedBy, summary: item.summary });
      item.cooHold = { until: new Date(Date.now() + COO_HOLD_MS).toISOString() };
    } catch (err) { log.warn('inbox', `COO copy of ${item.id}: ${err instanceof Error ? err.message : err}`); }
  }
  wp.db.prepare('insert into inbox (id, kind, state, raised_by, created_at, json) values (?, ?, ?, ?, ?, ?)')
    .run(item.id, item.kind, item.state, item.raisedBy, item.createdAt, JSON.stringify(item));
  wp.emit({ type: 'inbox.updated', item });
  // Routine housekeeping never pings or counts against the owner (it is not in his Inbox at all);
  // a held item pings when the hold ends (releaseHolds) or the COO says it needs the owner.
  if (isOwnerFacing(item) && !item.cooHold) wp.emit({ type: 'alert', level: 'needs-you', title: item.title, body: item.summary, inboxId: item.id });
  return item;
}

/* ---------- rework W4: the COO's copy and hold ---------- */

export const COO_HOLD_MS = 15 * 60_000;
/** The answer the COO records when he resolves an item none of whose options fits. */
export const COO_RESOLVED = 'resolved';

/**
 * Held for the COO: an owner item an agent (or the Workplace) raised. Not the owner's or the COO's
 * own, and not one that already came through the COO (`cooItemId`: forwarded by him, or his
 * offline fallback).
 */
export function heldForCoo(i: Pick<InboxItem, 'raisedBy' | 'context'>): boolean {
  return i.raisedBy !== 'owner' && i.raisedBy !== 'coo' && typeof i.context['cooItemId'] !== 'string';
}

function save(wp: Workplace, item: InboxItem): InboxItem {
  wp.db.prepare('update inbox set json = ? where id = ?').run(JSON.stringify(item), item.id);
  wp.emit({ type: 'inbox.updated', item });
  return item;
}

const withoutHold = ({ cooHold: _h, ...rest }: InboxItem): InboxItem => rest;

/**
 * End an open item's hold now and push it (the COO's "needs you", or the 15 minutes ran out). With
 * a note, it is kept on the item as `cooNote` and shown first. The alert goes out even when the hold
 * had already ended: the note is new information for the owner.
 */
export function releaseHold(wp: Workplace, id: string, note?: string): InboxItem {
  const item = get(wp, id);
  if (!item) throw new NotFound(`No inbox item ${id}`);
  if (item.state !== 'open') throw new Conflict(`${id} was already ${item.state}`);
  const next = save(wp, { ...withoutHold(item), ...(note?.trim() ? { cooNote: { text: note.trim(), at: now() } } : {}) });
  if (isOwnerFacing(next)) wp.emit({ type: 'alert', level: 'needs-you', title: next.title, body: next.summary, inboxId: next.id });
  return next;
}

/** The 60-second sweep: open items whose hold ran out are pushed, once. Returns their ids. */
export function releaseHolds(wp: Workplace, nowMs = Date.now()): string[] {
  // Oldest first, so the owner's phone shows them in the order they were raised.
  const due = list(wp, 'open').filter(i => i.cooHold && Date.parse(i.cooHold.until) <= nowMs).reverse();
  for (const i of due) releaseHold(wp, i.id);
  return due.map(i => i.id);
}

export function list(wp: Workplace, state?: InboxItem['state']): InboxItem[] {
  const rows = state
    ? wp.db.prepare('select json from inbox where state = ? order by created_at desc, rowid desc').all(state)
    : wp.db.prepare("select json from inbox order by case state when 'open' then 0 else 1 end, created_at desc, rowid desc").all();
  // Items raised before `affects` existed get it computed on read.
  const counts = messageCounts(wp);
  return rowsJson<InboxItem>(rows).map(i => backfill(wp, i, counts));
}

/** Replies per item, from the thread itself (the stored count can lag an item raised before v2). */
function messageCounts(wp: Workplace, id?: string): Map<string, { n: number; last: string }> {
  const rows = (id
    ? wp.db.prepare('select inbox_id as id, count(*) as n, max(at) as last from inbox_messages where inbox_id = ? group by inbox_id').all(id)
    : wp.db.prepare('select inbox_id as id, count(*) as n, max(at) as last from inbox_messages group by inbox_id').all()) as { id: string; n: number; last: string }[];
  return new Map(rows.map(r => [r.id, { n: r.n, last: r.last }]));
}

/**
 * The owner's Inbox (HLD, the owner's rule "nothing but decisions"): every item minus routine
 * housekeeping (`ownerFacing: false`). This is what `GET /api/inbox`, the "needs you" counts and
 * the digest show; a routine item still shows on the pages of the employees it affects.
 */
export function ownerList(wp: Workplace, state?: InboxItem['state']): InboxItem[] {
  return list(wp, state).filter(isOwnerFacing).map(i => ownerView(wp, i));
}

/**
 * One page of the owner's Inbox (iOS QA, 2 Oct: 88 KB for 45 items, nearly all answered): `state`
 * filters, `before` (an item id) starts after that item, `limit` (≤ 200) caps it. With none of them
 * it is exactly `ownerList`, so older clients see no change.
 */
export function ownerPage(wp: Workplace, q: { state?: string | null; limit?: string | null; before?: string | null }): InboxItem[] {
  const state = q.state || undefined;
  if (state && state !== 'open' && state !== 'answered' && state !== 'expired') throw new BadRequest('state must be open, answered or expired');
  let page = ownerList(wp, state as InboxItem['state'] | undefined);
  if (q.before) {
    const at = page.findIndex(i => i.id === q.before);
    if (at < 0) throw new BadRequest(`No inbox item ${q.before} in this list`);
    page = page.slice(at + 1);
  }
  if (q.limit) {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1) throw new BadRequest('limit must be a positive whole number');
    page = page.slice(0, Math.min(n, 200));
  }
  return page;
}

/** What the owner reads: known ids in the title, summary and details read as their titles (the stored item keeps them). */
export function ownerView(wp: Workplace, i: InboxItem): InboxItem {
  return {
    ...i, title: humanizeIds(wp, i.title), summary: humanizeIds(wp, i.summary),
    ...(i.details ? { details: humanizeIds(wp, i.details) } : {}),
  };
}

/**
 * Items raised before `affects` (D7b) or `summary` (D16) existed get them computed on read; every
 * item carries v2's `messageCount` (0 when no reply), `lastMessageAt` when there is one, and `urgency`
 * (QA 2 Oct: the apps never got them).
 */
function backfill(wp: Workplace, i: InboxItem, counts = messageCounts(wp, i.id)): InboxItem {
  const withAffects = i.affects ? i : { ...i, affects: affectsOf(wp, i), onApprove: i.onApprove ?? DEFAULT_EFFECT[i.kind].onApprove, onDeny: i.onDeny ?? DEFAULT_EFFECT[i.kind].onDeny };
  const lined = withAffects.summary ? withAffects : { ...withAffects, ...ownerLine(withAffects) };
  const c = counts.get(i.id);
  const { lastMessageAt: _stale, ...rest } = lined;
  return {
    ...rest,
    messageCount: c?.n ?? 0,
    ...(c ? { lastMessageAt: c.last } : {}),
    urgency: lined.urgency ?? urgencyOf(wp, lined.kind, lined.context),
  };
}

/** The one line for the owner: given, or the body's first plain sentence; the rest is details. */
function ownerLine(spec: { body: string; summary?: string; details?: string }): { summary: string; details?: string } {
  if (spec.summary?.trim()) { const s = oneLine(spec.summary).summary; const details = spec.details ?? (spec.body.trim() && spec.body.trim() !== s ? spec.body.trim() : undefined); return details ? { summary: s, details } : { summary: s }; }
  const line = oneLine(spec.body);
  return line.details ? { summary: line.summary, details: spec.details ?? line.details } : { summary: line.summary, ...(spec.details ? { details: spec.details } : {}) };
}

/** Open items that concern an employee, for its page (HLD D7b). */
export function forEmployee(wp: Workplace, employeeId: string): InboxItem[] {
  return list(wp, 'open').filter(i => i.affects.includes(employeeId));
}



/**
 * Inbox items about one work item (LLD §19.13): raised with it as `context.itemId` or
 * `context.assignmentId`, or naming its id in the title or body. Open first, newest first.
 */
export function linkedTo(wp: Workplace, itemId: string): InboxItem[] {
  return list(wp).filter(i => i.context['itemId'] === itemId || i.context['assignmentId'] === itemId || i.title.includes(itemId) || i.body.includes(itemId));
}

export function get(wp: Workplace, id: string): InboxItem | undefined {
  const item = rowJson<InboxItem>(wp.db.prepare('select json from inbox where id = ?').get(id));
  return item ? backfill(wp, item) : undefined;
}

export function answer(wp: Workplace, id: string, optionId: string, note: string | undefined, via: InboxAnswer['via'], opts: { by?: 'coo' } = {}): InboxItem {
  const item = get(wp, id);
  if (!item) throw new BadRequest(`No inbox item ${id}`);
  if (item.state !== 'open') throw new Conflict(`${id} was already answered`);
  const option = item.options.find(o => o.id === optionId);
  // The COO may resolve an item none of whose options fits (rework W4): recorded as `resolved`.
  if (!option && !(opts.by === 'coo' && optionId === COO_RESOLVED)) throw new BadRequest(`"${optionId}" is not one of the options: ${item.options.map(o => o.id).join(', ')}`);
  if (option?.needsNote && !note?.trim()) throw new BadRequest(`"${option.label}" needs a note`);

  // An answered item is never held (rework W4): the hold sweep and the push both skip it.
  const answered: InboxItem = {
    ...withoutHold(item),
    state: 'answered',
    answer: { optionId, ...(note ? { note } : {}), at: now(), via, ...(opts.by ? { by: opts.by } : {}) },
  };
  wp.db.prepare('update inbox set state = ?, json = ? where id = ?').run('answered', JSON.stringify(answered), id);
  wp.emit({ type: 'inbox.updated', item: answered });
  for (const fn of answerListeners) fn(wp, answered);
  return answered;
}

/** Move an open item on or off the owner's Inbox without answering it (a legacy item under a new rule). */
export function setOwnerFacing(wp: Workplace, id: string, ownerFacing: boolean): InboxItem {
  const item = get(wp, id);
  if (!item) throw new BadRequest(`No inbox item ${id}`);
  const next: InboxItem = { ...item, ownerFacing };
  wp.db.prepare('update inbox set json = ? where id = ?').run(JSON.stringify(next), id);
  wp.emit({ type: 'inbox.updated', item: next });
  return next;
}

/** The Workplace withdraws an item it raised itself (a superseded stall note). Never the owner's decisions. */
export function expire(wp: Workplace, id: string, why: string): InboxItem {
  return expireRaw(wp, id, why);
}

function expireRaw(wp: Workplace, id: string, why: string): InboxItem {
  const item = get(wp, id);
  if (!item) throw new BadRequest(`No inbox item ${id}`);
  if (item.state !== 'open') return item;
  const expired: InboxItem = { ...item, state: 'expired', answer: { optionId: 'expired', note: why, at: now(), via: 'workplace' } };
  wp.db.prepare('update inbox set state = ?, json = ? where id = ?').run('expired', JSON.stringify(expired), id);
  wp.emit({ type: 'inbox.updated', item: expired });
  return expired;
}

/** Services that need to act on an answer (gates, proposals, caps) subscribe here. */
type AnswerListener = (wp: Workplace, item: InboxItem) => void;
const answerListeners = new Set<AnswerListener>();
export function onAnswer(fn: AnswerListener): () => void {
  answerListeners.add(fn);
  return () => void answerListeners.delete(fn);
}

export const openCount = (wp: Workplace): number => ownerList(wp, 'open').length;


/* ---------- v2: every item is a thread (HLD D23, LLD §19.5) ---------- */

export function messages(wp: Workplace, inboxId: string): InboxMessage[] {
  return rowsJson<InboxMessage>(wp.db.prepare('select json from inbox_messages where inbox_id = ? order by at, rowid').all(inboxId));
}

export function thread(wp: Workplace, id: string): InboxThread {
  const item = get(wp, id);
  if (!item) throw new NotFound(`No inbox item ${id}`);
  return { item: ownerView(wp, item), messages: messages(wp, id) };
}

/**
 * A reply in an item's thread. With `optionId` it also answers the item (the text is the note);
 * text alone leaves it open — the owner can ask back or suggest something else, and the asker
 * answers in the same thread. An employee's reply is capped (COMMENT_CAP) and stored whole; the owner's never is.
 */
export function reply(wp: Workplace, id: string, spec: { by: string; text?: string; optionId?: string; via?: InboxAnswer['via'] }): InboxThread {
  const item = get(wp, id);
  if (!item) throw new NotFound(`No inbox item ${id}`);
  const text = spec.text?.trim() ?? '';
  if (!text && !spec.optionId) throw new BadRequest('Nothing to send: write a reply or pick an option.');
  if (spec.optionId && item.state !== 'open') throw new Conflict(`${id} was already answered`);
  let message: InboxMessage | undefined;
  if (text) {
    // Owner, 10 Oct: an agent's reply is capped like a comment and refused above it, never cut.
    const over = isAgent(wp, spec.by) ? overCap(text) : null;
    if (over) throw new BadRequest(over);
    message = { id: newId('im'), inboxId: id, at: now(), by: spec.by, text };
    wp.db.prepare('insert into inbox_messages (id, inbox_id, at, by, json) values (?, ?, ?, ?, ?)').run(message.id, id, message.at, message.by, JSON.stringify(message));
    const latest = get(wp, id)!;
    const counted: InboxItem = { ...latest, messageCount: (latest.messageCount ?? 0) + 1, lastMessageAt: message.at };
    wp.db.prepare('update inbox set json = ? where id = ?').run(JSON.stringify(counted), id);
    wp.emit({ type: 'inbox.message', message });
    wp.emit({ type: 'inbox.updated', item: counted });
  }
  if (spec.optionId) answer(wp, id, spec.optionId, text || undefined, spec.via ?? 'web');
  // Delivered only when the item is still a live conversation (an answer reaches the raiser through onAnswer).
  if (message && !spec.optionId) for (const fn of replyListeners) { try { fn(wp, get(wp, id)!, message); } catch { /* a listener never breaks the reply */ } }
  return thread(wp, id);
}

type ReplyListener = (wp: Workplace, item: InboxItem, message: InboxMessage) => void;
const replyListeners = new Set<ReplyListener>();
export function onReply(fn: ReplyListener): () => void {
  replyListeners.add(fn);
  return () => void replyListeners.delete(fn);
}

/**
 * One-off cleanup of duplicates raised before the fix (scripts/inbox-dedupe.ts): an open "Blocked on
 * you" question (`blocked:` key) that names another open owner-facing ask, or whose item already has
 * one, is the same thing asked twice. Pure, over stored items; the ask that is not the block survives.
 */
export function duplicateAsks(all: InboxItem[]): { keep: string; drop: string; itemId?: string }[] {
  const open = all.filter(i => i.state === 'open' && isAsk(i.kind) && isOwnerFacing(i));
  const out: { keep: string; drop: string; itemId?: string }[] = [];
  for (const q of open) {
    const key = q.context['dedupeKey'];
    if (typeof key !== 'string' || !key.startsWith('blocked:')) continue;
    const itemId = typeof q.context['itemId'] === 'string' ? q.context['itemId'] : key.slice('blocked:'.length);
    const named = new Set(`${q.body}\n${q.details ?? ''}`.match(/\bin_[a-z0-9]{6,}\b/g) ?? []);
    const other = open.find(o => o.id !== q.id && !(typeof o.context['dedupeKey'] === 'string' && (o.context['dedupeKey'] as string).startsWith('blocked:')) && (named.has(o.id) || o.context['itemId'] === itemId));
    if (other) out.push({ keep: other.id, drop: q.id, itemId });
  }
  return out;
}
