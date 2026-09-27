import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkplaceEvent } from '../src/services/workplace.js';
import * as inbox from '../src/services/inbox.js';
import { gate, mergeReviewer, OWNER_ACTIONS, POLICY, requestApproval } from '../src/services/approvals.js';
import { testWorkplace } from './fakes/workplace.js';

test('raising an item emits inbox.updated and a needs-you alert; answering twice is a conflict', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const events: WorkplaceEvent[] = [];
    wp.on(e => events.push(e));
    const item = inbox.raise(wp, { kind: 'question', title: 'Which port?', body: 'A or B?', raisedBy: 'kabir' });
    assert.deepEqual(events.map(e => e.type), ['inbox.updated', 'alert']);
    assert.equal(inbox.openCount(wp), 1);

    assert.throws(() => inbox.answer(wp, item.id, 'answered', undefined, 'web'), /needs a note/);
    assert.throws(() => inbox.answer(wp, item.id, 'nope', 'x', 'web'), /not one of the options/);
    const answered = inbox.answer(wp, item.id, 'answered', 'B', 'telegram');
    assert.equal(answered.state, 'answered');
    assert.equal(answered.answer?.via, 'telegram');
    assert.equal(answered.answer?.note, 'B');
    assert.throws(() => inbox.answer(wp, item.id, 'answered', 'A', 'web'), /already answered/);
    assert.equal(inbox.openCount(wp), 0);
    assert.equal(inbox.list(wp)[0]!.id, item.id);
  } finally {
    tmp.cleanup();
  }
});

test('a dedupe key reuses the open item instead of raising a second one', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const a = inbox.raise(wp, { kind: 'cap', title: 'Cap', body: 'x', raisedBy: 'workplace', dedupeKey: 'cap:today:company' });
    const b = inbox.raise(wp, { kind: 'cap', title: 'Cap', body: 'x', raisedBy: 'workplace', dedupeKey: 'cap:today:company' });
    assert.equal(a.id, b.id);
    assert.equal(inbox.list(wp).length, 1);
  } finally {
    tmp.cleanup();
  }
});

test('the §0 approvals table is encoded as stated', () => {
  assert.equal(POLICY['branch-work'], 'nobody');
  assert.equal(POLICY['merge-own-main'], 'lead');
  assert.equal(POLICY['pr-into-other-repo'], 'repo-lead');
  assert.equal(POLICY['contracts-change'], 'affected-leads+cos');
  assert.equal(POLICY['hire-contractor'], 'lead');
  for (const a of ['permanent-hire', 'org-change', 'release', 'deploy', 'spend-above-cap', 'external-message', 'destructive', 'new-secret'] as const) {
    assert.equal(POLICY[a], 'owner', a);
  }
  assert.equal(OWNER_ACTIONS.length, 8);
});

test('the merge reviewer is always a different identity: the lead for a hire, QA for a lead', () => {
  const { wp, tmp } = testWorkplace();
  try {
    assert.equal(mergeReviewer(wp, 'tara'), 'nikhil');
    assert.equal(mergeReviewer(wp, 'nikhil'), null, 'QA has nobody else in QA to review it; the owner decides');
    wp.org.employees.push({ id: 'arjun', name: 'Arjun', roleId: 'engineer', level: 2, permanent: false, charterIds: ['mobile'], unitId: 'platforms', chapterIds: [], reportsTo: 'tara', workspace: { repo: '/x' }, budget: { inrPerDay: 50, concurrentSessions: 1 }, state: 'idle' });
    assert.equal(mergeReviewer(wp, 'arjun'), 'tara');
  } finally {
    tmp.cleanup();
  }
});

test('the gate opens only for an approved Inbox item on the same subject', () => {
  const { wp, tmp } = testWorkplace();
  try {
    assert.equal(gate(wp, 'branch-work', 'anything').allowed, true);
    assert.equal(gate(wp, 'hire-contractor', 'x').allowed, false, 'lead approvals live on the work item, not this gate');

    let g = gate(wp, 'release', 'rel_1');
    assert.equal(g.allowed, false);
    assert.match(g.reason, /no approval/);

    const item = requestApproval(wp, 'release', 'rel_1', { title: 'Release 0.2.16', body: 'desktop-mac', raisedBy: 'nikhil', kind: 'release' });
    g = gate(wp, 'release', 'rel_1');
    assert.equal(g.allowed, false);
    assert.match(g.reason, /waiting for the owner/);
    assert.equal(g.inboxId, item.id);

    // Same subject, different action: not the same approval.
    assert.equal(gate(wp, 'deploy', 'rel_1').allowed, false);

    inbox.answer(wp, item.id, 'reject', undefined, 'web');
    g = gate(wp, 'release', 'rel_1');
    assert.equal(g.allowed, false);
    assert.match(g.reason, /rejected/);

    // Re-requested after a rejection: a fresh item, newest wins.
    const again = requestApproval(wp, 'release', 'rel_1', { title: 'Release 0.2.16', body: 'desktop-mac', raisedBy: 'nikhil', kind: 'release' });
    assert.notEqual(again.id, item.id);
    inbox.answer(wp, again.id, 'approve', undefined, 'phone');
    g = gate(wp, 'release', 'rel_1');
    assert.equal(g.allowed, true);
    assert.equal(g.inboxId, again.id);

    // Another subject stays closed.
    assert.equal(gate(wp, 'release', 'rel_2').allowed, false);
  } finally {
    tmp.cleanup();
  }
});
