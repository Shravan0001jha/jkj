import type { InboxItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as inbox from './inbox.js';
import * as replyDelivery from './reply-delivery.js';
import { COO_ID } from './coo.js';
import { BadRequest, Conflict, NotFound } from '../util/errors.js';
import { log } from '../util/logger.js';

/**
 * The COO works the owner's Inbox down (rework W4; owner, 10 Oct: "the COO is copied on everything
 * agents send the owner; he clears what he can, and says why for what he can't").
 *
 * Every agent-raised owner item is copied to the COO bridge (kind `owner-inbox`) and its push is held
 * 15 minutes (inbox.ts). From here the COO either resolves it on the owner's behalf (answered
 * `by: 'coo'`, the answer delivered to the raiser, never pushed) or marks it "needs you because …",
 * which pushes it at once with his note on top. Untouched, the hold sweep pushes it after 15 minutes.
 *
 * The routes are loopback only (/api/coo/owner-inbox…), like every other COO-only route. This is
 * its own module, not coo.ts, because it needs reply-delivery, which itself imports coo.ts.
 */

/** GET /api/coo/owner-inbox: the open owner items, held ones included, as the owner reads them. */
export function list(wp: Workplace): InboxItem[] {
  return inbox.ownerList(wp, 'open');
}

function openOwnerItem(wp: Workplace, id: string): InboxItem {
  const item = inbox.get(wp, id);
  if (!item || !inbox.isOwnerFacing(item)) throw new NotFound(`No owner Inbox item ${id}`);
  if (item.state !== 'open') throw new Conflict(`${id} was already ${item.state}`);
  return item;
}

/**
 * POST /api/coo/owner-inbox/:id/resolve {text, optionId?}: the COO answers for the owner. The text is
 * required (the raiser is told what was decided and why). Without an option, an item with a
 * free-text option (a question's "Answer") is answered with it; any other item records `resolved`.
 */
export function resolve(wp: Workplace, id: string, spec: { text: string; optionId?: string }): InboxItem {
  const text = spec.text?.trim() ?? '';
  if (!text) throw new BadRequest('A resolution needs a text: what was decided, for the raiser.');
  const item = openOwnerItem(wp, id);
  if (item.raisedBy === COO_ID) throw new BadRequest(`${id} is your own item; the owner answers it.`);
  const optionId = spec.optionId?.trim() || item.options.find(o => o.needsNote)?.id || inbox.COO_RESOLVED;
  if (spec.optionId?.trim() && !item.options.some(o => o.id === optionId)) {
    throw new BadRequest(`"${optionId}" is not one of the options: ${item.options.map(o => o.id).join(', ')}`);
  }
  // The COO's words go in the item's thread (the owner reads why), then the answer is recorded.
  const thread = inbox.reply(wp, id, { by: COO_ID, text });
  const message = thread.messages.filter(m => m.by === COO_ID).at(-1)!;
  const answered = inbox.answer(wp, id, optionId, text, 'web', { by: 'coo' });
  try { replyDelivery.deliverCooAnswer(wp, answered, { ...message, text }); }
  catch (err) { log.warn('inbox', `COO answer on ${id} to ${answered.raisedBy}: ${err instanceof Error ? err.message : err}`); }
  return answered;
}

/** POST /api/coo/owner-inbox/:id/needs-you {text}: his note goes on top, and the push goes now. */
export function needsYou(wp: Workplace, id: string, spec: { text: string }): InboxItem {
  const text = spec.text?.trim() ?? '';
  if (!text) throw new BadRequest('"Needs you" needs a text: why the owner must decide this.');
  openOwnerItem(wp, id);
  return inbox.releaseHold(wp, id, text);
}

/** The 60-second sweep (index.ts): held items whose 15 minutes ran out are pushed. */
export const releaseHolds = inbox.releaseHolds;
