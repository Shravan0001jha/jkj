import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { seedFeature, requestSpec, chiefOfStaff } from '../src/services/features.js';
import { workplaceTools } from '../src/services/employees.js';
import * as work from '../src/services/work.js';
import * as views from '../src/services/views.js';
import { build as buildDigest } from '../src/services/digest.js';
import { coverage } from '../src/services/requirements.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

const tick = () => new Promise(r => setTimeout(r, 5));

test('the seeded feature routes to five charters with the real statuses and marks its requirements planned', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const f = seedFeature(wp)!;
    assert.equal(f.state, 'in-progress');
    assert.equal(f.requirementIds.length, 4);
    const parts = work.list(wp, { kind: 'assignment', featureId: f.id });
    const byCharter = Object.fromEntries(parts.map(a => [a.charterId, a.state]));
    assert.deepEqual(byCharter, { experts: 'review', server: 'review', mobile: 'building', 'desktop-mac': 'planned', conversation: 'proposed' });
    assert.ok(parts.find(a => a.charterId === 'experts')!.evidence!.notVerified.length > 0, 'honest: not verified yet');
    assert.equal(coverage(wp.requirements()).planned, 4);
    assert.equal(seedFeature(wp), null, 'seeded once');
    const platform = views.pivot(wp, 'platform');
    assert.equal(platform.cells['ios']![f.id]!.total, 3, 'mobile, experts, conversation');
    assert.equal(platform.cells['server']![f.id]!.total, 3, 'server, experts, conversation');
    assert.equal(platform.cells['mac']![f.id]!.total, 3, 'desktop-mac, experts, conversation');
    const pivot = views.pivot(wp, 'charter');
    assert.deepEqual(pivot.rows, ['conversation', 'desktop-mac', 'experts', 'mobile', 'server']);
    assert.equal(pivot.cells['experts']![f.id]!.byState['review'], 1);
    const detail = views.featureDetail(wp, f.id);
    assert.equal(detail.requirements.length, 4);
    assert.ok(detail.requirements.every(r => r.featureIds.includes(f.id)));
  } finally {
    tmp.cleanup();
  }
});

test('a feature stated without a spec is handed to the Chief of Staff, whose write_spec tool moves it to specced', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    const f = work.create(wp, { kind: 'feature', title: 'Daily brief', body: 'A morning brief on the Mac.', platformIds: ['mac'] });
    assert.equal(chiefOfStaff(wp), 'asha');
    const agentId = requestSpec(wp, f);
    await tick();
    assert.ok(agentId);
    assert.ok(fake.last().options.prompt.includes('write_spec'));
    assert.ok(fake.last().options.cwd.includes('/asha/'), 'Asha works in her own worktree');

    const server = workplaceTools(wp, 'asha', () => ({ agentId: agentId!, employeeId: 'asha', startedAt: '', seen: {}, planCaptured: false }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(st);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(ct);
    const names = (await client.listTools()).tools.map(t => t.name);
    assert.ok(names.includes('write_spec') && names.includes('decompose_feature'));
    await client.callTool({ name: 'write_spec', arguments: { featureId: f.id, spec: 'AC1. It speaks at 9. AC2. It is one breath.' } });
    assert.equal(work.get(wp, f.id)!.state, 'specced');
    const r = await client.callTool({ name: 'decompose_feature', arguments: { featureId: f.id } });
    // "It speaks at 9" is the conversation charter's business as well as the Mac's.
    assert.match(JSON.stringify(r.content), /Routed to conversation, desktop-mac/);
    const parts = work.list(wp, { kind: 'assignment', featureId: f.id });
    assert.deepEqual(parts.map(a => a.employeeId).sort(), ['dev', 'rohan']);
    await tick();
    assert.equal(fake.sessions.length, 3, 'Dev\'s and Rohan\'s sessions started from the decomposition');

    // Not the Chief of Staff: refused.
    const tara = workplaceTools(wp, 'tara', () => ({ agentId: 'x', employeeId: 'tara', startedAt: '', seen: {}, planCaptured: false }));
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await tara.instance.connect(st2);
    const c2 = new Client({ name: 't2', version: '1' });
    await c2.connect(ct2);
    const refused = await c2.callTool({ name: 'write_spec', arguments: { featureId: f.id, spec: 'x' } });
    assert.match(JSON.stringify(refused.content), /Only the Chief of Staff/);
    await client.close(); await c2.close();
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('the digest counts what needs the owner, what is blocked, and spend', () => {
  const { wp, tmp } = testWorkplace();
  try {
    seedFeature(wp);
    const text = buildDigest(wp);
    assert.match(text, /^Iris Workplace · needs you \d+ · done yesterday/);
    assert.match(text, /needs you 0/);
    assert.match(text, /real money ₹0 of ₹1000/);
    assert.ok(text.split('\n').length <= 5);
  } finally {
    tmp.cleanup();
  }
});
