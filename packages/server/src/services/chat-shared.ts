import type { TalkMessage } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as room from './room.js';
import { threadIds } from './talk-store.js';
import { rowsJson } from './store.js';
import { BadRequest, NotFound } from '../util/errors.js';

/**
 * A chat's shared media, files and links over its whole history (CHAT-NOTIFY-CONTRACT §3; LLD-chat-notify §2).
 * Talk threads (the COO thread included, via its Talk mirror) give attachments and links; rooms give links.
 */

export type SharedKind = 'media' | 'files' | 'links';
export interface SharedItem {
  kind: SharedKind; messageId: string; at: string;
  url?: string; attachmentId?: string; name?: string; mime?: string; size?: number; thumbUrl?: string;
}
export const PAGE = 50;
const URL_RE = /\bhttps?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?]/g;

function linksOf(text: string | undefined, messageId: string, at: string): SharedItem[] {
  return [...new Set((text ?? '').match(URL_RE) ?? [])].map(url => ({ kind: 'links' as const, messageId, at, url }));
}

export function shared(wp: Workplace, threadId: string, kind: string, before?: string | null): { items: SharedItem[]; next: string | null } {
  if (kind !== 'media' && kind !== 'files' && kind !== 'links') throw new BadRequest('kind must be media, files or links');
  if (before && Number.isNaN(Date.parse(before))) throw new BadRequest('before must be an ISO date');
  let all: SharedItem[];
  if (threadIds(wp).includes(threadId)) {
    const msgs = rowsJson<TalkMessage>(wp.db.prepare('select json from talk_messages where thread_id = ? order by at desc').all(threadId));
    all = msgs.flatMap(m => {
      if (kind === 'links') return linksOf(m.text, m.id, m.at);
      return (m.attachments ?? [])
        .filter(a => a.id !== m.voice?.attachmentId && a.kind !== 'voice' && (kind === 'media' ? a.kind === 'image' : a.kind !== 'image'))
        .map(a => ({ kind, messageId: m.id, at: m.at, attachmentId: a.id, url: a.url, name: a.name, mime: a.mediaType, size: a.size, ...(a.kind === 'image' ? { thumbUrl: a.url } : {}) }));
    });
  } else if (room.getThread(wp, threadId)) {
    all = kind === 'links' ? room.messages(wp, threadId).slice().reverse().flatMap(m => linksOf(m.details ?? m.text, m.id, m.at)) : [];
  } else {
    throw new NotFound(`No chat ${threadId}`);
  }
  const page = all.filter(i => !before || i.at < before).slice(0, PAGE);
  return { items: page, next: page.length === PAGE ? page[page.length - 1]!.at : null };
}
