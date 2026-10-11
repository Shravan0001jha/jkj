import type { Item, StatusAnswer, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as items from './items.js';
import { stallReason } from './items.js';
import * as areas from './areas.js';
import { rowsJson } from './store.js';
import { levelOf, nameOf, STATUS_LABEL } from './v2-map.js';

/**
 * On-demand status (HLD D24): "what's the status of X?" answered from the plan, deterministically,
 * with links — by item title, by person, or by area. No model in the loop, so it cannot invent.
 */

const STOP = new Set(['what', 'whats', 's', 'is', 'are', 'the', 'status', 'of', 'on', 'doing', 'how', 'a', 'an', 'with', 'about', 'where', 'we', 'and', 'for', 'to', 'it', 'up']);
const words = (t: string): string[] => t.toLowerCase().replace(/[^a-z0-9&]+/g, ' ').split(' ').filter(w => w && w !== '&');
const normal = (t: string): string => words(t).join(' ');

const NOUN = { epic: 'Epic', story: 'Story', task: 'Task' } as const;
const ORDER = ['in-progress', 'blocked', 'in-review', 'ready', 'backlog', 'done'];

/** One line about one item: "Story 'X' — Blocked · Rohan · 2 pts · waiting on Dev: why". */
export function lineFor(wp: Workplace, it: Item): string {
  // Approved is not merged (11 Oct: "Done" here made Asha nearly unblock work on an unmerged fix).
  const parts: string[] = [(it as { trueStatus?: string }).trueStatus === 'approved' ? 'Approved, NOT merged yet' : STATUS_LABEL[it.status]];
  if (it.level === 'epic') {
    const p = items.progress(wp, it.id);
    parts.push(`${p.pct}% (${p.storiesDone}/${p.storiesTotal} stories)`);
  } else if (it.assigneeId) {
    const who = nameOf(wp, it.assigneeId);
    // Handed to a teammate (LLD §19.6c): "Dev (handed by Nikhil)".
    parts.push(`${who === 'you' ? 'You' : who}${it.handoff ? ` (handed by ${nameOf(wp, it.handoff.fromId)})` : ''}`);
  }
  if (it.points) parts.push(`${it.points} pts`);
  if (it.blocked) parts.push(`waiting on ${nameOf(wp, it.blocked.waitingOn)}: ${it.blocked.reason}`);
  else if (it.stall) parts.push(stallReason(it.stall.rule, it.stall.minutes * 60_000).toLowerCase());
  return `${NOUN[it.level]} '${it.title}' — ${parts.join(' · ')}`;
}

const match = (wp: Workplace, it: Item) => ({ item: it, line: lineFor(wp, it), href: `item/${it.id}` });

/** Item ids as the store mints them (`newId`: `as_…`, `ft_…`, any short prefix + base36). */
const ID_RE = /\b[a-z]{2,4}_[a-z0-9]{6,}\b/gi;

/**
 * A per-charter story's title without its " — <Charter>" suffix (`work.decompose` names each charter's
 * piece "<feature> — <charter title>"), so "Daily greeting" finds "Daily greeting — Character".
 */
export function baseTitle(wp: Workplace, title: string): string {
  const m = /^(.*\S)\s+[—–-]\s+([^—–]+)$/.exec(title.trim());
  if (!m) return title;
  const tail = m[2]!.trim().toLowerCase();
  for (const c of wp.org.charters.values()) if (c.title.toLowerCase() === tail || c.id === tail) return m[1]!;
  return title;
}

const meaningful = (t: string): string => words(t).filter(w => !STOP.has(w)).join(' ');

/**
 * Every item id written in `text` (the whole text, or ids inside it), resolved to live items: a merged
 * id follows `mergedInto` to its survivor (`merged` maps the asked id to it). Shared by `status_of`
 * and `item_read` (LLD §19.13), so both resolve ids the same way.
 */
export function resolveIds(wp: Workplace, text: string, rows?: WorkItem[]): { ids: string[]; found: WorkItem[]; merged: Map<string, string> } {
  const all = rows ?? rowsJson<WorkItem>(wp.db.prepare('select json from work order by coalesce(rank, 0), created_at').all());
  const byId = new Map(all.map(w => [w.id, w]));
  const merged = new Map<string, string>();
  const resolve = (id: string): WorkItem | undefined => {
    let w = byId.get(id) ?? byId.get(id.toLowerCase());
    for (let hops = 0; w?.mergedInto && hops < 10; hops++) w = byId.get(w.mergedInto) ?? w;
    const live = w && !w.mergedInto ? w : undefined;
    if (live && live.id !== id && live.id !== id.toLowerCase()) merged.set(id, live.id);
    return live;
  };
  const ids = [...new Set(text.trim().match(ID_RE) ?? [])];
  const found = [...new Map(ids.map(resolve).filter((w): w is WorkItem => !!w).map(w => [w.id, w])).values()];
  return { ids, found, merged };
}

export function answer(wp: Workplace, q: string, nowMs = Date.now()): StatusAnswer {
  const query = q.trim();
  const rows = rowsJson<WorkItem>(wp.db.prepare('select json from work order by coalesce(rank, 0), created_at').all());
  const all = rows.filter(w => !w.mergedInto);
  const none: StatusAnswer = { q: query, line: `Nothing in the plan matches "${query}".`, matches: [] };

  // Ids first: the whole query, or every id written inside it. A merged id answers with its survivor.
  const { ids, found } = resolveIds(wp, query, rows);
  if (found.length) {
    const matches = found.map(w => match(wp, items.toItem(wp, w, nowMs)));
    return { q: query, line: matches.map(m => m.line).join('; '), matches };
  }
  const text = ids.reduce((t, id) => t.replace(id, ' '), query);
  const tokens = words(text).filter(w => !STOP.has(w));
  if (!tokens.length) return none;

  // An exact title, with or without its " — <Charter>" suffix, beats a person or an area named in it.
  const qm = tokens.join(' ');
  const exact = all.filter(w => meaningful(w.title) === qm);
  const base = all.filter(w => !exact.includes(w) && meaningful(baseTitle(wp, w.title)) === qm);
  if (exact.length || base.length) {
    const matches = [...exact, ...base].slice(0, 10).map(w => match(wp, items.toItem(wp, w, nowMs)));
    return { q: query, line: matches[0]!.line, matches };
  }

  // A person: their open work, most active first.
  const person = wp.org.employees.find(e => tokens.includes(e.id) || tokens.includes(e.name.toLowerCase()));
  if (person) {
    const mine = all.filter(w => w.employeeId === person.id && levelOf(w) !== 'epic' && w.status !== 'done')
      .sort((a, b) => ORDER.indexOf(a.status ?? 'ready') - ORDER.indexOf(b.status ?? 'ready'))
      .map(w => match(wp, items.toItem(wp, w, nowMs)));
    return { q: query, line: mine.length ? `${person.name}: ${mine.map(m => m.line.replace(/^\w+ /, '')).join('; ')}` : `${person.name} has nothing open in the plan.`, matches: mine };
  }

  // An area: its epics and their progress.
  const qn = normal(text);
  const area = areas.list(wp).find(a => qn.includes(normal(a.title)));
  if (area) {
    const epics = all.filter(w => levelOf(w) === 'epic' && w.areaId === area.id).map(w => match(wp, items.toItem(wp, w, nowMs)));
    return { q: query, line: epics.length ? `${area.title}: ${epics.map(m => m.line).join('; ')}` : `${area.title} has no epics yet.`, matches: epics };
  }

  // Items by title: every meaningful word should appear; open work before done.
  const need = Math.max(1, Math.ceil(tokens.length * 0.6));
  const scored = all.map(w => ({ w, score: tokens.filter(t => words(w.title).includes(t)).length }))
    .filter(x => x.score >= need)
    .sort((a, b) => b.score - a.score || Number(a.w.status === 'done') - Number(b.w.status === 'done') || ['epic', 'story', 'task'].indexOf(levelOf(a.w)) - ['epic', 'story', 'task'].indexOf(levelOf(b.w)));
  if (!scored.length) return none;
  const matches = scored.slice(0, 10).map(x => match(wp, items.toItem(wp, x.w, nowMs)));
  return { q: query, line: matches[0]!.line, matches };
}
