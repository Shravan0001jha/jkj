import type { Workplace } from './workplace.js';
import { isAgent } from './v2-map.js';

/**
 * What a wait is (owner, 2 Oct; LLD §19.6c): "any story which has an agent working on it should not
 * be marked blocked; they can be rather assigned to the person working on it". A move into Blocked
 * is classified before it is applied:
 *
 * - `review`  — waiting on a teammate's review or sign-off, said explicitly (`kind: review`): In review, them reviewing;
 * - `handoff` — waiting on a teammate's work, said explicitly (`kind: work`): handed to them, back with item_handback;
 * - `wait`    — waiting on a teammate, no kind given (rework, Oct 2026): status `waiting`, nothing rewritten;
 * - `block`   — waiting on the owner (his Inbox), the COO, someone outside the team, or oneself.
 *
 * The reason is no longer read to guess a review: only an explicit `kind` rewrites the wait.
 */

export type WaitKind = 'review' | 'handoff' | 'wait' | 'block';

/** Someone outside the team: a reserved `waitingOn` (the reason says who). */
export const EXTERNAL = 'external';

/** Deliberately narrow and word-bounded ("previewing" is not a review). Hints only; it no longer decides a wait. */
const REVIEW_RE = /\b(review|reviews|reviewed|reviewing|sign[- ]?off|signs off|signed off|approve|approves|approved|approval)\b/i;

export const isReviewReason = (reason: string | undefined): boolean => !!reason && REVIEW_RE.test(reason);

export function classify(wp: Workplace, spec: { assigneeId?: string | undefined; waitingOn: string; reason?: string | undefined; kind?: 'review' | 'work' | undefined }): WaitKind {
  const { waitingOn } = spec;
  if (waitingOn === 'owner' || waitingOn === EXTERNAL || !isAgent(wp, waitingOn) || waitingOn === spec.assigneeId) return 'block';
  if (spec.kind === 'review') return 'review';
  if (spec.kind === 'work') return 'handoff';
  return 'wait';
}
