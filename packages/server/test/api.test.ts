import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { OfficeResponse, InboxItem, WorkItem, DecomposeResponse, Release, EmployeeDetail, ContextResponse } from '@jkj/shared';
import { loadConfig } from '../src/config.js';
import { start, type Running } from '../src/index.js';
import * as releases from '../src/services/releases.js';
import { installFakeRuntime, type FakeRuntime } from './fakes/fake-runtime.js';
import { tmpWorkplace, type TmpWorkplace } from './fakes/tmp-workplace.js';

/**
 * The server over real HTTP and a real socket, against a temp workplace and
 * the fake runtime. What the phone and the page will actually talk to.
 */

interface Booted { running: Running; base: string; tmp: TmpWorkplace; fake: FakeRuntime; stop(): Promise<void> }

async function boot(): Promise<Booted> {
  const tmp = tmpWorkplace();
  tmp.db.close();
  mkdirSync(join(tmp.dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(tmp.dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test\n');
  const fake = installFakeRuntime();
  const config = loadConfig(['--no-open', '--no-telegram', '--no-seed', '--port', '0'], {
    IRIS_WORKPLACE_DIR: tmp.dir, IRIS_OPS_DIR: join(tmp.dir, 'ops'), WORKPLACE_CAP_INR: '1000', WORKPLACE_USD_INR: '88',
  });
  const running = await start(config);
  const address = running.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { running, base: `http://127.0.0.1:${port}`, tmp, fake, stop: async () => { await running.stop(); fake.restore(); tmp.cleanup(); } };
}

async function call<T>(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() as T };
}

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

test('the Office answers with the seed organisation, coverage, the open decisions and spend', async () => {
  const b = await boot();
  try {
    const { status, body } = await call<OfficeResponse>(b.base, 'GET', '/api/office');
    assert.equal(status, 200);
    assert.equal(body.units.length, 4);
    assert.equal(body.units.flatMap(u => u.employees).length, 7);
    assert.equal(body.coverage.total, 206);
    assert.equal(body.coverage.owned, 206);
    assert.equal(body.needsYou, 8, 'the eight open product decisions are in the Inbox on first boot');
    assert.equal(body.coverage.planned, 4, 'the seeded feature plans four cross-device requirements');
    assert.equal(body.spend.capInr, 1000);
    assert.equal(body.lintErrors, 0);
    const health = await call<{ workplace: { capInr: number } }>(b.base, 'GET', '/api/health');
    assert.equal(health.body.workplace.capInr, 1000);
    // A second boot does not file the decisions twice.
    const inbox = await call<InboxItem[]>(b.base, 'GET', '/api/inbox');
    assert.equal(inbox.body.filter(i => i.kind === 'decision').length, 8);
  } finally {
    await b.stop();
  }
});

test('a stated feature is specced, decomposed by the map, and every assignee gets a session with its context and no API key', async () => {
  const b = await boot();
  process.env['ANTHROPIC_API_KEY'] = 'sk-must-not-reach-employees';
  try {
    const feature = await call<WorkItem>(b.base, 'POST', '/api/features', {
      title: 'Phone→Mac errand flow',
      body: 'State an errand on the phone; it runs on the Mac through the cloud agent; the result and a voice confirmation come back to the phone.',
      platformIds: ['ios', 'android', 'mac'],
      requirementIds: ['REQ-CROSSDEVICE-02'],
      spec: 'AC1: an errand typed on the iPhone appears as a Mac task within 5 s. AC2: the Mac result shows on the phone. AC3: she says one sentence when it lands.',
    });
    assert.equal(feature.status, 201);
    assert.equal(feature.body.state, 'specced');

    const events: string[] = [];
    const ws = new WebSocket(`${b.base.replace('http', 'ws')}/ws`);
    ws.on('message', raw => events.push((JSON.parse(String(raw)) as { type: string }).type));
    await new Promise(r => ws.once('open', r));

    b.fake.onStart = s => s.say(`## Plan\n1. Read ${s.options.cwd}\n2. Build\n3. Test`);
    const d = await call<DecomposeResponse>(b.base, 'POST', `/api/features/${feature.body.id}/decompose`, { paths: ['iris:services/agent-svc/phone.py', 'iris:services/cloud-agent/worker.py'] });
    assert.equal(d.status, 200);
    const charters = d.body.assignments.map(a => a.charterId).sort();
    assert.deepEqual(charters, ['conversation', 'desktop-mac', 'experts', 'mobile', 'server']);
    await tick(50);
    assert.equal(b.fake.sessions.length, 5);
    for (const s of b.fake.sessions) {
      assert.ok(s.options.systemPromptAppend!.includes('## Assignment: Phone→Mac errand flow'));
      assert.ok(s.options.systemPromptAppend!.includes('AC1: an errand typed on the iPhone'));
      assert.equal('ANTHROPIC_API_KEY' in s.options.env!, false);
      assert.equal(s.options.env!['CLAUDE_CODE_OAUTH_TOKEN'], 'sk-ant-oat-test');
    }
    const mobile = b.fake.sessions.find(s => s.options.cwd === '/Users/shravan0001jha/claude-dev-mobile');
    assert.ok(mobile, 'Tara works in the mobile worktree');

    const after = await call<{ assignments: WorkItem[] }>(b.base, 'GET', `/api/features/${feature.body.id}`);
    assert.ok(after.body.assignments.every(a => a.state === 'planned' && a.plan?.startsWith('1. Read')));
    const detail = await call<EmployeeDetail>(b.base, 'GET', '/api/employees/tara');
    assert.equal(detail.body.sessions.length, 1);
    assert.equal(detail.body.employee.state, 'working');
    assert.ok(events.includes('work.updated') && events.includes('office.updated') && events.includes('agent.log'));

    const pivot = await call<{ rows: string[]; cells: Record<string, Record<string, { total: number }>> }>(b.base, 'GET', '/api/features/pivot?rows=platform');
    // The seeded phone→Mac feature adds its own rows; ours is the second column.
    assert.deepEqual(pivot.body.rows, ['android', 'ios', 'mac', 'server']);
    assert.equal(pivot.body.cells['ios']![feature.body.id]!.total, 5);
    assert.equal(Object.keys(pivot.body.cells['ios']!).length, 2, 'the seeded feature and ours');
    ws.close();
  } finally {
    delete process.env['ANTHROPIC_API_KEY'];
    await b.stop();
  }
});

test('a release waits in the Inbox, runs only after approval, and streams its log', async () => {
  const b = await boot();
  const spawned: string[] = [];
  releases.useSpawner(async (spec, onLine) => { spawned.push(spec.command); onLine('line one'); return { code: 0 }; });
  try {
    const rel = await call<Release>(b.base, 'POST', '/api/releases', { shippable: 'desktop-mac', version: '0.2.16', by: 'nikhil' });
    assert.equal(rel.body.state, 'proposed');
    const refused = await call<{ error: string }>(b.base, 'POST', `/api/releases/${rel.body.id}/run`);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /waiting for the owner/);

    const logs: string[] = [];
    const ws = new WebSocket(`${b.base.replace('http', 'ws')}/ws`);
    ws.on('message', raw => { const e = JSON.parse(String(raw)) as { type: string; line?: string }; if (e.type === 'release.log') logs.push(e.line!); });
    await new Promise(r => ws.once('open', r));

    const answered = await call<InboxItem>(b.base, 'POST', `/api/inbox/${rel.body.inboxId}/answer`, { optionId: 'approve' });
    assert.equal(answered.body.state, 'answered');
    const ran = await call<Release>(b.base, 'POST', `/api/releases/${rel.body.id}/run`);
    assert.equal(ran.body.state, 'done');
    assert.deepEqual(spawned, ['/Users/shravan0001jha/claude-dev/scripts/release-iris.sh']);
    await tick();
    assert.deepEqual(logs, ['line one']);
    ws.close();
  } finally {
    releases.useSpawner(null);
    await b.stop();
  }
});

test('talk, context, charter edit and org history over HTTP', async () => {
  const b = await boot();
  try {
    const talk = await call<{ id: string; employeeId: string }>(b.base, 'POST', '/api/employees/asha/talk', { text: 'Status?' });
    assert.equal(talk.status, 201);
    assert.equal(talk.body.employeeId, 'asha');
    await tick();
    b.fake.last().say('All quiet.');
    const log = await call<{ kind: string; text: string }[]>(b.base, 'GET', `/api/agents/${talk.body.id}/log`);
    assert.deepEqual(log.body.map(e => e.text), ['Status?', 'All quiet.']);

    const ctx = await call<ContextResponse>(b.base, 'GET', '/api/employees/asha/context');
    assert.equal(ctx.body.layers[0]!.id, 'handbook');
    assert.ok(ctx.body.layers.some(l => l.id === 'charter:chief-of-staff'));
    assert.ok(ctx.body.layers.some(l => l.id.startsWith('project:')), 'the repo chain follows');
    const saved = await call<{ body: string }>(b.base, 'PUT', '/api/employees/asha/context', { id: 'handoff', body: 'Next: the split plan.\n' });
    assert.equal(saved.body.body, 'Next: the split plan.\n');

    const charter = await call<{ body: string; version: number }>(b.base, 'GET', '/api/charters/mobile');
    const edited = await call<{ version: number }>(b.base, 'PUT', '/api/charters/mobile', { body: charter.body.body + '\n- Added rule: never ship without the iPad talk mode checked.\n' });
    assert.equal(edited.body.version, charter.body.version + 1);
    const org = await call<{ history: { message: string }[]; lint: unknown[] }>(b.base, 'GET', '/api/org');
    assert.equal(org.body.history[0]!.message, 'Edit charter mobile (v2)');
    assert.ok(org.body.history.some(h => h.message === 'Edit Handoff for asha'), 'a handoff edit is a commit too');

    const missing = await call<{ error: string }>(b.base, 'GET', '/api/charters/nope');
    assert.equal(missing.status, 404);
    // The handoff prompt is answered like a real session: a turn that ends.
    b.fake.onSend = (s, text) => { if (text.includes('write_handoff')) { s.say('Status and handoff written.'); s.result(); } };
    const started = Date.now();
    const ended = await call<{ ok: boolean }>(b.base, 'POST', '/api/employees/asha/end-session');
    assert.equal(ended.status, 200);
    assert.ok(Date.now() - started < 5000, 'end-session returns as soon as the handoff turn is done');
    const after = await call<EmployeeDetail>(b.base, 'GET', '/api/employees/asha');
    assert.equal(after.body.sessions.length, 0);
  } finally {
    await b.stop();
  }
});
