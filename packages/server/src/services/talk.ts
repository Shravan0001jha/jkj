import type { Agent, Attachment, Mentionable, TalkAttachment, TalkMessage } from '@jkj/shared';
import { COO_NAME } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as employees from './employees.js';
import * as coo from './coo.js';
import * as runs from './runs.js';
import * as store from './talk-store.js';
import * as mentions from './mentions.js';
import { mentionsIn } from './room.js';
import { transcribe } from './stt.js';
import { BadRequest } from '../util/errors.js';

/**
 * Sending into a Talk thread (docs/LLD-app-fixes.md §2, §5–7): the owner's or the COO's message to an
 * employee (or to the COO), with reply-to, several @mentions, files and voice notes. The message is
 * staged under its id, then handed to the session; talk-store records it from the run's own line.
 */

export interface SendSpec {
  from: 'owner' | 'coo';
  text?: string;
  replyTo?: string;
  mentions?: string[];
  attachmentIds?: string[];
  /** Base64 files in the body (the existing Talk format). */
  attachments?: Attachment[];
  voice?: { attachmentId: string; transcript: string; durationMs?: number };
  probe?: boolean;
}

export function send(wp: Workplace, threadId: string, spec: SendSpec): { message: TalkMessage; agent?: Agent } {
  store.requireThread(wp, threadId);
  const files: TalkAttachment[] = (spec.attachmentIds ?? []).map(id => {
    const a = store.attachment(wp, id);
    if (!a || a.threadId !== threadId) throw new BadRequest(`No uploaded file ${id} in this thread; upload it again.`);
    const { threadId: _t, path: _p, ...pub } = a;
    return pub;
  });
  for (const f of spec.attachments ?? []) files.push(store.saveAttachment(wp, threadId, { name: f.name, mediaType: f.mediaType, data: Buffer.from(f.data, 'base64') }));
  const text = spec.text?.trim() ?? '';
  if (!text && files.length === 0 && !spec.voice) throw new BadRequest('Nothing to send.');
  if (threadId === store.COO_THREAD && files.some(f => f.kind !== 'voice')) throw new BadRequest('The COO thread takes text and voice; send files to an employee.');

  const quoted = spec.replyTo ? store.getMessage(wp, spec.replyTo) : undefined;
  if (spec.replyTo && (!quoted || quoted.threadId !== threadId)) throw new BadRequest(`No message ${spec.replyTo} in this thread to reply to.`);
  const tagged = validMentions(wp, [...(spec.mentions ?? []), ...mentionsIn(wp, text)]);

  const staged: store.Staged = {
    text: spec.voice ? spec.voice.transcript : text,
    mentions: tagged, attachments: files,
    ...(quoted ? { replyTo: store.quoteOf(quoted) } : {}),
    ...(spec.voice ? { voice: spec.voice } : {}),
  };
  const agentText = forAgent(wp, staged);
  const talkId = runs.newTalkId();

  let agent: Agent | undefined;
  if (threadId === store.COO_THREAD) {
    store.stageCoo(talkId, staged);
    const line = coo.sendOwnerMessage(wp, agentText);
    const message = store.getMessage(wp, line.id)!;
    wakeMentioned(wp, threadId, spec.from, message);
    return { message };
  }
  store.stage(talkId, staged);
  try {
    const images: Attachment[] = files.filter(f => f.kind === 'image').map(f => {
      const { data } = store.attachmentBytes(wp, f.id);
      return { name: f.name, mediaType: f.mediaType, data: data.toString('base64') };
    });
    agent = employees.talk(wp, threadId, agentText, images, { from: spec.from, talkId, ...(spec.probe ? { probe: true } : {}) });
  } finally {
    store.unstage(talkId);
  }
  const message = store.getMessage(wp, talkId);
  if (!message) throw new Error('The message was handed over but not recorded.');
  wakeMentioned(wp, threadId, spec.from, message);
  return { message, agent };
}

/**
 * What the agent reads: the quote it replies to, the text (or the transcript, marked as a voice
 * note), and a line per non-image file with its absolute path (images travel as images).
 */
export function forAgent(wp: Workplace, s: store.Staged): string {
  const parts: string[] = [];
  if (s.replyTo) parts.push(`> Replying to ${s.replyTo.fromName}: "${s.replyTo.text}"`);
  if (s.voice) parts.push(`${s.voice.transcript}\n\n(voice note)`);
  else if (s.text) parts.push(s.text);
  for (const f of s.attachments ?? []) {
    if (f.kind === 'image' || (s.voice && f.id === s.voice.attachmentId)) continue;
    const a = store.attachment(wp, f.id);
    if (a) parts.push(`Attached file: ${f.name} (${f.mediaType}, ${humanSize(f.size)}) at ${a.path} — read it with the Read tool.`);
  }
  if (!s.text && !s.voice && (s.attachments ?? []).length) parts.push('See the attached file.');
  return parts.join('\n\n');
}

const humanSize = (n: number): string => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Known ids only, de-duplicated; an unknown id is refused by name. */
export function validMentions(wp: Workplace, ids: string[]): string[] {
  const known = new Set(wp.org.employees.map(e => e.id));
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim().replace(/^@/, '').toLowerCase();
    if (!id) continue;
    if (!known.has(id)) throw new BadRequest(`@${raw} is not someone in the Workplace; GET /api/mentionable lists who can be tagged.`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function wakeMentioned(wp: Workplace, threadId: string, by: string, message: TalkMessage): void {
  const others = message.mentions.filter(id => id !== threadId && id !== by);
  if (others.length) mentions.notifyTalkMention(wp, { threadId, threadName: store.thread(wp, threadId).name, by, text: message.text, ids: others });
}

export function mentionable(wp: Workplace): Mentionable[] {
  return wp.org.employees
    .map(e => ({ id: e.id, name: e.id === store.COO_THREAD ? COO_NAME : e.name, ...(wp.org.roles.find(r => r.id === e.roleId)?.title ? { role: wp.org.roles.find(r => r.id === e.roleId)!.title } : {}), kind: (e.id === store.COO_THREAD ? 'coo' : 'employee') as Mentionable['kind'] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------- voice ---------- */

export const VOICE_TYPES = new Set(['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/mpeg', 'audio/mp3', 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/wave']);

/** Store, transcribe, send. Nothing is sent when transcription fails. */
export async function sendVoice(wp: Workplace, threadId: string, spec: { from: 'owner' | 'coo'; name: string; mediaType: string; data: Buffer; durationMs?: number; replyTo?: string }): Promise<{ message: TalkMessage; agent?: Agent }> {
  store.requireThread(wp, threadId);
  const mediaType = spec.mediaType.split(';')[0]!.trim().toLowerCase();
  if (!VOICE_TYPES.has(mediaType)) throw new BadRequest(`A voice note must be m4a, mp3, webm, ogg or wav, not ${mediaType || 'unknown'}.`);
  const transcript = await transcribe(spec.data, mediaType);
  const att = store.saveAttachment(wp, threadId, { name: spec.name || 'voice-note.m4a', mediaType, data: spec.data, kind: 'voice' });
  return send(wp, threadId, {
    from: spec.from, attachmentIds: [att.id],
    voice: { attachmentId: att.id, transcript, ...(spec.durationMs ? { durationMs: spec.durationMs } : {}) },
    ...(spec.replyTo ? { replyTo: spec.replyTo } : {}),
  });
}
