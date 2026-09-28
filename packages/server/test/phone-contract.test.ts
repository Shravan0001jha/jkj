import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, InboxItem, OfficeResponse, OrgProposal, Pivot, Release, WorkItem } from '@jkj/shared';
import type { FeatureBoard, FeatureDetail, ProposalDetail, ReleaseReadiness, RequestResponse } from '@jkj/shared';
import * as work from '../src/services/work.js';
import * as employees from '../src/services/employees.js';
import { boot, call, tick } from './fakes/boot.js';

/**
 * What the phone needs beyond the first contract (29 Sep, night shift): a free-text request that
 * Asha turns into a feature with a status the owner can read; proposals with their diff; release
 * readiness; assignment by employee or charter; the pivot with evidence; Asha as the default Talk.
 */

test('(a) a free-text request becomes a stated feature with Asha asked for the spec, and its status reads back at every stage', async () => {
  const b = await boot();
  try {
    const text = 'Iris should greet me each morning with the weather.\n\nOne sentence, no bubble reopening, weather from a free source. Mac first, then the phone.';
    const made = await call<RequestResponse>(b.base, 'POST', '/api/requests', { text, platformIds: ['mac'] });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.feature.kind, 'feature');
    assert.equal(made.body.feature.state, 'stated');
    assert.equal(made.body.feature.title, 'Iris should greet me each morning with the weather.');
    assert.equal(made.body.feature.body, text);
    assert.deepEqual(made.body.feature.platformIds, ['mac']);
    assert.equal(made.body.status.stage, 'with-asha');
    assert.match(made.body.status.line, /Asha is writing the spec/);
    await tick();
    assert.equal(b.fake.sessions.length, 1, 'Asha got a session');
    assert.match(b.fake.last().options.prompt, /write_spec/);
    assert.match(b.fake.last().options.prompt, /greet me each morning/);
    assert.equal(made.body.status.askedAgentId, employees.openSession('asha')?.agentId, 'the session that was asked');

    const listed = await call<RequestResponse[]>(b.base, 'GET', '/api/requests');
    assert.equal(listed.status, 200);
    assert.equal(listed.body[0]!.feature.id, made.body.feature.id);
    assert.equal(listed.body[0]!.status.stage, 'with-asha');
    assert.equal((await call<{ error: string }>(b.base, 'POST', '/api/requests', { text: '   ' })).status, 400, 'an empty request is refused');

    // Asha's spec lands (the tool would do this): the status says so and names the next step.
    const id = made.body.feature.id;
    await call<WorkItem>(b.base, 'POST', `/api/work/${id}/transition`, { to: 'specced', spec: 'AC1 one sentence. AC2 weather present.' });
    let detail = await call<FeatureDetail>(b.base, 'GET', `/api/features/${id}`);
    assert.equal(detail.body.status.stage, 'specced');
    assert.match(detail.body.status.line, /Spec written .* ready to route/);

    // Routed to several charters: the status counts the assignments by state.
    const dec = await call<{ assignments: WorkItem[] }>(b.base, 'POST', `/api/features/${id}/decompose`, {});
    assert.ok(dec.body.assignments.length >= 1, JSON.stringify(dec.body.assignments.map(a => a.charterId)));
    await tick();
    detail = await call<FeatureDetail>(b.base, 'GET', `/api/features/${id}`);
    assert.equal(detail.body.status.stage, 'building');
    assert.match(detail.body.status.line, /(\d+) of \1 (assignments )?building/);
    assert.equal(detail.body.status.assignments.length, dec.body.assignments.length);
    assert.ok(detail.body.status.assignments.every(a => a.employeeId && a.charterId && a.state === 'building'));
    const board = await call<FeatureBoard>(b.base, 'GET', '/api/features');
    assert.equal(board.body.status[id]!.stage, 'building');
  } finally {
    await b.stop();
  }
});

test('(b) a proposal reads back with its diff and Inbox item; approving it in the Inbox lets apply run; a denial is final', async () => {
  const b = await boot();
  try {
    const made = await call<OrgProposal>(b.base, 'POST', '/api/proposals', { kind: 'split', reason: 'iOS and Android need separate leads', params: { charterId: 'mobile', into: [{ id: 'mobile-ios', keys: ['ios'] }, { id: 'mobile-android', keys: ['android'] }] } });
    assert.equal(made.status, 201);
    const detail = await call<ProposalDetail>(b.base, 'GET', `/api/proposals/${made.body.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.proposal.state, 'pending');
    assert.match(detail.body.proposal.diff, /^\+.*mobile-ios/m, 'a unified diff of the org files');
    assert.match(detail.body.proposal.diff, /^-.*mobile/m);
    assert.equal(detail.body.item.kind, 'org-change');
    assert.deepEqual(detail.body.item.options.map(o => o.id), ['approve', 'reject']);
    assert.ok(detail.body.item.affects.includes('tara'));
    assert.equal((await call<{ error: string }>(b.base, 'GET', '/api/proposals/nope')).status, 404);

    // Apply before approval is refused; approving in the Inbox applies it (one commit); a second apply is a conflict.
    assert.equal((await call<{ error: string }>(b.base, 'POST', `/api/proposals/${made.body.id}/apply`)).status, 400);
    await call<InboxItem>(b.base, 'POST', `/api/inbox/${detail.body.item.id}/answer`, { optionId: 'approve' });
    const applied = await call<ProposalDetail>(b.base, 'GET', `/api/proposals/${made.body.id}`);
    assert.equal(applied.body.proposal.state, 'applied');
    assert.ok(applied.body.proposal.appliedCommit);
    assert.equal((await call<{ error: string }>(b.base, 'POST', `/api/proposals/${made.body.id}/apply`)).status, 409);

    const second = await call<OrgProposal>(b.base, 'POST', '/api/proposals', { kind: 'reassign', reason: 'no', params: { charterId: 'character', toEmployeeId: 'mira' } });
    await call<InboxItem>(b.base, 'POST', `/api/inbox/${second.body.inboxId}/answer`, { optionId: 'reject', note: 'Dev keeps character.' });
    assert.equal((await call<ProposalDetail>(b.base, 'GET', `/api/proposals/${second.body.id}`)).body.proposal.state, 'rejected');
    assert.equal((await call<{ error: string }>(b.base, 'POST', `/api/proposals/${second.body.id}/apply`)).status, 400);
  } finally {
    await b.stop();
  }
});

test('(c) release readiness per shippable: what is done and unreleased, the open release, the last one; approve or reject from the Inbox', async () => {
  const b = await boot();
  try {
    const wp = b.running.wp;
    const a = work.create(wp, { kind: 'assignment', title: 'Composer safe area', body: 'x', employeeId: 'tara', platformIds: ['ios'] });
    work.attachPlan(wp, a.id, 'p', 'tara');
    work.reportDone(wp, a.id, { tests: { passed: 3, failed: 0 }, commits: ['abc1234'], liveVerified: ['device'], notVerified: [] }, 'tara');
    work.transition(wp, a.id, { to: 'done', by: 'nikhil' });

    let ready = await call<ReleaseReadiness[]>(b.base, 'GET', '/api/releases/ready');
    assert.equal(ready.status, 200);
    const ios = ready.body.find(r => r.shippable === 'ios')!;
    assert.equal(ios.unreleased.length, 1);
    assert.match(ios.unreleased[0]!, /Composer safe area/);
    assert.equal(ios.open, undefined);
    assert.equal(ios.last, undefined);
    assert.equal(ready.body.find(r => r.shippable === 'android')!.unreleased.length, 0);

    const rel = await call<Release>(b.base, 'POST', '/api/releases', { shippable: 'ios', version: '1.0.1' });
    ready = await call<ReleaseReadiness[]>(b.base, 'GET', '/api/releases/ready');
    assert.equal(ready.body.find(r => r.shippable === 'ios')!.open?.id, rel.body.id);
    await call<InboxItem>(b.base, 'POST', `/api/inbox/${rel.body.inboxId}/answer`, { optionId: 'reject', note: 'not tonight' });
    const listed = await call<Release[]>(b.base, 'GET', '/api/releases');
    assert.equal(listed.body.find(r => r.id === rel.body.id)!.state, 'rejected');
    ready = await call<ReleaseReadiness[]>(b.base, 'GET', '/api/releases/ready');
    assert.equal(ready.body.find(r => r.shippable === 'ios')!.open, undefined, 'a rejected release is not open');
    assert.equal(ready.body.find(r => r.shippable === 'ios')!.unreleased.length, 1, 'still unreleased');

    const again = await call<Release>(b.base, 'POST', '/api/releases', { shippable: 'ios', version: '1.0.1' });
    await call<InboxItem>(b.base, 'POST', `/api/inbox/${again.body.inboxId}/answer`, { optionId: 'approve' });
    ready = await call<ReleaseReadiness[]>(b.base, 'GET', '/api/releases/ready');
    assert.equal(ready.body.find(r => r.shippable === 'ios')!.open?.state, 'approved');
  } finally {
    await b.stop();
  }
});

test('(d) assign to an employee or to a charter (least-loaded holder), starting the session; a feature routes to several', async () => {
  const b = await boot();
  try {
    const toTara = await call<WorkItem>(b.base, 'POST', '/api/work', { kind: 'assignment', title: 'Fix the keyboard inset', body: 'x', employeeId: 'tara' });
    assert.equal(toTara.status, 201);
    assert.equal(toTara.body.charterId, 'mobile');
    await tick();
    assert.equal(b.fake.sessions.length, 1);
    assert.equal(employees.stateOf(b.running.wp, 'tara'), 'working');

    const toCharter = await call<WorkItem>(b.base, 'POST', '/api/work', { kind: 'assignment', title: 'Weather expert', body: 'x', charterId: 'experts', start: false });
    assert.equal(toCharter.body.employeeId, 'mira');
    assert.equal(toCharter.body.state, 'proposed');
    assert.equal(b.fake.sessions.length, 1, 'start: false');
    const started = await call<Agent>(b.base, 'POST', `/api/work/${toCharter.body.id}/start`);
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.equal(started.body.assignmentId, toCharter.body.id, 'the session that took it');
    await tick();
    assert.equal(b.fake.sessions.length, 2);
    assert.equal((await call<{ error: string }>(b.base, 'POST', '/api/work', { kind: 'assignment', title: 'x', body: 'x', charterId: 'nope' })).status, 400);
  } finally {
    await b.stop();
  }
});

test('(e) the pivot carries the assignments in each cell with their evidence and a link', async () => {
  const b = await boot();
  try {
    const wp = b.running.wp;
    const f = work.create(wp, { kind: 'feature', title: 'Greeting', body: 'x', platformIds: ['mac'] });
    const a = work.create(wp, { kind: 'assignment', title: 'Greeting — experts', body: 'x', charterId: 'experts', featureId: f.id, platformIds: ['mac'] });
    work.attachPlan(wp, a.id, 'p', 'mira');
    work.reportDone(wp, a.id, { tests: { passed: 14, failed: 0, command: 'pytest' }, commits: ['abc1234', 'def5678'], liveVerified: ['spoken once on the Mac'], notVerified: ['phone'] }, 'mira');
    const p = await call<Pivot>(b.base, 'GET', '/api/features/pivot?rows=charter');
    const cell = p.body.cells['experts']![f.id]!;
    assert.equal(cell.total, 1);
    assert.deepEqual(cell.byState, { review: 1 });
    assert.equal(cell.items.length, 1);
    const item = cell.items[0]!;
    assert.equal(item.id, a.id);
    assert.equal(item.employeeId, 'mira');
    assert.equal(item.state, 'review');
    assert.deepEqual(item.evidence, { tests: '14 passed, 0 failed', commits: ['abc1234', 'def5678'], liveVerified: 1, notVerified: 1 });
    assert.equal(item.href, `#/employee/mira?item=${a.id}`);
    const empty = p.body.cells['experts']?.['nothing'];
    assert.equal(empty, undefined);
  } finally {
    await b.stop();
  }
});

test('(f) Asha is the default Talk: POST /api/talk reaches the Chief of Staff, and the Office names her', async () => {
  const b = await boot();
  try {
    const office = await call<OfficeResponse>(b.base, 'GET', '/api/office');
    assert.equal(office.body.chiefOfStaff, 'asha');
    const talk = await call<Agent>(b.base, 'POST', '/api/talk', { text: 'Where do we stand?' });
    assert.equal(talk.status, 201, JSON.stringify(talk.body));
    await tick();
    assert.equal(b.fake.last().options.prompt.includes('Where do we stand?'), true);
    assert.equal(employees.openSession('asha')?.agentId, talk.body.id);
    assert.equal((await call<{ error: string }>(b.base, 'POST', '/api/talk', { text: '' })).status, 400);
  } finally {
    await b.stop();
  }
});
