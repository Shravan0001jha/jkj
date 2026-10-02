import type { Area, CreateAreaRequest, UpdateAreaRequest } from '@jkj/shared';
import { MAX_ACTIVE_AREAS } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as room from './room.js';
import { newId, now, rowJson, rowsJson } from './store.js';
import { BadRequest, Conflict, NotFound } from '../util/errors.js';

/**
 * Areas (HLD D18): long-lived product areas the owner creates, each with its own room; at most
 * five active at once, so the Plan stays a handful of things.
 */

export function list(wp: Workplace): Area[] {
  return rowsJson<Area>(wp.db.prepare("select json from areas order by case state when 'active' then 0 else 1 end, rank, created_at").all());
}

export function get(wp: Workplace, id: string): Area | undefined {
  return rowJson<Area>(wp.db.prepare('select json from areas where id = ?').get(id));
}

export function require$(wp: Workplace, id: string): Area {
  const a = get(wp, id);
  if (!a) throw new NotFound(`No area ${id}`);
  return a;
}

const activeCount = (wp: Workplace): number => (wp.db.prepare("select count(*) as n from areas where state = 'active'").get() as { n: number }).n;

function refuseSixth(wp: Workplace): void {
  if (activeCount(wp) >= MAX_ACTIVE_AREAS) throw new Conflict(`There are already ${MAX_ACTIVE_AREAS} active areas; archive one first.`);
}

export function create(wp: Workplace, req: CreateAreaRequest, by: string): Area {
  const title = req.title?.trim();
  if (!title) throw new BadRequest('An area needs a title.');
  refuseSixth(wp);
  const at = now();
  const id = newId('ar');
  const maxRank = (wp.db.prepare('select max(rank) as r from areas').get() as { r: number | null }).r ?? 0;
  const area: Area = {
    id, title, ...(req.description?.trim() ? { description: req.description.trim() } : {}), state: 'active', rank: maxRank + 1,
    ownerId: req.ownerId ?? 'owner', roomId: `area:${id}`, threadId: room.areaThreadId(id), createdAt: at, updatedAt: at,
  };
  wp.db.prepare('insert into areas (id, title, state, rank, created_at, json) values (?, ?, ?, ?, ?, ?)').run(id, title, 'active', area.rank, at, JSON.stringify(area));
  room.ensureThread(wp, { id: area.threadId, title, roomId: area.roomId, headline: `Everything in ${title}.` });
  wp.emit({ type: 'area.updated', area });
  void by;
  return area;
}

export function update(wp: Workplace, id: string, patch: UpdateAreaRequest): Area {
  const area = require$(wp, id);
  if (patch.state && patch.state !== 'active' && patch.state !== 'archived') throw new BadRequest('state must be active or archived');
  if (patch.state === 'active' && area.state !== 'active') refuseSixth(wp);
  if (patch.title !== undefined && !patch.title.trim()) throw new BadRequest('An area needs a title.');
  const next: Area = {
    ...area,
    ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
    ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
    ...(patch.state ? { state: patch.state } : {}),
    ...(typeof patch.rank === 'number' && Number.isFinite(patch.rank) ? { rank: patch.rank } : {}),
    updatedAt: now(),
  };
  wp.db.prepare('update areas set title = ?, state = ?, rank = ?, json = ? where id = ?').run(next.title, next.state, next.rank, JSON.stringify(next), id);
  if (next.title !== area.title) room.ensureThread(wp, { id: next.threadId, title: next.title, roomId: next.roomId });
  wp.emit({ type: 'area.updated', area: next });
  return next;
}
