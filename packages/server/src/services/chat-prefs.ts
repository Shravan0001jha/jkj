import type { Workplace } from './workplace.js';
import * as room from './room.js';
import { threadIds } from './talk-store.js';
import { BadRequest, NotFound } from '../util/errors.js';

/**
 * Per-chat notification mute (CHAT-NOTIFY-CONTRACT §2; LLD-chat-notify §1). Stored in `settings`
 * (`chat-pref:<threadId>`). Defaults when nothing is stored: the COO thread and 1:1 Talk threads
 * notify, rooms are muted. A `mutedUntil` in the past reads as unmuted.
 */

export interface ChatPref { muted: boolean; mutedUntil: string | null }
type Kind = 'talk' | 'room';

const KEY = (id: string) => `chat-pref:${id}`;

function kindOf(wp: Workplace, id: string): Kind | null {
  if (threadIds(wp).includes(id)) return 'talk';
  if (room.getThread(wp, id)) return 'room';
  return null;
}

function stored(wp: Workplace, id: string): ChatPref | null {
  const row = wp.db.prepare('select value from settings where key = ?').get(KEY(id)) as { value: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.value) as ChatPref; } catch { return null; }
}

function effectiveOf(p: ChatPref | null, kind: Kind, now: number): ChatPref {
  if (!p) return { muted: kind === 'room', mutedUntil: null };
  if (p.muted && p.mutedUntil && Date.parse(p.mutedUntil) <= now) return { muted: false, mutedUntil: null };
  return { muted: p.muted, mutedUntil: p.muted ? p.mutedUntil : null };
}

/** The effective pref for every chat the owner has: COO, each Talk thread, each room thread. */
export function all(wp: Workplace, now = Date.now()): Record<string, ChatPref> {
  const out: Record<string, ChatPref> = {};
  for (const id of threadIds(wp)) out[id] = effectiveOf(stored(wp, id), 'talk', now);
  for (const t of room.listThreads(wp)) out[t.id] = effectiveOf(stored(wp, t.id), 'room', now);
  return out;
}

/** True when a push for this chat should not be sent. Unknown chats are treated as unmuted talk. */
export function isMuted(wp: Workplace, id: string, now = Date.now()): boolean {
  return effectiveOf(stored(wp, id), kindOf(wp, id) ?? 'talk', now).muted;
}

export function set(wp: Workplace, id: string, body: { muted?: unknown; mutedUntil?: unknown }, now = Date.now()): ChatPref {
  const kind = kindOf(wp, id);
  if (!kind) throw new NotFound(`No chat ${id}: use coo, an employee id or a room thread id.`);
  if (typeof body.muted !== 'boolean') throw new BadRequest('muted must be true or false');
  const until = body.mutedUntil ?? null;
  if (until !== null && (typeof until !== 'string' || Number.isNaN(Date.parse(until)))) throw new BadRequest('mutedUntil must be an ISO date or null');
  const pref: ChatPref = { muted: body.muted, mutedUntil: body.muted ? (until as string | null) : null };
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(KEY(id), JSON.stringify(pref));
  const eff = effectiveOf(pref, kind, now);
  wp.emit({ type: 'chat.prefs', threadId: id, muted: eff.muted, mutedUntil: eff.mutedUntil });
  return eff;
}
