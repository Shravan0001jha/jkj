import type { InboxItem, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as stall from './stall.js';
import * as spend from './spend.js';
import * as inbox from './inbox.js';
import * as employees from './employees.js';
import * as proposals from './proposals.js';
import * as room from './room.js';
import { chiefOfStaff } from './features.js';
import { log } from '../util/logger.js';

/**
 * The Chief of Staff's routine (lead, 27 Sep): no silent stalls. For each stalled assignment,
 * resume it within budget (once a day per item, one per tick), or raise one short Inbox note
 * saying why it waits. Deterministic and cheap: it spends nothing itself; a resumed session does.
 */

export const MIN_HEADROOM_INR = 50;

export interface TickResult {
  resumed: string[];
  noted: { id: string; reason: string }[];
  /** Threads handed to the Chief of Staff this tick. */
  moderated: string[];
  /** Resumable items that wait for a later tick (one resume per tick); no note is raised for them. */
  queued: string[];
}

export function tick(wp: Workplace, nowMs = Date.now(), opts: { stalls?: boolean } = {}): TickResult {
  const result: TickResult = { resumed: [], noted: [], moderated: [], queued: [] };
  const day = spend.dayOf(new Date(nowMs));
  const cos = chiefOfStaff(wp) ?? 'workplace';
  let resumedThisTick = false;

  // The Team Room: threads with new messages go to the Chief of Staff's session (free under D9b).
  const pendingThreads = room.needsModeration(wp, cos);
  if (pendingThreads.length && cos !== 'workplace') {
    try {
      const list = pendingThreads.map(t => `- ${t.id}: ${t.title} (${t.messageCount} messages)`).join('\n');
      employees.talk(wp, cos, `Team Room moderation. These threads have new messages:\n${list}\n\nFor each: read it (room_read), then reply, assign a follow-up or resolve it (room_resolve) within your authority; escalate to the owner (escalate) only for what the approvals table reserves for him. Keep it short.`, [], { autonomous: true });
      room.markSeen(wp, cos, new Date(nowMs).toISOString());
      result.moderated = pendingThreads.map(t => t.id);
    } catch (err) {
      log.warn('cos', `moderation: ${err instanceof Error ? err.message : err}`);
    }
  }

  // v2 (HLD D21): stalls are the event-driven watcher's (watch.ts); index.ts runs this with stalls off.
  for (const item of opts.stalls === false ? [] : stall.stalledAssignments(wp, nowMs)) {
    const reason = whyWaiting(wp, item, day);
    if (!reason && !resumedThisTick && !resumedToday(wp, item.id, day)) {
      try {
        employees.assign(wp, item.id);
        for (const i of inbox.list(wp, 'open').filter(i => isStallDetectorItem(i) && i.raisedBy === item.employeeId)) {
          inbox.answer(wp, i.id, 'answered', 'The Chief of Staff\'s routine resumed the work in a fresh session; the interrupted one was closed.', 'workplace');
        }
        wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`resumed:${item.id}:${day}`, new Date(nowMs).toISOString());
        result.resumed.push(item.id);
        resumedThisTick = true;
        log.info('cos', `resumed stalled ${item.id} (${item.title})`);
        continue;
      } catch (err) {
        note(wp, item, `could not resume: ${err instanceof Error ? err.message : String(err)}`, cos, day, result);
        continue;
      }
    }
    if (!reason && !resumedToday(wp, item.id, day)) {
      // Resumable, but this round's resume went to another item: the next tick takes it. No note,
      // or a restart with ten stalled items would ping the owner ten times for what the routine
      // itself clears.
      result.queued.push(item.id);
      continue;
    }
    note(wp, item, reason ?? `resumed once today already and stalled again; no session activity since ${item.stalledSince!.slice(11, 16)} UTC`, cos, day, result);
  }
  return result;
}

/** Why an item should not simply be resumed. Null means "resume it". */
export function whyWaiting(wp: Workplace, item: WorkItem, day: string): string | null {
  if (!item.employeeId) return 'no assignee';
  const budget = spend.canSpend(wp, item.employeeId, day);
  if (!budget.ok) return `spend cap reached (${budget.scope}); it resumes when the cap is raised or tomorrow`;
  // A resumed session is free (subscription); the headroom rule only guards real-money work.

  const emp = wp.org.employees.find(e => e.id === item.employeeId);
  // The routine's own notes and the stall detector's "did nothing for 10 minutes" items are not
  // questions the work waits on (QA B3: they made every stalled item wait on itself, for ever).
  const open = inbox.list(wp, 'open').filter(i => !isRoutineNote(i) && !isStallDetectorItem(i));
  const lost = open.find(i => i.raisedBy === item.employeeId && i.context['lostSession']);
  if (lost) return `waiting on your answer: "${lost.title}"`;
  const pending = proposals.list(wp).find(p => p.state === 'pending' && touches(p.params, item, emp?.charterIds ?? []));
  if (pending) return `waiting on the org-change proposal: ${pending.kind} ${String(pending.params['charterId'] ?? pending.params['name'] ?? '')} (${pending.inboxId})`;
  const ownerAsk = open.find(i => i.context['assignmentId'] === item.id);
  if (ownerAsk) return `waiting on your answer: "${ownerAsk.title}"`;
  return null;
}

function touches(params: Record<string, unknown>, item: WorkItem, charters: string[]): boolean {
  const ids = [params['charterId'], ...(Array.isArray(params['charterIds']) ? params['charterIds'] : [])].filter((x): x is string => typeof x === 'string');
  return ids.some(id => id === item.charterId || charters.includes(id));
}

function resumedToday(wp: Workplace, id: string, day: string): boolean {
  return !!wp.db.prepare('select 1 from settings where key = ?').get(`resumed:${id}:${day}`);
}

/** A note the routine filed ("Waiting: …"), whatever its state. */
export function isRoutineNote(i: InboxItem): boolean {
  return i.kind === 'question' && 'stalledSince' in i.context && typeof i.context['assignmentId'] === 'string';
}

/** The stall detector's "X is stalled/looping" item (health.ts), about a session rather than the work. */
export function isStallDetectorItem(i: InboxItem): boolean {
  return i.kind === 'question' && typeof i.context['agentId'] === 'string' && (i.context['reason'] === 'idle' || i.context['reason'] === 'loop');
}

/**
 * One note per work item: the previous day's open note is withdrawn when a new one is filed, and a
 * note answered today ("Let it wait") is not filed again today. At boot, `dedupeNotes` withdraws
 * the duplicates an earlier build left (27 open notes for 12 items on 29 Sep).
 */
export function dedupeNotes(wp: Workplace): { expired: string[] } {
  const notes = inbox.list(wp, 'open').filter(isRoutineNote);
  const newestFor = new Map<string, InboxItem>();
  for (const n of notes) {
    const id = String(n.context['assignmentId']);
    const seen = newestFor.get(id);
    if (!seen || n.createdAt > seen.createdAt) newestFor.set(id, n);
  }
  const expired: string[] = [];
  for (const n of notes) {
    const keep = newestFor.get(String(n.context['assignmentId']))!;
    if (keep.id === n.id) continue;
    inbox.expire(wp, n.id, `Superseded by ${keep.id} (one note per work item).`);
    expired.push(n.id);
  }
  if (expired.length) log.info('cos', `withdrew ${expired.length} duplicate stall note(s)`);
  return { expired };
}

/**
 * One-time cleanup of the pre-fix flood (29 Sep QA): stall notices and "did nothing" items raised
 * before `ownerFacing` existed are withdrawn from the owner's Inbox (not answered — the underlying
 * work, if still stalled, raises a fresh routine note next tick); QA's `[TEST]` fixtures are
 * withdrawn too; an open review request is moved onto the reviewer's/Asha's page instead of being
 * withdrawn, since it is real, open work. Idempotent: nothing is left to touch on the next boot.
 */
export function cleanupLegacyInbox(wp: Workplace): { withdrawn: string[]; reclassified: string[] } {
  const withdrawn: string[] = [];
  const reclassified: string[] = [];
  const isTestFixture = (i: InboxItem): boolean => /^\[TEST\]/.test(i.summary) || /^\[TEST\]/.test(i.title) || /^\[TEST\]/.test(i.body);
  for (const i of inbox.list(wp, 'open')) {
    if (i.ownerFacing === false) continue; // already under the new rule
    if (isRoutineNote(i) || isStallDetectorItem(i)) {
      inbox.expire(wp, i.id, 'Moved to Asha\'s queue: routine stall/idle notices never reach the owner\'s Inbox.');
      withdrawn.push(i.id);
    } else if (isTestFixture(i)) {
      inbox.expire(wp, i.id, 'Withdrawn: a QA test fixture, not a real proposal.');
      withdrawn.push(i.id);
    } else if (i.kind === 'question' && i.title.startsWith('Review requested:')) {
      inbox.setOwnerFacing(wp, i.id, false);
      reclassified.push(i.id);
    }
  }
  if (withdrawn.length || reclassified.length) log.info('cos', `legacy inbox cleanup: withdrew ${withdrawn.length}, moved ${reclassified.length} off the owner's Inbox`);
  return { withdrawn, reclassified };
}

function note(wp: Workplace, item: WorkItem, reason: string, by: string, day: string, result: TickResult): void {
  const emp = wp.org.employees.find(e => e.id === item.employeeId);
  const key = `noted:${item.id}:${day}`;
  if (wp.db.prepare('select 1 from settings where key = ?').get(key)) return;
  for (const old of inbox.list(wp, 'open').filter(i => isRoutineNote(i) && i.context['assignmentId'] === item.id)) {
    inbox.expire(wp, old.id, 'Superseded by today\'s note on the same work item.');
  }
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(key, new Date().toISOString());
  const before = inbox.list(wp, 'open').length;
  // Stalled work is Asha's to resume, reassign or let wait (the owner's rule: only decisions reach
  // him). Nothing in whyWaiting() is a §0 owner decision on its own — a real cap, org-change or
  // lost-approval question is already its own owner item elsewhere — so this note stays off his
  // Inbox and on Asha's own page (`ownerFacing: false`).
  inbox.raise(wp, {
    kind: 'question',
    title: `Waiting: ${item.title}`,
    body: `${emp?.name ?? item.employeeId ?? 'nobody'}'s assignment ${item.id} (${item.state}) has had no session activity since ${item.stalledSince?.replace('T', ' ').slice(0, 16)} UTC. Why: ${reason}.\nAnswer with what should happen, or nothing: it is noted, not forgotten.`,
    raisedBy: by,
    context: { assignmentId: item.id, employeeId: item.employeeId ?? null, stalledSince: item.stalledSince ?? null, reason },
    options: [{ id: 'resume', label: 'Resume it now' }, { id: 'wait', label: 'Let it wait' }, { id: 'answered', label: 'Instruction', needsNote: true }],
    dedupeKey: `stall:${item.id}:${day}`,
    ownerFacing: false,
  });
  if (inbox.list(wp, 'open').length > before) result.noted.push({ id: item.id, reason });
}

// "Resume it now" from the Inbox starts the session regardless of the once-a-day rule (budget still applies).
inbox.onAnswer((wp, item) => {
  if (item.kind !== 'question' || !item.context['stalledSince'] || item.answer?.optionId !== 'resume') return;
  const id = String(item.context['assignmentId'] ?? '');
  try { employees.assign(wp, id); } catch (err) { log.warn('cos', `resume ${id}: ${err instanceof Error ? err.message : err}`); }
});
