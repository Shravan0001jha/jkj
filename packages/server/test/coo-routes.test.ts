import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { CooMessage, LogEntry } from '@jkj/shared';
import { loadConfig } from '../src/config.js';
import { start, type Running } from '../src/index.js';
import { installFakeRuntime, type FakeRuntime } from './fakes/fake-runtime.js';
import { tmpWorkplace, type TmpWorkplace } from './fakes/tmp-workplace.js';

/**
 * The COO bridge and the chat-view query param, over real HTTP — same shape as api.test.ts.
 *
 * The owner reaches the Workplace only through the tunnel from his phone, so the owner-facing
 * routes (log, message, presence) must work over it: an ordinary bearer/cookie session, same as
 * every other /api/* route. Only the lead-only routes (reply, items, answer, forward — only the
 * lead's own process ever writes as the COO) refuse a request that arrived through the tunnel,
 * exactly like /api/pair and /api/relay/off. Every request here is physically loopback already
 * (127.0.0.1); `x-via-tunnel` is the header the tunnel itself sets on a forwarded request, so it is
 * what stands in for "this came through the relay" — `isLoopback` alone would not tell the two apart.
 */

interface Booted { running: Running; base: string; tmp: TmpWorkplace; fake: FakeRuntime; stop(): Promise<void> }

async function boot(): Promise<Booted> {
  const tmp = tmpWorkplace();
  tmp.db.close();
  mkdirSync(join(tmp.dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(tmp.dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test\n');
  const fake = installFakeRuntime();
  const config = loadConfig(['--no-open', '--no-telegram', '--no-seed', '--port', '0'], {
    IRIS_WORKPLACE_DIR: tmp.dir, IRIS_OPS_DIR: join(tmp.dir, 'ops'), IRIS_WORK_DIR: tmp.workDir, WORKPLACE_CAP_INR: '1000', WORKPLACE_USD_INR: '88',
  });
  const running = await start(config);
  const address = running.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { running, base: `http://127.0.0.1:${port}`, tmp, fake, stop: async () => { await running.stop(); fake.restore(); tmp.cleanup(); } };
}

async function call<T>(base: string, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() as T };
}

test('owner-facing (log, message, presence) works both from loopback and through the tunnel', async () => {
  const b = await boot();
  try {
    const sent = await call<CooMessage>(b.base, 'POST', '/api/coo/message', { text: 'Is the release ready?' });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.from, 'owner');

    const log = await call<CooMessage[]>(b.base, 'GET', '/api/coo/log');
    assert.equal(log.status, 200);
    assert.equal(log.body.length, 1);

    const presence = await call<{ online: boolean }>(b.base, 'GET', '/api/coo/presence');
    assert.equal(presence.status, 200);
    assert.equal(presence.body.online, false, 'no heartbeat yet');

    // The same three, through the tunnel (the owner's phone): still allowed.
    const tunneledSend = await call<CooMessage>(b.base, 'POST', '/api/coo/message', { text: 'From the phone.' }, { 'x-via-tunnel': '1' });
    assert.equal(tunneledSend.status, 201);
    const tunneledLog = await call<CooMessage[]>(b.base, 'GET', '/api/coo/log', undefined, { 'x-via-tunnel': '1' });
    assert.equal(tunneledLog.status, 200);
    assert.equal(tunneledLog.body.length, 2);
    const tunneledPresence = await call<{ online: boolean }>(b.base, 'GET', '/api/coo/presence', undefined, { 'x-via-tunnel': '1' });
    assert.equal(tunneledPresence.status, 200);
  } finally {
    await b.stop();
  }
});

test('lead-only (reply, items, answer, forward) works from loopback but refuses a request that arrived through the tunnel', async () => {
  const b = await boot();
  try {
    const sent = await call<CooMessage>(b.base, 'POST', '/api/coo/message', { text: 'Is the release ready?' });

    const reply = await call<CooMessage>(b.base, 'POST', '/api/coo/reply', { inReplyTo: sent.body.id, text: 'Yes, shipping now.' });
    assert.equal(reply.status, 201);
    assert.equal(reply.body.from, 'coo');
    const items = await call<unknown[]>(b.base, 'GET', '/api/coo/items');
    assert.equal(items.status, 200);

    // The same requests, through the tunnel: refused, whatever a bearer token would otherwise allow.
    const tunneledReply = await call<{ error: string }>(b.base, 'POST', '/api/coo/reply', { inReplyTo: sent.body.id, text: 'leak?' }, { 'x-via-tunnel': '1' });
    assert.equal(tunneledReply.status, 400);
    const tunneledItems = await call<{ error: string }>(b.base, 'GET', '/api/coo/items', undefined, { 'x-via-tunnel': '1' });
    assert.equal(tunneledItems.status, 400);
    const tunneledAnswer = await call<{ error: string }>(b.base, 'POST', '/api/coo/answer', { itemId: 'coi_x', optionId: 'ok' }, { 'x-via-tunnel': '1' });
    assert.equal(tunneledAnswer.status, 400);
    const tunneledForward = await call<{ error: string }>(b.base, 'POST', '/api/coo/forward', { itemId: 'coi_x', recommendation: 'leak?' }, { 'x-via-tunnel': '1' });
    assert.equal(tunneledForward.status, 400);

    // The transcript is unchanged by the refused attempt: no mirroring, no leakage.
    const after = await call<CooMessage[]>(b.base, 'GET', '/api/coo/log');
    assert.equal(after.body.length, 2);
  } finally {
    await b.stop();
  }
});

test('over the socket: coo.message reaches a tunnelled client too; coo.item never does', async () => {
  const b = await boot();
  const wsUrl = b.base.replace('http', 'ws') + '/ws';
  const local = new WebSocket(wsUrl);
  const tunnelled = new WebSocket(wsUrl, { headers: { 'x-via-tunnel': '1' } });
  const localEvents: string[] = [];
  const tunnelledEvents: string[] = [];
  try {
    await Promise.all([
      new Promise<void>(resolve => local.on('open', () => resolve())),
      new Promise<void>(resolve => tunnelled.on('open', () => resolve())),
    ]);
    local.on('message', raw => localEvents.push((JSON.parse(String(raw)) as { type: string }).type));
    tunnelled.on('message', raw => tunnelledEvents.push((JSON.parse(String(raw)) as { type: string }).type));

    const sent = await call<CooMessage>(b.base, 'POST', '/api/coo/message', { text: 'Ping from the owner.' });
    await call<CooMessage>(b.base, 'POST', '/api/coo/reply', { inReplyTo: sent.body.id, text: 'Pong.' }); // coo.message
    await call(b.base, 'POST', '/api/room', { title: 'x', text: '@coo status?', charterIds: [] }); // room.message, then coo.item (offline fallback)
    await new Promise(resolve => setTimeout(resolve, 30));

    assert.ok(localEvents.includes('coo.message'), 'the loopback client gets the owner/coo conversation');
    assert.ok(localEvents.includes('coo.item'), 'the loopback client gets the lead-only escalation bookkeeping too');
    assert.ok(tunnelledEvents.includes('coo.message'), 'the phone, through the tunnel, gets the conversation it is part of');
    assert.ok(!tunnelledEvents.includes('coo.item'), 'but never the lead-only bookkeeping');
  } finally {
    local.close(); tunnelled.close();
    await b.stop();
  }
});

test('talking to the coo employee through the ordinary Talk route is refused, pointed at the bridge', async () => {
  const b = await boot();
  try {
    const res = await call<{ error: string }>(b.base, 'POST', '/api/employees/coo/talk', { text: 'hi' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /coo\/message/);
  } finally {
    await b.stop();
  }
});

test('GET /api/agents/:id/log?view=chat collapses tool activity; the default (no view) still returns the full log', async () => {
  const b = await boot();
  try {
    const talked = await call<{ id: string }>(b.base, 'POST', '/api/employees/mira/talk', { text: 'Ship the weather fix.' });
    assert.equal(talked.status, 201);
    const session = b.fake.last();
    session.say('On it.');
    session.tool('Read', { file_path: 'a.py' });
    session.tool('Bash', { command: 'npm test' });
    session.result();

    const full = await call<LogEntry[]>(b.base, 'GET', `/api/agents/${talked.body.id}/log`);
    assert.ok(full.body.some(e => e.kind === 'read') && full.body.some(e => e.kind === 'bash'));

    const chat = await call<LogEntry[]>(b.base, 'GET', `/api/agents/${talked.body.id}/log?view=chat`);
    assert.ok(chat.body.some(e => e.kind === 'activity' && /worked · 2 steps/.test(e.text)));
    assert.ok(!chat.body.some(e => e.kind === 'read' || e.kind === 'bash'), 'the raw tool entries are collapsed away in the chat view');
  } finally {
    await b.stop();
  }
});
