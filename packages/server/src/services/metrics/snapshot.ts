/** LLD-dashboard §2-§4 + HLD §5: the snapshot v1 contract shared by the online dashboard and the app. Pure. */

import { storyTimeline, type Transition } from './timeline.js';
import { splitWait, type Span, type Cause } from './causes.js';
import { throughputForecast } from './forecast.js';
import { buildProducts, type ProductConfig, type Product, type Trends } from './products.js';
import type { Usage } from './extras.js';

const DAY = 86_400_000;
const FIXED_DAYS = 2;            // staging batch + CTO journey + owner device check (6 Nov plan)
const WAITING = new Set(['ready', 'in-review', 'blocked', 'waiting', 'parked']);
const BUILDING = new Set(['in-progress']);
const DONE = new Set(['done']);
const CLOSED = new Set(['done', 'rejected', 'cancelled']);

export interface EpicRow {
  id: string; title: string; status: string; statusSince: number; targetDate: string | null; createdAt: number;
  targetHistory: { at: number; from: string | null; to: string | null }[];
}
export interface StoryRow { id: string; epicId: string; title: string; status: string; employeeId: string | null; charterId: string | null; createdAt: number; type?: string | null; createdBy?: string | null; mergedSha?: string | null }
export interface Rows {
  now: number;
  epics: EpicRow[];
  stories: StoryRow[];
  transitions: Transition[];
  holds: Span[]; caps: Span[]; stagingDown: Span[];
  notes: { itemId: string; at: number; text: string }[];
  inbox: { createdAt: number; answeredAt: number | null; refs: string[] }[];
  costByStory: Record<string, number>;
  devApprovals: Record<string, number>;
  startsAfter: Record<string, string>;
  prTimes?: Record<string, { pushedAt: number; devAt: number | null; qaAt: number | null }>;
  stage?: Record<string, 'prod' | 'staging' | 'merged'>;   // furthest place each merged story has reached
  release?: { prodSha: string | null; stagingSha: string | null };
  dailyInr?: { day: string; inr: number }[];
  pace?: { utilization: number; allowance: number; resetsAtMs: number; dayIndex: number } | null;
  qaIds?: string[];
}

export type ScopeStatus = 'not-started' | 'building' | 'merged' | 'staging' | 'verified' | 'dropped';
export interface Feature {
  id: string; name: string; state: 'in-progress' | 'delivered' | 'planned';
  committedDate: string | null; originalDate: string | null; forecast: { p50: string | null; p90: string | null };
  health: 'on-track' | 'at-risk' | 'late' | 'delivered' | 'no-date'; healthReason: string | null;
  startedAt: string | null; deliveredAt: string | null; ageDays: number | null;
  scope: { id: string; label: string; status: ScopeStatus }[];
  dateHistory: { at: string; from: string | null; to: string | null }[];
  lostDays: Partial<Record<Cause, number>>; buildingDays: number; sendBacks: number; costInr: number;
  remaining: number; done: number;
}
export interface Snapshot {
  version: 1; generatedAt: string;
  products: Product[];
  trends: Trends;
  usage: Usage;
  release: { prodSha: string | null; stagingSha: string | null };
  features: Feature[];
  gaps: {
    window: '30d';
    unit: 'story-days';
    parkedStoryDays: number;
    reviewWait: { approval1Minutes: { p50: number | null; p90: number | null }; approval2Minutes: { p50: number | null; p90: number | null } };
    lostDaysByCause: { cause: Cause; days: number; weekly: number[] }[];
    reviewWaitHours: { p50: number | null; p90: number | null };
    sendBacks: number;
    stagingDownDays: number;
  };
  unknownShare: number;
  notes: string[];
}

const iso = (ms: number) => new Date(ms).toISOString();
const day = (ms: number) => iso(ms).slice(0, 10);
const r1 = (x: number) => Math.round(x * 10) / 10;
const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
};

function scopeStatus(status: string): ScopeStatus {
  if (DONE.has(status)) return 'merged';
  if (status === 'rejected' || status === 'cancelled') return 'dropped';
  if (status === 'in-progress' || status === 'in-review') return 'building';
  return 'not-started';
}

export function buildSnapshot(rows: Rows, cfg: ProductConfig = { products: [] }): Snapshot {
  const now = rows.now;
  const byStory = new Map<string, Transition[]>();
  for (const t of rows.transitions) (byStory.get(t.itemId) ?? byStory.set(t.itemId, []).get(t.itemId)!).push(t);
  const notesBy = new Map<string, { at: number; text: string }[]>();
  for (const n of rows.notes) (notesBy.get(n.itemId) ?? notesBy.set(n.itemId, []).get(n.itemId)!).push(n);

  // Who was building what, when (for "queued behind a busy person").
  const buildingSpans = new Map<string, { story: string; from: number; to: number }[]>();
  const timelines = new Map<string, ReturnType<typeof storyTimeline>>();
  for (const s of rows.stories) {
    const tl = storyTimeline(byStory.get(s.id) ?? [], now);
    timelines.set(s.id, tl);
    if (!s.employeeId) continue;
    for (const seg of tl) if (BUILDING.has(seg.status)) (buildingSpans.get(s.employeeId) ?? buildingSpans.set(s.employeeId, []).get(s.employeeId)!).push({ story: s.id, ...seg });
  }
  const busyShare = (emp: string | null, self: string) => (from: number, to: number) => {
    if (!emp || to <= from) return 0;
    let ms = 0;
    for (const b of buildingSpans.get(emp) ?? []) if (b.story !== self) ms += Math.max(0, Math.min(to, b.to) - Math.max(from, b.from));
    return Math.min(1, ms / (to - from));
  };

  const gapLost = new Map<Cause, number>();
  const gapWeekly = new Map<Cause, number[]>();
  const windowStart = now - 30 * DAY;
  let unknownMs = 0, waitMs = 0, totalSendBacks = 0;
  const reviewWaits: number[] = [];
  const waitParts: { at: number; to: number; cause: string; ms: number }[] = [];

  const features: Feature[] = rows.epics.map(ep => {
    const stories = rows.stories.filter(s => s.epicId === ep.id);
    const lost: Partial<Record<Cause, number>> = {};
    let buildingMs = 0, sendBacks = 0, cost = 0, started: number | null = null;
    const openWait = new Map<Cause, number>();
    for (const s of stories) {
      cost += rows.costByStory[s.id] ?? 0;
      const ts = byStory.get(s.id) ?? [];
      sendBacks += ts.filter(t => t.from === 'in-review' && t.to === 'in-progress').length;
      const first = ts.filter(t => t.to === 'in-progress').map(t => t.at).sort((a, b) => a - b)[0];
      if (first !== undefined && (started === null || first < started)) started = first;
      const tl = timelines.get(s.id) ?? [];
      let seenStart = false;
      for (const seg of tl) {
        if (BUILDING.has(seg.status)) { seenStart = true; buildingMs += seg.to - seg.from; continue; }
        if (!seenStart || !WAITING.has(seg.status)) continue;
        const parts = splitWait(seg, {
          holds: rows.holds, caps: rows.caps, stagingDown: rows.stagingDown,
          notes: notesBy.get(s.id) ?? [],
          inbox: rows.inbox.filter(i => i.refs.includes(s.id) || i.refs.includes(ep.id)),
          assigneeBusy: busyShare(s.employeeId, s.id),
          startsAfter: rows.startsAfter[s.id], devApprovalAt: rows.devApprovals[s.id],
        });
        const segMs = seg.to - seg.from;
        const inWin = Math.max(0, seg.to - Math.max(seg.from, windowStart));
        if (seg.status === 'in-review') reviewWaits.push(segMs / 3_600_000);
        if (seg.to === now && !CLOSED.has(s.status) && parts.length) { const c = parts[parts.length - 1]!.cause; openWait.set(c, (openWait.get(c) ?? 0) + 1); }
        for (const { cause, ms } of parts) {
          waitParts.push({ at: seg.from, to: seg.to, cause, ms });
          lost[cause] = (lost[cause] ?? 0) + ms / DAY;
          
          // Workplace-gap totals: this cause's share of the part of the segment inside the 30-day window.
          if (inWin <= 0 || segMs <= 0) continue;
          const share = ms / segMs;
          gapLost.set(cause, (gapLost.get(cause) ?? 0) + (inWin * share) / DAY);
          const wk = gapWeekly.get(cause) ?? [0, 0, 0, 0, 0];
          for (let w = 0; w < 5; w++) {
            const a = windowStart + w * 6 * DAY, b = a + 6 * DAY;
            wk[w]! += (Math.max(0, Math.min(seg.to, b) - Math.max(seg.from, a)) * share) / DAY;
          }
          gapWeekly.set(cause, wk);
          waitMs += inWin * share;
          if (cause === 'unknown') unknownMs += inWin * share;
        }
      }
    }
    totalSendBacks += sendBacks;
    const remaining = stories.filter(s => !CLOSED.has(s.status)).length;
    // Delivered when the feature is closed, or when every story is closed even if nobody closed the feature.
    const lastClose = Math.max(0, ...stories.flatMap(s => (byStory.get(s.id) ?? []).filter(t => CLOSED.has(t.to)).map(t => t.at)));
    const delivered = DONE.has(ep.status) || (stories.length > 0 && remaining === 0 && stories.some(s => DONE.has(s.status)));
    const deliveredAt = !delivered ? null : DONE.has(ep.status) ? ep.statusSince : lastClose || ep.statusSince;
    const doneCount = stories.filter(s => DONE.has(s.status)).length;
    const doneLast14 = stories.filter(s => (byStory.get(s.id) ?? []).some(t => DONE.has(t.to) && t.at >= now - 14 * DAY)).length;
    const fc = delivered ? { p50: null, p90: null } : throughputForecast(remaining, doneLast14, FIXED_DAYS, now);
    const committed = ep.targetDate;
    const original = ep.targetHistory.map(h => h.to).find(Boolean) ?? committed;
    let health: Feature['health'];
    if (delivered) health = 'delivered';
    else if (!committed) health = 'no-date';
    else if (day(now) > committed) health = 'late';
    else if (!fc.p50 || fc.p50 > committed) health = 'at-risk';
    else health = 'on-track';
    const top = [...openWait.entries()].sort((a, b) => b[1] - a[1])[0];
    const reason = health === 'delivered' ? null : !top ? (fc.p50 === null && remaining > 0 ? 'stalled: nothing finished in 14 days' : null) : `${top[1]} open ${top[1] === 1 ? 'story' : 'stories'} waiting on ${top[0]}`;
    return {
      id: ep.id, name: ep.title,
      state: delivered ? 'delivered' : started === null ? 'planned' : 'in-progress',
      committedDate: committed, originalDate: original, forecast: fc, health, healthReason: reason,
      startedAt: started === null ? null : iso(started), deliveredAt: deliveredAt === null ? null : iso(deliveredAt),
      ageDays: started === null ? null : r1(((deliveredAt ?? now) - started) / DAY),
      scope: stories.map(s => ({ id: s.id, label: s.title, status: scopeStatus(s.status) })),
      dateHistory: ep.targetHistory.map(h => ({ at: iso(h.at), from: h.from, to: h.to })),
      lostDays: Object.fromEntries(Object.entries(lost).map(([k, v]) => [k, r1(v!)])) as Feature['lostDays'],
      buildingDays: r1(buildingMs / DAY), sendBacks, costInr: Math.round(cost), remaining, done: doneCount,
    };
  });

  const order = { late: 0, 'at-risk': 1, 'on-track': 2, 'no-date': 3, delivered: 4 } as const;
  features.sort((a, b) => order[a.health] - order[b.health] || (a.committedDate ?? '9').localeCompare(b.committedDate ?? '9'));
  const stagingDownDays = rows.stagingDown.reduce((n, s) => n + Math.max(0, Math.min(s.to, now) - Math.max(s.from, windowStart)), 0) / DAY;
  // Review waits per review round, from Workplace events: entering in-review -> "Developer approval by" (approval 1),
  // then approval 1 -> leaving review to done (approval 2 + merge). Rounds that start inside the window.
  const a1: number[] = [], a2: number[] = [];
  for (const st of rows.stories) {
    const devNotes = (notesBy.get(st.id) ?? []).filter(n => /^Developer approval by /.test(n.text)).map(n => n.at);
    const ts = (byStory.get(st.id) ?? []).slice().sort((x, y) => x.at - y.at);
    for (let i = 0; i < ts.length; i++) {
      if (ts[i]!.to !== 'in-review' || ts[i]!.at < windowStart) continue;
      const start = ts[i]!.at, end = ts[i + 1]?.at ?? now;
      const dev = devNotes.find(at => at >= start && at <= end);
      if (dev !== undefined) a1.push((dev - start) / 60_000);
      if (dev !== undefined && ts[i + 1] && DONE.has(ts[i + 1]!.to)) a2.push((end - dev) / 60_000);
    }
  }
  const pp = (xs: number[]) => ({ p50: pct(xs, 0.5) === null ? null : r1(pct(xs, 0.5)!), p90: pct(xs, 0.9) === null ? null : r1(pct(xs, 0.9)!) });
  const parkedDays = gapLost.get('parked') ?? 0;
  gapLost.delete('parked');
  const lostWait = waitMs - parkedDays * DAY;
  const { products, trends, usage } = buildProducts(rows, features, cfg, waitParts);
  return {
    version: 1, generatedAt: iso(now), products, trends, usage, release: rows.release ?? { prodSha: null, stagingSha: null }, features,
    gaps: {
      window: '30d',
      unit: 'story-days',
      parkedStoryDays: r1(parkedDays),
      reviewWait: { approval1Minutes: pp(a1), approval2Minutes: pp(a2) },
      lostDaysByCause: [...gapLost.entries()].map(([cause, days]) => ({ cause, days: r1(days), weekly: (gapWeekly.get(cause) ?? []).map(r1) })).sort((a, b) => b.days - a.days),
      reviewWaitHours: pp(reviewWaits),
      sendBacks: totalSendBacks,
      stagingDownDays: r1(stagingDownDays),
    },
    unknownShare: lostWait > 0 ? Math.round((unknownMs / lostWait) * 100) / 100 : 0,
    notes: [
      'Phase 1: scope items show merged at most; staging and device verification arrive with Phase 2 records.',
      'Every number is computed from Workplace status, PR, stall, Inbox and usage records; nothing is typed in by an agent.',
    ],
  };
}
