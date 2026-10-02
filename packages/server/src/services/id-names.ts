import type { Workplace } from './workplace.js';

/**
 * Raw ids in owner-facing text (iOS QA, 2 Oct): agents write "blocked on as_muk…" and "see th_…" into
 * Inbox summaries, status reports and Room headlines, which mean nothing on a phone. `humanizeIds`
 * replaces every id it can resolve — an item (as_/ft_), a Room thread (th_…, including th_epic_<id>
 * and th_area_<id>), an Inbox item (in_…), an area (ar_…) — with its title in quotes, at read time,
 * for the owner's views only; the stored text keeps its ids (agents and the COO act on them).
 * Anything it cannot resolve (an unknown or a run id) is left exactly as written.
 */

const ID = /\b(?:as|ft|th|in|ar)_[a-z0-9_]*[a-z0-9]\b/g;

function titleOf(wp: Workplace, table: 'work' | 'threads' | 'inbox' | 'areas', id: string): string | undefined {
  const row = wp.db.prepare(`select json from ${table} where id = ?`).get(id) as { json: string } | undefined;
  if (!row) return undefined;
  try { const t = (JSON.parse(row.json) as { title?: unknown }).title; return typeof t === 'string' && t.trim() ? t.trim() : undefined; } catch { return undefined; }
}

export function nameOfId(wp: Workplace, id: string): string | undefined {
  if (id.startsWith('as_') || id.startsWith('ft_')) return titleOf(wp, 'work', id);
  if (id.startsWith('in_')) return titleOf(wp, 'inbox', id);
  if (id.startsWith('ar_')) return titleOf(wp, 'areas', id);
  if (id.startsWith('th_')) {
    const thread = titleOf(wp, 'threads', id);
    if (thread) return thread;
    const epic = /^th_epic_(.+)$/.exec(id)?.[1];
    if (epic) return titleOf(wp, 'work', epic);
    const area = /^th_area_(.+)$/.exec(id)?.[1];
    if (area) return titleOf(wp, 'areas', area);
  }
  return undefined;
}

/**
 * `keepIds` (agent-facing reads, LLD §19.13): `"Title" (as_x)` instead of `"Title"`, so a reader who
 * acts on the id (inbox_read, item_comment) still has it.
 */
export function humanizeIds(wp: Workplace, text: string, opts?: { keepIds?: boolean }): string;
export function humanizeIds(wp: Workplace, text: string | undefined, opts?: { keepIds?: boolean }): string | undefined;
export function humanizeIds(wp: Workplace, text: string | undefined, opts: { keepIds?: boolean } = {}): string | undefined {
  if (!text || !text.includes('_')) return text;
  const cache = new Map<string, string | undefined>();
  return text.replace(ID, id => {
    if (!cache.has(id)) cache.set(id, nameOfId(wp, id));
    const name = cache.get(id);
    return name ? (opts.keepIds ? `"${name}" (${id})` : `"${name}"`) : id;
  });
}
