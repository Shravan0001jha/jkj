import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workplace } from './workplace.js';
import * as coo from './coo.js';
import { rawGet } from './v2-map.js';
import { log } from '../util/logger.js';

/**
 * The COO pickup alarm (dry run #22, 4 Oct). The owner's message to the COO, or his @coo mention, lands
 * in `coo/inbox.jsonl` for the lead's terminal to pick up. When the COO has not responded within 15
 * minutes (no reply on the COO chat, no thread-reply, no answer to the mention, no COO post or move
 * on that story or thread), the owner gets ONE push: "The COO hasn't picked up your message on <X>".
 *
 * Only the owner's messages and mentions count: system kinds (stalls, floor pause notices,
 * escalations, inbox-reply relays) are the COO's queue, not something the owner is waiting on.
 * One record per bridge line (`coo-pickup:<line id>`), so each is alarmed at most once; lines older
 * than two hours are never alarmed (a restart or a first deploy does not replay history).
 */

const MIN = 60_000;
export const PICKUP_MS = 15 * MIN;
const LOOKBACK_MS = 2 * 60 * MIN;
const PREFIX = 'coo-pickup:';

interface Line { id?: string; at?: string; kind?: string; itemId?: string; title?: string; text?: string }

function lines(wp: Workplace): Line[] {
  const file = join(wp.config.workplaceDir, 'coo', 'inbox.jsonl');
  if (!existsSync(file)) return [];
  const out: Line[] = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    try { out.push(JSON.parse(raw) as Line); } catch { /* a torn line */ }
  }
  return out;
}

const seen = (wp: Workplace, id: string): boolean => !!wp.db.prepare('select 1 from settings where key = ?').get(PREFIX + id);
const mark = (wp: Workplace, id: string, at: string): void => void wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(PREFIX + id, at);

/** Anything from the COO after `at` on the COO chat (a /api/coo/reply). */
const cooReplied = (wp: Workplace, at: string, ref?: string): boolean => {
  const rows = wp.db.prepare("select json from coo_messages where from_who = 'coo' and at >= ?").all(at) as { json: string }[];
  if (!ref) return rows.length > 0;
  return rows.some(r => { try { return (JSON.parse(r.json) as { inReplyTo?: string }).inReplyTo === ref; } catch { return false; } });
};

/** A COO post or move on the story or Room thread after `at`. */
function cooPosted(wp: Workplace, threadId: string | undefined, at: string): boolean {
  if (!threadId) return false;
  if (threadId.startsWith('item:')) {
    const id = threadId.slice('item:'.length);
    return !!wp.db.prepare("select 1 from comments where item_id = ? and by = 'coo' and at >= ? limit 1").get(id, at)
      || !!wp.db.prepare("select 1 from activity where item_id = ? and by = 'coo' and at >= ? limit 1").get(id, at);
  }
  return !!wp.db.prepare("select 1 from messages where thread_id = ? and by = 'coo' and at >= ? limit 1").get(threadId, at);
}

/** Where the message was: "the COO chat", a story's title, or a thread's. */
function where(wp: Workplace, threadId: string | undefined, fallback: string): string {
  if (threadId?.startsWith('item:')) return `"${rawGet(wp, threadId.slice('item:'.length))?.title ?? fallback}"`;
  if (threadId?.startsWith('talk:')) return fallback;
  if (threadId) {
    const t = wp.db.prepare('select title from threads where id = ?').get(threadId) as { title: string } | undefined;
    if (t) return `"${t.title}"`;
  }
  return fallback;
}

/** One pass: owner messages and mentions with no COO response after 15 min raise one push. Returns what was alarmed. */
export function check(wp: Workplace, nowMs = Date.now()): string[] {
  const late: { id: string; where: string }[] = [];
  for (const l of lines(wp)) {
    if (!l.id || !l.at || (l.kind !== 'message' && l.kind !== 'mention')) continue;
    const age = nowMs - Date.parse(l.at);
    if (!(age > PICKUP_MS) || age > LOOKBACK_MS || seen(wp, l.id)) continue;
    if (l.kind === 'message') {
      if (cooReplied(wp, l.at)) { mark(wp, l.id, 'answered'); continue; }
      late.push({ id: l.id, where: 'the COO chat' });
      continue;
    }
    const item = l.itemId ? coo.getItem(wp, l.itemId) : undefined;
    if (!item || item.raisedBy !== 'owner') { mark(wp, l.id, 'not the owner\'s'); continue; }
    if (item.state !== 'open' || cooReplied(wp, l.at, item.id) || cooReplied(wp, l.at, l.id) || cooPosted(wp, item.threadId, l.at)) { mark(wp, l.id, 'answered'); continue; }
    late.push({ id: l.id, where: where(wp, item.threadId, item.title) });
  }
  if (!late.length) return [];
  const at = new Date(nowMs).toISOString();
  for (const x of late) mark(wp, x.id, at);
  const first = late[0]!;
  const more = late.length > 1 ? ` (and ${late.length - 1} more)` : '';
  wp.emit({
    type: 'alert', level: 'needs-you',
    title: `The COO hasn't picked up your message on ${first.where}${more}`,
    body: 'No COO response in 15 min. The lead\'s terminal may be down: check it, or reach the COO another way.',
  });
  log.warn('coo', `pickup alarm: ${late.map(x => x.id).join(', ')} unanswered for 15 min`);
  return late.map(x => x.id);
}
