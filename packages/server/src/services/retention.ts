import { rmSync } from 'node:fs';
import type { TalkAttachment } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import { COO_THREAD, thread } from './talk-store.js';
import { log } from '../util/logger.js';

/**
 * Talk retention (rework W4; owner, 10 Oct: "DELETE agent update pings older than 3 days. No archive.
 * Details belong on stories and docs, not in the owner's chat").
 *
 * Deletes, for good, every Talk message an employee sent (`direction = 'out'`, `from_who` an employee
 * id) more than 3 days ago, with its attachments' rows and files. Kept: everything the owner, the COO
 * or the Workplace wrote, and the whole COO thread (its rows also back-fill from `coo_messages` on
 * boot, so deleting them would only bring them back). Hard delete is the owner's decision; it is
 * the one destructive change in the rework.
 *
 * Runs once per IST day from the rhythm timer, and once 5 minutes after boot (index.ts).
 */

export const KEEP_MS = 3 * 24 * 60 * 60_000;
const NOT_AGENTS = new Set(['owner', 'coo', 'workplace']);
const ranKey = (day: string): string => `retention:talk:${day}`;
const istDay = (ms: number): string => new Date(ms + 5.5 * 60 * 60_000).toISOString().slice(0, 10);

export interface RetentionResult { messages: number; attachments: number }

export function sweep(wp: Workplace, nowMs = Date.now()): RetentionResult {
  const employees = new Set(wp.org.employees.map(e => e.id).filter(id => !NOT_AGENTS.has(id)));
  const cutoff = new Date(nowMs - KEEP_MS).toISOString();
  const rows = (wp.db.prepare("select id, thread_id, from_who, json from talk_messages where direction = 'out' and at < ? and thread_id != ?")
    .all(cutoff, COO_THREAD) as { id: string; thread_id: string; from_who: string; json: string }[])
    .filter(r => employees.has(r.from_who));
  if (!rows.length) return { messages: 0, attachments: 0 };

  const attachmentIds = new Set<string>();
  for (const r of rows) {
    try {
      const m = JSON.parse(r.json) as { attachments?: TalkAttachment[]; voice?: { attachmentId?: string } };
      for (const a of m.attachments ?? []) if (a?.id) attachmentIds.add(a.id);
      if (m.voice?.attachmentId) attachmentIds.add(m.voice.attachmentId);
    } catch { /* a malformed row still goes */ }
  }

  const deleteMessage = wp.db.prepare('delete from talk_messages where id = ?');
  const findAttachment = wp.db.prepare('select path from talk_attachments where id = ?');
  const stillUsed = wp.db.prepare('select 1 from talk_messages where json like ? limit 1');
  const deleteAttachment = wp.db.prepare('delete from talk_attachments where id = ?');
  const files: string[] = [];
  let attachments = 0;
  wp.db.exec('begin');
  try {
    for (const r of rows) deleteMessage.run(r.id);
    for (const id of attachmentIds) {
      // A file another kept message still shows (a forward, a quote) stays.
      if (stillUsed.get(`%"${id}"%`)) continue;
      const a = findAttachment.get(id) as { path: string } | undefined;
      if (!a) continue;
      deleteAttachment.run(id);
      files.push(a.path);
      attachments += 1;
    }
    wp.db.exec('commit');
  } catch (err) {
    wp.db.exec('rollback');
    throw err;
  }
  for (const path of files) {
    try { rmSync(path, { force: true }); } catch (err) { log.warn('retention', `could not remove ${path}: ${err instanceof Error ? err.message : err}`); }
  }
  // Open apps refresh the thread list (previews and unread counts may have changed).
  for (const threadId of new Set(rows.map(r => r.thread_id))) {
    try { wp.emit({ type: 'talk.thread', thread: thread(wp, threadId) }); } catch { /* a thread of a retired employee */ }
  }
  log.info('retention', `deleted ${rows.length} agent Talk message(s) older than 3 days and ${attachments} attachment(s)`);
  return { messages: rows.length, attachments };
}

/** Once per IST day (the rhythm timer calls it every minute). Null when it already ran today. */
export function maybeRun(wp: Workplace, nowMs = Date.now()): RetentionResult | null {
  const day = istDay(nowMs);
  if (wp.db.prepare('select 1 from settings where key = ?').get(ranKey(day))) return null;
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(ranKey(day), new Date(nowMs).toISOString());
  return sweep(wp, nowMs);
}
