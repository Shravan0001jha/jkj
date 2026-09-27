import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as proposals from '../src/services/proposals.js';
import * as inbox from '../src/services/inbox.js';
import * as work from '../src/services/work.js';
import { commitOrg, orgHistory } from '../src/services/org.js';
import { assembleContext } from '../src/services/context-layers.js';
import { lint } from '../src/services/ownership.js';
import { testWorkplace } from './fakes/workplace.js';

const noDisk = { exists: () => true, topLevelDirs: () => [] };

test('splitting mobile into iOS and Android moves the map, keeps the holder on the first, and is a diff until approved', () => {
  const { wp, tmp } = testWorkplace();
  try {
    commitOrg(wp.org.dir, 'Seed the first organisation');
    const p = proposals.propose(wp, {
      kind: 'split', reason: 'The phone queue keeps growing and iOS and Android need different hands.', proposedBy: 'asha',
      params: {
        charterId: 'mobile',
        into: [
          { id: 'mobile-ios', title: 'Mobile: iOS', mission: 'Own the iPhone and iPad app.', keys: ['iris-mobile:mobile/ios', 'ios', 'ipad', 'iphone', 'testflight', 'widget', 'live activit'] },
          { id: 'mobile-android', title: 'Mobile: Android', mission: 'Own the Android app.', keys: ['iris-mobile:mobile/android', 'android'] },
        ],
      },
    });
    assert.equal(p.state, 'pending');
    assert.ok(p.diff.includes('+++ org/charters/mobile-ios.md') || p.diff.includes('mobile-ios.md'), 'the diff names the new charter file');
    assert.ok(p.after.charters.some(c => c.id === 'mobile-ios') && p.after.charters.some(c => c.id === 'mobile-android'));
    assert.ok(!p.after.charters.some(c => c.id === 'mobile'));
    assert.equal(p.after.map.find(m => m.kind === 'platform' && m.key === 'android')!.primary, 'mobile-android');
    assert.equal(p.after.map.find(m => m.kind === 'platform' && m.key === 'ios')!.primary, 'mobile-ios');
    assert.equal(p.after.map.find(m => m.kind === 'requirement-group' && m.key === 'Cross-device')!.primary, 'mobile-ios', 'unnamed keys go to the first target');
    assert.deepEqual(p.after.employees.find(e => e.id === 'tara')!.charterIds, ['mobile-ios']);
    assert.ok(p.lint.some(f => f.code === 'unheld-charter' && f.subject === 'mobile-android'), 'the second charter waits for a hire');
    assert.ok(!p.lint.some(f => f.severity === 'error'));

    // Nothing changed on disk yet.
    assert.equal(wp.org.charters.has('mobile'), true);
    assert.equal(existsSync(join(wp.org.dir, 'charters', 'mobile-ios.md')), false);
    assert.throws(() => proposals.apply(wp, p.id), /not approved/);

    // The owner approves in the Inbox: applied, committed, reloaded.
    inbox.answer(wp, p.inboxId, 'approve', undefined, 'phone');
    const applied = proposals.get(wp, p.id)!;
    assert.equal(applied.state, 'applied');
    assert.ok(applied.appliedCommit);
    assert.equal(wp.org.charters.has('mobile'), false);
    assert.equal(wp.org.charters.get('mobile-ios')!.holderIds[0], 'tara');
    assert.equal(existsSync(join(wp.org.dir, 'charters', 'mobile.md')), false);
    assert.match(orgHistory(wp.org.dir)[0]!.message, /Split charter: mobile into mobile-ios \+ mobile-android/);
    assert.throws(() => proposals.apply(wp, p.id), /already applied/);
  } finally {
    tmp.cleanup();
  }
});

test('a hire from a role template holds the new charter and routes work with no code change', () => {
  const { wp, tmp } = testWorkplace();
  try {
    commitOrg(wp.org.dir, 'Seed');
    const split = proposals.propose(wp, { kind: 'split', reason: 'r', proposedBy: 'asha', params: { charterId: 'mobile', into: [{ id: 'mobile-ios', keys: ['ios', 'ipad', 'iris-mobile:mobile/ios'] }, { id: 'mobile-android', keys: ['android', 'iris-mobile:mobile/android'] }] } });
    inbox.answer(wp, split.inboxId, 'approve', undefined, 'web');

    // Before the hire: an Android feature routes to an unheld charter.
    const before = work.routeFeature(wp, work.create(wp, { kind: 'feature', title: 'Android floating bubble', body: 'The floating Iris bubble on Android.', platformIds: ['android'] }));
    assert.deepEqual(before.primaries.map(h => h.charterId), ['mobile-android']);
    assert.equal(wp.org.charters.get('mobile-android')!.holderIds.length, 0);

    const hire = proposals.propose(wp, { kind: 'hire', reason: 'Android needs its own lead.', proposedBy: 'asha', params: { name: 'Arjun', roleId: 'lead', charterIds: ['mobile-android'], reportsTo: 'asha', unitId: 'platforms' } });
    assert.ok(hire.after.employees.some(e => e.id === 'arjun' && e.level === 1 && e.permanent && e.githubApp === 'iris-mobile-android-lead'));
    assert.ok(!hire.lint.some(f => f.code === 'unheld-charter'));
    inbox.answer(wp, hire.inboxId, 'approve', undefined, 'telegram');

    assert.deepEqual(wp.org.charters.get('mobile-android')!.holderIds, ['arjun']);
    const a = work.create(wp, { kind: 'assignment', title: 'Bubble', body: 'x', charterId: 'mobile-android' });
    assert.equal(a.employeeId, 'arjun');
    const ctx = assembleContext(wp.org, wp.org.employees.find(e => e.id === 'arjun')!);
    assert.ok(ctx.append.includes('## Charter: mobile-android') || ctx.append.includes('## Charter: Mobile'));
    assert.ok(ctx.append.includes('## Unit: Platforms'));
    assert.equal(lint(wp.org, wp.requirements(), noDisk).filter(f => f.severity === 'error').length, 0);
    assert.equal(orgHistory(wp.org.dir).length, 3);
  } finally {
    tmp.cleanup();
  }
});

test('a contractor hire gets a branch in the lead\'s repo and cannot itself propose', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const hire = proposals.propose(wp, { kind: 'hire', reason: 'One task.', proposedBy: 'tara', params: { name: 'Priya', roleId: 'engineer', charterIds: ['mobile'], reportsTo: 'tara' } });
    const priya = hire.after.employees.find(e => e.id === 'priya')!;
    assert.equal(priya.level, 2);
    assert.equal(priya.permanent, false);
    assert.equal(priya.workspace.repo, '/Users/shravan0001jha/claude-dev-mobile');
    assert.equal(priya.workspace.branch, 'priya/work');
    assert.equal(priya.githubApp, undefined);
    inbox.answer(wp, hire.inboxId, 'approve', undefined, 'web');
    assert.throws(() => proposals.propose(wp, { kind: 'hire', reason: 'x', proposedBy: 'priya', params: { name: 'Z', roleId: 'engineer', charterIds: [] } }), /no level 3/);
    assert.throws(() => proposals.propose(wp, { kind: 'hire', reason: 'x', proposedBy: 'tara', params: { name: 'Q', roleId: 'engineer', charterIds: [], reportsTo: 'priya' } }), /no level 3/);
  } finally {
    tmp.cleanup();
  }
});

test('retire needs a successor for held charters; merge and reassign remap the map', () => {
  const { wp, tmp } = testWorkplace();
  try {
    assert.throws(() => proposals.propose(wp, { kind: 'retire', reason: 'x', proposedBy: 'asha', params: { employeeId: 'rohan' } }), /successorId/);
    const retire = proposals.propose(wp, { kind: 'retire', reason: 'x', proposedBy: 'asha', params: { employeeId: 'rohan', successorId: 'tara' } });
    assert.deepEqual(retire.after.employees.find(e => e.id === 'tara')!.charterIds, ['mobile', 'desktop-mac', 'windows']);

    const merge = proposals.propose(wp, { kind: 'merge', reason: 'x', proposedBy: 'asha', params: { charterIds: ['qa-release', 'beta-ops'], into: 'quality' } });
    assert.ok(merge.after.charters.some(c => c.id === 'quality'));
    assert.ok(merge.after.map.every(m => m.primary !== 'qa-release' && m.primary !== 'beta-ops'));
    assert.deepEqual(merge.after.employees.find(e => e.id === 'nikhil')!.charterIds, ['quality']);

    const reassign = proposals.propose(wp, { kind: 'reassign', reason: 'x', proposedBy: 'asha', params: { charterId: 'character', toEmployeeId: 'mira' } });
    assert.deepEqual(reassign.after.employees.find(e => e.id === 'dev')!.charterIds, ['conversation']);
    assert.deepEqual(reassign.after.employees.find(e => e.id === 'mira')!.charterIds, ['experts', 'character']);

    const restructure = proposals.propose(wp, { kind: 'restructure', reason: 'x', proposedBy: 'asha', params: { units: [{ id: 'growth', title: 'Growth', parentId: 'product', kind: 'chapter' }], moves: [{ employeeId: 'dev', chapterIds: ['growth'] }] } });
    assert.ok(restructure.after.units.some(u => u.id === 'growth'));
    assert.deepEqual(restructure.after.employees.find(e => e.id === 'dev')!.chapterIds, ['growth']);

    // A rejection is kept with its reason and never applied.
    inbox.answer(wp, retire.inboxId, 'reject', 'Rohan stays', 'web');
    assert.equal(proposals.get(wp, retire.id)!.state, 'rejected');
    assert.ok(wp.org.employees.some(e => e.id === 'rohan'));
    assert.equal(proposals.list(wp).length, 4, 'the refused retire never became a proposal');
  } finally {
    tmp.cleanup();
  }
});

test('a proposal with a bad reference is refused outright', () => {
  const { wp, tmp } = testWorkplace();
  try {
    assert.throws(() => proposals.propose(wp, { kind: 'reassign', reason: 'x', proposedBy: 'asha', params: { charterId: 'nope', toEmployeeId: 'mira' } }), /No charter nope/);
    assert.throws(() => proposals.propose(wp, { kind: 'hire', reason: '', proposedBy: 'asha', params: {} }), /needs a reason/);
  } finally {
    tmp.cleanup();
  }
});
