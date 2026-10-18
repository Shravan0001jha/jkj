import type { Comment, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as items from './items.js';
import * as trail from './trail.js';
import * as employees from './employees.js';
import { log } from '../util/logger.js';
import { levelOf, nameOf, rawGet } from './v2-map.js';

/**
 * RCA (owner, 18 Oct): stories sat Waiting for a day after the person they waited on had answered.
 * A wait (`waiting: {on, reason, since}`) only ever ended by the waiter's own item_update, and a reply
 * woke the waiter only if it @mentioned them. Asha's "Already done" carried no @mention, so nothing
 * moved. Now the awaited person's (or the COO's) comment on the story ends the wait itself: back to
 * In progress with "<name> replied: …", and the assignee is woken with the reply.
 */

const clip = (s: string, n: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The latest comment by the person a Waiting story waits on, made after the wait began. */
export function answerTo(wp: Workplace, w: WorkItem): Comment | undefined {
  const wait = w.waiting;
  if (w.status !== 'waiting' || !wait?.on || levelOf(w) === 'epic') return undefined;
  const since = Date.parse(wait.since);
  return trail.comments(wp, w.id).filter(c => c.by === wait.on && Date.parse(c.at) > since).at(-1);
}

/** End the wait `reply` answers, if it answers one. Returns whether the story moved. */
export function endOnReply(wp: Workplace, reply: Comment, wake = true): boolean {
  const w = rawGet(wp, reply.itemId);
  if (!w || w.status !== 'waiting' || w.waiting?.on !== reply.by) return false;
  if (Date.parse(reply.at) <= Date.parse(w.waiting.since)) return false;
  const who = nameOf(wp, reply.by);
  const text = (reply.details ?? reply.text);
  const to = w.employeeId ? 'in-progress' : 'ready';
  try {
    items.update(wp, w.id, { status: to, reason: `${who} replied: ${clip(text, 160)}` }, 'workplace', { checked: true });
  } catch (err) {
    log.warn('wait-reply', `${w.id}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
  if (wake && w.employeeId && !reply.mentions.includes(w.employeeId)) {
    const prompt = [`${who} replied on "${w.title}" (${w.id}), which was Waiting on ${who}; it is back In progress:`, '', `"${clip(text, 4000)}"`, '', 'Carry on with the work using this answer. Comment with item_comment only if you have something to add.'].join('\n');
    try { employees.talk(wp, w.employeeId, prompt, [], { autonomous: true, probe: true }); }
    catch (err) { log.warn('wait-reply', `wake ${w.employeeId} on ${w.id}: ${err instanceof Error ? err.message : err}`); }
  }
  return true;
}
