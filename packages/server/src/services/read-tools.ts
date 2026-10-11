import type { InboxItem, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as items from './items.js';
import * as inbox from './inbox.js';
import * as trail from './trail.js';
import * as statusAnswers from './status.js';
import { humanizeIds } from './id-names.js';
import { nameOf, STATUS_LABEL } from './v2-map.js';

/**
 * Read-only tools for reviewers (LLD §19.13, QA 3 Oct): `item_read` gives an item's detail with its
 * comments and activity, `inbox_read` the Inbox items and their threads. Nikhil bounced valid
 * no-code / decision stories because he could not see that evidence. Both answer in plain text
 * bounded to `MAX_CHARS`; neither writes anything.
 */

export const MAX_CHARS = 8000;
const BODY_MAX = 1500;
/** An agent comment is at most 1200 characters (one-line.ts COMMENT_CAP), so a stored one is read whole. */
const COMMENT_MAX = 1200;
/** A comment's details (older comments were cut to 400 characters with the rest here); never cut mid-argument. */
const DETAILS_MAX = 4000;
/** A comment that is a plan or an RCA is never dropped from a read: it is pinned after the head. */
export const PINNED = /^\s*##\s*(Plan|RCA)\b/im;
const ACTIVITY_MAX = 200;
const ACTIVITY_LAST = 30;
const CHILDREN_MAX = 15;
const INBOX_LIST_MAX = 25;
const RECENT_MS = 7 * 24 * 3600_000;

/** One line (newlines folded) or a block, clipped to `max` chars with an ellipsis. */
export function clip(text: string | undefined, max: number): string {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…` : t;
}

/** Ids in free text read as `"Title" (id)`: the owner-facing rewriting, keeping the id the reader acts on. */
const named = (wp: Workplace, text: string | undefined, max: number): string => clip(humanizeIds(wp, text ?? '', { keepIds: true }), max);

/** A person for an agent: "Mira (mira)", "the owner", "nobody". */
function who(wp: Workplace, id: string | undefined): string {
  if (!id) return 'nobody';
  if (id === 'owner') return 'the owner';
  const name = nameOf(wp, id);
  return name === id ? id : `${name} (${id})`;
}

/**
 * The head is always kept; past `MAX_CHARS` the oldest entries of each list (in the given order) are
 * dropped first, keeping at least the newest of each, each list noting how many it omitted; then a hard cut.
 */
function fit(head: string[], lists: { title: string; noun: string; lines: string[]; omitted?: number }[]): string {
  const render = () => [
    ...head,
    ...lists.flatMap(l => [
      '',
      `${l.title}:`,
      ...(l.omitted ? [`  (${l.omitted} older ${l.noun}${l.omitted === 1 ? '' : 's'} omitted)`] : []),
      ...(l.lines.length ? l.lines : ['  none']),
    ]),
  ].join('\n');
  let out = render();
  for (const l of lists) {
    while (out.length > MAX_CHARS && l.lines.length > 1) {
      // Drop several at a time when far over, so a 60-comment item does not re-render 60 times.
      const over = out.length - MAX_CHARS;
      const avg = Math.max(1, Math.round(l.lines.join('\n').length / l.lines.length));
      const n = Math.min(l.lines.length - 1, Math.max(1, Math.floor(over / avg)));
      l.lines = l.lines.slice(n);
      l.omitted = (l.omitted ?? 0) + n;
      out = render();
    }
  }
  const cut = '\n…[truncated]';
  return out.length > MAX_CHARS ? out.slice(0, MAX_CHARS - cut.length) + cut : out;
}

const answerLine = (i: InboxItem): string => {
  if (!i.answer) return '';
  const label = i.options.find(o => o.id === i.answer!.optionId)?.label ?? i.answer.optionId;
  return ` → ${label}`;
};

const inboxLine = (wp: Workplace, i: InboxItem): string =>
  `  ${i.id} · ${i.state} · ${i.kind} · ${named(wp, i.title, 160)}${answerLine(i)}${i.ownerFacing === false ? ' (routine, not in the owner\'s Inbox)' : ''}`;

/* ---------- item_read ---------- */

export function readItem(wp: Workplace, q: string): string {
  const { ids, found, merged } = statusAnswers.resolveIds(wp, q);
  const w: WorkItem | undefined = found[0];
  if (!w) {
    if (ids.length) return `No item ${ids.join(', ')} in the plan.`;
    const a = statusAnswers.answer(wp, q);
    const candidates = a.matches.slice(0, 8).map(m => `  ${m.line} [${m.item.id}]`);
    return candidates.length
      ? `No item id in "${clip(q, 80)}". Items that match it (call item_read with one id):\n${candidates.join('\n')}`
      : `No item id in "${clip(q, 80)}", and nothing in the plan matches it.`;
  }
  const d = items.detail(wp, w.id);
  const it = d.item;
  const head: string[] = [];
  head.push(`# ${it.title} [${it.id}]`);
  for (const [asked, into] of merged) if (into === it.id) head.push(`(${asked} was merged into ${it.id}; showing ${it.id}.)`);
  if (found.length > 1) head.push(`(Also named: ${found.slice(1).map(f => f.id).join(', ')}; read them with item_read.)`);
  let status = STATUS_LABEL[it.status];
  // Approved is not merged (11 Oct: agents read "Done" as finished and reported fixes as stranded).
  if ((it as { trueStatus?: string }).trueStatus === 'approved') status = 'Approved, NOT merged yet (its merge checks are still pending; it is not finished)';
  if (it.resolution && it.resolution !== 'done') status += ` (${it.resolution})`;
  if (it.blocked) status += ` · waiting on ${who(wp, it.blocked.waitingOn)}: ${clip(it.blocked.reason, 200)}`;
  if (it.handoff) status += ` · handed by ${who(wp, it.handoff.fromId)}`;
  head.push(`${it.level[0]!.toUpperCase()}${it.level.slice(1)} · ${status} (since ${it.statusSince})${it.points ? ` · ${it.points} pts` : ''}`);
  head.push(`Assignee: ${who(wp, it.assigneeId)} · Reviewer: ${who(wp, it.reviewerId)}${it.level === 'epic' && it.ownerId ? ` · Owner: ${who(wp, it.ownerId)}` : ''}`);
  if (d.parent) head.push(`Parent: ${d.parent.title} [${d.parent.id}]`);
  if (d.progress) head.push(`Progress: ${d.progress.pct}% (${d.progress.storiesDone}/${d.progress.storiesTotal} stories)`);
  head.push('', 'Acceptance criteria:', ...(it.acceptance.length ? it.acceptance.map(a => `  - ${named(wp, a, 300)}`) : ['  none']));
  head.push('', 'Body:', it.body.trim() ? named(wp, it.body, BODY_MAX) : '  (empty)');
  const kids = d.children.slice(0, CHILDREN_MAX).map(c => `  ${statusAnswers.lineFor(wp, c)} [${c.id}]`);
  if (d.children.length > CHILDREN_MAX) kids.push(`  +${d.children.length - CHILDREN_MAX} more`);
  head.push('', `Children (${d.children.length}):`, ...(kids.length ? kids : ['  none']));
  const linked = inbox.linkedTo(wp, it.id);
  head.push('', 'Linked Inbox items (read with inbox_read):', ...(linked.length ? linked.slice(0, 10).map(i => inboxLine(wp, i)) : ['  none']));
  if (linked.length > 10) head.push(`  +${linked.length - 10} more`);
  // The developer's recorded live checks (dry run #5): QA opens the logs and cites one as "Evidence: live check <id>".
  const checks = (w.liveChecks ?? []).slice(-5);
  if (checks.length) {
    const headSha = w.pr?.headSha;
    head.push('', 'Live checks (open the logs; cite one in the QA doc as "Evidence: live check <id>"):', ...checks.map(l =>
      `  - ${l.id} by ${who(wp, l.by)} at ${l.at} on ${l.sha.slice(0, 8)}${headSha && l.sha !== headSha ? ' (an older commit)' : ''}: ${clip(l.summary, 300)}\n      logs: ${l.logPaths.join(', ')}`));
  }

  const commentLine = (c: (typeof d.comments)[number], max: number): string => {
    const details = c.details ? `\n      details: ${named(wp, c.details, DETAILS_MAX)}` : '';
    return `  - ${who(wp, c.by)} at ${c.at}: ${named(wp, c.text, max)}${details}`;
  };
  // Plans and RCAs are what a reviewer judges the work against (owner, 10 Oct: they were dropped from
  // context on long stories): pinned after the head and never dropped, oldest first.
  const pinned = d.comments.filter(c => PINNED.test(c.text));
  if (pinned.length) head.push('', `Plan and RCA (pinned, ${pinned.length}):`, ...pinned.map(c => commentLine(c, DETAILS_MAX)));
  const comments = d.comments.filter(c => !PINNED.test(c.text)).map(c => commentLine(c, COMMENT_MAX));
  const activity = d.activity.slice(-ACTIVITY_LAST).map(a => {
    const move = a.from !== undefined || a.to !== undefined ? ` ${a.from ?? '∅'}→${a.to ?? '∅'}` : '';
    return `  - ${a.at} ${who(wp, a.by)} ${a.kind}${move}: ${named(wp, a.text, ACTIVITY_MAX)}`;
  });
  const olderActivity = Math.max(0, d.activity.length - ACTIVITY_LAST);
  return fit(head, [
    { title: `Comments (${d.comments.length}${pinned.length ? `, ${pinned.length} pinned above` : ''})`, noun: 'comment', lines: comments },
    { title: `Activity (last ${Math.min(ACTIVITY_LAST, d.activity.length)} of ${d.activity.length})`, noun: 'activity entry', lines: activity, ...(olderActivity ? { omitted: olderActivity } : {}) },
  ]);
}

/* ---------- inbox_read ---------- */

const INBOX_ID = /\bin_[a-z0-9]{4,}\b/i;

export function readInbox(wp: Workplace, q: { itemId?: string; state?: string }, nowMs = Date.now()): string {
  const raw = q.itemId?.trim();
  if (raw) {
    const inboxId = INBOX_ID.exec(raw)?.[0];
    if (inboxId) return readOne(wp, inboxId);
    const { ids, found } = statusAnswers.resolveIds(wp, raw);
    const w = found[0];
    if (!w) return ids.length ? `No Inbox item or work item ${ids.join(', ')}.` : `No Inbox id (in_…) or item id in "${clip(raw, 80)}".`;
    const linked = inbox.linkedTo(wp, w.id);
    return [`Inbox items about ${w.title} [${w.id}] (read one with inbox_read and its id):`, ...(linked.length ? linked.slice(0, INBOX_LIST_MAX).map(i => inboxLine(wp, i)) : ['  none'])].join('\n');
  }
  const state = q.state ?? 'recent';
  if (!['open', 'answered', 'expired', 'all', 'recent'].includes(state)) return 'state must be open, answered, expired or all.';
  const all = inbox.list(wp);
  const picked = state === 'all' ? all
    : state === 'recent' ? all.filter(i => i.state === 'open' || (i.state === 'answered' && i.answer && nowMs - Date.parse(i.answer.at) <= RECENT_MS))
      : all.filter(i => i.state === state);
  const sorted = [...picked].sort((a, b) => Number(b.state === 'open') - Number(a.state === 'open') || Date.parse(b.answer?.at ?? b.createdAt) - Date.parse(a.answer?.at ?? a.createdAt));
  const title = state === 'recent' ? 'Inbox: open, and answered in the last 7 days' : `Inbox: ${state}`;
  const lines = sorted.slice(0, INBOX_LIST_MAX).map(i => inboxLine(wp, i));
  if (sorted.length > INBOX_LIST_MAX) lines.push(`  +${sorted.length - INBOX_LIST_MAX} more`);
  return clip([`${title} (${sorted.length}; read one with inbox_read and its id):`, ...(lines.length ? lines : ['  none'])].join('\n'), MAX_CHARS);
}

function readOne(wp: Workplace, id: string): string {
  const stored = inbox.get(wp, id);
  if (!stored) return `No Inbox item ${id}.`;
  const i = inbox.ownerView(wp, stored);
  const head: string[] = [];
  head.push(`# ${named(wp, stored.title, 200)} [${i.id}]`);
  head.push(`${i.kind} · ${i.state} · urgency ${i.urgency ?? 'normal'} · raised by ${who(wp, i.raisedBy)} at ${i.createdAt}${i.ownerFacing === false ? ' · routine (not in the owner\'s Inbox)' : ' · the owner\'s Inbox'}`);
  const workId = typeof i.context['itemId'] === 'string' ? i.context['itemId'] : typeof i.context['assignmentId'] === 'string' ? i.context['assignmentId'] : undefined;
  const work = workId ? items.get(wp, workId) : undefined;
  if (workId) head.push(`About: ${work ? `${work.title} [${work.id}]` : workId}`);
  head.push(`Summary: ${named(wp, stored.summary, 300)}`);
  head.push('', 'Body:', named(wp, stored.body, BODY_MAX));
  if (i.options.length) head.push('', 'Options:', ...i.options.map(o => `  - ${o.label} (${o.id})${o.recommended ? ' — recommended' : ''}`));
  const rec = i.options.find(o => o.recommended)?.label ?? (typeof i.context['recommendation'] === 'string' ? i.context['recommendation'] : undefined);
  head.push(`Recommendation: ${rec ? clip(rec, 300) : 'none given'}`);
  if (i.answer) {
    const label = i.options.find(o => o.id === i.answer!.optionId)?.label ?? i.answer.optionId;
    head.push(`Answer: ${label}${i.answer.note ? ` — "${clip(i.answer.note, 400)}"` : ''} (at ${i.answer.at}, via ${i.answer.via})`);
  } else head.push(`Answer: none yet (${i.state})`);
  const msgs = inbox.messages(wp, id).map(m => `  - ${m.by === 'owner' ? 'owner' : who(wp, m.by)} at ${m.at}: ${named(wp, m.text, COMMENT_MAX)}${m.details ? `\n      details: ${named(wp, m.details, DETAILS_MAX)}` : ''}`);
  return fit(head, [{ title: `Thread (${msgs.length} messages)`, noun: 'message', lines: msgs }]);
}
