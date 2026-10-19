import type { Workplace } from './workplace.js';
import * as employees from './employees.js';
import * as runs from './runs.js';
import * as trail from './trail.js';
import { log } from '../util/logger.js';

/**
 * The Workplace telling one employee something about an item: the line goes on the item (the record) AND
 * into their live session on that item, else their open session (the delivery).
 *
 * Board bug 3 (19 Oct): an item comment by 'workplace' is a record only; its @mentions are never delivered
 * (mentions.ts skips the Workplace's own notes, so its notes never wake the whole team). Every Workplace
 * message that asks a person to act goes through here (or review-wake for reviews), never through an
 * @mention in a Workplace comment.
 */
export function tell(wp: Workplace, emp: string, itemId: string, text: string, from = 'mac-queue'): void {
  try { trail.comment(wp, itemId, { by: 'workplace', text }); } catch (err) { log.warn(from, `comment on ${itemId}: ${err instanceof Error ? err.message : err}`); }
  const s = employees.sessionsOf(emp).find(x => employees.isLive(x.agentId) && x.assignmentId === itemId) ?? employees.openSession(emp);
  if (!s) return;
  try { runs.sendMessage(s.agentId, text, [], { from: 'workplace' }); } catch (err) { log.warn(from, `message to ${emp}: ${err instanceof Error ? err.message : err}`); }
}
