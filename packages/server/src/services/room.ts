import type { Area, Room, RoomDetail, RoomMessage, RoomThread, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as work from './work.js';
import * as inbox from './inbox.js';
import * as coo from './coo.js';
import { readEmployeeFile } from './org.js';
import { newId, now, rowJson, rowsJson } from './store.js';
import { oneLine, short } from './one-line.js';
import { authorId } from './v2-map.js';
import { humanizeIds } from './id-names.js';
import { BadRequest, NotFound } from '../util/errors.js';

/**
 * The Team Room (HLD D3b): cross-team work as a persistent, moderated group chat. Threads per
 * topic with @mentions; employees post instead of editing outside their charter; the Chief of
 * Staff resolves and escalates only above her authority; the owner reads and comments anytime.
 */

export function listThreads(wp: Workplace, state?: RoomThread['state']): RoomThread[] {
  return storedThreads(wp, state).map(t => ownerThread(wp, withHeadline(t)));
}

/** As stored (for writes: a read view must never be saved back). */
function storedThreads(wp: Workplace, state?: RoomThread['state']): RoomThread[] {
  const rows = state
    ? wp.db.prepare('select json from threads where state = ? order by last_at desc').all(state)
    : wp.db.prepare("select json from threads order by case state when 'open' then 0 else 1 end, last_at desc").all();
  return rowsJson<RoomThread>(rows);
}

/** A thread as the owner reads it: known ids in its headline read as titles (the stored headline keeps them). */
export const ownerThread = (wp: Workplace, t: RoomThread): RoomThread => ({ ...t, headline: humanizeIds(wp, t.headline) });

export function getThread(wp: Workplace, id: string): RoomThread | undefined {
  const t = rowJson<RoomThread>(wp.db.prepare('select json from threads where id = ?').get(id));
  return t ? withHeadline(t) : undefined;
}

/** Threads made before D16 read as their title until someone sets a headline. */
const withHeadline = (t: RoomThread): RoomThread => (t.headline ? t : { ...t, headline: oneLine(t.title).summary });

export function messages(wp: Workplace, threadId: string): RoomMessage[] {
  return rowsJson<RoomMessage>(wp.db.prepare('select json from messages where thread_id = ? order by at, rowid').all(threadId));
}

/** Employees named in a message: @dev, @Mira, @asha. */
export function mentionsIn(wp: Workplace, text: string): string[] {
  const ids = new Set(wp.org.employees.map(e => e.id));
  const names = new Map(wp.org.employees.map(e => [e.name.toLowerCase(), e.id]));
  const found = new Set<string>();
  for (const m of text.matchAll(/@([a-zA-Z][a-zA-Z0-9_-]*)/g)) {
    const raw = m[1]!.toLowerCase();
    if (ids.has(raw)) found.add(raw);
    else if (names.has(raw)) found.add(names.get(raw)!);
  }
  return [...found];
}

export function createThread(wp: Workplace, spec: { title: string; text: string; by: string; charterIds?: string[]; mentions?: string[]; at?: string; headline?: string }): { thread: RoomThread; message: RoomMessage } {
  if (!spec.title.trim()) throw new BadRequest('A thread needs a title.');
  const at = spec.at ?? now();
  const thread: RoomThread = {
    id: newId('th'), title: spec.title.trim(), charterIds: spec.charterIds ?? [], createdBy: spec.by, createdAt: at,
    state: 'open', headline: oneLine(spec.headline?.trim() || spec.title).summary, lastAt: at, messageCount: 0, participants: [], escalations: [],
  };
  wp.db.prepare('insert into threads (id, title, charter_ids, created_by, created_at, state, last_at, json) values (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(thread.id, thread.title, JSON.stringify(thread.charterIds), thread.createdBy, at, 'open', at, JSON.stringify(thread));
  const message = post(wp, thread.id, { text: spec.text, by: spec.by, mentions: spec.mentions, at });
  return { thread: getThread(wp, thread.id)!, message };
}

export function post(wp: Workplace, threadId: string, given: { text: string; by: string; mentions?: string[]; at?: string; headline?: string; kind?: RoomMessage['kind']; about?: string; itemId?: string }): RoomMessage {
  const spec = { ...given, by: authorId(wp, given.by) };
  const thread = getThread(wp, threadId);
  if (!thread) throw new BadRequest(`No thread ${threadId}`);
  if (!spec.text.trim()) throw new BadRequest('An empty message says nothing.');
  const at = spec.at ?? now();
  const mentions = [...new Set([...(spec.mentions ?? []), ...mentionsIn(wp, spec.text)])];
  // Messages stay small (HLD D22): an employee's long post keeps its start, the rest goes to details.
  // The owner's words and the Workplace's own lines are never cut.
  const body = spec.by === 'owner' || spec.by === 'workplace' ? { text: spec.text.trim() } : short(spec.text);
  const message: RoomMessage = {
    id: newId('msg'), threadId, at, by: spec.by, owner: spec.by === 'owner', text: body.text, mentions,
    ...(body.details ? { details: body.details } : {}),
    ...(spec.kind ? { kind: spec.kind } : {}), ...(spec.about ? { about: spec.about } : {}), ...(spec.itemId ? { itemId: spec.itemId } : {}),
  };
  wp.db.prepare('insert into messages (id, thread_id, at, by, text, mentions, json) values (?, ?, ?, ?, ?, ?, ?)')
    .run(message.id, threadId, at, message.by, message.text, JSON.stringify(mentions), JSON.stringify(message));
  const participants = new Set(thread.participants);
  if (spec.by !== 'owner' && spec.by !== 'workplace') participants.add(spec.by);
  for (const m of mentions) participants.add(m);
  const updated: RoomThread = { ...thread, lastAt: at, messageCount: thread.messageCount + 1, participants: [...participants], ...(spec.headline?.trim() ? { headline: oneLine(spec.headline).summary } : {}) };
  saveThread(wp, updated);
  wp.emit({ type: 'room.message', message, thread: updated });
  return message;
}

/** The Chief of Staff closes a thread with a summary; follow-ups become assignments. */
export function resolve(wp: Workplace, threadId: string, spec: { summary: string; by: string; followUps?: { employeeId: string; title: string; body: string }[] }): { thread: RoomThread; followUps: string[] } {
  const thread = getThread(wp, threadId);
  if (!thread) throw new BadRequest(`No thread ${threadId}`);
  if (isChannel(thread)) throw new BadRequest(`"${thread.title}" is a standing channel (${thread.epicId ? 'the epic\'s own thread' : 'a room channel'}); it cannot be resolved. Post a summary in it instead.`);
  if (!spec.summary.trim()) throw new BadRequest('A resolution needs a summary.');
  const created: string[] = [];
  for (const f of spec.followUps ?? []) {
    const item = work.create(wp, { kind: 'assignment', title: f.title, body: `${f.body}\n\nFrom the Team Room thread "${thread.title}" (${thread.id}).`, employeeId: f.employeeId, by: spec.by });
    created.push(item.id);
  }
  post(wp, threadId, { text: `Resolved: ${spec.summary.trim()}${created.length ? `\nFollow-ups: ${created.join(', ')}` : ''}`, by: spec.by });
  const updated: RoomThread = { ...getThread(wp, threadId)!, state: 'resolved', summary: spec.summary.trim(), headline: oneLine(spec.summary).summary };
  saveThread(wp, updated);
  return { thread: updated, followUps: created };
}

/**
 * Escalate a thread: only for decisions above the Chief of Staff's own authority. Owner request of
 * 29 Sep: this goes to the COO first, as a `coo` inbox item (HLD "the COO bridge"), and only
 * reaches the owner's Inbox directly if the COO has been offline for more than 30 minutes — the
 * fallback `routeEscalation` itself applies. The COO then answers it or forwards it to the owner
 * with a recommendation.
 */
export function escalate(wp: Workplace, threadId: string, spec: { title: string; body: string; by: string; options?: string[]; recommendation?: string }) {
  const thread = getThread(wp, threadId);
  if (!thread) throw new BadRequest(`No thread ${threadId}`);
  const options = spec.options?.length ? spec.options.map(o => ({ id: o.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label: o })) : undefined;
  const routed = coo.routeEscalation(wp, {
    title: spec.title, body: `${spec.body}\n\nFrom the Team Room thread "${thread.title}".`, by: spec.by, threadId,
    ...(options ? { options } : {}), ...(spec.recommendation ? { recommendation: spec.recommendation } : {}), context: { threadId, charterIds: thread.charterIds },
    links: [{ label: 'Team Room thread', href: `#/room/${threadId}` }],
  });
  const escalationId = routed.ownerInboxId ?? routed.item.id;
  saveThread(wp, { ...thread, escalations: [...thread.escalations, escalationId] });
  post(wp, threadId, {
    text: routed.ownerInboxId
      ? `Escalated to the owner (the COO is offline): "${spec.title}" (${routed.ownerInboxId}).`
      : `Escalated to the COO: "${spec.title}" (${routed.item.id}).`,
    by: 'workplace',
  });
  return routed.ownerInboxId ? inbox.get(wp, routed.ownerInboxId)! : routed.item;
}

/** The default channel every employee and the owner share (owner request, 29 Sep), beside the topic threads. */
export const GENERAL_THREAD_ID = 'th_general';

export function ensureGeneral(wp: Workplace): RoomThread {
  const existing = getThread(wp, GENERAL_THREAD_ID);
  if (existing) return existing;
  const at = now();
  const thread: RoomThread = {
    id: GENERAL_THREAD_ID, title: 'General', charterIds: [], createdBy: 'workplace', createdAt: at,
    state: 'open', headline: 'Where everyone talks.', lastAt: at, messageCount: 0, participants: [], escalations: [],
  };
  wp.db.prepare('insert into threads (id, title, charter_ids, created_by, created_at, state, last_at, json) values (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(thread.id, thread.title, JSON.stringify(thread.charterIds), thread.createdBy, at, 'open', at, JSON.stringify(thread));
  return thread;
}

/** Open threads that concern an employee: it posted, was mentioned, or holds a charter the thread touches. */
export function threadsFor(wp: Workplace, employeeId: string): RoomThread[] {
  const emp = wp.org.employees.find(e => e.id === employeeId);
  return listThreads(wp, 'open').filter(t =>
    t.participants.includes(employeeId) || t.createdBy === employeeId || t.charterIds.some(c => emp?.charterIds.includes(c)));
}

/** The Team Room context layer: an employee's open threads with their last three messages. */
export function contextFor(wp: Workplace, employeeId: string): string {
  const threads = threadsFor(wp, employeeId);
  if (threads.length === 0) return '';
  const lines = ['Open threads that concern you (post with room_post; never edit outside your charter to settle these):'];
  for (const t of threads) {
    lines.push(`\n### ${t.title} (${t.id}; charters: ${t.charterIds.join(', ') || 'none'})`);
    for (const m of messages(wp, t.id).slice(-3)) lines.push(`- ${m.owner ? 'OWNER' : m.by} (${m.at.slice(5, 16).replace('T', ' ')}): ${m.text.slice(0, 280).replace(/\s+/g, ' ')}`);
  }
  return lines.join('\n');
}

/**
 * Threads with messages from people newer than the moderator's last look. The Workplace's own lines
 * (update, stand-up, release) are not a conversation and never wake the moderator (QA 2 Oct: Asha was
 * handed the P0 epic's thread for every automated line, and resolved it to make them stop).
 */
export function needsModeration(wp: Workplace, moderatorId: string): RoomThread[] {
  const last = (wp.db.prepare('select value from settings where key = ?').get(`room-seen:${moderatorId}`) as { value: string } | undefined)?.value ?? '';
  return listThreads(wp, 'open').filter(t => {
    if (t.lastAt <= last) return false;
    const spoken = messages(wp, t.id).filter(m => !isAutomated(m));
    const newest = spoken.at(-1);
    return !!newest && newest.at > last && newest.by !== moderatorId;
  });
}

/** A line the Workplace posts by itself (a named update, a stand-up, a release post). */
export const isAutomated = (m: RoomMessage): boolean => m.by === 'workplace' && !!m.kind && m.kind !== 'message';

/**
 * Standing channels (LLD §19.4, QA 2 Oct): an epic's own thread, an area's channel, General and
 * Releases. Their update lines keep coming for as long as the work exists, so they are never
 * resolved; a topic thread is.
 */
export function isChannel(t: Pick<RoomThread, 'id' | 'epicId'>): boolean {
  return !!t.epicId || t.id.startsWith('th_epic_') || t.id.startsWith('th_area_') || t.id === GENERAL_THREAD_ID || t.id === RELEASES_THREAD_ID;
}

/** Standing channels resolved before the rule are reopened (boot migration; idempotent). */
export function reopenChannels(wp: Workplace): string[] {
  const reopened: string[] = [];
  for (const t of storedThreads(wp, 'resolved')) {
    if (!isChannel(t)) continue;
    const { summary: _summary, ...rest } = t;
    saveThread(wp, { ...rest, state: 'open' });
    reopened.push(t.id);
  }
  return reopened;
}

export function markSeen(wp: Workplace, moderatorId: string, at = now()): void {
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`room-seen:${moderatorId}`, at);
}

function saveThread(wp: Workplace, t: RoomThread): void {
  wp.db.prepare('update threads set title = ?, state = ?, last_at = ?, room_id = ?, json = ? where id = ?').run(t.title, t.state, t.lastAt, t.roomId ?? null, JSON.stringify(t), t.id);
  wp.emit({ type: 'room.thread', thread: t });
}

/* ---------- v2: rooms (LLD §19.1) — General, one per active area, Releases ---------- */

export const RELEASES_THREAD_ID = 'th_releases';
export const areaThreadId = (areaId: string): string => `th_area_${areaId}`;
export const epicThreadId = (epicId: string): string => `th_epic_${epicId}`;

/** A fixed-id thread, made once; an existing one is moved to `roomId` and retitled if asked. */
export function ensureThread(wp: Workplace, spec: { id: string; title: string; roomId: string; epicId?: string; headline?: string }): RoomThread {
  const existing = getThread(wp, spec.id);
  if (existing) {
    if (existing.roomId !== spec.roomId || existing.title !== spec.title) {
      const moved: RoomThread = { ...existing, roomId: spec.roomId, title: spec.title };
      saveThread(wp, moved);
      return moved;
    }
    return existing;
  }
  const at = now();
  const thread: RoomThread = {
    id: spec.id, title: spec.title, charterIds: [], createdBy: 'workplace', createdAt: at, state: 'open',
    headline: oneLine(spec.headline ?? spec.title).summary, lastAt: at, messageCount: 0, participants: [], escalations: [],
    roomId: spec.roomId, ...(spec.epicId ? { epicId: spec.epicId } : {}),
  };
  wp.db.prepare('insert into threads (id, title, charter_ids, created_by, created_at, state, last_at, room_id, json) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(thread.id, thread.title, '[]', 'workplace', at, 'open', at, thread.roomId ?? null, JSON.stringify(thread));
  wp.emit({ type: 'room.thread', thread });
  return thread;
}

export function ensureReleases(wp: Workplace): RoomThread {
  return ensureThread(wp, { id: RELEASES_THREAD_ID, title: 'Releases', roomId: 'releases', headline: 'Every release and what shipped in it.' });
}

/** The epic's thread in its area room; undefined while the epic has no area. */
export function epicThread(wp: Workplace, epic: WorkItem): RoomThread | undefined {
  if (!epic.areaId) return undefined;
  return ensureThread(wp, { id: epicThreadId(epic.id), title: epic.title, roomId: `area:${epic.areaId}`, epicId: epic.id });
}

/** A line the Workplace itself posts (a named update, a stand-up, a release): authored by 'workplace'. */
export function postLine(wp: Workplace, threadId: string, spec: { text: string; kind: NonNullable<RoomMessage['kind']>; itemId?: string; about?: string }): RoomMessage {
  return post(wp, threadId, { text: spec.text, by: 'workplace', kind: spec.kind, ...(spec.itemId ? { itemId: spec.itemId } : {}), ...(spec.about ? { about: spec.about } : {}) });
}

const roomOf = (t: RoomThread): string => t.roomId ?? 'general';

function activeAreas(wp: Workplace): Area[] {
  return rowsJson<Area>(wp.db.prepare("select json from areas where state = 'active' order by rank, created_at").all());
}

/** General first, then each active area's room in rank order, then Releases. */
export function listRooms(wp: Workplace): Room[] {
  const threads = listThreads(wp);
  const make = (id: string, kind: Room['kind'], title: string, headline: string, areaId?: string): Room => {
    const mine = threads.filter(t => roomOf(t) === id);
    return {
      id, kind, title, ...(areaId ? { areaId } : {}), headline,
      lastAt: mine.reduce((m, t) => (t.lastAt > m ? t.lastAt : m), ''),
      threadIds: mine.map(t => t.id),
    };
  };
  return [
    make('general', 'general', 'General', 'Where everyone talks.'),
    ...activeAreas(wp).map(a => make(`area:${a.id}`, 'area', a.title, a.description ?? `Everything in ${a.title}.`, a.id)),
    make('releases', 'releases', 'Releases', 'Every release and what shipped in it.'),
  ];
}

export function roomDetail(wp: Workplace, id: string): RoomDetail {
  const room = listRooms(wp).find(r => r.id === id);
  if (!room) throw new NotFound(`No room ${id}`);
  return { room, threads: listThreads(wp).filter(t => roomOf(t) === id) };
}

/* ---------- the seed: the real cross-team threads from the 27 Sep plans ---------- */

export function seedThreads(wp: Workplace): RoomThread[] {
  if (wp.db.prepare('select 1 from settings where key = ?').get('room-seeded')) return [];
  const greeting = work.list(wp, { kind: 'feature' }).find(f => f.title.startsWith('Daily greeting'));
  const plans = greeting ? work.list(wp, { kind: 'assignment', featureId: greeting.id }).filter(a => a.plan) : [];
  const has = (id: string, re: RegExp) => plans.some(a => a.employeeId === id && re.test(a.plan ?? ''));
  const made: RoomThread[] = [];
  const at = '2026-09-27T17:00:00.000Z';

  if (has('kabir', /not a Memory feature|misrout/i)) {
    made.push(createThread(wp, { at, by: 'kabir', charterIds: ['memory', 'character', 'conversation', 'chief-of-staff'],
      title: 'Daily greeting: the memory piece is misrouted',
      text: 'My assignment for the greeting reached memory on a keyword match ("memory" in "the weather facts she already has"), not a charter decision. Every acceptance criterion touches app.py\'s proactive block, context/weather.py and the Speaker, none of which memory owns. @asha please re-route it to @dev (character/conversation); I will build a delegated piece only if Dev wants one.' }).thread);
  }
  if (has('mira', /greeting\.py|Dev\'s explicit sign-off|sign-off/i)) {
    made.push(createThread(wp, { at, by: 'mira', charterIds: ['experts', 'conversation', 'character'],
      title: 'Daily greeting: greeting.py wiring and the spoken sentence need conversation/character sign-off',
      text: 'I am building the decision engine as a pure module, services/agent-svc/greeting.py (unowned until now; I claim it for experts). The one hunk in app.py\'s _presence_tick and the wording of the spoken sentence are conversation/character territory: @dev, please review both before merge, in addition to QA. The mute signal is bool(_listener and _listener.armed); no new plumbing.' }).thread);
  }
  if (has('rohan', /screen-share|AC8/i) || has('mira', /Screen-share detector genuinely does not exist/i)) {
    made.push(createThread(wp, { at, by: 'rohan', charterIds: ['character', 'experts', 'desktop-mac', 'product-and-business'],
      title: 'Daily greeting AC8: nobody owns a screen-share / meeting detector',
      text: 'AC8 ("never during screen share") is blocked: no detector exists anywhere (character_spec.py:181-183, the overnight ledger). The definition calls auto-hide on screen share the one non-negotiable, so this is bigger than the greeting. @asha: which charter owns the sensor layer? It needs a real assignment, not a footnote in three plans. @mira @dev' }).thread);
  }
  if (has('rohan', /AC9|one sentence, no reopening|Speaker/i)) {
    made.push(createThread(wp, { at, by: 'rohan', charterIds: ['conversation', 'character', 'desktop-mac'],
      title: 'Daily greeting AC9: a Speaker interface for "one sentence, no reopening"',
      text: 'The visual side can reuse the existing greet reaction (driver.js via _bus.publish). The spoken side has no primitive for "say one sentence, do not mark awaiting-reply, do not reopen": @dev, I will propose an interface and you own the implementation. Also flagging plainly: the desktop-mac ticket needs no Electron or packaging change at all; everything is in files character/conversation own.' }).thread);
  }
  if (plans.some(a => /app\.py.*(not in Experts|not in .*owned|outside (my|desktop-mac)'?s? ownership)/i.test(a.plan ?? ''))) {
    made.push(createThread(wp, { at, by: 'asha', charterIds: ['experts', 'conversation', 'character', 'chief-of-staff'],
      title: 'Who owns services/agent-svc/app.py?',
      text: 'Three plans stopped at the same line: the map says app.py is experts (consulted: conversation, desktop-mac), the experts charter says the Speaker\'s words and the delivery gate are conversation\'s, and the proactive/character block is character\'s. One file, three owners. Proposal: keep experts as the primary for app.py, and record in the map that _presence_tick/_PROACTIVE/pet_proactive are character\'s and the Speaker path is conversation\'s, as path-level entries once the file is split by the repo split. Objections here by tomorrow; then I write it into the charters. @mira @dev @rohan' }).thread);
  }
  // No plans yet (a fresh workplace): try again on the next boot rather than marking it done.
  if (made.length) wp.db.prepare('insert into settings (key, value) values (?, ?)').run('room-seeded', now());
  return made;
}

export function handoffMentions(wp: Workplace, employeeId: string): string {
  return readEmployeeFile(wp.org, employeeId, 'handoff.md').slice(0, 200);
}
