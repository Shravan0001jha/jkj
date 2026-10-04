/**
 * Talk threads (docs/LLD-app-fixes.md §2): one conversation per employee (id = the employee id) and
 * the COO's ('coo'). Types only, plus the pure sender-name helper.
 */

/** Who wrote a message: the owner, the COO, the Workplace itself, or an employee id. */
export type TalkFrom = 'owner' | 'coo' | 'workplace' | (string & {});

export interface TalkAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  kind: 'image' | 'file' | 'voice';
  /** Relative: `/api/talk/attachments/<id>`; send the bearer token. */
  url: string;
}

export interface TalkQuote {
  id: string;
  from: TalkFrom;
  fromName: string;
  /** One line, at most 140 characters. */
  text: string;
}

export interface TalkMessage {
  id: string;
  threadId: string;
  at: string;
  from: TalkFrom;
  fromName: string;
  /** 'in' = to the agent; 'out' = from the agent. */
  direction: 'in' | 'out';
  /** For a voice note: the transcript. */
  text: string;
  replyTo?: TalkQuote;
  mentions: string[];
  attachments: TalkAttachment[];
  voice?: { attachmentId: string; transcript: string; durationMs?: number };
  /** Inbound only: 'delivered' = handed to the agent's session; 'read' = the agent's turn consumed it. */
  receipt?: 'delivered' | 'read';
  deliveredAt?: string;
  readAt?: string;
  /** Outbound prose from a turn no human message started (work narration): not counted unread. */
  quiet?: boolean;
  /** The session (run) it belongs to. */
  agentId?: string;
}

export interface TalkThread {
  id: string;
  employeeId: string;
  name: string;
  role?: string;
  lastMessageAt?: string;
  lastMessage?: TalkQuote;
  unreadCount: number;
  lastReadAt?: string;
  pinned: boolean;
  pinnedAt?: string;
  typing: boolean;
}

export interface Mentionable {
  id: string;
  name: string;
  role?: string;
  kind: 'employee' | 'coo';
}

export const COO_NAME = 'Claude — COO';

/** The display name of a sender: "You", "Claude — COO", "Workplace", or the employee's name. */
export function senderName(from: string | undefined, names: ReadonlyMap<string, string> | Record<string, string> = {}): string {
  if (!from || from === 'owner') return 'You';
  if (from === 'coo') return COO_NAME;
  if (from === 'workplace') return 'Workplace';
  const name = names instanceof Map ? names.get(from) : (names as Record<string, string>)[from];
  return name ?? from;
}
