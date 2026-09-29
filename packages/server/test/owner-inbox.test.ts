import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cos from '../src/services/cos.js';
import * as inbox from '../src/services/inbox.js';
import * as work from '../src/services/work.js';
import * as runs from '../src/services/runs.js';
import * as employees from '../src/services/employees.js';
import * as health from '../src/services/health.js';
import * as spend from '../src/services/spend.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * The owner's rule: only real decisions reach his Inbox. Stall notices, "did nothing" items and
 * routine review requests are Asha's, never his; a restart must not re-raise what was already
 * noted; the pre-fix flood and the stale pre-migration cap item are cleaned up once, durably.
 */

const tick = () => new Promise(r => setTimeout(r, 5));

function ops(tmp: { dir: string }): void {
  mkdirSync(join(tmp.dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(tmp.dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=x\n');
}

test('rule 1: a stall note (cos.ts) never reaches the owner\'s Inbox, only Asha\'s page', async () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_STALL_MINUTES: '30', WORKPLACE_USD_INR: '100', WORKPLACE_CAP_INR: '100000' });
  const fake = installFakeRuntime();
  try {
    ops(tmp);
    const a = work.create(wp, { kind: 'assignment', title: 'Composer', body: 'x', charterId: 'mobile', employeeId: 'tara' });
    work.attachPlan(wp, a.id, 'p', 'tara');
    // Something real to wait on, so the routine notes instead of resuming.
    inbox.raise(wp, { kind: 'decision', title: 'Adopt tiers?', body: 'x', raisedBy: 'tara', context: { assignmentId: a.id, lostSession: 'run_x' } });
    const nowMs = Date.now() + 31 * 60_000;
    const before = inbox.openCount(wp);
    const result = cos.tick(wp, nowMs);
    assert.equal(result.noted.length, 1, JSON.stringify(result));
    // Never counted, never on GET /api/inbox's list.
    assert.equal(inbox.openCount(wp), before, 'the owner\'s count does not move');
    const note = inbox.list(wp, 'open').find(cos.isRoutineNote)!;
    assert.equal(note.ownerFacing, false);
    assert.equal(inbox.ownerList(wp, 'open').some(i => i.id === note.id), false);
    // Still on Asha's own page.
    assert.ok(inbox.forEmployee(wp, 'asha').some(i => i.id === note.id), 'Asha still sees it');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('rule 1: "did nothing for 10 minutes" (health.ts) never reaches the owner\'s Inbox; a restart\'s fresh session does not re-raise it', async () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_USD_INR: '100', WORKPLACE_CAP_INR: '100000' });
  const fake = installFakeRuntime();
  try {
    ops(tmp);
    health.setHandoffWait(50);
    const a = work.create(wp, { kind: 'assignment', title: 'Greeting', body: 'x', employeeId: 'mira' });
    employees.assign(wp, a.id);
    await tick();
    const before = inbox.openCount(wp);

    const first = await health.handleStalls(wp, Date.now() + 11 * 60_000);
    assert.equal(first.length, 1);
    await tick();
    const item = inbox.list(wp, 'open').find(i => cos.isStallDetectorItem(i) && i.raisedBy === 'mira')!;
    assert.ok(item, 'the item exists');
    assert.equal(item.ownerFacing, false, 'never owner-facing');
    assert.equal(inbox.openCount(wp), before, 'the owner\'s count does not move');
    // The routine item does not force "needs-owner" any more (B16): the honest label is that her
    // assignment is blocked, not that the owner has something to answer.
    assert.equal(employees.stateOf(wp, 'mira'), 'blocked');

    // Simulate a restart: a fresh session (a different run id) for the same assignment goes stale too.
    employees.assign(wp, a.id);
    await tick();
    const second = await health.handleStalls(wp, Date.now() + 22 * 60_000);
    assert.equal(second.length, 1);
    await tick();
    const openStallItems = inbox.list(wp, 'open').filter(i => cos.isStallDetectorItem(i) && i.raisedBy === 'mira');
    assert.equal(openStallItems.length, 1, 'the durable key (employee + assignment) reused the same item, not a duplicate');
  } finally {
    health.setHandoffWait(30_000);
    fake.restore();
    tmp.cleanup();
  }
});

test('rule 6: a routine review request is never owner-facing; it still shows for Asha', async () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_USD_INR: '100', WORKPLACE_CAP_INR: '100000' });
  const fake = installFakeRuntime();
  try {
    ops(tmp);
    const a = work.create(wp, { kind: 'assignment', title: 'Greeting', body: 'x', employeeId: 'mira' });
    const before = inbox.openCount(wp);
    inbox.raise(wp, { kind: 'question', title: `Review requested: ${a.title}`, body: 'Please verify.', raisedBy: 'mira', context: { assignmentId: a.id }, dedupeKey: `review:${a.id}`, ownerFacing: false });
    assert.equal(inbox.openCount(wp), before, 'not counted against the owner');
    assert.ok(inbox.forEmployee(wp, 'asha').some(i => i.title.startsWith('Review requested:')));
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('B16: a live, working session is never shown as needs-owner because of a routine (non-owner-facing) item', async () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_USD_INR: '100', WORKPLACE_CAP_INR: '100000' });
  const fake = installFakeRuntime();
  try {
    ops(tmp);
    employees.talk(wp, 'kabir', 'hello');
    await tick();
    assert.equal(employees.stateOf(wp, 'kabir'), 'working', 'control: no stray item yet');
    // A routine, non-owner-facing item raised by Kabir (e.g. a leftover stall notice from before a
    // resume) must not override his live, working status.
    inbox.raise(wp, { kind: 'question', title: 'Kabir is stalled', body: 'old', raisedBy: 'kabir', context: { agentId: 'run_old', reason: 'idle' }, ownerFacing: false });
    assert.equal(employees.stateOf(wp, 'kabir'), 'working', 'still working: the routine item is not the owner\'s business');

    // A REAL owner-facing item raised by Kabir still takes priority (unchanged behaviour).
    inbox.raise(wp, { kind: 'decision', title: 'Real question', body: 'x', raisedBy: 'kabir' });
    assert.equal(employees.stateOf(wp, 'kabir'), 'needs-owner');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('legacy flood cleanup: pre-fix open stall/idle/[TEST] items are withdrawn once; a real open review request is moved off the owner\'s Inbox, not withdrawn; decisions and real org-changes are untouched', async () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_USD_INR: '100', WORKPLACE_CAP_INR: '100000' });
  const fake = installFakeRuntime();
  try {
    ops(tmp);
    const a = work.create(wp, { kind: 'assignment', title: 'Composer', body: 'x', employeeId: 'tara' });
    // Pre-fix items: raised the old way, with no `ownerFacing` field at all.
    const legacyNote = inbox.raise(wp, { kind: 'question', title: `Waiting: ${a.title}`, body: 'old', raisedBy: 'asha', context: { assignmentId: a.id, employeeId: 'tara', stalledSince: null, reason: 'x' } });
    const legacyStall = inbox.raise(wp, { kind: 'question', title: 'Tara is stalled', body: 'idle', raisedBy: 'tara', context: { agentId: 'run_dead', reason: 'idle' } });
    const legacyReview = inbox.raise(wp, { kind: 'question', title: `Review requested: ${a.title}`, body: 'Please verify.', raisedBy: 'tara', context: { assignmentId: a.id } });
    const testFixture = inbox.raise(wp, { kind: 'org-change', title: 'Hire: Testy', body: 'x', summary: '[TEST] QA fixture: reject this.', raisedBy: 'owner' });
    const realDecision = inbox.raise(wp, { kind: 'decision', title: 'Adopt tiers?', body: 'x', raisedBy: 'asha' });
    const realOrgChange = inbox.raise(wp, { kind: 'org-change', title: 'Split charter: mobile', body: 'x', raisedBy: 'asha' });

    const before = inbox.openCount(wp);
    const result = cos.cleanupLegacyInbox(wp);
    assert.deepEqual(result.withdrawn.sort(), [legacyNote.id, legacyStall.id, testFixture.id].sort());
    assert.deepEqual(result.reclassified, [legacyReview.id]);

    assert.equal(inbox.get(wp, legacyNote.id)!.state, 'expired');
    assert.equal(inbox.get(wp, legacyStall.id)!.state, 'expired');
    assert.equal(inbox.get(wp, testFixture.id)!.state, 'expired');
    assert.equal(inbox.get(wp, legacyReview.id)!.state, 'open', 'not withdrawn: real, open work');
    assert.equal(inbox.get(wp, legacyReview.id)!.ownerFacing, false, 'moved off the owner\'s Inbox');
    assert.equal(inbox.get(wp, realDecision.id)!.state, 'open');
    assert.equal(inbox.get(wp, realOrgChange.id)!.state, 'open');
    assert.notEqual(inbox.get(wp, realDecision.id)!.ownerFacing, false);
    assert.notEqual(inbox.get(wp, realOrgChange.id)!.ownerFacing, false);
    assert.ok(inbox.openCount(wp) < before, 'the owner\'s open count drops');

    // Idempotent: a second run (a restart) touches nothing more.
    assert.deepEqual(cos.cleanupLegacyInbox(wp), { withdrawn: [], reclassified: [] });
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('the stale pre-migration cap item is resolved as obsolete, every boot, not just once', () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_USD_INR: '100', WORKPLACE_CAP_INR: '100000' });
  try {
    spend.migrateToRealMoney(wp); // sets the cutover marker
    const staleDay = spend.dayOf(new Date(Date.parse((wp.db.prepare("select value from settings where key = 'migrated:real-money'").get() as { value: string }).value) - 24 * 3600 * 1000));
    const stale = inbox.raise(wp, { kind: 'cap', title: 'Spend cap reached: employee:mira', body: 'x', raisedBy: 'workplace', context: { scope: 'employee:mira', day: staleDay, spent: 151.68, cap: 150 }, dedupeKey: `cap:${staleDay}:employee:mira` });
    const result = spend.resolveStalePreMigrationCapItems(wp);
    assert.deepEqual(result.resolved, [stale.id]);
    assert.equal(inbox.get(wp, stale.id)!.state, 'answered');
    assert.match(inbox.get(wp, stale.id)!.answer!.note ?? '', /old equivalent-cost model/);
    // Idempotent.
    assert.deepEqual(spend.resolveStalePreMigrationCapItems(wp), { resolved: [] });

    // A current, real cap item is untouched.
    const today = spend.dayOf();
    const real = inbox.raise(wp, { kind: 'cap', title: 'Spend cap reached: company', body: 'x', raisedBy: 'workplace', context: { scope: 'company', day: today, spent: 999, cap: 1000 }, dedupeKey: `cap:${today}:company` });
    spend.resolveStalePreMigrationCapItems(wp);
    assert.equal(inbox.get(wp, real.id)!.state, 'open');
  } finally {
    tmp.cleanup();
  }
});
