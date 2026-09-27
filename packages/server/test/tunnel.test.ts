import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { Tunnel, type Frame } from '../src/services/tunnel.js';

/**
 * A fake relay: accepts one tunnel connection when the secret is right and
 * lets the test push frames down it. The "Workplace" is a tiny loopback
 * server so the tunnel's proxying is exercised for real.
 */
async function fakeRelay(secret: string) {
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  let mac: WebSocket | null = null;
  const received: Frame[] = [];
  let waiters: ((f: Frame) => void)[] = [];
  const rejected: number[] = [];
  server.on('upgrade', (req, socket, head) => {
    if (req.headers['authorization'] !== `Bearer ${secret}`) { rejected.push(401); socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      mac = ws;
      ws.on('message', raw => { const f = JSON.parse(String(raw)) as Frame; received.push(f); const w = waiters; waiters = []; for (const fn of w) fn(f); });
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const next = (pred: (f: Frame) => boolean, ms = 3000): Promise<Frame> => new Promise((resolve, reject) => {
    const hit = received.find(pred); if (hit) return resolve(hit);
    const t = setTimeout(() => reject(new Error('no frame')), ms);
    waiters.push(f => { if (pred(f)) { clearTimeout(t); resolve(f); } });
  });
  return {
    url: `ws://127.0.0.1:${port}/tunnel`,
    send: (f: Frame) => mac!.send(JSON.stringify(f)),
    next, received, rejected,
    connected: () => new Promise<void>(r => { const i = setInterval(() => { if (mac?.readyState === 1) { clearInterval(i); r(); } }, 20); }),
    dropMac: () => mac?.close(),
    close: () => new Promise<void>(r => { wss.close(); server.closeAllConnections(); server.close(() => r()); }),
  };
}

async function fakeWorkplace() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-seen-auth': String(req.headers['authorization'] ?? 'none') });
      res.end(JSON.stringify({ path: req.url, method: req.method, body }));
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => { ws.send(JSON.stringify({ type: 'hello' })); ws.on('message', m => ws.send(`echo:${m}`)); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { local: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => { wss.close(); server.closeAllConnections(); server.close(() => r()); }) };
}

test('the tunnel authenticates, proxies HTTP and sockets to loopback, relays Telegram, and reconnects', async () => {
  const relay = await fakeRelay('s3cret');
  const wp = await fakeWorkplace();
  const statuses: string[] = [];
  const notified: string[] = [];
  const tunnel = new Tunnel({ url: relay.url, secret: 's3cret', local: wp.local, minBackoffMs: 50, maxBackoffMs: 100, onStatus: s => statuses.push(s), notify: async t => { notified.push(t); return true; } });
  try {
    tunnel.start();
    await relay.connected();
    assert.equal(tunnel.status, 'connected');

    // HTTP: the relay's request reaches the Workplace on loopback; the answer comes back by id.
    relay.send({ type: 'http', id: 'r1', method: 'POST', path: '/api/inbox/in_1/answer', headers: { 'content-type': 'application/json', cookie: 'wp_session=abc', host: 'work.irisforu.com' }, body: Buffer.from('{"optionId":"approve"}').toString('base64') });
    const res = await relay.next(f => f.type === 'response' && f.id === 'r1') as Extract<Frame, { type: 'response' }>;
    assert.equal(res.status, 200);
    const echoed = JSON.parse(Buffer.from(res.body!, 'base64').toString());
    assert.equal(echoed.path, '/api/inbox/in_1/answer');
    assert.equal(echoed.method, 'POST');
    assert.equal(echoed.body, '{"optionId":"approve"}');
    assert.equal(res.headers['x-seen-auth'], 'none', 'the relay session cookie is not turned into a bearer');

    // WebSocket: one relay client socket becomes one local socket.
    relay.send({ type: 'ws-open', id: 'c1', path: '/ws' });
    const hello = await relay.next(f => f.type === 'ws-frame' && f.id === 'c1') as Extract<Frame, { type: 'ws-frame' }>;
    assert.equal(JSON.parse(hello.data).type, 'hello');
    relay.send({ type: 'ws-frame', id: 'c1', data: 'ping-from-phone' });
    const echo = await relay.next(f => f.type === 'ws-frame' && f.id === 'c1' && f.data.startsWith('echo:')) as Extract<Frame, { type: 'ws-frame' }>;
    assert.equal(echo.data, 'echo:ping-from-phone');
    relay.send({ type: 'ws-close', id: 'c1' });

    // Telegram codes go out through the Mac.
    relay.send({ type: 'telegram', text: 'Your Iris Workplace code: 123456' });
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(notified, ['Your Iris Workplace code: 123456']);

    // Liveness and reconnect: the relay's ping is answered, and it counts as life (the Mac never pings).
    (tunnel as unknown as { lastPong: number }).lastPong = Date.now() - 60_000;
    relay.send({ type: 'ping' });
    await relay.next(f => f.type === 'pong');
    assert.ok(Date.now() - (tunnel as unknown as { lastPong: number }).lastPong < 1000, 'a ping refreshes liveness');
    relay.dropMac();
    await new Promise(r => setTimeout(r, 30));
    await relay.connected();
    assert.equal(tunnel.status, 'connected');
    assert.ok(statuses.includes('offline') && statuses.filter(s => s === 'connected').length >= 2);

    // The off switch tells the relay and stops reconnecting.
    tunnel.off();
    await relay.next(f => f.type === 'off');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(tunnel.status, 'off');
  } finally {
    tunnel.stop();
    await relay.close();
    await wp.close();
  }
});

test('a wrong secret is refused and the tunnel keeps trying with backoff, never connecting', async () => {
  const relay = await fakeRelay('right');
  const wp = await fakeWorkplace();
  const tunnel = new Tunnel({ url: relay.url, secret: 'wrong', local: wp.local, minBackoffMs: 30, maxBackoffMs: 60 });
  try {
    tunnel.start();
    await new Promise(r => setTimeout(r, 250));
    assert.ok(relay.rejected.length >= 2, `retried: ${relay.rejected.length}`);
    assert.notEqual(tunnel.status, 'connected');
  } finally {
    tunnel.stop();
    await relay.close();
    await wp.close();
  }
});
