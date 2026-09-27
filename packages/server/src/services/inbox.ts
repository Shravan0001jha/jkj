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
}

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
  return rowsJson<InboxItem>(rows);
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
