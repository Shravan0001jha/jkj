import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Activity, Area, Comment, Focus, ItemDetail, WorkItem } from '@jkj/shared';
import * as trail from '../src/services/trail.js';
import { Tunnel, type Frame } from '../src/services/tunnel.js';
import { boot } from './fakes/boot.js';

/**
 * Who did it (LLD §19.8, "Actor"): the COO drives the owner-facing API from this Mac too, and its
 * actions must read as the COO's, not the owner's. `x-workplace-actor: coo` is honoured only on a
 * loopback request that did not come through the tunnel (requireLocal's test); a relayed request is
 * always the owner, whatever headers or `by` it carries.
 */

const COO = { 'x-workplace-actor': 'coo' };
const TUNNEL = { 'x-via-tunnel': '1' };

async function call<T>(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() as T };
}

/** Every attributed write the owner-facing API makes, sent with the given headers; returns who each was recorded as. */
async function actAs(base: string, wp: Parameters<typeof trail.activityFor>[0], headers: Record<string, string>) {
  const area = await call<Area>(base, 'POST', '/api/areas', { title: `Area ${Math.random().toString(36).slice(2, 6)}` }, headers);
  assert.equal(area.status, 201);
  const areaPatch = await call<Area>(base, 'POST', `/api/areas/${area.body.id}`, { description: 'renamed' }, headers);
  assert.equal(areaPatch.status, 200);
  const epic = await call<ItemDetail>(base, 'POST', '/api/items', { level: 'epic', title: 'Iris works while music plays', areaId: area.body.id }, headers);
  assert.equal(epic.status, 201);
  const story = await call<ItemDetail>(base, 'POST', '/api/items', { level: 'story', parentId: epic.body.item.id, title: 'Duck music under speech', assigneeId: 'owner' }, headers);
  const focus = await call<Focus>(base, 'POST', '/api/focus', { epicIds: [epic.body.item.id] }, headers);
  assert.equal(focus.status, 200);
  const updated = await call<ItemDetail>(base, 'POST', `/api/items/${story.body.item.id}`, { points: 3 }, headers);
  assert.equal(updated.status, 200);
  const comment = await call<Comment>(base, 'POST', `/api/items/${story.body.item.id}/comments`, { text: 'Looks right.' }, headers);
  assert.equal(comment.status, 201);
  const legacy = await call<WorkItem>(base, 'POST', '/api/work', { kind: 'assignment', title: 'Old engine item', start: false }, headers);
  const moved = await call<WorkItem>(base, 'POST', `/api/work/${legacy.body.id}/transition`, { to: 'rejected', note: 'not needed' }, headers);
  assert.equal(moved.status, 200);
  const acts = (id: string) => trail.activityFor(wp, id);
  return {
    focus: focus.body.setBy,
    epicCreated: acts(epic.body.item.id).find((a: Activity) => a.kind === 'created')!.by,
    pointsBy: acts(story.body.item.id).find((a: Activity) => a.kind === 'points')!.by,
    comment: comment.body.by,
    areaNotes: trail.activitySince(wp, '').filter((a: Activity) => a.itemId === null && a.text.includes(area.body.title)).map((a: Activity) => a.by),
    legacyCreated: legacy.body.history[0]!.by,
    transition: moved.body.history.at(-1)!.by,
  };
}

test('x-workplace-actor: coo from loopback attributes focus, items, comments, areas and transitions to the COO', async () => {
  const b = await boot();
  try {
    const r = await actAs(b.base, b.running.wp, COO);
    assert.equal(r.focus, 'coo');
    assert.equal(r.epicCreated, 'coo');
    assert.equal(r.pointsBy, 'coo');
    assert.equal(r.comment, 'coo');
    assert.ok(r.areaNotes.length >= 2 && r.areaNotes.every(by => by === 'coo'), `area writes by the COO: ${r.areaNotes}`);
    assert.equal(r.legacyCreated, 'coo');
    assert.equal(r.transition, 'coo');
  } finally {
    await b.stop();
  }
});

test('without the header, loopback is still the owner', async () => {
  const b = await boot();
  try {
    const r = await actAs(b.base, b.running.wp, {});
    assert.deepEqual([r.focus, r.epicCreated, r.pointsBy, r.comment, r.legacyCreated, r.transition], Array(6).fill('owner'));
    assert.ok(r.areaNotes.length >= 2 && r.areaNotes.every(by => by === 'owner'), `area writes by the owner: ${r.areaNotes}`);
  } finally {
    await b.stop();
  }
});

test('through the tunnel the header (and a body `by`) is ignored: always the owner', async () => {
  const b = await boot();
  try {
    const r = await actAs(b.base, b.running.wp, { ...COO, ...TUNNEL });
    assert.deepEqual([r.focus, r.epicCreated, r.pointsBy, r.comment, r.legacyCreated, r.transition], Array(6).fill('owner'));
    assert.ok(r.areaNotes.length >= 2 && r.areaNotes.every(by => by === 'owner'), `area writes by the owner: ${r.areaNotes}`);
    const legacy = await call<WorkItem>(b.base, 'POST', '/api/work', { kind: 'assignment', title: 'Another', start: false }, TUNNEL);
    const spoof = await call<WorkItem>(b.base, 'POST', `/api/work/${legacy.body.id}/transition`, { to: 'rejected', by: 'coo', note: 'x' }, TUNNEL);
    assert.equal(spoof.status, 200);
    assert.equal(spoof.body.history.at(-1)!.by, 'owner', 'a relayed body cannot name its author either');
  } finally {
    await b.stop();
  }
});

test('an unknown actor from loopback is refused, not silently recorded', async () => {
  const b = await boot();
  try {
    const res = await call<{ error: string }>(b.base, 'POST', '/api/focus', { epicIds: [] }, { 'x-workplace-actor': 'dev' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /x-workplace-actor/);
  } finally {
    await b.stop();
  }
});

test('the tunnel strips x-workplace-actor from a relayed request before it reaches loopback', async () => {
  const seen: IncomingHttpHeaders[] = [];
  const local = createServer((req, res) => { seen.push(req.headers); req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }); });
  await new Promise<void>(r => local.listen(0, '127.0.0.1', () => r()));
  const relayServer = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let mac: WebSocket | null = null;
  const frames: Frame[] = [];
  relayServer.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => { mac = ws; ws.on('message', raw => frames.push(JSON.parse(String(raw)) as Frame)); }));
  await new Promise<void>(r => relayServer.listen(0, '127.0.0.1', () => r()));
  const tunnel = new Tunnel({
    url: `ws://127.0.0.1:${(relayServer.address() as { port: number }).port}/tunnel`, secret: 's', local: `http://127.0.0.1:${(local.address() as { port: number }).port}`,
    minBackoffMs: 50, maxBackoffMs: 100, notify: async () => true,
  });
  try {
    tunnel.start();
    for (let i = 0; i < 100 && mac?.readyState !== 1; i++) await new Promise(r => setTimeout(r, 20));
    mac!.send(JSON.stringify({ type: 'http', id: 'a1', method: 'POST', path: '/api/focus', headers: { 'content-type': 'application/json', 'X-Workplace-Actor': 'coo' }, body: Buffer.from('{"epicIds":[]}').toString('base64') }));
    for (let i = 0; i < 100 && !frames.some(f => f.type === 'response'); i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!['x-workplace-actor'], undefined);
    assert.equal(seen[0]!['x-via-tunnel'], '1');
  } finally {
    tunnel.stop();
    wss.close(); relayServer.closeAllConnections(); relayServer.close(); local.closeAllConnections(); local.close();
  }
});
