/** Dashboard v3 extras (owner, 1 Nov): release stage, quality, cost and capacity, all from system records. Pure. */

import type { Rows } from './snapshot.js';
import type { ProductDef } from './products.js';

const DAY = 86_400_000, H = 3_600_000;
const DONE = 'done';

export type Filer = 'qa' | 'coo' | 'cto' | 'team' | 'system';
export interface ProductExtras {
  release: { merged: number; staging: number; prod: number };   // done stories by the furthest place they reached
  costInr: number; costPerDelivered: number | null;
  sendBacksPerStory: number | null;
  bugsByFiler: Record<Filer, number>;
  deliveredAt: string | null;
  weeklyCost: number[];
}
export interface TrendExtras {
  bugFixHours: (number | null)[];            // median hours a bug stayed open, bugs closed that week
  sendBackRate: (number | null)[];           // send-backs per review that week
  costInr: number[];                         // model spend per week (₹ equivalent)
  idleHours: number[];                       // person-hours free while ready work waited on someone else in the same charter
  ownerWaitHours: (number | null)[];         // median hours an Inbox item waited for the owner, by week answered
  bugsByFiler: Record<Filer, number[]>;      // bugs opened per week by who filed them
}
export interface Usage {
  utilization: number | null; allowanceToday: number | null; resetsAt: string | null;
  dailyInr: { day: string; inr: number }[];
  projectedAtReset: number | null;           // weekly usage at reset if today's average pace holds
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return Math.round((s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) * 10) / 10;
};

export function filerOf(by: string | null | undefined, qaIds: string[]): Filer {
  if (!by) return 'system';
  if (by === 'workplace' || by === 'system') return 'system';
  if (by === 'coo' || by === 'owner') return 'coo';
  if (by === 'cto') return 'cto';
  if (qaIds.includes(by)) return 'qa';
  return 'team';
}

export function buildExtras(rows: Rows, defs: ProductDef[], weeks: number[]): { products: Record<string, ProductExtras>; trends: TrendExtras; usage: Usage } {
  const now = rows.now, W = weeks.length;
  const idx = (ms: number) => { const i = Math.floor((ms - weeks[0]!) / (7 * DAY)); return i >= 0 && i < W ? i : -1; };
  const byStory = new Map<string, { at: number; from: string | null; to: string }[]>();
  for (const t of rows.transitions) (byStory.get(t.itemId) ?? byStory.set(t.itemId, []).get(t.itemId)!).push(t);
  for (const v of byStory.values()) v.sort((a, b) => a.at - b.at);
  const doneAt = (id: string) => (byStory.get(id) ?? []).filter(t => t.to === DONE).map(t => t.at).at(-1);
  const qa = rows.qaIds ?? [];
  const zeroF = (): Record<Filer, number> => ({ qa: 0, coo: 0, cto: 0, team: 0, system: 0 });

  // Cost per week per story: spread each story's cost over its building span (first start -> done or now).
  const costWeeksOf = (id: string): number[] => {
    const out = new Array<number>(W).fill(0), cost = rows.costByStory[id] ?? 0;
    if (!cost) return out;
    const ts = byStory.get(id) ?? [];
    const a = ts.find(t => t.to === 'in-progress')?.at ?? ts[0]?.at, b = doneAt(id) ?? now;
    if (a === undefined || b <= a) { const i = idx(a ?? now); if (i >= 0) out[i] = (out[i] ?? 0) + cost; return out; }
    for (let i = 0; i < W; i++) {
      const s = weeks[i]!, e = s + 7 * DAY;
      out[i] = (out[i] ?? 0) + cost * (Math.max(0, Math.min(b, e) - Math.max(a, s)) / (b - a));
    }
    return out;
  };

  const products: Record<string, ProductExtras> = {};
  for (const d of defs) {
    const stories = rows.stories.filter(s => d.epics.includes(s.epicId));
    const done = stories.filter(s => s.status === DONE);
    const release = { merged: 0, staging: 0, prod: 0 };
    for (const s of done) release[rows.stage?.[s.id] ?? 'merged']++;
    const costInr = Math.round(stories.reduce((n, s) => n + (rows.costByStory[s.id] ?? 0), 0));
    const sendBacks = stories.reduce((n, s) => n + (byStory.get(s.id) ?? []).filter(t => t.from === 'in-review' && t.to === 'in-progress').length, 0);
    const reviewed = stories.filter(s => (byStory.get(s.id) ?? []).some(t => t.to === 'in-review')).length;
    const bugsByFiler = zeroF();
    for (const s of stories) if (s.type === 'bug') bugsByFiler[filerOf(s.createdBy, qa)]++;
    const allClosed = stories.length > 0 && stories.every(s => ['done', 'rejected', 'cancelled'].includes(s.status));
    const last = allClosed ? Math.max(...done.map(s => doneAt(s.id) ?? 0)) : 0;
    const weeklyCost = new Array<number>(W).fill(0);
    for (const s of stories) costWeeksOf(s.id).forEach((v, i) => { weeklyCost[i]! += v; });
    products[d.id] = {
      release, costInr, costPerDelivered: done.length ? Math.round(costInr / done.length) : null,
      sendBacksPerStory: reviewed ? Math.round((sendBacks / reviewed) * 100) / 100 : null,
      bugsByFiler, deliveredAt: last ? new Date(last).toISOString() : null,
      weeklyCost: weeklyCost.map(Math.round),
    };
  }

  // Trends across all stories.
  const bugFix: number[][] = Array.from({ length: W }, () => []);
  const reviews = new Array<number>(W).fill(0), backs = new Array<number>(W).fill(0);
  const cost = new Array<number>(W).fill(0);
  const filerW: Record<Filer, number[]> = { qa: new Array(W).fill(0), coo: new Array(W).fill(0), cto: new Array(W).fill(0), team: new Array(W).fill(0), system: new Array(W).fill(0) };
  for (const s of rows.stories) {
    const ts = byStory.get(s.id) ?? [];
    for (const t of ts) {
      const i = idx(t.at); if (i < 0) continue;
      if (t.to === 'in-review') reviews[i]!++;
      if (t.from === 'in-review' && t.to === 'in-progress') backs[i]!++;
    }
    if (s.type === 'bug') {
      const ci = idx(s.createdAt); if (ci >= 0) filerW[filerOf(s.createdBy, qa)][ci]!++;
      const d = doneAt(s.id);
      if (d !== undefined && s.status === DONE) { const i = idx(d); if (i >= 0) bugFix[i]!.push((d - s.createdAt) / H); }
    }
    costWeeksOf(s.id).forEach((v, i) => { cost[i]! += v; });
  }

  // Idle capacity: hourly samples. A person is idle when nothing of theirs is in progress, while a story in their
  // charter sits Ready on someone else who is busy. Only people who worked a story in the window count.
  const segs = new Map<string, { emp: string; charter: string | null; status: string; from: number; to: number }[]>();
  for (const s of rows.stories) {
    if (!s.employeeId) continue;
    const ts = byStory.get(s.id) ?? [];
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i]!, end = ts[i + 1]?.at ?? now;
      if (t.to === 'done' || t.to === 'rejected') break;
      (segs.get(s.employeeId) ?? segs.set(s.employeeId, []).get(s.employeeId)!).push({ emp: s.employeeId, charter: s.charterId, status: t.to, from: t.at, to: end });
    }
  }
  const people = [...segs.keys()];
  const charterOf = new Map(people.map(p => [p, segs.get(p)!.map(x => x.charter).find(Boolean) ?? null]));
  const busyAt = (p: string, t: number) => segs.get(p)!.some(x => x.status === 'in-progress' && x.from <= t && x.to > t);
  const idleHours = new Array<number>(W).fill(0);
  for (let t = weeks[0]!; t < Math.min(now, weeks[0]! + W * 7 * DAY); t += H) {
    const i = idx(t);
    for (const p of people) {
      if (busyAt(p, t)) continue;
      const ch = charterOf.get(p);
      if (!ch) continue;
      const queued = people.some(q => q !== p && charterOf.get(q) === ch && busyAt(q, t) && segs.get(q)!.some(x => x.status === 'ready' && x.from <= t && x.to > t));
      if (queued) idleHours[i]!++;
    }
  }

  const ownerWait: number[][] = Array.from({ length: W }, () => []);
  for (const it of rows.inbox) if (it.answeredAt !== null) { const i = idx(it.answeredAt); if (i >= 0 && it.answeredAt > it.createdAt) ownerWait[i]!.push((it.answeredAt - it.createdAt) / H); }

  const p = rows.pace ?? null;
  let projected: number | null = null;
  if (p) {
    const weekStart = p.resetsAtMs - 7 * DAY, elapsed = Math.max(H, now - weekStart);
    projected = Math.round(Math.min(2, (p.utilization / elapsed) * 7 * DAY) * 100) / 100;
  }
  return {
    products,
    trends: {
      bugFixHours: bugFix.map(median),
      sendBackRate: reviews.map((r, i) => (r ? Math.round((backs[i]! / r) * 100) / 100 : null)),
      costInr: cost.map(Math.round),
      idleHours,
      ownerWaitHours: ownerWait.map(median),
      bugsByFiler: filerW,
    },
    usage: {
      utilization: p?.utilization ?? null, allowanceToday: p?.allowance ?? null,
      resetsAt: p ? new Date(p.resetsAtMs).toISOString() : null,
      dailyInr: (rows.dailyInr ?? []).slice(-21).map(d => ({ day: d.day, inr: Math.round(d.inr) })),
      projectedAtReset: projected,
    },
  };
}
