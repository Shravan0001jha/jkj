import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { Tunnel, type Frame, type TunnelLookup } from '../src/services/tunnel.js';

/**
 * The tunnel after the laptop is left alone (docs/RESILIENCE-workplace.md §3): the relay restarts,
 * the socket goes half-open after sleep, DNS fails for a while, the relay is gone for a long time,
 * a connect hangs. In every case the tunnel comes back on its own, its backoff never passes the cap,
 * and its stats say what happened.
 */

interface Relay {
  url: string;
  port: number;
  mac: () => WebSocket | null;
  connections: number;
  send: (f: Frame) => void;
  connected: (ms?: number) => Promise<void>;
  silent: boolean;
  close: () => Promise<void>;
}

/** A fake relay on a fixed port so it can "restart" (close, then open again on the same address). */
async function fakeRelay(secret: string, port = 0): Promise<Relay> {
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  const relay: Relay = {
    url: '', port: 0, connections: 0, silent: false,
    mac: () => mac,
    send: f => mac?.send(JSON.stringify(f)),
    connected: (ms = 3000) => new Promise((resolve, reject) => {
      const seen = relay.connections;
      const t = setTimeout(() => { clearInterval(i); reject(new Error(`no new tunnel connection in ${ms} ms`)); }, ms);
      const i = setInterval(() => { if (relay.connections > seen && mac?.readyState === 1) { clearInterval(i); clearTimeout(t); resolve(); } }, 10);
    }),
    close: () => new Promise<void>(r => { for (const c of wss.clients) c.terminate(); wss.close(); server.closeAllConnections(); server.close(() => r()); }),
  };
  let mac: WebSocket | null = null;
  server.on('upgrade', (req, socket, head) => {
    if (req.headers['authorization'] !== `Bearer ${secret}`) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      mac = ws; relay.connections += 1;
      // A live relay pings; a "silent" one holds the socket open and says nothing (half-open after sleep).
      const ping = setInterval(() => { if (!relay.silent && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' })); }, 20);
      ws.on('close', () => clearInterval(ping));
    });
  });
  await new Promise<void>(r => server.listen(port, '127.0.0.1', () => r()));
  relay.port = (server.address() as { port: number }).port;
  relay.url = `ws://127.0.0.1:${relay.port}/tunnel`;
  return relay;
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (pred: () => boolean, ms = 3000, what = 'condition'): Promise<void> => {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await wait(10); }
};

const local = 'http://127.0.0.1:1'; // never called in these tests

test('relay restart: the tunnel reconnects to the same address once the relay is back, and its stats record the gap', async () => {
  let relay = await fakeRelay('s');
  const port = relay.port;
  const statuses: string[] = [];
  const tunnel = new Tunnel({ url: relay.url, secret: 's', local, minBackoffMs: 20, maxBackoffMs: 80, onStatus: s => statuses.push(s) });
  try {
    tunnel.start();
    await relay.connected();
    const firstConnect = tunnel.stats.lastConnectedAt;
    assert.ok(firstConnect, 'connect time recorded');
    assert.equal(tunnel.stats.connects, 1);
    assert.equal(tunnel.stats.downForSeconds, 0);

    // The relay goes away entirely (a deploy), taking the socket with it.
    await relay.close();
    await until(() => tunnel.status !== 'connected', 3000, 'disconnect');
    assert.ok(tunnel.stats.lastDisconnectedAt, 'disconnect time recorded');
    await wait(150);
    assert.ok(tunnel.stats.attempts >= 2, `kept trying while the relay was down: ${tunnel.stats.attempts}`);

    // It comes back on the same port: the tunnel is connected again without anyone touching it.
    relay = await fakeRelay('s', port);
    await relay.connected(4000);
    assert.equal(tunnel.status, 'connected');
    assert.equal(tunnel.stats.connects, 2);
    assert.notEqual(tunnel.stats.lastConnectedAt, firstConnect);
    assert.equal(tunnel.stats.downForSeconds, 0);
    assert.equal(tunnel.stats.lastError, null, 'a fresh connect clears the last error');
  } finally {
    tunnel.stop();
    await relay.close();
  }
});

test('half-open socket: a relay that goes silent is dropped by the liveness check and a new connection is made', async () => {
  const relay = await fakeRelay('s');
  const tunnel = new Tunnel({ url: relay.url, secret: 's', local, minBackoffMs: 20, maxBackoffMs: 80, pongTimeoutMs: 120, livenessIntervalMs: 30 });
  try {
    tunnel.start();
    await relay.connected();
    const first = relay.mac()!;
    await wait(200);
    assert.equal(relay.mac(), first, 'a relay that pings keeps its connection');
    assert.equal(tunnel.stats.connects, 1);

    // After sleep the socket is still "open" on the Mac but nothing arrives on it.
    relay.silent = true;
    await relay.connected(3000);
    assert.notEqual(relay.mac(), first, 'the silent socket was replaced');
    assert.equal(tunnel.stats.connects, 2);
    assert.equal(tunnel.status, 'connected');
    assert.ok(tunnel.stats.reconnects.halfOpen >= 1, 'the drop was counted as a half-open socket');
  } finally {
    tunnel.stop();
    await relay.close();
  }
});

test('DNS failure: the name does not resolve for a while, then does; the tunnel connects and logged the failure once', async () => {
  const relay = await fakeRelay('s');
  let failures = 0;
  const lookup: TunnelLookup = (_hostname, options, callback) => {
    if (failures < 4) {
      failures += 1;
      const err = Object.assign(new Error('getaddrinfo ENOTFOUND relay.example'), { code: 'ENOTFOUND' });
      return callback(err, options && typeof options === 'object' && (options as { all?: boolean }).all ? [] : '');
    }
    const all = !!(options && typeof options === 'object' && (options as { all?: boolean }).all);
    return all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4);
  };
  const warned: string[] = [];
  const tunnel = new Tunnel({ url: `ws://relay.example:${relay.port}/tunnel`, secret: 's', local, minBackoffMs: 10, maxBackoffMs: 40, lookup, logger: { warn: m => warned.push(m), info: () => {} } });
  try {
    tunnel.start();
    await relay.connected(4000);
    assert.equal(failures, 4, 'four attempts failed on DNS');
    assert.equal(tunnel.status, 'connected');
    assert.equal(tunnel.stats.lastError, null);
    const dns = warned.filter(m => m.includes('ENOTFOUND'));
    assert.equal(dns.length, 1, `the same DNS error is logged once, not per attempt: ${JSON.stringify(warned)}`);
    assert.ok(!warned.some(m => /closed before the connection was established/.test(m)), 'the abort that follows an error is not logged as a second error');
  } finally {
    tunnel.stop();
    await relay.close();
  }
});

test('long outage: attempts keep coming at the capped interval, never faster after the cap, and the tunnel returns when the relay does', async () => {
  const relay = await fakeRelay('s');
  const port = relay.port;
  await relay.close();
  const attemptsAt: number[] = [];
  const tunnel = new Tunnel({ url: `ws://127.0.0.1:${port}/tunnel`, secret: 's', local, minBackoffMs: 10, maxBackoffMs: 60, onAttempt: () => attemptsAt.push(Date.now()) });
  try {
    tunnel.start();
    await wait(600);
    assert.ok(attemptsAt.length >= 6, `many attempts during the outage: ${attemptsAt.length}`);
    assert.ok(tunnel.stats.backoffMs <= 60, `backoff is capped at the maximum: ${tunnel.stats.backoffMs}`);
    // After the cap is reached the gaps stay at about the cap: never longer than the cap plus slack, never a runaway.
    const late = attemptsAt.slice(-3);
    for (let i = 1; i < late.length; i += 1) assert.ok(late[i]! - late[i - 1]! < 60 + 150, `gap ${late[i]! - late[i - 1]!} ms stays near the cap`);
    assert.ok(tunnel.stats.downForSeconds >= 0 && tunnel.stats.lastConnectedAt === null, 'never connected so far');

    const back = await fakeRelay('s', port);
    try {
      await back.connected(4000);
      assert.equal(tunnel.status, 'connected');
      assert.equal(tunnel.stats.backoffMs, 10, 'a successful connect resets the backoff to the minimum');
    } finally { await back.close(); }
  } finally {
    tunnel.stop();
  }
});

test('a connect that hangs (the network is up but nothing answers) is abandoned after the handshake timeout and retried', async () => {
  // A TCP listener that accepts and then says nothing: the WebSocket handshake never completes.
  const held = new Set<import('node:net').Socket>();
  const blackhole = createTcpServer(socket => { held.add(socket); socket.on('error', () => {}); socket.on('close', () => held.delete(socket)); });
  await new Promise<void>(r => blackhole.listen(0, '127.0.0.1', () => r()));
  const port = (blackhole.address() as { port: number }).port;
  const tunnel = new Tunnel({ url: `ws://127.0.0.1:${port}/tunnel`, secret: 's', local, minBackoffMs: 10, maxBackoffMs: 20, handshakeTimeoutMs: 80 });
  try {
    tunnel.start();
    await wait(400);
    assert.ok(tunnel.stats.attempts >= 3, `retried after each hung handshake: ${tunnel.stats.attempts}`);
    assert.match(tunnel.stats.lastError ?? '', /timed out|timeout/i);
    assert.notEqual(tunnel.status, 'connected');
  } finally {
    tunnel.stop();
    // The blackhole never answered, so it still holds every accepted socket; a server.close() would wait forever.
    for (const s of held) s.destroy();
    await new Promise<void>(r => blackhole.close(() => r()));
  }
});

test('the backoff sequence doubles from the minimum to the cap and no further', () => {
  const tunnel = new Tunnel({ url: 'ws://127.0.0.1:1/tunnel', secret: 's', local, minBackoffMs: 1000, maxBackoffMs: 30_000 });
  const waits: number[] = [];
  for (let i = 0; i < 8; i += 1) waits.push((tunnel as unknown as { nextWait(): number }).nextWait());
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
});

test('stop() during an outage cancels the pending retry so nothing lingers', async () => {
  const relay = await fakeRelay('s');
  const port = relay.port;
  await relay.close();
  const tunnel = new Tunnel({ url: `ws://127.0.0.1:${port}/tunnel`, secret: 's', local, minBackoffMs: 20, maxBackoffMs: 40 });
  tunnel.start();
  await wait(50);
  const before = tunnel.stats.attempts;
  tunnel.stop();
  await wait(150);
  assert.equal(tunnel.stats.attempts, before, 'no attempt after stop');
  assert.equal(tunnel.status, 'offline');
});

