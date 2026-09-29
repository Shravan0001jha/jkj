import type { RoomMessage, RoomThread } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as employees from './employees.js';
import * as coo from './coo.js';
import { onRunEvent } from './runs.js';
import { log } from '../util/logger.js';

/**
 * RCA (owner request, 29 Sep): `@mentions` in the Team Room go unanswered. `room.ts` has always
 * computed `mentions` on a message (`mentionsIn`) and stored them, but nothing downstream ever
 * turned that into a session doing anything — the only consumer was `push.ts`, and only for an
 * `@owner`/`@shravan` mention (a phone notification, never a turn). An employee mentioned in a
 * thread, or `@coo`, simply never heard about it until it happened to look at the Room on its own.
 *
 * The fix: wake the mentioned employee with a short, budget-bounded turn. Wired once at boot
 * (`wireMentionReplies`) onto the same `room.message` event `room.post`/`createThread` already
 * emit, so every path that can post (the REST route, the `room_post` tool, the seed) is covered
 * without room.ts depending on employees.ts (that would cycle: employees.ts already depends on
 * room.ts for the Team Room context layer).
 */

/** One reply turn per mention: do not re-wake the same employee about the same thread inside this window. */
export const MENTION_COOLDOWN_MS = 10 * 60_000;

const lastTurnAt = new Map<string, number>(); // `${employeeId}:${threadId}` -> epoch ms

export function wireMentionReplies(wp: Workplace): () => void {
  return wp.on(event => {
    if (event.type !== 'room.message') return;
    handle(wp, event.thread, event.message);
  });
}

function handle(wp: Workplace, thread: RoomThread, message: RoomMessage): void {
  if (message.by === 'workplace') return; // the Workplace's own notes (e.g. "Escalated to …") mention nobody worth waking
  for (const id of message.mentions) {
    if (id === message.by) continue; // self-mention
    if (coo.isCoo(id)) { notifyCoo(wp, thread, message); continue; }
    const emp = wp.org.employees.find(e => e.id === id);
    if (!emp || emp.virtual) continue;
    wake(wp, thread, message, id);
  }
}

function notifyCoo(wp: Workplace, thread: RoomThread, message: RoomMessage): void {
  try {
    coo.notifyMention(wp, { threadId: thread.id, threadTitle: thread.title, by: message.by, text: message.text });
  } catch (err) {
    log.warn('mentions', `@coo in ${thread.id}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Start or resume a short turn for the mentioned employee, with the thread as its prompt. Bounded:
 * a rate limit per (employee, thread), and `probe: true` so this never overwrites the employee's
 * real status/handoff — it is a Room reply, not an assignment. Subscription use only (free, D9b);
 * `employees.talk` still refuses at a real-money cap, which is caught and logged, not thrown.
 *
 * `room.replying` (owner, 29 Sep — a "Mira is replying…" indicator on the phone): `skipped` when
 * the rate limit or a cap holds the turn back entirely — nothing ever starts, so there is nothing
 * to show as finished. Otherwise `started` the moment the turn is handed to the employee, and
 * `done` when that run next leaves `running` (the SDK's own turn boundary) — whether it replied,
 * did nothing, or errored; the indicator does not distinguish those, only "still going" from "not".
 */
function wake(wp: Workplace, thread: RoomThread, message: RoomMessage, employeeId: string): void {
  const key = `${employeeId}:${thread.id}`;
  const last = lastTurnAt.get(key) ?? 0;
  if (Date.now() - last < MENTION_COOLDOWN_MS) {
    wp.emit({ type: 'room.replying', threadId: thread.id, employeeId, state: 'skipped' });
    return;
  }
  lastTurnAt.set(key, Date.now());

  const who = message.owner ? 'the owner' : (wp.org.employees.find(e => e.id === message.by)?.name ?? message.by);
  const prompt = [
    `Team Room: ${who} mentioned you in "${thread.title}" (${thread.id}).`,
    '',
    `"${message.text.slice(0, 500)}"`,
    '',
    'This is a Room reply, not an assignment: read the thread with room_read if you need more context, then ' +
      'reply with room_post only if you have something to say; otherwise do nothing. Keep it short.',
  ].join('\n');

  let agentId: string;
  try {
    agentId = employees.talk(wp, employeeId, prompt, [], { autonomous: true, probe: true }).id;
  } catch (err) {
    log.warn('mentions', `${employeeId} in ${thread.id}: ${err instanceof Error ? err.message : err}`);
    wp.emit({ type: 'room.replying', threadId: thread.id, employeeId, state: 'skipped' });
    return;
  }

  wp.emit({ type: 'room.replying', threadId: thread.id, employeeId, state: 'started' });
  const unsubscribe = onRunEvent(({ agent }) => {
    if (agent?.id !== agentId || agent.status === 'running') return;
    unsubscribe();
    wp.emit({ type: 'room.replying', threadId: thread.id, employeeId, state: 'done' });
  });
}

/** Test-only: let a test move past the cooldown without waiting for it. */
export function resetForTest(): void {
  lastTurnAt.clear();
}
