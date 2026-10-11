import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as items from '../src/services/items.js';
import * as coo from '../src/services/coo.js';
import * as employees from '../src/services/employees.js';
import * as inbox from '../src/services/inbox.js';
import * as trail from '../src/services/trail.js';
import * as macQueue from '../src/services/mac-queue.js';
import { rawGet } from '../src/services/v2-map.js';
import * as testAccounts from '../src/services/test-accounts.js';
import * as costWatch from '../src/services/cost-watch.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';
import { createServer } from 'node:http';
import { createRouter } from '../src/http/routes.js';
import { Auth } from '../src/http/auth.js';

/**
 * W6 services (docs/LLD-rework-2026-10.md §W6, TDD §W6): the Mac queue, the test-account pool and
 * the GitHub cost watcher. Plain deterministic services; every outside system is a fake port.
 */

const MIN = 60_000;
const runtime = installFakeRuntime();
after(() => runtime.restore());

type Wp = ReturnType<typeof testWorkplace>['wp'];

function setup() {
  const t = testWorkplace();
  mkdirSync(join(t.tmp.dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(t.tmp.dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token-value\n');
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

/* ---------------------------------- Mac queue ---------------------------------- */

test('mac 1: request_mac queues the request and returns its position', async () => {
  const { wp, story, done } = setup();
  try {
    const a = story('Wake word on the Mac', 'tara');
    const b = story('Pet lip-sync', 'mira');
    const client = await connect(wp, 'tara');
    const r = await client.callTool({ name: 'request_mac', arguments: { itemId: a.id, minutes: 20, why: 'live wake-word check' } });
    assert.match(textOf(r), /position 1/i);
    const r2 = await (await connect(wp, 'mira')).callTool({ name: 'request_mac', arguments: { itemId: b.id, minutes: 15, why: 'lip-sync on real audio' } });
    assert.match(textOf(r2), /position 2/i);
    const again = await client.callTool({ name: 'request_mac', arguments: { itemId: a.id, minutes: 20, why: 'again' } });
    assert.match(textOf(again), /already queued.*position 1/i, 'one request per person and story');
    const tooLong = await client.callTool({ name: 'request_mac', arguments: { itemId: a.id, minutes: 60, why: 'long' } });
    assert.match(textOf(tooLong), /45/);
    const q = macQueue.list(wp);
    assert.equal(q.active, null);
    assert.deepEqual(q.queue.map(x => [x.emp, x.itemId, x.minutes, x.state]), [['tara', a.id, 20, 'queued'], ['mira', b.id, 15, 'queued']]);
    assert.ok(q.queue.every(x => x.why.length > 0));
    await client.close();
  } finally { await done(); }
});

test('mac 2: the sweep grants the head only when the requester has a live session on that item', async () => {
  const { wp, story, done } = setup();
  try {
    const a = story('Wake word on the Mac', 'tara');
    const other = story('Something else', 'tara');
    macQueue.request(wp, { emp: 'tara', itemId: a.id, minutes: 20, why: 'live check' });
    const t0 = Date.now();
    assert.equal(macQueue.sweep(wp, t0).granted, undefined, 'no session at all: not granted');
    employees.assign(wp, other.id);
    assert.ok(employees.sessionOn('tara', other.id));
    assert.equal(macQueue.sweep(wp, t0 + 30_000).granted, undefined, 'a session on another story does not count');
    assert.equal(coo.isLiveWindowOpen(wp, 'tara'), false);
    employees.close(wp, employees.openSession('tara')!.agentId, 'test');
    employees.assign(wp, a.id);
    const s = macQueue.sweep(wp, t0 + 60_000);
    assert.ok(s.granted);
    const active = macQueue.list(wp).active!;
    assert.equal(active.emp, 'tara');
    assert.equal(active.state, 'granted');
    assert.equal(coo.isLiveWindowOpen(wp, 'tara'), true, 'the guard window opens');
    const until = coo.liveWindowUntil(wp, 'tara')!;
    assert.ok(Math.abs(until - (Date.now() + 20 * MIN)) < 5_000, 'for the minutes asked');
    assert.ok(trail.comments(wp, a.id).some(c => c.by === 'workplace' && /Mac.*open.*20 min/i.test(c.text)), 'the person is told on the story');
    assert.ok(runtime.last().sent.some(m => /Mac.*open/i.test(m.text)), 'and in their session');
  } finally { await done(); }
});

test('mac 2b: an approved story held at the merge gate for its live check is granted to its author with any open session (11 Oct, gap #20)', async () => {
  const { wp, story, done } = setup();
  try {
    const a = story('Errand read guard', 'tara');
    const raw = rawGet(wp, a.id)!;
    raw.status = 'done'; (raw as { pr?: unknown }).pr = { number: 9, url: 'u', branch: 'b', base: 'feat/iris-character', headSha: 'abc', pushedAt: new Date().toISOString() };
    wp.db.prepare('update work set status = ?, json = ? where id = ?').run('done', JSON.stringify(raw), a.id);
    macQueue.request(wp, { emp: 'tara', itemId: a.id, minutes: 20, why: 'live check' });
    const t0 = Date.now();
    assert.equal(macQueue.sweep(wp, t0, () => false, () => false).granted, undefined, 'no open session at all: not granted');
    assert.ok(macQueue.sweep(wp, t0 + 30_000, () => false, () => true).granted, 'the author with an open session gets it');
  } finally { await done(); }
});

test('mac 2c: an author with an open session on another story is NOT granted for a story that is not awaiting a live check', async () => {
  const { wp, story, done } = setup();
  try {
    const a = story('Still being built', 'tara');
    macQueue.request(wp, { emp: 'tara', itemId: a.id, minutes: 20, why: 'live check' });
    assert.equal(macQueue.sweep(wp, Date.now(), () => false, () => true).granted, undefined);
  } finally { await done(); }
});

test('mac 2d: a session started by a mention (no assignment) that has the story\'s branch checked out counts as on the story (11 Oct, Zoya)', async () => {
  const { wp, story, done } = setup();
  try {
    const a = story('Android 16 emulator', 'tara');
    employees.talk(wp, 'tara', 'ping from the COO', [], { autonomous: true, probe: true, from: 'coo' });
    const sess = employees.openSession('tara')!;
    assert.equal(sess.assignmentId, undefined, 'a mention session carries no assignment');
    assert.equal(employees.sessionOn('tara', a.id), false, 'not on the story yet');
    const wt = (sess as { worktree?: { path: string } }).worktree!.path;
    execFileSync('git', ['-C', wt, 'checkout', '-q', '-B', `emp/tara/${a.id}`]);
    assert.equal(employees.sessionOn('tara', a.id), true, 'its checked-out branch says which story it works');
    macQueue.request(wp, { emp: 'tara', itemId: a.id, minutes: 20, why: 'live check' });
    assert.ok(macQueue.sweep(wp, Date.now()).granted, 'and the Mac is granted');
  } finally { await done(); }
});

test('mac 3: six skips expire the request', async () => {
  const { wp, story, done } = setup();
  try {
    const a = story('Wake word on the Mac', 'tara');
    const r = macQueue.request(wp, { emp: 'tara', itemId: a.id, minutes: 10, why: 'check' });
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(macQueue.sweep(wp, t0 + i * 30_000).expired, []);
      assert.equal(macQueue.get(wp, r.request.id)!.skips, i + 1);
    }
    assert.deepEqual(macQueue.sweep(wp, t0 + 5 * 30_000).expired, [r.request.id]);
    assert.equal(macQueue.get(wp, r.request.id)!.state, 'expired');
    assert.deepEqual(macQueue.list(wp).queue, []);
    assert.ok(trail.comments(wp, a.id).some(c => /expired/i.test(c.text) && /request_mac/.test(c.text)), 'told how to ask again');
  } finally { await done(); }
});

test('mac 4: release or expiry frees the Mac for the next request', async () => {
  const { wp, story, done } = setup();
  try {
    const a = story('Wake word on the Mac', 'tara');
    const b = story('Pet lip-sync', 'mira');
    macQueue.request(wp, { emp: 'tara', itemId: a.id, minutes: 10, why: 'check' });
    macQueue.request(wp, { emp: 'mira', itemId: b.id, minutes: 15, why: 'check' });
    employees.assign(wp, a.id);
    employees.assign(wp, b.id);
    const t0 = Date.now();
    assert.equal(macQueue.sweep(wp, t0).granted, macQueue.list(wp).active!.id);
    assert.equal(macQueue.list(wp).active!.emp, 'tara');
    assert.equal(macQueue.sweep(wp, t0 + 30_000).granted, undefined, 'one at a time');
    assert.equal(macQueue.list(wp).queue[0]!.skips, 0, 'waiting behind a grant is not a skip');

    // Release through the tool: the window closes at once and the next person gets the Mac.
    const client = await connect(wp, 'tara');
    assert.match(textOf(await client.callTool({ name: 'release_mac', arguments: {} })), /released/i);
    await client.close();
    assert.equal(coo.isLiveWindowOpen(wp, 'tara'), false, 'closeLiveWindow cleared the setting');
    assert.equal(coo.liveWindowUntil(wp, 'tara'), null);
    macQueue.sweep(wp, t0 + 60_000);
    assert.equal(macQueue.list(wp).active!.emp, 'mira');

    // Expiry: Mira's 15 minutes run out; the grant is done and the Mac is free again.
    const c = story('Third', 'tara');
    macQueue.request(wp, { emp: 'tara', itemId: c.id, minutes: 5, why: 'again' });
    employees.close(wp, employees.openSession('tara')!.agentId, 'test');
    employees.assign(wp, c.id);
    const later = Date.now() + 16 * MIN;
    const s = macQueue.sweep(wp, later);
    assert.equal(s.done.length, 1);
    assert.equal(macQueue.history(wp).find(x => x.emp === 'mira')!.state, 'done');
    assert.equal(macQueue.list(wp).active!.emp, 'tara', 'the next request is granted in the same sweep');
  } finally { await done(); }
});

test('mac 5: grant from the owner opens it now (route), and a non-queued id is a 404', async () => {
  const { wp, story, done, tmp } = setup();
  const handle = createRouter({ config: wp.config, wp, auth: new Auth(join(tmp.dir, 'ops', 'auth-token')) });
  const server = createServer((req, res) => { void handle(req, res).then(found => { if (!found) { res.statusCode = 404; res.end(); } }); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const s = story('Wake word', 'tara');
    const r = macQueue.request(wp, { emp: 'tara', itemId: s.id, minutes: 12, why: 'check' });
    const list = await fetch(`${base}/api/mac-queue`).then(x => x.json()) as { active: unknown; queue: { id: string }[] };
    assert.equal(list.active, null);
    assert.deepEqual(list.queue.map(x => x.id), [r.request.id]);
    // No session on the story: the owner's grant opens it anyway.
    const g = await fetch(`${base}/api/mac-queue/${r.request.id}/grant`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(g.status, 200);
    const granted = await g.json() as { state: string; grantedBy: string };
    assert.equal(granted.state, 'granted');
    assert.equal(granted.grantedBy, 'owner');
    assert.equal(coo.isLiveWindowOpen(wp, 'tara'), true);
    // The COO, from this Mac, is attributed as the COO.
    const s2 = story('Lip-sync', 'mira');
    const r2 = macQueue.request(wp, { emp: 'mira', itemId: s2.id, minutes: 5, why: 'check' });
    const g2 = await fetch(`${base}/api/mac-queue/${r2.request.id}/grant`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workplace-actor': 'coo' }, body: '{}' });
    assert.equal(((await g2.json()) as { grantedBy: string }).grantedBy, 'coo');
    const missing = await fetch(`${base}/api/mac-queue/mq_nope/grant`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
    await done();
  }
});

test('mac 5b: the owner granting someone else while the Mac is held ends the current grant', async () => {
  const { wp, story, done } = setup();
  try {
    const a = story('A', 'tara');
    const b = story('B', 'mira');
    macQueue.request(wp, { emp: 'tara', itemId: a.id, minutes: 10, why: 'x' });
    const rb = macQueue.request(wp, { emp: 'mira', itemId: b.id, minutes: 10, why: 'y' });
    employees.assign(wp, a.id);
    macQueue.sweep(wp);
    assert.equal(macQueue.list(wp).active!.emp, 'tara');
    macQueue.grantNow(wp, rb.request.id, 'coo');
    assert.equal(macQueue.list(wp).active!.emp, 'mira');
    assert.equal(coo.isLiveWindowOpen(wp, 'tara'), false);
    assert.equal(coo.isLiveWindowOpen(wp, 'mira'), true);
    assert.ok(trail.comments(wp, a.id).some(c => /Mac.*(owner|COO)/i.test(c.text)), 'the person cut off is told why');
  } finally { await done(); }
});

/* -------------------------------- Test accounts -------------------------------- */

const SECRET = 'iris-session-SECRET-token-123';

function fakeAccounts(opts: { valid?: (t: string) => boolean } = {}) {
  const created: string[] = [];
  let n = 0;
  const port: testAccounts.TestAccountPort = {
    async signIn(email) { created.push(email); n += 1; return { token: `${SECRET}-${n}` }; },
    async tokenValid(token) { return opts.valid ? opts.valid(token) : true; },
  };
  return { port, created };
}

test('accounts 6: a lease returns no secret fields; the desktop profile is signed in server-side', async () => {
  const { wp, story, done, tmp } = setup();
  const fake = fakeAccounts();
  const restore = testAccounts.usePort(fake.port);
  try {
    const s = story('Sign-in flow', 'tara');
    const lease = await testAccounts.lease(wp, { emp: 'tara', itemId: s.id, platform: 'desktop' });
    assert.deepEqual(Object.keys(lease).sort(), ['accountId', 'email', 'expiresAt', 'platform', 'profilePath']);
    assert.ok(!JSON.stringify(lease).includes(SECRET));
    assert.match(lease.email, /@e2e\.irisforu\.com$/);
    assert.deepEqual(fake.created, [lease.email]);
    // The profile lives in the agent's work dir and holds what the app's own sign-in writes.
    assert.equal(lease.profilePath, join(wp.config.workDir, 'tara', 'test-profiles', lease.accountId));
    const creds = JSON.parse(readFileSync(join(lease.profilePath!, 'credentials.json'), 'utf8')) as { email: string; token: string };
    assert.equal(creds.email, lease.email);
    assert.ok(creds.token.startsWith(SECRET));
    assert.equal(statSync(join(lease.profilePath!, 'credentials.json')).mode & 0o777, 0o600);
    // No secret in the store, the list or the API shape.
    const dump = JSON.stringify(wp.db.prepare('select * from test_accounts').all());
    assert.ok(!dump.includes(SECRET));
    assert.ok(!JSON.stringify(testAccounts.list(wp)).includes(SECRET));
    // The token is kept server-side, under the ops dir, owner-only.
    const kept = join(tmp.dir, 'ops', 'workplace', 'test-accounts', `${lease.accountId}.json`);
    assert.equal(statSync(kept).mode & 0o777, 0o600);

    // Through the tool: no token in what the agent reads.
    const client = await connect(wp, 'mira');
    const s2 = story('Other', 'mira');
    const r = await client.callTool({ name: 'lease_test_account', arguments: { itemId: s2.id, platform: 'desktop' } });
    const text = textOf(r);
    assert.match(text, /@e2e\.irisforu\.com/);
    assert.match(text, /--user-data-dir/);
    assert.ok(!text.includes(SECRET), text);
    await client.close();
  } finally { restore(); await done(); }
});

test('accounts 7: a second lease gets a different account', async () => {
  const { wp, story, done } = setup();
  const fake = fakeAccounts();
  const restore = testAccounts.usePort(fake.port);
  try {
    const s = story('Account switch', 'tara');
    const one = await testAccounts.lease(wp, { emp: 'tara', itemId: s.id, platform: 'desktop' });
    const two = await testAccounts.lease(wp, { emp: 'tara', itemId: s.id, platform: 'desktop' });
    assert.notEqual(one.accountId, two.accountId);
    assert.notEqual(one.email, two.email);
    assert.equal(fake.created.length, 2);
    // Two leases at the same instant never share an account.
    const [x, y] = await Promise.all([
      testAccounts.lease(wp, { emp: 'mira', itemId: s.id, platform: 'ios' }),
      testAccounts.lease(wp, { emp: 'mira', itemId: s.id, platform: 'ios' }),
    ]);
    assert.notEqual(x.accountId, y.accountId);
    assert.equal(x.profilePath, undefined, 'only desktop gets a profile');
  } finally { restore(); await done(); }
});

test('accounts 8: a returned account is leased again (fresh profile, no new account)', async () => {
  const { wp, story, done } = setup();
  const fake = fakeAccounts();
  const restore = testAccounts.usePort(fake.port);
  try {
    const s = story('Sign-in flow', 'tara');
    const one = await testAccounts.lease(wp, { emp: 'tara', itemId: s.id, platform: 'desktop' });
    writeFileSync(join(one.profilePath!, 'leftover.json'), '{}');
    assert.throws(() => testAccounts.giveBack(wp, one.accountId, 'mira'), /tara/, 'only the holder returns it');
    const client = await connect(wp, 'tara');
    assert.match(textOf(await client.callTool({ name: 'return_test_account', arguments: { accountId: one.accountId } })), /returned/i);
    await client.close();
    assert.equal(existsSync(one.profilePath!), false, 'the profile (and its token) is removed on return');
    const again = await testAccounts.lease(wp, { emp: 'tara', itemId: s.id, platform: 'desktop' });
    assert.equal(again.accountId, one.accountId);
    assert.equal(fake.created.length, 1, 'no new account was created');
    assert.equal(existsSync(join(again.profilePath!, 'leftover.json')), false, 'a fresh profile');
    assert.ok(existsSync(join(again.profilePath!, 'credentials.json')));
  } finally { restore(); await done(); }
});

test('accounts 8b: a stored token that is no longer valid is renewed by signing in again', async () => {
  const { wp, story, done } = setup();
  const fake = fakeAccounts({ valid: t => !t.endsWith('-1') });
  const restore = testAccounts.usePort(fake.port);
  try {
    const s = story('Sign-in flow', 'tara');
    const one = await testAccounts.lease(wp, { emp: 'tara', itemId: s.id, platform: 'desktop' });
    testAccounts.giveBack(wp, one.accountId, 'tara');
    const again = await testAccounts.lease(wp, { emp: 'tara', itemId: s.id, platform: 'desktop' });
    assert.equal(again.accountId, one.accountId);
    assert.deepEqual(fake.created, [one.email, one.email], 'signed the same account in again');
    const creds = JSON.parse(readFileSync(join(again.profilePath!, 'credentials.json'), 'utf8')) as { token: string };
    assert.ok(creds.token.endsWith('-2'));
  } finally { restore(); await done(); }
});

test('accounts 9: a lease expires after 4 hours', async () => {
  const { wp, story, done } = setup();
  const fake = fakeAccounts();
  const restore = testAccounts.usePort(fake.port);
  try {
    const s = story('Sign-in flow', 'tara');
    const t0 = Date.now();
    const one = await testAccounts.lease(wp, { emp: 'tara', itemId: s.id, platform: 'desktop' }, t0);
    assert.equal(Date.parse(one.expiresAt), t0 + 4 * 60 * MIN);
    assert.deepEqual(testAccounts.expireLeases(wp, t0 + 4 * 60 * MIN - 1), []);
    assert.deepEqual(testAccounts.expireLeases(wp, t0 + 4 * 60 * MIN + 1), [one.accountId]);
    assert.equal(testAccounts.list(wp).find(a => a.id === one.accountId)!.state, 'free');
    assert.equal(existsSync(one.profilePath!), false);
    assert.ok(trail.comments(wp, s.id).some(c => /lease.*expired/i.test(c.text)));
    const next = await testAccounts.lease(wp, { emp: 'mira', itemId: s.id, platform: 'ios' }, t0 + 5 * 60 * MIN);
    assert.equal(next.accountId, one.accountId, 'back in the pool');
  } finally { restore(); await done(); }
});

/* ---- staging off (dry run 10 Oct, gap #4: "fetch failed" because staging was stopped) ---- */

function fakeStaging(behaviour: 'up' | 'starts' | 'fails' | 'hangs') {
  const calls: string[] = [];
  const staging = {
    async ensureUp() {
      calls.push('ensureUp');
      if (behaviour === 'fails') throw new Error('fetch failed');
      if (behaviour === 'hangs') await new Promise(() => undefined);
      if (behaviour === 'starts') await new Promise(r => setTimeout(r, 10));
    },
  };
  return { staging, calls };
}

test('accounts 10: a stopped staging is started (the evidence staging port) before the account is signed in', async () => {
  const { wp, story, done } = setup();
  const fake = fakeAccounts();
  const order: string[] = [];
  const port: testAccounts.TestAccountPort = { signIn: async e => { order.push('signIn'); return fake.port.signIn(e); }, tokenValid: fake.port.tokenValid };
  const st = fakeStaging('starts');
  const restore = testAccounts.usePort(port);
  const restoreStaging = testAccounts.useStaging({ ensureUp: async () => { order.push('ensureUp'); await st.staging.ensureUp(); } });
  try {
    const s = story('Sign-in flow', 'tara');
    const lease = await testAccounts.lease(wp, { emp: 'tara', itemId: s.id, platform: 'desktop' });
    assert.ok(lease.accountId);
    assert.deepEqual(order, ['ensureUp', 'signIn'], 'staging is up before any account call');
    assert.equal(coo.listItems(wp).length, 0, 'nothing for the COO when it came up');
  } finally { restoreStaging(); restore(); await done(); }
});

test('accounts 11: staging that cannot be started gives a clear message and tells the COO, never a raw "fetch failed"', async () => {
  const { wp, story, done } = setup();
  const fake = fakeAccounts();
  const restore = testAccounts.usePort(fake.port);
  const st = fakeStaging('fails');
  const restoreStaging = testAccounts.useStaging(st.staging);
  try {
    const s = story('Sign-in flow', 'tara');
    await assert.rejects(testAccounts.lease(wp, { emp: 'tara', itemId: s.id, platform: 'desktop' }), (err: Error) => {
      assert.equal(err.message, 'Staging is off and could not be started; told the COO.');
      return true;
    });
    assert.deepEqual(fake.created, [], 'no account call against a dead staging');
    assert.equal(testAccounts.list(wp).length, 0, 'no half-made account row');
    const raised = coo.listItems(wp).filter(i => i.kind === 'stall');
    assert.equal(raised.length, 1, 'the COO is told');
    assert.match(raised[0]!.title, /staging/i);
    assert.match(raised[0]!.body, /fetch failed/, 'the COO gets the cause');
    assert.equal(raised[0]!.itemId, s.id);
    // Through the tool: the clear message, not the fetch error; a second try within the hour does not ring the COO again.
    const client = await connect(wp, 'tara');
    const text = textOf(await client.callTool({ name: 'lease_test_account', arguments: { itemId: s.id, platform: 'ios' } }));
    await client.close();
    assert.match(text, /Staging is off and could not be started; told the COO/);
    assert.doesNotMatch(text, /fetch failed/);
    assert.equal(coo.listItems(wp).filter(i => i.kind === 'stall').length, 1, 'one COO item per outage, not one per try');
  } finally { restoreStaging(); restore(); await done(); }
});

test('accounts 12: the wait for staging is bounded (6 min by default); past it, the same clear message', async () => {
  const { wp, story, done } = setup();
  const fake = fakeAccounts();
  const restore = testAccounts.usePort(fake.port);
  assert.equal(testAccounts.STAGING_WAIT_MS, 6 * MIN);
  const st = fakeStaging('hangs');
  const restoreStaging = testAccounts.useStaging(st.staging, 30);
  try {
    const s = story('Sign-in flow', 'tara');
    const t0 = Date.now();
    await assert.rejects(testAccounts.lease(wp, { emp: 'tara', itemId: s.id, platform: 'android' }), /Staging is off and could not be started; told the COO/);
    assert.ok(Date.now() - t0 < 2000, 'gave up at the bound');
    assert.deepEqual(fake.created, []);
    const raised = coo.listItems(wp).filter(i => i.kind === 'stall');
    assert.equal(raised.length, 1);
    assert.match(raised[0]!.body, /did not come up/i);
  } finally { restoreStaging(); restore(); await done(); }
});

/* -------------------------------- Cost watcher -------------------------------- */

const IST = (day: string, hhmm: string): number => Date.parse(`${day}T${hhmm}:00+05:30`);

function fakeBilling(byDay: Record<string, number>, month?: number) {
  const calls: string[] = [];
  const port: costWatch.GitHubBillingPort = {
    async usageUsd({ year, month: m, day }) {
      const key = day ? `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}` : `${year}-${String(m).padStart(2, '0')}`;
      calls.push(key);
      if (!day) return month ?? Object.entries(byDay).filter(([d]) => d.startsWith(key)).reduce((n, [, v]) => n + v, 0);
      return byDay[key] ?? 0;
    },
  };
  return { port, calls };
}

const capItems = (wp: Wp) => inbox.list(wp).filter(i => i.kind === 'cap');

test('cost 10: spend over 2× the 7-day average and over $1 raises one cap item per day', async () => {
  const { wp, done } = setup();
  try {
    const days: Record<string, number> = { '2026-10-02': 0.5, '2026-10-03': 0.6, '2026-10-04': 0.4, '2026-10-05': 0.5, '2026-10-06': 0.5, '2026-10-07': 0.6, '2026-10-08': 0.4, '2026-10-09': 3.2 };
    const { port } = fakeBilling(days, 7);
    const r = await costWatch.check(wp, IST('2026-10-10', '09:00'), port);
    assert.equal(r.day, '2026-10-09');
    assert.equal(r.yesterdayUsd, 3.2);
    assert.equal(r.avgUsd, 0.5);
    assert.ok(r.raised);
    const items1 = capItems(wp);
    assert.equal(items1.length, 1);
    assert.match(items1[0]!.title, /GitHub spend jumped: \$3\.20 yesterday vs \$0\.50 avg/);
    // Stored per day, in USD.
    assert.equal((wp.db.prepare('select value from settings where key = ?').get('cost:github:2026-10-09') as { value: string }).value, '3.2');
    // Same day again (a restart, the next minute): still one.
    await costWatch.check(wp, IST('2026-10-10', '11:00'), port);
    assert.equal(capItems(wp).length, 1);
    // Answered, then the watcher runs again the same day: not raised again.
    inbox.answer(wp, items1[0]!.id, items1[0]!.options[0]!.id, undefined, 'web');
    await costWatch.check(wp, IST('2026-10-10', '15:00'), port);
    assert.equal(capItems(wp).length, 1);
    // Through the rhythm-facing entry: before 09:00 nothing; after, once.
    assert.equal(await costWatch.maybeRun(wp, IST('2026-10-11', '08:59'), port), null);
  } finally { await done(); }
});

test('cost 10b: month-to-date over ₹5000/month pace raises a cap item even without a jump', async () => {
  const { wp, done } = setup();
  try {
    const days: Record<string, number> = {};
    for (let d = 1; d <= 9; d++) days[`2026-10-${String(d).padStart(2, '0')}`] = 4;
    const { port } = fakeBilling(days, 36);
    const r = await costWatch.check(wp, IST('2026-10-10', '09:05'), port);
    assert.equal(r.monthUsd, 36);
    assert.ok(r.raised, '36 > 84 × 9/30 = 25.2');
    assert.match(capItems(wp)[0]!.title, /GitHub spend this month/);
  } finally { await done(); }
});

test('cost 11: normal spend raises nothing', async () => {
  const { wp, done } = setup();
  try {
    const days: Record<string, number> = { '2026-10-02': 0.5, '2026-10-03': 0.6, '2026-10-04': 0.4, '2026-10-05': 0.5, '2026-10-06': 0.5, '2026-10-07': 0.6, '2026-10-08': 0.4, '2026-10-09': 0.9 };
    const { port, calls } = fakeBilling(days);
    const r = await costWatch.check(wp, IST('2026-10-10', '09:00'), port);
    assert.equal(r.raised, undefined);
    assert.equal(capItems(wp).length, 0);
    // A cheap jump (over 2× but under $1) is not a spike either.
    const { port: p2, calls: calls2 } = fakeBilling({ ...days, '2026-10-10': 0.95 });
    await costWatch.check(wp, IST('2026-10-11', '09:00'), p2);
    assert.equal(capItems(wp).length, 0);
    // The days already stored are not fetched again: only the new day and the month total.
    assert.equal(calls.filter(c => c === '2026-10-05').length, 1);
    assert.deepEqual(calls2, ['2026-10-10', '2026-10'], 'yesterday and the month, nothing else');
  } finally { await done(); }
});

test('cost: maybeRun runs once per IST day from 09:00 and retries a failed fetch later', async () => {
  const { wp, done } = setup();
  try {
    let fail = true;
    const port: costWatch.GitHubBillingPort = { async usageUsd() { if (fail) throw new Error('gh: not logged in'); return 0.2; } };
    assert.equal(await costWatch.maybeRun(wp, IST('2026-10-10', '08:59'), port), null);
    assert.equal(await costWatch.maybeRun(wp, IST('2026-10-10', '09:00'), port), null, 'the fetch failed');
    fail = false;
    assert.equal(await costWatch.maybeRun(wp, IST('2026-10-10', '09:10'), port), null, 'retries no sooner than an hour');
    const r = await costWatch.maybeRun(wp, IST('2026-10-10', '10:01'), port);
    assert.equal(r?.day, '2026-10-09');
    assert.equal(await costWatch.maybeRun(wp, IST('2026-10-10', '12:00'), port), null, 'once a day');
  } finally { await done(); }
});

test('cost: the real port sums the billing usage items gh returns', async () => {
  const calls: string[][] = [];
  const port = costWatch.ghBillingPort('shravan0001jha-iris-hq', async (args) => {
    calls.push(args);
    return JSON.stringify({ usageItems: [{ netAmount: 1.25, grossAmount: 2 }, { netAmount: 0.5, grossAmount: 0.5 }, { grossAmount: 9 }] });
  });
  assert.equal(await port.usageUsd({ year: 2026, month: 10, day: 9 }), 1.75);
  assert.deepEqual(calls[0], ['api', '/organizations/shravan0001jha-iris-hq/settings/billing/usage?year=2026&month=10&day=9']);
  await port.usageUsd({ year: 2026, month: 10 });
  assert.deepEqual(calls[1], ['api', '/organizations/shravan0001jha-iris-hq/settings/billing/usage?year=2026&month=10']);
});

test('accounts: the real port reads its keys from SSM at sign-in and never puts them in an error', async () => {
  const ssm: string[] = [];
  const requests: { url: string; auth?: string; body?: string }[] = [];
  const port = testAccounts.e2eAccountPort({
    api: 'https://staging.example',
    secrets: {
      ssm: async name => { ssm.push(name); return name === '/iris-staging/e2e-admin-key' ? 'ADMIN-KEY-xyz' : 'E2E-TOKEN-abc'; },
      codesUrl: async () => 'https://codes.example/',
    },
    fetch: async (url, init) => {
      requests.push({ url, ...(init?.headers?.['authorization'] ? { auth: init.headers['authorization'] } : {}), ...(init?.body ? { body: init.body } : {}) });
      if (url.startsWith('https://codes.example')) return { ok: true, status: 200, json: async () => ({ code: '123456', at: new Date().toISOString() }) };
      if (url.endsWith('/auth/code')) return { ok: true, status: 200, json: async () => ({}) };
      if (url.endsWith('/auth/verify')) return { ok: true, status: 200, json: async () => ({ token: 'SESSION-tok' }) };
      if (url.endsWith('/admin/e2e/plan')) return { ok: true, status: 200, json: async () => ({ tier: 'robot' }) };
      return { ok: false, status: 404, json: async () => ({}) };
    },
    sleep: async () => {},
    codeGapMs: 0,
  });
  const r = await port.signIn('wp-x@e2e.irisforu.com');
  assert.equal(r.token, 'SESSION-tok');
  assert.deepEqual(ssm.sort(), ['/iris-alpha/e2e-token', '/iris-staging/e2e-admin-key']);
  const verify = requests.find(q => q.url.endsWith('/auth/verify'))!;
  assert.deepEqual(JSON.parse(verify.body!), { email: 'wp-x@e2e.irisforu.com', code: '123456', accepted_terms: true });
  const plan = requests.find(q => q.url.endsWith('/admin/e2e/plan'))!;
  assert.equal(plan.auth, 'Bearer ADMIN-KEY-xyz');
  assert.deepEqual(JSON.parse(plan.body!), { email: 'wp-x@e2e.irisforu.com', plan: 'robot' });
  assert.equal(requests.find(q => q.url.startsWith('https://codes.example'))!.auth, 'Bearer E2E-TOKEN-abc');

  const failing = testAccounts.e2eAccountPort({
    api: 'https://staging.example',
    secrets: { ssm: async () => 'ADMIN-KEY-xyz', codesUrl: async () => 'https://codes.example/' },
    fetch: async url => url.endsWith('/admin/e2e/plan') ? { ok: false, status: 403, json: async () => ({ error: 'bad key ADMIN-KEY-xyz' }) } : url.startsWith('https://codes') ? { ok: true, status: 200, json: async () => ({ code: '123456', at: new Date().toISOString() }) } : { ok: true, status: 200, json: async () => ({ token: 'SESSION-tok' }) },
    sleep: async () => {}, codeGapMs: 0,
  });
  await assert.rejects(failing.signIn('wp-y@e2e.irisforu.com'), (err: Error) => /403/.test(err.message) && !err.message.includes('ADMIN-KEY') && !err.message.includes('SESSION-tok'));
});
