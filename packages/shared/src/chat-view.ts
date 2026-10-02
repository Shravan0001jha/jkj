import type { LogEntry, LogKind } from './types.js';

/**
 * Talk must read like a chat (owner request, 29 Sep). Today's transcript shows every tool call and
 * search; the RCA is simply that nothing ever summarised it. `toChatView` is a pure transform, not
 * a second copy of the log: the server serves it for `GET /api/agents/:id/log?view=chat`, and the
 * web applies the same function to whatever is already in the store (initial fetch or a live
 * `agent.log` socket entry) so the chat view stays correct while a session is still running. The
 * full log is never discarded — `view=full` (or no `view`) still returns it, and every collapsed
 * `'activity'` entry carries its original entries for the "expand" control.
 *
 * What counts as a message: `'assistant'`/`'user'` prose and `'image'` attachments pass through
 * unchanged (an assistant entry already carries `summary`/`details`, D16). `'read' | 'edit' |
 * 'bash' | 'search' | 'task' | 'tool'` are tool activity: a run of two or more consecutive ones
 * collapses into one `'activity'` entry; a single one is left as it is, since "worked · 1 step ·
 * 2s" reads worse than just showing the read. `'system'` and `'error'` entries (approval
 * allowed/denied, a rate limit, a permission-mode change, a session note) are neither tool activity
 * nor a chat message; they are left in place, uncollapsed, so nothing the owner needs — an approval
 * that was granted, a session that closed — silently disappears into a "worked" line. The live
 * approval prompt itself is not a transcript entry at all (`Agent.approval`); it renders above the
 * transcript in both views and this transform never touches it.
 */

const TOOL_KINDS: ReadonlySet<LogKind> = new Set(['read', 'edit', 'bash', 'search', 'task', 'tool']);

/**
 * v2 chat hygiene (owner, 2 Oct: "a chat is a chat"): besides tool runs, two more kinds of entry
 * are not messages and fold into the activity line — a `user` entry the Workplace itself sent
 * (`from: 'workplace'`: an assignment prompt, a moderation turn, a handoff request; it is not the
 * owner's words) and a `system` note (stalled, resumed, an approval decided). Nothing is dropped:
 * the activity entry keeps them for "expand". Errors stay in place.
 */
const isActivity = (e: LogEntry): boolean =>
  TOOL_KINDS.has(e.kind) || e.kind === 'system' || (e.kind === 'user' && e.from === 'workplace');

export function toChatView(entries: LogEntry[]): LogEntry[] {
  const out: LogEntry[] = [];
  let run: LogEntry[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length === 1 && TOOL_KINDS.has(run[0]!.kind)) { out.push(run[0]!); run = []; return; }
    out.push(activityEntry(run));
    run = [];
  };

  for (const entry of entries) {
    if (isActivity(entry)) { run.push(entry); continue; }
    flush();
    out.push(entry);
  }
  flush();
  return out;
}

function activityEntry(run: LogEntry[]): LogEntry {
  const first = run[0]!;
  const last = run[run.length - 1]!;
  const durationMs = Math.max(0, new Date(last.at).getTime() - new Date(first.at).getTime());
  return {
    id: `activity_${first.id}`,
    agentId: first.agentId,
    at: first.at,
    kind: 'activity',
    label: '',
    text: `worked · ${run.length} step${run.length === 1 ? '' : 's'} · ${humanDuration(durationMs)}`,
    activity: { count: run.length, durationMs, entries: run },
  };
}

function humanDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
