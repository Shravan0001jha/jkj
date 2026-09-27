import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Evidence } from '@jkj/shared';
import * as work from '../src/services/work.js';
import { testWorkplace } from './fakes/workplace.js';

const evidence: Evidence = { tests: { passed: 12, failed: 0, command: 'npm test' }, commits: ['abc123'], liveVerified: ['ran on the Mac'], notVerified: ['iPad'] };

test('an assignment walks proposed → planned → building → review → done, and refuses shortcuts', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const a = work.create(wp, { kind: 'assignment', title: 'Wire the composer', body: 'x', charterId: 'mobile' });
    assert.equal(a.state, 'proposed');
    assert.equal(a.employeeId, 'tara', 'routed to the charter holder');

    assert.throws(() => work.transition(wp, a.id, { to: 'building', by: 'tara' }), /cannot go from proposed to building/);
    assert.throws(() => work.transition(wp, a.id, { to: 'planned', by: 'tara' }), /once a plan is attached/);

    work.transition(wp, a.id, { to: 'planned', by: 'tara', plan: '1. read 2. build 3. test' });
    work.transition(wp, a.id, { to: 'building', by: 'tara' });
    assert.throws(() => work.transition(wp, a.id, { to: 'review', by: 'tara' }), /needs evidence/);
    assert.throws(() => work.transition(wp, a.id, { to: 'review', by: 'tara', evidence: { ...evidence, commits: [] } }), /needs commits, or notes/);

    const reviewed = work.transition(wp, a.id, { to: 'review', by: 'tara', evidence });
    assert.equal(reviewed.state, 'review');
    assert.throws(() => work.transition(wp, a.id, { to: 'done', by: 'tara' }), /cannot verify its own work/);
    const done = work.transition(wp, a.id, { to: 'done', by: 'nikhil' });
    assert.equal(done.state, 'done');
    assert.equal(done.verifiedBy, 'nikhil');
    assert.equal(done.history.length, 5);
    assert.throws(() => work.transition(wp, a.id, { to: 'building', by: 'nikhil' }), /cannot go from done/);
  } finally {
    tmp.cleanup();
  }
});

test('the assignee reporting done lands in review, never in done', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const a = work.create(wp, { kind: 'assignment', title: 'T', body: 'x', employeeId: 'mira' });
    assert.equal(a.charterId, 'experts', 'an employee assignment takes its first charter');
    assert.throws(() => work.reportDone(wp, a.id, evidence, 'mira'), /Attach a plan/);
    work.attachPlan(wp, a.id, 'plan', 'mira');
    const r = work.reportDone(wp, a.id, evidence, 'mira');
    assert.equal(r.state, 'review');
    // Sent back = rework, and the "done" was false.
    const back = work.sendBack(wp, a.id, 'asha', 'tests did not run');
    assert.equal(back.state, 'building');
    assert.match(back.history.at(-1)!.note!, /sent back/);
  } finally {
    tmp.cleanup();
  }
});

test('non-code work reviews with notes and zero tests', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const a = work.create(wp, { kind: 'assignment', title: 'Pricing decision doc', body: 'x', charterId: 'product-and-business' });
    work.attachPlan(wp, a.id, 'write the doc', 'asha');
    work.transition(wp, a.id, { to: 'building', by: 'asha' });
    const r = work.transition(wp, a.id, { to: 'review', by: 'asha', evidence: { tests: { passed: 0, failed: 0 }, commits: [], liveVerified: [], notVerified: [], notes: 'docs/pricing.md written; decision filed to the Inbox' } });
    assert.equal(r.state, 'review');
  } finally {
    tmp.cleanup();
  }
});

test('a feature is decomposed by the map into one assignment per charter, to the least-loaded holder', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const f = work.create(wp, {
      kind: 'feature',
      title: 'Phone→Mac errand flow',
      body: 'State an errand on the phone; it runs on the Mac through the cloud agent; the result comes back to the phone with voice confirmation.',
      platformIds: ['ios', 'android', 'mac'],
      requirementIds: ['REQ-CROSSDEVICE-02'],
    });
    assert.throws(() => work.decompose(wp, f.id), /Write the spec/);
    work.transition(wp, f.id, { to: 'specced', by: 'asha', spec: 'AC1: ... AC2: ...' });

    const { feature, assignments, route } = work.decompose(wp, f.id, { paths: ['iris:services/agent-svc/phone.py', 'iris:services/cloud-agent/worker.py'] });
    assert.equal(feature.state, 'decomposed');
    const charters = assignments.map(a => a.charterId).sort();
    assert.deepEqual(charters, ['conversation', 'desktop-mac', 'experts', 'mobile', 'server']);
    assert.equal(route.primaries.length, 5);
    assert.ok(assignments.every(a => a.featureId === f.id && a.state === 'proposed' && a.spec === 'AC1: ... AC2: ...'));
    assert.ok(assignments.find(a => a.charterId === 'experts')!.body.includes('because of: path:iris:services/agent-svc/phone.py'));

    // Decomposing again is idempotent.
    const again = work.decompose(wp, f.id, { paths: ['iris:services/agent-svc/phone.py'] });
    assert.equal(again.assignments.length, 5);

    // The feature follows its assignments.
    for (const a of assignments) {
      work.attachPlan(wp, a.id, 'p', a.employeeId!);
      work.transition(wp, a.id, { to: 'building', by: a.employeeId! });
    }
    assert.equal(work.get(wp, f.id)!.state, 'in-progress');
    for (const a of assignments) {
      work.transition(wp, a.id, { to: 'review', by: a.employeeId!, evidence });
      work.transition(wp, a.id, { to: 'done', by: 'nikhil' });
    }
    assert.equal(work.get(wp, f.id)!.state, 'built');
  } finally {
    tmp.cleanup();
  }
});

test('a plan is parsed from the first "## Plan" heading', () => {
  assert.equal(work.parsePlan('Hello\n## Plan\n1. a\n2. b\n\n## Next\nx'), '1. a\n2. b');
  assert.equal(work.parsePlan('no plan here'), null);
  assert.equal(work.parsePlan('## plan\nonly'), 'only');
});

test('listing filters by every dimension', () => {
  const { wp, tmp } = testWorkplace();
  try {
    work.create(wp, { kind: 'bug', title: 'B', body: 'x', charterId: 'server' });
    work.create(wp, { kind: 'assignment', title: 'A', body: 'x', charterId: 'server' });
    assert.equal(work.list(wp, { kind: 'bug' }).length, 1);
    assert.equal(work.list(wp, { charterId: 'server' }).length, 2);
    assert.equal(work.list(wp, { employeeId: 'kabir' }).length, 2);
    assert.equal(work.list(wp, { employeeId: 'tara' }).length, 0);
  } finally {
    tmp.cleanup();
  }
});
