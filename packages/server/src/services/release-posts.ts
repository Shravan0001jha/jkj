import type { CreateReleasePostRequest, ReleasePost, ReleasePostItem, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as room from './room.js';
import * as areas from './areas.js';
import * as work from './work.js';
import { newId, now, rowJson, rowsJson } from './store.js';
import { epicOf, levelOf, rawGet } from './v2-map.js';
import { BadRequest } from '../util/errors.js';

/**
 * The Releases room (HLD D22): each release is one post listing every story and fix that shipped
 * in it, grouped by area. Posted when a release run finishes, or by hand; an item ships once.
 */

export function list(wp: Workplace): ReleasePost[] {
  return rowsJson<ReleasePost>(wp.db.prepare('select json from release_posts order by at desc, rowid desc').all());
}

export function get(wp: Workplace, id: string): ReleasePost | undefined {
  return rowJson<ReleasePost>(wp.db.prepare('select json from release_posts where id = ?').get(id));
}

/** Done stories (bugs read as fixes) not yet in any post. */
function shippedSinceLast(wp: Workplace): WorkItem[] {
  return rowsJson<WorkItem>(wp.db.prepare("select json from work where status = 'done' order by updated_at").all())
    .filter(w => levelOf(w) === 'story' && (w.resolution ?? 'done') === 'done' && !w.releasedIn);
}

const isFix = (w: WorkItem): boolean => w.kind === 'bug' || /^fix\b/i.test(w.title);

export function create(wp: Workplace, req: CreateReleasePostRequest & { releaseId?: string }, by: string): ReleasePost {
  const version = req.version?.trim();
  if (!version) throw new BadRequest('A release post needs a version.');
  const chosen = req.itemIds?.length
    ? req.itemIds.map(id => { const w = rawGet(wp, id); if (!w) throw new BadRequest(`No item ${id}`); return w; })
    : shippedSinceLast(wp);

  const allAreas = areas.list(wp);
  const groups = new Map<string, { areaId: string | null; areaTitle: string; items: ReleasePostItem[] }>();
  for (const w of chosen) {
    const areaId = epicOf(wp, w)?.areaId ?? null;
    const key = areaId ?? '';
    if (!groups.has(key)) groups.set(key, { areaId, areaTitle: allAreas.find(a => a.id === areaId)?.title ?? 'Other', items: [] });
    groups.get(key)!.items.push({ id: w.id, title: w.title, level: levelOf(w), kind: isFix(w) ? 'fix' : 'story' });
  }
  const rank = (areaId: string | null): number => (areaId ? allAreas.find(a => a.id === areaId)?.rank ?? 999 : 1000);
  const ordered = [...groups.values()].sort((a, b) => rank(a.areaId) - rank(b.areaId));

  const title = req.title?.trim() || `${req.shippable ? `${req.shippable} ` : ''}${version}`;
  const lines = [`Released ${title}`];
  for (const g of ordered) {
    lines.push(`${g.areaTitle}:`);
    for (const i of g.items) lines.push(`- ${i.kind === 'fix' ? 'Fix' : 'Story'}: ${i.title}`);
  }
  if (!ordered.length) lines.push('No stories or fixes recorded for this release.');
  const thread = room.ensureReleases(wp);
  const post: ReleasePost = {
    id: newId('rp'), at: now(), title, version, ...(req.shippable ? { shippable: req.shippable } : {}), ...(req.releaseId ? { releaseId: req.releaseId } : {}),
    by, groups: ordered, text: lines.join('\n'), threadId: thread.id,
  };
  wp.db.prepare('insert into release_posts (id, at, version, json) values (?, ?, ?, ?)').run(post.id, post.at, version, JSON.stringify(post));
  for (const w of chosen) work.saveQuiet(wp, { ...w, releasedIn: post.id });
  room.postLine(wp, thread.id, { text: post.text, kind: 'release' });
  wp.emit({ type: 'release.post', post });
  return post;
}
