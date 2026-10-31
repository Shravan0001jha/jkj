/** Product view (owner, 1 Nov): product parts built from epics, with weekly trends. Pure; inputs are system records. */

import type { Feature, Rows, Snapshot } from './snapshot.js';

const DAY = 86_400_000;
const WEEKS = 6;
const DONE = new Set(['done']);
const CLOSED = new Set(['done', 'rejected', 'cancelled']);

export interface ProductDef { id: string; name: string; epics: string[] }
export interface ProductConfig { products: ProductDef[]; committed?: Record<string, string | null> }

export interface Product {
  id: string; name: string;
  health: Feature['health']; committedDate: string | null; forecast: { p50: string | null; p90: string | null };
  done: number; total: number; startedAt: string | null; ageDays: number | null;
  epics: string[];
  weekly: { delivered: number[]; bugs: number[] };
  burnup: { done: number[]; total: number[] };
}
export interface Trends {
  weeks: string[];                                   // Monday of each week, oldest first
  deliveredByProduct: Record<string, number[]>;      // stories closed as done per week
  bugsByProduct: Record<string, number[]>;           // bug stories opened per week
  bugsOpenTotal: number[];                           // open bug stories at each week's end (all products)
  medianHoursToDone: (number | null)[];              // first start -> done, stories finished that week
  waitByCause: Record<string, number[]>;             // story-days waiting per week (not parked)
}

/** Monday 00:00 UTC of the week containing `ms`. */
export function weekStart(ms: number): number {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * DAY;
}
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return Math.round((s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) * 10) / 10;
};

export function buildProducts(rows: Rows, features: Feature[], cfg: ProductConfig, waitParts: { at: number; to: number; cause: string; ms: number }[]): { products: Product[]; trends: Trends } {
  const now = rows.now;
  const w0 = weekStart(now) - (WEEKS - 1) * 7 * DAY;
  const weeks = Array.from({ length: WEEKS }, (_, i) => w0 + i * 7 * DAY);
  const idx = (ms: number) => { const i = Math.floor((ms - w0) / (7 * DAY)); return i >= 0 && i < WEEKS ? i : -1; };
  const byStory = new Map<string, { at: number; to: string }[]>();
  for (const t of rows.transitions) (byStory.get(t.itemId) ?? byStory.set(t.itemId, []).get(t.itemId)!).push(t);
  const doneAt = (id: string) => (byStory.get(id) ?? []).filter(t => DONE.has(t.to)).map(t => t.at).sort((a, b) => b - a)[0];
  const startAt = (id: string) => (byStory.get(id) ?? []).filter(t => t.to === 'in-progress').map(t => t.at).sort((a, b) => a - b)[0];

  const deliveredByProduct: Record<string, number[]> = {}, bugsByProduct: Record<string, number[]> = {};
  const products: Product[] = cfg.products.map(p => {
    const fs = features.filter(f => p.epics.includes(f.id));
    const stories = rows.stories.filter(s => p.epics.includes(s.epicId));
    const delivered = new Array(WEEKS).fill(0), bugs = new Array(WEEKS).fill(0), doneCum = new Array(WEEKS).fill(0), totalCum = new Array(WEEKS).fill(0);
    for (const s of stories) {
      const d = doneAt(s.id);
      if (DONE.has(s.status) && d !== undefined) { const i = idx(d); if (i >= 0) delivered[i]++; }
      if (s.type === 'bug') { const i = idx(s.createdAt); if (i >= 0) bugs[i]++; }
      for (let i = 0; i < WEEKS; i++) {
        const end = weeks[i]! + 7 * DAY;
        if (s.createdAt < end && s.status !== 'rejected' && s.status !== 'cancelled') totalCum[i]++;
        if (DONE.has(s.status) && d !== undefined && d < end) doneCum[i]++;
      }
    }
    deliveredByProduct[p.id] = delivered; bugsByProduct[p.id] = bugs;
    const total = stories.filter(s => s.status !== 'rejected' && s.status !== 'cancelled').length;
    const done = stories.filter(s => DONE.has(s.status)).length;
    const committed = cfg.committed?.[p.id] ?? null;
    const p50s = fs.filter(f => f.state !== 'delivered').map(f => f.forecast.p50);
    const forecast = p50s.length === 0 ? { p50: null, p90: null }
      : p50s.some(x => x === null) ? { p50: null, p90: null }
      : { p50: (p50s as string[]).sort().at(-1)!, p90: fs.map(f => f.forecast.p90).filter(Boolean).sort().at(-1) ?? null };
    const allDone = total > 0 && stories.every(s => CLOSED.has(s.status));
    const today = new Date(now).toISOString().slice(0, 10);
    const health: Feature['health'] = allDone ? 'delivered' : !committed ? 'no-date' : today > committed ? 'late' : !forecast.p50 || forecast.p50 > committed ? 'at-risk' : 'on-track';
    const starts = fs.map(f => f.startedAt).filter(Boolean).sort() as string[];
    return {
      id: p.id, name: p.name, health, committedDate: committed, forecast, done, total,
      startedAt: starts[0] ?? null, ageDays: starts[0] ? Math.round(((now - Date.parse(starts[0])) / DAY) * 10) / 10 : null,
      epics: p.epics, weekly: { delivered, bugs }, burnup: { done: doneCum, total: totalCum },
    };
  });

  // Overall trends across every story (product and internal).
  const bugsOpenTotal = weeks.map(w => {
    const end = w + 7 * DAY;
    return rows.stories.filter(s => s.type === 'bug' && s.createdAt < end && !((d => d !== undefined && d < end)(doneAt(s.id)))).length;
  });
  const medianHoursToDone = weeks.map(w => {
    const xs: number[] = [];
    for (const s of rows.stories) {
      const d = doneAt(s.id), st = startAt(s.id);
      if (d !== undefined && st !== undefined && d >= w && d < w + 7 * DAY && d > st) xs.push((d - st) / 3_600_000);
    }
    return median(xs);
  });
  const waitByCause: Record<string, number[]> = {};
  for (const p of waitParts) {
    if (p.cause === 'parked') continue;
    const segMs = p.to - p.at;
    if (segMs <= 0) continue;
    for (let i = 0; i < WEEKS; i++) {
      const a = weeks[i]!, b = a + 7 * DAY;
      const ov = Math.max(0, Math.min(p.to, b) - Math.max(p.at, a));
      if (!ov) continue;
      const arr = (waitByCause[p.cause] ??= new Array<number>(WEEKS).fill(0));
      arr[i] = (arr[i] ?? 0) + (ov * (p.ms / segMs)) / DAY;
    }
  }
  for (const k of Object.keys(waitByCause)) waitByCause[k] = waitByCause[k]!.map(v => Math.round(v * 10) / 10);
  return {
    products,
    trends: { weeks: weeks.map(w => new Date(w).toISOString().slice(0, 10)), deliveredByProduct, bugsByProduct, bugsOpenTotal, medianHoursToDone, waitByCause },
  };
}

export type { Snapshot };
