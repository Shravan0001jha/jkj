import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as items from '../src/services/items.js';
import * as coo from '../src/services/coo.js';
import * as employees from '../src/services/employees.js';
import * as evidence from '../src/services/evidence.js';
import * as macQueue from '../src/services/mac-queue.js';
import { detectMacHost, macHost, NO_MAC_REFUSAL, setMacHostForTest } from '../src/services/mac-host.js';
import { createRouter } from '../src/http/routes.js';
import { Auth } from '../src/http/auth.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * No Mac on the cloud server (17 Oct): the Workplace runs on Linux with no Mac attached, so the Mac
 * queue, the COO live window and the tool texts must refuse cleanly instead of handing out a "Mac slot"
 * whose shell is Linux. On a Mac (or with WORKPLACE_MAC_HOST=1) behaviour is unchanged.
 */

const runtime = installFakeRuntime();
after(() => runtime.restore());
afterEach(() => setMacHostForTest(undefined));

type Wp = ReturnType<typeof testWorkplace>['wp'];

function setup() {
  const t = testWorkplace();
  mkdirSync(join(t.tmp.dir, 'ops', 'workplace'), { recursive: true });
  const epic = items.create(t.wp, { level: 'epic', title: 'Practice' }, 'owner');
  const story = (title: string, assigneeId: string) => items.create(t.wp, { level: 'story', parentId: epic.id, title, assigneeId }, 'owner');
  return { ...t, story, done: async () => { await new Promise(r => setTimeout(r, 20)); t.tmp.cleanup(); } };
}

async function connect(wp: Wp, employeeId: string) {
  const server = employees.workplaceTools(wp, employeeId, () => ({ agentId: 'a', employeeId, startedAt: '', seen: {}, planCaptured: false }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(st);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(ct);
  return client;
}
const textOf = (r: unknown): string => ((r as { content: { text: string }[] }).content ?? []).map(c => c.text).join('\n');

test('macHost: true only on darwin by default; WORKPLACE_MAC_HOST overrides either way', () => {
  assert.equal(detectMacHost('darwin', {}), true);
  assert.equal(detectMacHost('linux', {}), false);
  assert.equal(detectMacHost('win32', {}), false);
  assert.equal(detectMacHost('linux', { WORKPLACE_MAC_HOST: '1' }), true, 'a future remote Mac, said explicitly');
  assert.equal(detectMacHost('linux', { WORKPLACE_MAC_HOST: 'true' }), true);
  assert.equal(detectMacHost('darwin', { WORKPLACE_MAC_HOST: '0' }), false);
  assert.equal(detectMacHost('linux', { WORKPLACE_MAC_HOST: '' }), false);
  setMacHostForTest(true);
  assert.equal(macHost(), true);
  setMacHostForTest(false);
  assert.equal(macHost(), false);
  assert.match(NO_MAC_REFUSAL, /No Mac is attached to the Workplace \(cloud server\)/);
  assert.match(NO_MAC_REFUSAL, /resumeWhen 'a Mac is attached'/);
});

test('no Mac: request_mac refuses with the park instruction, queues nothing, and its description says so', async () => {
  setMacHostForTest(false);
  const { wp, story, done } = setup();
  try {
    const a = story('Wake word on the Mac', 'tara');
    assert.throws(() => macQueue.request(wp, { emp: 'tara', itemId: a.id, minutes: 10, why: 'check' }), /No Mac is attached/);
    const client = await connect(wp, 'tara');
    const tools = (await client.listTools()).tools;
    const desc = tools.find(t => t.name === 'request_mac')!.description!;
    assert.match(desc, /No Mac is attached/);
    assert.match(desc, /a Mac is attached/);
    const r = textOf(await client.callTool({ name: 'request_mac', arguments: { itemId: a.id, minutes: 10, why: 'live check' } }));
    assert.match(r, /No Mac is attached to the Workplace \(cloud server\)/);
    assert.match(r, /resumeWhen 'a Mac is attached'/);
    assert.deepEqual(macQueue.list(wp), { active: null, queue: [] });
    const evDesc = tools.find(t => t.name === 'run_evidence')!.description!;
    assert.match(evDesc, /No Mac is attached/, 'run_evidence no longer sends desktop checks to a Mac that is not there');
    assert.doesNotMatch(evDesc, /ask for the Mac with request_mac/);
    await client.close();
  } finally { await done(); }
});

test('no Mac: the live window, a COO/owner grant and the sweep grant nothing', async () => {
  const { wp, story, done } = setup();
  try {
    const a = story('Wake word on the Mac', 'tara');
    setMacHostForTest(true);
    const r = macQueue.request(wp, { emp: 'tara', itemId: a.id, minutes: 10, why: 'check' }); // queued while a Mac was there
    setMacHostForTest(false);
    assert.throws(() => coo.openLiveWindow(wp, 'tara', 10), /No Mac is attached/);
    assert.equal(coo.liveWindowUntil(wp, 'tara'), null);
    assert.throws(() => macQueue.grantNow(wp, r.request.id, 'coo'), /No Mac is attached/);
    assert.equal(macQueue.sweep(wp, Date.now(), () => true, () => true).granted, undefined);
    assert.equal(macQueue.list(wp).active, null);
    assert.equal(macQueue.get(wp, r.request.id)!.skips, 0, 'no Mac is not the requester\'s skip');
  } finally { await done(); }
});

test('no Mac: run_evidence refusal for desktop/voice features parks instead of pointing to request_mac', () => {
  setMacHostForTest(false);
  const m = evidence.unsupportedRefusal({ android: ['queries'], ios: ['queries'], desktop: [], windows: [] } as never, ['ios'] as never, ['voice']);
  assert.ok(m);
  assert.match(m, /No Mac is attached/);
  assert.doesNotMatch(m, /request_mac/);
  assert.match(evidence.platformRefusal('desktop') ?? '', /No Mac is attached/, 'a desktop run is not sent to a COO live window either');
  setMacHostForTest(true);
  assert.equal(evidence.platformRefusal('desktop'), evidence.DESKTOP_REFUSAL);
  assert.match(evidence.unsupportedRefusal({ android: ['queries'], ios: ['queries'], desktop: [], windows: [] } as never, ['ios'] as never, ['voice'])!, /request_mac/);
});

test('no Mac: POST /api/coo/live-window refuses (400) with the same message; on a Mac it opens', async () => {
  const { wp, done, tmp } = setup();
  const handle = createRouter({ config: wp.config, wp, auth: new Auth(join(tmp.dir, 'ops', 'auth-token')) });
  const server = createServer((req, res) => { void handle(req, res).then(found => { if (!found) { res.statusCode = 404; res.end(); } }); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const post = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/coo/live-window`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ employeeId: 'tara', minutes: 10 }) });
    return { status: res.status, body: await res.json() as { error?: string; until?: string } };
  };
  try {
    setMacHostForTest(false);
    const refused = await post();
    assert.equal(refused.status, 400);
    assert.match(refused.body.error ?? '', /No Mac is attached/);
    assert.equal(coo.liveWindowUntil(wp, 'tara'), null);
    setMacHostForTest(true);
    const opened = await post();
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.ok(Date.parse(opened.body.until!) > Date.now());
  } finally { server.close(); await done(); }
});

test('on a Mac: request_mac queues and its description is the usual one', async () => {
  setMacHostForTest(true);
  const { wp, story, done } = setup();
  try {
    const a = story('Wake word on the Mac', 'tara');
    const client = await connect(wp, 'tara');
    const desc = (await client.listTools()).tools.find(t => t.name === 'request_mac')!.description!;
    assert.doesNotMatch(desc, /No Mac is attached/);
    assert.match(textOf(await client.callTool({ name: 'request_mac', arguments: { itemId: a.id, minutes: 10, why: 'live check' } })), /position 1/);
    assert.equal(macQueue.sweep(wp, Date.now(), () => true, () => true).granted !== undefined, true);
    await client.close();
  } finally { await done(); }
});
