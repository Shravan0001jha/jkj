import type { Item, StatusAnswer, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as items from './items.js';
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
  const parts: string[] = [STATUS_LABEL[it.status]];
  if (it.level === 'epic') {
    const p = items.progress(wp, it.id);
    parts.push(`${p.pct}% (${p.storiesDone}/${p.storiesTotal} stories)`);
  } else if (it.assigneeId) {
    const who = nameOf(wp, it.assigneeId);
    parts.push(who === 'you' ? 'You' : who);
  }
  if (it.points) parts.push(`${it.points} pts`);
  if (it.blocked) parts.push(`waiting on ${nameOf(wp, it.blocked.waitingOn)}: ${it.blocked.reason}`);
  else if (it.stall) parts.push(it.stall.rule === 'idle' ? `no activity for ${it.stall.minutes} min` : it.stall.rule === 'not-started' ? `not started for ${it.stall.minutes} min` : `in review untouched for ${it.stall.minutes} min`);
  return `${NOUN[it.level]} '${it.title}' — ${parts.join(' · ')}`;
}

const match = (wp: Workplace, it: Item) => ({ item: it, line: lineFor(wp, it), href: `item/${it.id}` });

export function answer(wp: Workplace, q: string, nowMs = Date.now()): StatusAnswer {
  const query = q.trim();
  const tokens = words(query).filter(w => !STOP.has(w));
  const all = rowsJson<WorkItem>(wp.db.prepare('select json from work order by coalesce(rank, 0), created_at').all()).filter(w => !w.mergedInto);
  const none: StatusAnswer = { q: query, line: `Nothing in the plan matches "${query}".`, matches: [] };
  if (!tokens.length) return none;

  // A person: their open work, most active first.
  const person = wp.org.employees.find(e => tokens.includes(e.id) || tokens.includes(e.name.toLowerCase()));
  if (person) {
    const mine = all.filter(w => w.employeeId === person.id && levelOf(w) !== 'epic' && w.status !== 'done')
      .sort((a, b) => ORDER.indexOf(a.status ?? 'ready') - ORDER.indexOf(b.status ?? 'ready'))
      .map(w => match(wp, items.toItem(wp, w, nowMs)));
    return { q: query, line: mine.length ? `${person.name}: ${mine.map(m => m.line.replace(/^\w+ /, '')).join('; ')}` : `${person.name} has nothing open in the plan.`, matches: mine };
  }

  // An area: its epics and their progress.
  const qn = normal(query);
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
