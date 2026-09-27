import type { WorkItem } from '@jkj/shared';
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
}

export function tick(wp: Workplace, nowMs = Date.now()): TickResult {
  const result: TickResult = { resumed: [], noted: [], moderated: [] };
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

  for (const item of stall.stalledAssignments(wp, nowMs)) {
    const reason = whyWaiting(wp, item, day);
    if (!reason && !resumedThisTick && !resumedToday(wp, item.id, day)) {
      try {
        employees.assign(wp, item.id);
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
    note(wp, item, reason ?? (resumedToday(wp, item.id, day)
      ? `resumed once today already and stalled again; no session activity since ${item.stalledSince!.slice(11, 16)} UTC`
      : 'another stalled item was resumed this round; this one waits for the next'), cos, day, result);
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
  const open = inbox.list(wp, 'open');
  const lost = open.find(i => i.raisedBy === item.employeeId && (i.context['lostSession'] || i.context['agentId']));
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

function note(wp: Workplace, item: WorkItem, reason: string, by: string, day: string, result: TickResult): void {
  const emp = wp.org.employees.find(e => e.id === item.employeeId);
  const before = inbox.list(wp, 'open').length;
  inbox.raise(wp, {
    kind: 'question',
    title: `Waiting: ${item.title}`,
    body: `${emp?.name ?? item.employeeId ?? 'nobody'}'s assignment ${item.id} (${item.state}) has had no session activity since ${item.stalledSince?.replace('T', ' ').slice(0, 16)} UTC. Why: ${reason}.\nAnswer with what should happen, or nothing: it is noted, not forgotten.`,
    raisedBy: by,
    context: { assignmentId: item.id, employeeId: item.employeeId ?? null, stalledSince: item.stalledSince ?? null, reason },
    options: [{ id: 'resume', label: 'Resume it now' }, { id: 'wait', label: 'Let it wait' }, { id: 'answered', label: 'Instruction', needsNote: true }],
    dedupeKey: `stall:${item.id}:${day}`,
  });
  if (inbox.list(wp, 'open').length > before) result.noted.push({ id: item.id, reason });
}

// "Resume it now" from the Inbox starts the session regardless of the once-a-day rule (budget still applies).
inbox.onAnswer((wp, item) => {
  if (item.kind !== 'question' || !item.context['stalledSince'] || item.answer?.optionId !== 'resume') return;
  const id = String(item.context['assignmentId'] ?? '');
  try { employees.assign(wp, id); } catch (err) { log.warn('cos', `resume ${id}: ${err instanceof Error ? err.message : err}`); }
});
