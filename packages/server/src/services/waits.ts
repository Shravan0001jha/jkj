import type { Workplace } from './workplace.js';
import { isAgent } from './v2-map.js';

/**
 * What a wait is (owner, 2 Oct; LLD §19.6c): "any story which has an agent working on it should not
 * be marked blocked; they can be rather assigned to the person working on it". A move into Blocked
 * is classified before it is applied:
 *
 * - `review`  — waiting on a teammate's review or sign-off: In review, them reviewing;
 * - `handoff` — waiting on a teammate's work: handed to them, In progress, back with item_handback;
 * - `block`   — waiting on the owner (his Inbox), the COO, someone outside the team, or oneself.
 */

export type WaitKind = 'review' | 'handoff' | 'block';

/** Someone outside the team: a reserved `waitingOn` (the reason says who). */
export const EXTERNAL = 'external';

/** Deliberately narrow and word-bounded ("previewing" is not a review). `kind` overrides it either way. */
const REVIEW_RE = /\b(review|reviews|reviewed|reviewing|sign[- ]?off|signs off|signed off|approve|approves|approved|approval)\b/i;

export const isReviewReason = (reason: string | undefined): boolean => !!reason && REVIEW_RE.test(reason);

export function classify(wp: Workplace, spec: { assigneeId?: string | undefined; waitingOn: string; reason?: string | undefined; kind?: 'review' | 'work' | undefined }): WaitKind {
  const { waitingOn } = spec;
  if (waitingOn === 'owner' || waitingOn === EXTERNAL || !isAgent(wp, waitingOn) || waitingOn === spec.assigneeId) return 'block';
  if (spec.kind === 'review') return 'review';
  if (spec.kind === 'work') return 'handoff';
  return isReviewReason(spec.reason) ? 'review' : 'handoff';
}
