import type { InboxAnswer, InboxItem, InboxKind, InboxOption } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import { newId, now, rowJson, rowsJson } from './store.js';
import { BadRequest, Conflict } from '../util/errors.js';

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
}

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
    context: { ...(spec.context ?? {}), ...(spec.dedupeKey ? { dedupeKey: spec.dedupeKey } : {}) },
    options: spec.options ?? DEFAULT_OPTIONS[spec.kind],
    state: 'open',
    raisedBy: spec.raisedBy,
    createdAt: now(),
    affects: affectsOf(wp, spec),
    onApprove: spec.onApprove ?? DEFAULT_EFFECT[spec.kind].onApprove,
    onDeny: spec.onDeny ?? DEFAULT_EFFECT[spec.kind].onDeny,
    ...(spec.links ? { links: spec.links } : {}),
  };
  wp.db.prepare('insert into inbox (id, kind, state, raised_by, created_at, json) values (?, ?, ?, ?, ?, ?)')
    .run(item.id, item.kind, item.state, item.raisedBy, item.createdAt, JSON.stringify(item));
  wp.emit({ type: 'inbox.updated', item });
  wp.emit({ type: 'alert', level: 'needs-you', title: item.title, body: firstLine(item.body), inboxId: item.id });
  return item;
}

export function list(wp: Workplace, state?: InboxItem['state']): InboxItem[] {
  const rows = state
    ? wp.db.prepare('select json from inbox where state = ? order by created_at desc, rowid desc').all(state)
    : wp.db.prepare("select json from inbox order by case state when 'open' then 0 else 1 end, created_at desc, rowid desc").all();
  // Items raised before `affects` existed get it computed on read.
  return rowsJson<InboxItem>(rows).map(i => i.affects ? i : { ...i, affects: affectsOf(wp, i), onApprove: i.onApprove ?? DEFAULT_EFFECT[i.kind].onApprove, onDeny: i.onDeny ?? DEFAULT_EFFECT[i.kind].onDeny });
}

/** Open items that concern an employee, for its page (HLD D7b). */
export function forEmployee(wp: Workplace, employeeId: string): InboxItem[] {
  return list(wp, 'open').filter(i => i.affects.includes(employeeId));
}



export function get(wp: Workplace, id: string): InboxItem | undefined {
  return rowJson<InboxItem>(wp.db.prepare('select json from inbox where id = ?').get(id));
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

/** Services that need to act on an answer (gates, proposals, caps) subscribe here. */
type AnswerListener = (wp: Workplace, item: InboxItem) => void;
const answerListeners = new Set<AnswerListener>();
export function onAnswer(fn: AnswerListener): () => void {
  answerListeners.add(fn);
  return () => void answerListeners.delete(fn);
}

export const openCount = (wp: Workplace): number =>
  Number((wp.db.prepare("select count(*) as n from inbox where state = 'open'").get() as { n: number }).n);

const firstLine = (s: string): string => s.split('\n').find(l => l.trim())?.slice(0, 200) ?? '';
