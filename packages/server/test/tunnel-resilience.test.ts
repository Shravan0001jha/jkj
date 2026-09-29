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
// 10 s, not 3: alone the tunnel reconnects in well under a second, but inside the whole suite (the e2e
// relay, several booted servers) a 3 s wait missed the second connect once (29 Sep integration run).
const until = async (pred: () => boolean, ms = 10_000, what = 'condition'): Promise<void> => {
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
    await until(() => tunnel.stats.connects === 2, 2000, 'the client side of the second connect');
    assert.equal(tunnel.status, 'connected');
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
    await until(() => tunnel.stats.connects === 2, 2000, 'the client side of the second connect');
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


/* ---------- B2 (29 Sep): the real cadence — the Mac sleeps, the relay keeps pinging and drops it ---------- */

import { Worker } from 'node:worker_threads';
import { SuspendDetector } from '../src/services/suspend.js';

/**
 * The relay in its own thread, so freezing this thread (as sleep freezes the process) leaves the
 * relay running: it keeps pinging every `pingMs` and, like the real one, drops a Mac that has not
 * answered for `staleMs`. Reports connects and drops to the test.
 */
const RELAY_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { createServer } = require('node:http');
const { WebSocketServer } = require('ws');
const { secret, pingMs, staleMs } = workerData;
const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
const wss = new WebSocketServer({ noServer: true });
let connects = 0, drops = 0;
server.on('upgrade', (req, socket, head) => {
  if (req.headers['authorization'] !== 'Bearer ' + secret) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    connects += 1; parentPort.postMessage({ type: 'connected', connects });
    let lastPong = Date.now();
    ws.on('message', raw => { const f = JSON.parse(String(raw)); if (f.type === 'pong' || f.type === 'on') lastPong = Date.now(); });
    const t = setInterval(() => {
      if (ws.readyState !== 1) return clearInterval(t);
      if (Date.now() - lastPong > staleMs) { drops += 1; parentPort.postMessage({ type: 'dropped', drops }); ws.close(1012, 'stale'); clearInterval(t); return; }
      ws.send(JSON.stringify({ type: 'ping' }));
    }, pingMs);
    ws.on('close', () => clearInterval(t));
  });
});
server.listen(0, '127.0.0.1', () => parentPort.postMessage({ type: 'listening', port: server.address().port }));
parentPort.on('message', m => { if (m === 'close') { for (const c of wss.clients) c.terminate(); wss.close(); server.close(() => process.exit(0)); } });
`;

async function relayInWorker(secret: string, pingMs: number, staleMs: number) {
  const worker = new Worker(RELAY_WORKER, { eval: true, workerData: { secret, pingMs, staleMs } });
  const state = { connects: 0, drops: 0, port: 0 };
  const waiters: (() => void)[] = [];
  worker.on('message', (m: { type: string; connects?: number; drops?: number; port?: number }) => {
    if (m.type === 'listening') state.port = m.port!;
    if (m.type === 'connected') state.connects = m.connects!;
    if (m.type === 'dropped') state.drops = m.drops!;
    for (const w of waiters.splice(0)) w();
  });
  const untilState = (pred: () => boolean, ms: number, what: string) => new Promise<void>((resolve, reject) => {
    if (pred()) return resolve();
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    const check = () => { if (pred()) { clearTimeout(t); resolve(); } else waiters.push(check); };
    waiters.push(check);
  });
  await untilState(() => state.port > 0, 3000, 'the relay to listen');
  return {
    url: `ws://127.0.0.1:${state.port}/tunnel`, state, untilState,
    close: () => new Promise<void>(r => { worker.once('exit', () => r()); worker.postMessage('close'); }),
  };
}

const freeze = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

test('B2: the Mac sleeps past the relay\'s stale limit and wakes; the tunnel reconnects at once on each wake, names the cause, and the backoff never grows', async () => {
  // Scale: relay pings every 45 ms and drops after 270 ms of silence (well above scheduler jitter) (real: 15 s / 45 s).
  const relay = await relayInWorker('s', 45, 270);
  const logged: string[] = [];
  const tunnel = new Tunnel({
    url: relay.url, secret: 's', local, minBackoffMs: 20, maxBackoffMs: 400, pongTimeoutMs: 270, livenessIntervalMs: 45,
    logger: { info: m => logged.push(m), warn: m => logged.push(m) },
  });
  const suspend = new SuspendDetector({ intervalMs: 20, thresholdMs: 100 });
  suspend.onResume(gap => tunnel.wake(gap));
  try {
    tunnel.start();
    suspend.start();
    await relay.untilState(() => relay.state.connects === 1, 3000, 'first connect');
    await wait(100);
    assert.equal(relay.state.drops, 0, 'awake and answering, the relay keeps it');

    // Three sleep/wake cycles, as the night of 28 Sep: each sleep is longer than the relay's limit.
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      freeze(700);
      const woke = Date.now();
      await relay.untilState(() => relay.state.connects === cycle + 1, 2000, `reconnect after sleep ${cycle}`);
      const took = Date.now() - woke;
      assert.ok(took < 300, `reconnected ${took} ms after waking (cycle ${cycle}), not after a liveness timeout`);
      assert.ok(relay.state.drops >= cycle, `the relay had dropped the sleeping Mac (${relay.state.drops})`);
      await wait(200);
      assert.equal(tunnel.status, 'connected');
      assert.equal(tunnel.stats.backoffMs, 20, 'the backoff is at the minimum after every wake');
    }
    assert.equal(tunnel.stats.reconnects.afterSleep, 3);
    assert.equal(suspend.state.count, 3);
    const asleep = logged.filter(m => /the Mac was asleep/.test(m));
    assert.equal(asleep.length, 3, `the log names the cause each time: ${JSON.stringify(asleep)}`);
    assert.ok(!logged.some(m => /no frame from the relay/.test(m)), 'never reported as a half-open socket');

    // A doze well inside the relay's limit (120 ms + one ping interval < 270 ms): the socket is still good and is kept.
    const before = relay.state.connects;
    freeze(120);
    await wait(300);
    assert.equal(relay.state.connects, before, 'no reconnect for a short doze');
    assert.equal(tunnel.status, 'connected');
    assert.ok(suspend.state.count >= 4, `the doze was noticed (jitter on a loaded machine may add one): ${suspend.state.count}`);
    assert.equal(tunnel.stats.reconnects.afterSleep, 3);
  } finally {
    suspend.stop();
    tunnel.stop();
    await relay.close();
  }
});

test('B2: asleep while a retry was pending (the relay was down) → the retry runs on wake, not after the old backoff', async () => {
  const relay = await fakeRelay('s');
  const port = relay.port;
  await relay.close();
  const tunnel = new Tunnel({ url: `ws://127.0.0.1:${port}/tunnel`, secret: 's', local, minBackoffMs: 200, maxBackoffMs: 5000 });
  try {
    tunnel.start();
    await wait(50);
    const attempts = tunnel.stats.attempts;
    const back = await fakeRelay('s', port);
    try {
      tunnel.wake(120_000);
      await back.connected(500);
      assert.equal(tunnel.stats.attempts, attempts + 1, 'exactly one attempt, at once');
      assert.equal(tunnel.status, 'connected');
    } finally { await back.close(); }
  } finally {
    tunnel.stop();
  }
});
