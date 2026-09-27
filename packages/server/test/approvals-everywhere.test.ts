import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as inbox from '../src/services/inbox.js';
import * as employees from '../src/services/employees.js';
import * as work from '../src/services/work.js';
import * as proposals from '../src/services/proposals.js';
import * as views from '../src/services/views.js';
import { readEmployeeFile } from '../src/services/org.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/** Approvals visible and actionable in three places (HLD D7b). */

const tick = () => new Promise(r => setTimeout(r, 5));

test('affects is computed from the raiser, the assignment, the charters and the cap scope, and always includes the Chief of Staff', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const a = work.create(wp, { kind: 'assignment', title: 'Composer', body: 'x', charterId: 'mobile' });
    const review = inbox.raise(wp, { kind: 'question', title: 'Review requested', body: 'x', raisedBy: 'nikhil', context: { assignmentId: a.id } });
    assert.deepEqual(review.affects.sort(), ['asha', 'nikhil', 'tara']);
    assert.ok(review.onApprove && review.onDeny);

    const cap = inbox.raise(wp, { kind: 'cap', title: 'Cap', body: 'x', raisedBy: 'workplace', context: { scope: 'unit:platforms' } });
    assert.deepEqual(cap.affects.sort(), ['asha', 'rohan', 'tara']);

    const split = proposals.propose(wp, { kind: 'split', reason: 'r', proposedBy: 'asha', params: { charterId: 'mobile', into: [{ id: 'mobile-ios', keys: ['ios'] }, { id: 'mobile-android', keys: ['android'] }] } });
    const orgItem = inbox.get(wp, split.inboxId)!;
    assert.deepEqual(orgItem.affects.sort(), ['asha', 'tara'], 'the holder of the charter being split');

    const reassign = proposals.propose(wp, { kind: 'reassign', reason: 'r', proposedBy: 'asha', params: { charterId: 'character', toEmployeeId: 'mira' } });
    assert.deepEqual(inbox.get(wp, reassign.inboxId)!.affects.sort(), ['asha', 'dev', 'mira']);

    // Each page lists exactly what concerns it; the Chief of Staff sees everything.
    assert.deepEqual(views.employeeDetail(wp, 'tara').needsYou.map(i => i.title).sort(), ['Cap', 'Review requested', 'Split charter: mobile into mobile-ios + mobile-android']);
    assert.deepEqual(views.employeeDetail(wp, 'rohan').needsYou.map(i => i.title), ['Cap']);
    assert.equal(views.employeeDetail(wp, 'asha').needsYou.length, inbox.list(wp, 'open').length);
    assert.equal(employees.card(wp, 'tara').needsYou, 3);
  } finally {
    tmp.cleanup();
  }
});

test('answering in one place resolves it everywhere, live; a denial reaches the raiser', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    mkdirSync(join(tmp.dir, 'ops', 'workplace'), { recursive: true });
    writeFileSync(join(tmp.dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=x\n');
    const events: string[] = [];
    wp.on(e => { if (e.type === 'inbox.updated') events.push(e.item.state); });
    const item = inbox.raise(wp, { kind: 'decision', title: 'Adopt the three tiers?', body: 'x', raisedBy: 'asha', options: [{ id: 'adopt', label: 'Adopt' }, { id: 'reject', label: 'Keep cap plans', danger: true }] });
    assert.equal(views.employeeDetail(wp, 'asha').needsYou.length, 1);
    // Asha has no session open: the denial lands in her handoff for the next one.
    inbox.answer(wp, item.id, 'reject', 'Not before the cost audit.', 'phone');
    assert.deepEqual(events, ['open', 'answered']);
    assert.equal(views.employeeDetail(wp, 'asha').needsYou.length, 0, 'gone from her page');
    assert.equal(inbox.list(wp, 'open').length, 0, 'gone from the Inbox');
    const handoff = readEmployeeFile(wp.org, 'asha', 'handoff.md');
    assert.match(handoff, /## Denied: Adopt the three tiers\?/);
    assert.match(handoff, /Reason: Not before the cost audit\./);

    // With a session open, the denial goes straight into it.
    employees.talk(wp, 'mira', 'go');
    await tick();
    const q = inbox.raise(wp, { kind: 'approval', title: 'Add a Deepgram key', body: 'x', raisedBy: 'mira' });
    inbox.answer(wp, q.id, 'reject', 'Use the existing one.', 'web');
    assert.ok(fake.last().sent.some(m => /denied "Add a Deepgram key": Use the existing one/.test(m.text)));
    assert.throws(() => inbox.answer(wp, q.id, 'approve', undefined, 'web'), /already answered/, 'never answered twice');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});
