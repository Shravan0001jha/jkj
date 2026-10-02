// Workplace v2 for the mock (LLD §19.8): starts from the JSON captured from the live Workplace on
// 2 Oct (fixtures/live-*.json, read-only GETs), so the simulator shows the same plan the owner's
// phone does, then adds what the live data has none of yet so every screen has something to show:
// points on the P0 stories, an epic owner, one story assigned to the owner, a release post, and a
// reply thread with a recommended option on the open Inbox decision. Those additions are marked
// `mock` in their ids. Test and preview data only; never shipped in the app.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const live = (name) => JSON.parse(readFileSync(join(dir, `live-${name}.json`), 'utf8'));

export const STATUSES = ['backlog', 'ready', 'in-progress', 'in-review', 'done', 'blocked'];
const NOW = '2026-10-02T06:10:00.000Z';
const P0 = 'ft_mummakwyuew19';
const OPEN_DECISION = 'in_muqel76q1h1i1';

export function v2State() {
  const items = live('items');
  const byId = Object.fromEntries(items.map(i => [i.id, i]));
  // Points and owners the live data does not have yet (server gap: none set after migration).
  const pts = { as_muqecr89jhjst: 5, as_muqecr8avlkkr: 3, as_muqed3ed0cpmg: 3 };
  for (const [id, p] of Object.entries(pts)) if (byId[id]) byId[id].points = p;
  for (const e of items.filter(i => i.level === 'epic')) e.ownerId = 'asha';
  if (byId.as_muqed3ed0cpmg) byId.as_muqed3ed0cpmg.reviewerId = 'nikhil';
  const mine = {
    id: 'as_mock_owner_test', level: 'story', title: 'Test the music fix on your Mac with music playing',
    body: 'Play a song, say "Iris pause", then talk over it at volume 0. Pass when the music pauses (not the system volume) and Iris hears you.',
    status: 'ready', statusSince: NOW, parentId: P0, epicId: P0, areaId: byId[P0]?.areaId, assigneeId: 'owner', reviewerId: 'nikhil',
    points: 1, rank: 9, acceptance: ['Pause acts on the player', 'Iris hears you at volume 0'],
    legacy: { kind: 'assignment', state: 'proposed', featureId: P0 }, createdAt: NOW, updatedAt: NOW,
  };
  items.push(mine);

  const details = {};
  for (const name of ['item-epic', 'item-story']) { const d = live(name); details[d.item.id] = d; }
  const comments = {};
  const activity = {};
  for (const d of Object.values(details)) { comments[d.item.id] = d.comments; activity[d.item.id] = d.activity; }
  comments[P0] = [
    { id: 'com_mock_1', itemId: P0, at: '2026-10-02T05:20:00.000Z', by: 'asha', text: 'Dev is blocked on the session classifier; Mira carries AC1, AC2 and AC5 meanwhile.', mentions: [] },
    { id: 'com_mock_2', itemId: P0, at: '2026-10-02T05:25:00.000Z', by: 'owner', text: '@coo can you unblock Dev today?', mentions: ['coo'] },
  ];

  const inboxThread = live('inbox-thread');
  inboxThread.item.urgency = 'high';
  inboxThread.item.options[0].recommended = true;
  inboxThread.messages = [
    { id: 'im_mock_1', inboxId: OPEN_DECISION, at: '2026-10-02T05:30:00.000Z', by: 'owner', text: 'Why not add the remap kind now?' },
    { id: 'im_mock_2', inboxId: OPEN_DECISION, at: '2026-10-02T05:31:00.000Z', by: 'asha', text: 'It is a server change and the P0 has priority. The 2-entry edit unblocks routing today; the kind can follow.' },
  ];
  inboxThread.item.messageCount = 2;
  inboxThread.item.lastMessageAt = '2026-10-02T05:31:00.000Z';

  const releasePosts = [{
    id: 'rp_mock_0215', at: '2026-10-01T12:00:00.000Z', title: 'Iris 0.2.15 (Mac arm64)', version: '0.2.15', shippable: 'desktop-mac', by: 'nikhil',
    groups: [
      { areaId: byId[P0]?.areaId ?? null, areaTitle: 'Voice & audio', items: [{ id: 'as_muqed3ed0cpmg', title: 'Music controls act on the player, not the system volume', level: 'story', kind: 'story' }] },
      { areaId: 'ar_muqhzr7lq5qxd', areaTitle: 'Mac & mobile apps', items: [
        { id: 'as_muk0srs9kx5vs', title: 'Phone actions on the Mac: no false Done', level: 'story', kind: 'story' },
        { id: 'as_muk0srsaw3n4j', title: 'A busy Mac shows as online', level: 'story', kind: 'fix' },
      ] },
    ],
    text: 'Iris 0.2.15 shipped: 3 changes.', threadId: 'th_releases',
  }];

  return {
    items, areas: live('areas'), focus: live('focus'), details, comments, activity,
    updates: live('updates'), inboxThread, releasePosts,
    rooms: live('rooms'), roomDetails: { 'area:ar_muqhzr5khct7v': live('room-area'), general: live('room-general'), releases: live('room-releases') },
    epicThread: live('room-thread-epic'), seq: 100,   // above the seeded *_mock_1, *_mock_2 ids
  };
}

const isOpen = (i) => i.status !== 'done';
const byRank = (a, b) => a.rank - b.rank;

function progress(s, epic) {
  const stories = s.items.filter(i => i.level === 'story' && i.parentId === epic.id && i.resolution !== 'wont-do' && i.resolution !== 'duplicate');
  const done = stories.filter(i => i.status === 'done');
  const pt = (xs) => xs.reduce((n, i) => n + (i.points ?? 0), 0);
  const pointsTotal = pt(stories), pointsDone = pt(done);
  const pct = pointsTotal > 0 ? Math.round(100 * pointsDone / pointsTotal) : stories.length ? Math.round(100 * done.length / stories.length) : 0;
  return { pointsDone, pointsTotal, storiesDone: done.length, storiesTotal: stories.length, pct };
}

function card(s, epic) {
  const kids = s.items.filter(i => i.parentId === epic.id).sort(byRank);
  const flags = [];
  for (const k of kids) {
    if (k.status === 'blocked' && k.blocked) flags.push({ kind: 'blocked', itemId: k.id, title: k.title, reason: k.blocked.reason, waitingOn: k.blocked.waitingOn, since: k.blocked.since });
    else if (k.stall) flags.push({ kind: 'stalled', itemId: k.id, title: k.title, reason: k.stall.rule === 'unreviewed' ? `In review for ${k.stall.minutes} min, untouched` : `No activity for ${k.stall.minutes} min`, since: k.stall.since });
  }
  const nextItem = kids.find(isOpen);
  const c = { epic, progress: progress(s, epic), flags, inFocus: s.focus.epicIds.includes(epic.id) };
  if (nextItem) c.next = { id: nextItem.id, title: nextItem.title };
  return c;
}

export function plan(s, board = false) {
  const epics = s.items.filter(i => i.level === 'epic' && isOpen(i)).sort(byRank);
  const work = s.items.filter(i => i.level !== 'epic');
  const counts = Object.fromEntries(STATUSES.map(st => [st, work.filter(i => i.status === st).length]));
  const out = {
    areas: s.areas.filter(a => a.state === 'active').sort(byRank).map(area => ({ area, epics: epics.filter(e => e.areaId === area.id).map(e => card(s, e)) })),
    unfiled: epics.filter(e => !e.areaId).map(e => card(s, e)),
    mine: work.filter(i => i.assigneeId === 'owner' && isOpen(i)).sort(byRank),
    focus: s.focus, counts,
  };
  if (board) out.board = Object.fromEntries(STATUSES.map(st => [st, work.filter(i => i.status === st).sort(byRank)]));
  return out;
}

export function detail(s, id) {
  const item = s.items.find(i => i.id === id);
  if (!item) return null;
  const parent = item.parentId ? s.items.find(i => i.id === item.parentId) : undefined;
  const epicId = item.level === 'epic' ? item.id : item.epicId ?? item.parentId;
  const epic = epicId ? s.items.find(i => i.id === epicId) : undefined;
  const area = s.areas.find(a => a.id === (epic?.areaId ?? item.areaId));
  const d = { item, children: s.items.filter(i => i.parentId === id).sort(byRank), comments: s.comments[id] ?? [], activity: s.activity[id] ?? [] };
  if (parent) d.parent = parent;
  if (epic && epic.id !== id) d.epic = epic;
  if (area) d.area = area;
  if (item.level === 'epic') { d.progress = progress(s, item); d.threadId = `th_epic_${id}`; }
  return d;
}

/** POST /api/items/:id — the §19.3 rules the app's error paths need, not the whole machine. */
export function update(s, id, body, by = 'owner') {
  const item = s.items.find(i => i.id === id);
  if (!item) return { status: 404, body: { error: 'no such item' } };
  const now = new Date().toISOString();
  const rec = (kind, text, from, to) => (s.activity[id] ??= []).push({ id: `act_mock_${s.seq++}`, at: now, itemId: id, by, kind, ...(from !== undefined ? { from: String(from) } : {}), ...(to !== undefined ? { to: String(to) } : {}), text });
  if (body.status === 'in-review' && !(body.reviewerId ?? item.reviewerId)) return { status: 400, body: { error: 'A reviewer is required before an item can enter review.' } };
  if (body.status === 'blocked' && (!body.blockedReason || !body.waitingOn)) return { status: 400, body: { error: 'Blocked needs a reason and who it is waiting on.' } };
  if (body.points !== undefined && body.points !== null && ![1, 2, 3, 5, 8].includes(body.points)) return { status: 400, body: { error: 'Points are 1, 2, 3, 5 or 8.' } };
  for (const k of ['title', 'body', 'assigneeId', 'reviewerId', 'ownerId', 'points', 'rank', 'areaId', 'targetDate', 'acceptance']) {
    if (body[k] === undefined) continue;
    const before = item[k];
    if (body[k] === null) delete item[k]; else item[k] = body[k];
    rec(k === 'assigneeId' ? 'assigned' : k === 'reviewerId' ? 'reviewer' : k === 'points' ? 'points' : 'field', `${k} changed`, before ?? '', body[k] ?? '');
  }
  if (body.status && body.status !== item.status) {
    const from = item.status;
    item.status = body.status; item.statusSince = now;
    if (body.status === 'blocked') item.blocked = { reason: body.blockedReason, waitingOn: body.waitingOn, since: now }; else delete item.blocked;
    if (body.resolution) item.resolution = body.resolution;
    rec('status', `${from} → ${body.status}${body.note ? `: ${body.note}` : ''}`, from, body.status);
  }
  item.updatedAt = now;
  return { status: 200, body: detail(s, id), item };
}

export function create(s, body) {
  if (!body?.title || !body?.level) return { status: 400, body: { error: 'level and title required' } };
  const now = new Date().toISOString();
  const id = `${body.level === 'epic' ? 'ft' : 'as'}_mock_${s.seq++}`;
  const parent = body.parentId ? s.items.find(i => i.id === body.parentId) : undefined;
  const epicId = body.level === 'epic' ? id : parent?.level === 'epic' ? parent.id : parent?.epicId;
  const item = {
    id, level: body.level, title: body.title, body: body.body ?? '', status: body.status ?? 'ready', statusSince: now,
    ...(body.parentId ? { parentId: body.parentId } : {}), epicId,
    ...(body.level === 'epic' && body.areaId ? { areaId: body.areaId } : {}),
    ...(body.assigneeId ? { assigneeId: body.assigneeId } : {}), ...(body.ownerId ? { ownerId: body.ownerId } : {}),
    ...(body.points ? { points: body.points } : {}), rank: body.rank ?? (Math.max(0, ...s.items.map(i => i.rank)) + 1),
    acceptance: body.acceptance ?? [], legacy: { kind: body.level === 'epic' ? 'feature' : 'assignment', state: body.level === 'epic' ? 'stated' : 'proposed' },
    createdAt: now, updatedAt: now,
  };
  s.items.push(item);
  s.activity[id] = [{ id: `act_mock_${s.seq++}`, at: now, itemId: id, by: 'owner', kind: 'created', text: 'created' }];
  return { status: 201, body: detail(s, id), item };
}

/** Sample v2 socket events for the fixtures (LLD §19.8 shapes, built from the live data). */
export function sampleV2Events() {
  const s = v2State();
  const story = s.items.find(i => i.id === 'as_muqed3ed0cpmg');
  return [
    { type: 'item.updated', item: story },
    { type: 'item.comment', comment: s.comments[P0][1] },
    { type: 'activity.recorded', activity: s.activity.as_muqecr89jhjst.at(-1) },
    { type: 'update.posted', update: s.updates[0] },
    { type: 'area.updated', area: s.areas[0] },
    { type: 'inbox.message', message: s.inboxThread.messages[1] },
    { type: 'release.post', post: s.releasePosts[0] },
  ];
}
