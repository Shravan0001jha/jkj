import type { InboxItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as inbox from './inbox.js';

/**
 * Who approves what (the brief §0, final), enforced as gates in code.
 *
 * An outward action runs only through a gate, and a gate opens only for an
 * approved Inbox item whose subject matches. An AI manager's approval is
 * recorded where the table says so, but it is never a safety gate: in
 * Project Vend the AI "CEO" co-signed bad decisions.
 */

export type Action =
  | 'branch-work'            // work on a branch in own repo, run tests
  | 'merge-own-main'         // merge to own repo's main
  | 'pr-into-other-repo'     // PR into another lead's repo
  | 'contracts-change'       // change to the shared contracts repo
  | 'hire-contractor'        // within budget
  | 'permanent-hire'
  | 'org-change'             // create, split, merge a charter; change the ownership map
  | 'release'                // release, deploy, TestFlight, store upload
  | 'deploy'
  | 'spend-above-cap'
  | 'external-message'
  | 'destructive'            // force-push, history rewrite, deleting repos or data
  | 'new-secret';

export type Approver = 'nobody' | 'lead' | 'qa' | 'repo-lead' | 'affected-leads+cos' | 'owner';

export const POLICY: Record<Action, Approver> = {
  'branch-work': 'nobody',
  'merge-own-main': 'lead',            // a different identity: lead for a hire's PR, QA for a lead's own PR
  'pr-into-other-repo': 'repo-lead',
  'contracts-change': 'affected-leads+cos',
  'hire-contractor': 'lead',
  'permanent-hire': 'owner',
  'org-change': 'owner',
  'release': 'owner',
  'deploy': 'owner',
  'spend-above-cap': 'owner',
  'external-message': 'owner',
  'destructive': 'owner',
  'new-secret': 'owner',
};

/** Actions only the owner can approve; every one of them is an Inbox item. */
export const OWNER_ACTIONS = (Object.keys(POLICY) as Action[]).filter(a => POLICY[a] === 'owner');

export interface GateResult {
  allowed: boolean;
  approver: Approver;
  reason: string;
  inboxId?: string;
}

/**
 * Who reviews a merge to a repo's main: a different identity from the author.
 * A hire's PR is reviewed by the lead; a lead's own PR by QA. Never the author.
 */
export function mergeReviewer(wp: Workplace, authorId: string): string | null {
  const author = wp.org.employees.find(e => e.id === authorId);
  if (!author) return null;
  if (author.level === 2 && author.reportsTo) return author.reportsTo;
  const qa = wp.org.employees.find(e => e.roleId === 'qa' && e.id !== authorId);
  return qa?.id ?? null;
}

/**
 * The gate. `subject` names what is being acted on (a release id, a proposal
 * id, a script name); the approval must be for exactly that subject.
 */
export function gate(wp: Workplace, action: Action, subject: string): GateResult {
  const approver = POLICY[action];
  if (approver === 'nobody') return { allowed: true, approver, reason: 'free within the charter' };
  if (approver !== 'owner') {
    // Non-owner approvals are recorded on the work item (work.ts), not here;
    // this gate is for outward actions, which are all the owner's.
    return { allowed: false, approver, reason: `${action} is approved by ${approver} on the work item, not through this gate` };
  }

  const item = findApproval(wp, action, subject);
  if (!item) return { allowed: false, approver, reason: `no approval in the Inbox for ${action} ${subject}` };
  if (item.state !== 'answered') return { allowed: false, approver, reason: `waiting for the owner (${item.id})`, inboxId: item.id };
  if (item.answer?.optionId !== 'approve') return { allowed: false, approver, reason: `the owner rejected it (${item.id})`, inboxId: item.id };
  return { allowed: true, approver, reason: `approved by the owner in ${item.id}`, inboxId: item.id };
}

/** File the request that will later open the gate. Idempotent per subject. */
export function requestApproval(wp: Workplace, action: Action, subject: string, spec: {
  title: string; body: string; raisedBy: string; kind?: InboxItem['kind']; context?: Record<string, unknown>;
}): InboxItem {
  return inbox.raise(wp, {
    kind: spec.kind ?? 'approval',
    title: spec.title,
    body: spec.body,
    raisedBy: spec.raisedBy,
    context: { ...(spec.context ?? {}), action, subject },
    dedupeKey: `${action}:${subject}`,
  });
}

function findApproval(wp: Workplace, action: Action, subject: string): InboxItem | undefined {
  // Newest first, so a re-requested approval after a rejection is what counts.
  return inbox.list(wp).find(i => i.context['action'] === action && i.context['subject'] === subject);
}
