import type { InboxAnswer, InboxItem, InboxKind, InboxMessage, InboxOption, InboxThread } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import { oneLine, short } from './one-line.js';
import { newId, now, rowJson, rowsJson } from './store.js';
import { BadRequest, Conflict, NotFound } from '../util/errors.js';

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
  /** v2: shown by colour and label. */
  urgency?: InboxItem['urgency'];
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
  if (spec.dedupeKey) {
    const open = list(wp, 'open').find(i => i.context['dedupeKey'] === spec.dedupeKey);
    if (open) return open;
  }
  const item: InboxItem = {
    id: newId('in'),
    kind: spec.kind,
    title: spec.title,
    body: spec.body,
    ...ownerLine(spec),
    context: { ...(spec.context ?? {}), ...(spec.dedupeKey ? { dedupeKey: spec.dedupeKey } : {}) },
    options: spec.options ?? DEFAULT_OPTIONS[spec.kind],
    state: 'open',
    raisedBy: spec.raisedBy,
    createdAt: now(),
    affects: affectsOf(wp, spec),
    onApprove: spec.onApprove ?? DEFAULT_EFFECT[spec.kind].onApprove,
    onDeny: spec.onDeny ?? DEFAULT_EFFECT[spec.kind].onDeny,
    ...(spec.links ? { links: spec.links } : {}),
    ...(spec.ownerFacing === false ? { ownerFacing: false } : {}),
    ...(spec.urgency && spec.urgency !== 'normal' ? { urgency: spec.urgency } : {}),
  };
  wp.db.prepare('insert into inbox (id, kind, state, raised_by, created_at, json) values (?, ?, ?, ?, ?, ?)')
    .run(item.id, item.kind, item.state, item.raisedBy, item.createdAt, JSON.stringify(item));
  wp.emit({ type: 'inbox.updated', item });
  // Routine housekeeping never pings or counts against the owner (it is not in his Inbox at all).
  if (isOwnerFacing(item)) wp.emit({ type: 'alert', level: 'needs-you', title: item.title, body: item.summary, inboxId: item.id });
  return item;
}

export function list(wp: Workplace, state?: InboxItem['state']): InboxItem[] {
  const rows = state
    ? wp.db.prepare('select json from inbox where state = ? order by created_at desc, rowid desc').all(state)
    : wp.db.prepare("select json from inbox order by case state when 'open' then 0 else 1 end, created_at desc, rowid desc").all();
  // Items raised before `affects` existed get it computed on read.
  return rowsJson<InboxItem>(rows).map(i => backfill(wp, i));
}

/**
 * The owner's Inbox (HLD, the owner's rule "nothing but decisions"): every item minus routine
 * housekeeping (`ownerFacing: false`). This is what `GET /api/inbox`, the "needs you" counts and
 * the digest show; a routine item still shows on the pages of the employees it affects.
 */
export function ownerList(wp: Workplace, state?: InboxItem['state']): InboxItem[] {
  return list(wp, state).filter(isOwnerFacing);
}

/** Items raised before `affects` (D7b) or `summary` (D16) existed get them computed on read. */
function backfill(wp: Workplace, i: InboxItem): InboxItem {
  const withAffects = i.affects ? i : { ...i, affects: affectsOf(wp, i), onApprove: i.onApprove ?? DEFAULT_EFFECT[i.kind].onApprove, onDeny: i.onDeny ?? DEFAULT_EFFECT[i.kind].onDeny };
  return withAffects.summary ? withAffects : { ...withAffects, ...ownerLine(withAffects) };
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



export function get(wp: Workplace, id: string): InboxItem | undefined {
  const item = rowJson<InboxItem>(wp.db.prepare('select json from inbox where id = ?').get(id));
  return item ? backfill(wp, item) : undefined;
}

export function answer(wp: Workplace, id: string, optionId: string, note: string | undefined, via: InboxAnswer['via']): InboxItem {
  const item = get(wp, id);
  if (!item) throw new BadRequest(`No inbox item ${id}`);
  if (item.state !== 'open') throw new Conflict(`${id} was already answered`);
  const option = item.options.find(o => o.id === optionId);
  if (!option) throw new BadRequest(`"${optionId}" is not one of the options: ${item.options.map(o => o.id).join(', ')}`);
  if (option.needsNote && !note?.trim()) throw new BadRequest(`"${option.label}" needs a note`);

  const answered: InboxItem = {
    ...item,
    state: 'answered',
    answer: { optionId, ...(note ? { note } : {}), at: now(), via },
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
  return { item, messages: messages(wp, id) };
}

/**
 * A reply in an item's thread. With `optionId` it also answers the item (the text is the note);
 * text alone leaves it open — the owner can ask back or suggest something else, and the asker
 * answers in the same thread. An employee's reply is kept short; the owner's never is.
 */
export function reply(wp: Workplace, id: string, spec: { by: string; text?: string; optionId?: string; via?: InboxAnswer['via'] }): InboxThread {
  const item = get(wp, id);
  if (!item) throw new NotFound(`No inbox item ${id}`);
  const text = spec.text?.trim() ?? '';
  if (!text && !spec.optionId) throw new BadRequest('Nothing to send: write a reply or pick an option.');
  if (spec.optionId && item.state !== 'open') throw new Conflict(`${id} was already answered`);
  let message: InboxMessage | undefined;
  if (text) {
    const body = spec.by === 'owner' ? { text } : short(text);
    message = { id: newId('im'), inboxId: id, at: now(), by: spec.by, text: body.text, ...(body.details ? { details: body.details } : {}) };
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
