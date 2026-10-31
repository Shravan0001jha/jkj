/** LLD-dashboard §3: why a story waited. Fixed rules, first match wins, so the same history always gets the same label. */

import type { Segment } from './timeline.js';

export interface Span { from: number; to: number }
export interface CauseCtx {
  holds: Span[];            // Workplace paused or weekly pace hold
  caps: Span[];             // GitHub / daily spend caps
  stagingDown: Span[];      // staging stopped or a batch deploy deferred
  notes: { at: number; text: string }[];   // this story's activity text (category only, never a number)
  inbox: { createdAt: number; answeredAt: number | null }[];   // owner Inbox items about this story or its feature
  assigneeBusy: (from: number, to: number) => number;          // share of the span the assignee had other work in progress
  startsAfter: string | undefined;
  devApprovalAt: number | undefined;
}
export type Cause = 'paused/pace-hold' | 'budget-cap' | 'staging-down' | 'review' | 'dependency' | 'mac-or-device' | 'owner-decision' | 'queued-behind-busy' | 'parked' | 'unknown';

const overlaps = (s: Segment, spans: Span[]) => spans.some(x => x.from < s.to && x.to > s.from);
const MAC = /\bMac\b|device|iPhone|real phone|Android phone/i;

export function waitCause(s: Segment, c: CauseCtx): { cause: Cause; detail?: string } {
  if (overlaps(s, c.holds)) return { cause: 'paused/pace-hold' };
  if (overlaps(s, c.caps)) return { cause: 'budget-cap' };
  if (overlaps(s, c.stagingDown)) return { cause: 'staging-down' };
  if (s.status === 'in-review') {
    const second = c.devApprovalAt !== undefined && c.devApprovalAt <= s.to;
    return { cause: 'review', detail: second ? 'approval 2' : 'approval 1' };
  }
  if (s.status === 'blocked' || s.status === 'waiting') {
    if (c.startsAfter) return { cause: 'dependency', detail: c.startsAfter };
    if (c.notes.some(n => n.at >= s.from && n.at <= s.to && MAC.test(n.text))) return { cause: 'mac-or-device' };
    if (c.inbox.some(i => i.createdAt <= s.to && (i.answeredAt === null || i.answeredAt > s.from))) return { cause: 'owner-decision' };
    return { cause: 'unknown' };
  }
  if (s.status === 'ready' && c.assigneeBusy(s.from, s.to) > 0.5) return { cause: 'queued-behind-busy' };
  if (s.status === 'parked') return { cause: 'parked' };
  return { cause: 'unknown' };
}

/** Subtract spans from [from, to); returns the covered and the uncovered pieces. */
function cut(pieces: Span[], spans: Span[]): { hit: number; rest: Span[] } {
  let hit = 0;
  let rest = pieces;
  for (const s of spans) {
    const next: Span[] = [];
    for (const p of rest) {
      const a = Math.max(p.from, s.from), b = Math.min(p.to, s.to);
      if (a >= b) { next.push(p); continue; }
      hit += b - a;
      if (p.from < a) next.push({ from: p.from, to: a });
      if (b < p.to) next.push({ from: b, to: p.to });
    }
    rest = next;
  }
  return { hit, rest };
}

/**
 * LLD-dashboard §3, by time: only the part of a wait that overlaps a pause, a cap or staging-down is charged to it;
 * the rest is charged by the story's own status. Parked is the owner's or lead's choice, charged as parked whole.
 */
export function splitWait(s: Segment, c: CauseCtx): { cause: Cause; ms: number; detail?: string }[] {
  if (s.status === 'parked') return [{ cause: 'parked', ms: s.to - s.from }];
  const out: { cause: Cause; ms: number; detail?: string }[] = [];
  let rest: Span[] = [{ from: s.from, to: s.to }];
  for (const [cause, spans] of [['paused/pace-hold', c.holds], ['budget-cap', c.caps], ['staging-down', c.stagingDown]] as const) {
    const r = cut(rest, [...spans]);
    if (r.hit > 0) out.push({ cause, ms: r.hit });
    rest = r.rest;
  }
  const plain = { ...c, holds: [], caps: [], stagingDown: [] };
  for (const p of rest) {
    const { cause, detail } = waitCause({ status: s.status, from: p.from, to: p.to }, plain);
    out.push({ cause, ms: p.to - p.from, ...(detail ? { detail } : {}) });
  }
  return out;
}
