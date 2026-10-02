import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { Resolver, lookup as osLookup } from 'node:dns';
import { join } from 'node:path';
import WebSocket from 'ws';
import { log as defaultLog } from '../util/logger.js';
import type { PushIntent, PushResult } from './push.js';

/**
 * The Mac's outbound tunnel to the relay (HLD D11b, LLD §17).
 *
 * Nothing listens on the Mac off loopback. The Workplace opens one WSS to
 * the relay, authenticated with the tunnel secret, and answers the relay's
 * frames by calling its own loopback port: HTTP requests as requests, relay
 * client sockets as local sockets. The relay asks the Mac to send Telegram
 * codes, so the bot token never leaves this machine.
 *
 * It must come back on its own after anything the laptop at home goes
 * through (docs/RESILIENCE-workplace.md §3): sleep and wake, a Wi-Fi change,
 * DNS that fails for a while, a relay restart, a long outage. Reconnect with
 * backoff 1 s → 30 s (capped); a socket that goes silent is a half-open
 * socket and is dropped; a handshake that hangs is abandoned. Stats for the
 * health check: last connect, last disconnect, attempts, connects.
 */

export type Frame =
  | { type: 'http'; id: string; method: string; path: string; headers: Record<string, string>; body?: string }
  | { type: 'response'; id: string; status: number; headers: Record<string, string>; body?: string }
  | { type: 'ws-open'; id: string; path: string }
  | { type: 'ws-frame'; id: string; data: string }
  | { type: 'ws-close'; id: string; code?: number }
  | { type: 'telegram'; text: string }
  | ({ type: 'push' } & PushIntent)
  | ({ type: 'push-result' } & PushResult)
  | { type: 'off' }
  | { type: 'on' }
  | { type: 'enrol-on' }
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'hello'; relay: string };

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;
export type TunnelLookup = (hostname: string, options: unknown, callback: LookupCb) => void;

export interface TunnelOptions {
  /** wss://work.irisforu.com/tunnel */
  url: string;
  secret: string;
  /** The Workplace's own loopback origin, e.g. http://127.0.0.1:4317 */
  local: string;
  /** Sends a Telegram message; defaults to notify.sh. */
  notify?: (text: string) => Promise<boolean>;
  /** Backoff bounds, ms: 1 s doubling to 30 s. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** The relay pings every 15 s; this long without any frame is a half-open socket (45 s). */
  pongTimeoutMs?: number;
  livenessIntervalMs?: number;
  /** A connect that has not completed its handshake by then is abandoned and retried (15 s). */
  handshakeTimeoutMs?: number;
  /** Name resolution; defaults to a direct query with an OS fallback. */
  lookup?: TunnelLookup;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
  onStatus?: (status: TunnelStatus) => void;
  /** The relay's answer to a push frame. */
  onPushResult?: (result: PushResult) => void;
  onAttempt?: (attempt: number) => void;
}

export type TunnelStatus = 'connecting' | 'connected' | 'offline' | 'off';

export interface TunnelStats {
  status: TunnelStatus;
  /** Connect attempts since the process started. */
  attempts: number;
  /** Successful connects since the process started. */
  connects: number;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  /** The error of the current run of failed attempts; null once connected. */
  lastError: string | null;
  /** How long the tunnel has been away from 'connected' now; 0 while connected. */
  downForSeconds: number;
  /** The wait before the next attempt. */
  backoffMs: number;
  reconnects: { halfOpen: number; afterSleep: number };
}

const DEFAULT_MIN_BACKOFF = 1000;
const DEFAULT_MAX_BACKOFF = 30_000;
const DEFAULT_PONG_TIMEOUT = 45_000;
const DEFAULT_LIVENESS_INTERVAL = 15_000;
const DEFAULT_HANDSHAKE_TIMEOUT = 15_000;

export class Tunnel {
  private ws: WebSocket | null = null;
  private locals = new Map<string, WebSocket>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private liveness: ReturnType<typeof setInterval> | null = null;
  private lastLogged = '';
  private backoff: number;
  private stopped = false;
  private _status: TunnelStatus = 'offline';
  private lastPong = Date.now();
  private readonly log: { info: (msg: string) => void; warn: (msg: string) => void };

  private attempts = 0;
  private connects = 0;
  private halfOpen = 0;
  private afterSleep = 0;
  private lastConnectedAt: number | null = null;
  private lastDisconnectedAt: number | null = null;
  private downSince: number | null = null;
  private lastError: string | null = null;

  constructor(private options: TunnelOptions) {
    this.backoff = options.minBackoffMs ?? DEFAULT_MIN_BACKOFF;
    this.log = options.logger ?? { info: m => defaultLog.info('tunnel', m), warn: m => defaultLog.warn('tunnel', m) };
  }

  get status(): TunnelStatus {
    return this._status;
  }

  get stats(): TunnelStats {
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    return {
      status: this._status,
      attempts: this.attempts,
      connects: this.connects,
      lastConnectedAt: iso(this.lastConnectedAt),
      lastDisconnectedAt: iso(this.lastDisconnectedAt),
      lastError: this.lastError,
      downForSeconds: this._status === 'connected' || this.downSince === null ? 0 : Math.max(0, Math.round((Date.now() - this.downSince) / 1000)),
      backoffMs: this.backoff,
      reconnects: { halfOpen: this.halfOpen, afterSleep: this.afterSleep },
    };
  }

  /**
   * The process was frozen for gapMs (the Mac slept; services/suspend.ts). The relay drops a Mac
   * that is silent for 45 s, so after a sleep longer than that the open socket is already dead on
   * the far side: drop it now and reconnect at once, instead of waiting up to 15 s for the liveness
   * check to say "no pong". A pending retry runs immediately; the backoff starts over because the
   * network just came back. (B2, 29 Sep: every flap was a wake.)
   */
  wake(gapMs: number): void {
    if (this.stopped) return;
    const seconds = Math.round(gapMs / 1000);
    this.backoff = this.options.minBackoffMs ?? DEFAULT_MIN_BACKOFF;
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (gapMs > (this.options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT)) {
        this.afterSleep += 1;
        this.log.warn(`the Mac was asleep ${seconds} s; the relay will have dropped this socket; reconnecting now`);
        ws.terminate();
      } else {
        this.log.info(`the Mac was asleep ${seconds} s; the socket may still be good, the liveness check decides`);
      }
      return;
    }
    if (this.timer) {
      this.log.info(`the Mac was asleep ${seconds} s; retrying the relay now`);
      clearTimeout(this.timer);
      this.timer = null;
      this.connect();
    }
  }

  start(): void {
    this.stopped = false;
    this.downSince ??= Date.now();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) { if (ws.readyState === WebSocket.OPEN) ws.close(); else ws.terminate(); }
    this.setStatus('offline');
  }

  /**
   * Ask the relay to push to the owner's phones (LLD-workplace-push §8). False when nothing is
   * connected: the intent is dropped, never queued, so a reconnect cannot replay stale "needs you".
   */
  push(intent: PushIntent): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.send({ type: 'push', ...intent });
    return true;
  }

  /** Re-enable passkey enrolment on the relay after it disabled itself. */
  enrolOn(): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.send({ type: 'enrol-on' });
    return true;
  }

  /** Publish again after off(): reconnect; the 'on' frame goes out on connect. */
  on(): boolean {
    if (this._status !== 'off') return false;
    this.stopped = false;
    this.backoff = this.options.minBackoffMs ?? DEFAULT_MIN_BACKOFF;
    this.connect();
    return true;
  }

  /** The emergency off switch: tell the relay to drop everything, then close. */
  off(): void {
    this.send({ type: 'off' });
    this.setStatus('off');
    this.stopped = true;
    this.clearTimers();
    setTimeout(() => this.ws?.close(), 200);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus('connecting');
    this.attempts += 1;
    this.options.onAttempt?.(this.attempts);
    const ws = new WebSocket(this.options.url, {
      headers: { authorization: `Bearer ${this.options.secret}` },
      lookup: (this.options.lookup ?? freshLookup) as unknown as undefined,
      handshakeTimeout: this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT,
    });
    this.ws = ws;
    let reported = false;

    ws.on('open', () => {
      this.lastLogged = '';
      this.lastError = null;
      this.backoff = this.options.minBackoffMs ?? DEFAULT_MIN_BACKOFF;
      this.lastPong = Date.now();
      this.connects += 1;
      this.lastConnectedAt = Date.now();
      this.downSince = null;
      this.setStatus('connected');
      this.log.info(`connected to ${this.options.url}`);
      // The relay stays "off" across restarts until the Mac says otherwise (review M2). A Mac that
      // connects is publishing on purpose; the off switch stops it from connecting at all.
      this.send({ type: 'on' });
      const timeout = this.options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT;
      const interval = this.options.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL;
      let lastTick = Date.now();
      this.liveness = setInterval(() => {
        // This timer was frozen with the process: a tick that is late by more than the relay's limit
        // means the Mac slept, and the relay has dropped the socket meanwhile (B2). Name that cause;
        // do not call it a half-open socket.
        const now = Date.now();
        const late = now - lastTick - interval;
        lastTick = now;
        if (late > timeout) {
          this.afterSleep += 1;
          this.log.warn(`the Mac was asleep ${Math.round(late / 1000)} s; the relay will have dropped this socket; reconnecting now`);
          ws.terminate();
          return;
        }
        // The relay pings every 15 s; this long without a frame is a half-open socket (review M3),
        // the state after a Wi-Fi change or a relay that went away without a FIN.
        if (now - this.lastPong > timeout) {
          this.halfOpen += 1;
          this.log.warn(`no frame from the relay for ${Math.round(timeout / 1000)} s; dropping the socket and reconnecting`);
          ws.terminate();
        }
      }, this.options.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL);
    });
    ws.on('message', raw => { void this.handle(raw.toString()); });
    ws.on('close', code => {
      if (this.liveness) { clearInterval(this.liveness); this.liveness = null; }
      if (this.ws === ws) this.ws = null;
      for (const local of this.locals.values()) local.close();
      this.locals.clear();
      if (this.lastConnectedAt !== null && this.lastConnectedAt >= (this.lastDisconnectedAt ?? -1)) this.lastDisconnectedAt = Date.now();
      this.downSince ??= Date.now();
      if (this._status !== 'off') this.setStatus('offline');
      if (!this.stopped) this.schedule(`closed (${code})`);
    });
    ws.on('error', err => {
      // One error per attempt: the abort that follows it also emits an error, and that is not news.
      if (reported) return;
      reported = true;
      this.lastError = err.message;
      // The same failure every retry (DNS not there yet, relay down) is logged once, not per attempt.
      if (err.message !== this.lastLogged) { this.log.warn(`error: ${err.message}`); this.lastLogged = err.message; }
      ws.terminate();
    });
  }

  /** The wait before the next attempt: doubles from the minimum to the cap and stays there. */
  private nextWait(): number {
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF);
    return wait;
  }

  private schedule(reason: string): void {
    if (this.stopped) return;
    const wait = this.nextWait();
    this.log.info(`${reason}; reconnecting in ${wait >= 1000 ? `${Math.round(wait / 1000)} s` : `${wait} ms`}`);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, wait);
  }

  private clearTimers(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.liveness) { clearInterval(this.liveness); this.liveness = null; }
  }

  private setStatus(status: TunnelStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.options.onStatus?.(status);
  }

  private send(frame: Frame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private async handle(raw: string): Promise<void> {
    let frame: Frame;
    try { frame = JSON.parse(raw) as Frame; } catch { return; }
    // Any frame from the relay is proof the socket is alive; the relay pings, the Mac only answers.
    this.lastPong = Date.now();

    switch (frame.type) {
      case 'ping': this.send({ type: 'pong' }); break;
      case 'pong': this.lastPong = Date.now(); break;
      case 'hello': break;
      case 'http':
        if (!safePath(frame.path)) { this.send({ type: 'response', id: frame.id, status: 400, headers: {}, body: '' }); break; }
        await this.proxyHttp(frame);
        break;
      case 'ws-open': if (safePath(frame.path)) this.openLocal(frame.id, frame.path); break;
      case 'ws-frame': this.locals.get(frame.id)?.send(frame.data); break;
      case 'ws-close': { const l = this.locals.get(frame.id); this.locals.delete(frame.id); l?.close(); break; }
      case 'telegram': await (this.options.notify ?? notifyViaScript)(frame.text); break;
      case 'push-result': this.options.onPushResult?.({ id: String(frame.id), sent: Number(frame.sent) || 0, dropped: Number(frame.dropped) || 0, failed: Number(frame.failed) || 0 }); break;
      default: break;
    }
  }

  /** The Workplace's real loopback origin once the listener is bound (`--port 0` in tests binds a random port). */
  setLocal(origin: string): void {
    this.options = { ...this.options, local: origin };
  }

  /** One relay request → one request to our own loopback port. */
  private async proxyHttp(frame: Extract<Frame, { type: 'http' }>): Promise<void> {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(frame.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && !MAC_ONLY.has(k.toLowerCase())) headers[k] = v;
    }
    // Set by the Mac, never by a client: the loopback listener uses it to refuse pairing (review M5).
    headers['x-via-tunnel'] = '1';
    try {
      const res = await fetch(`${this.options.local}${frame.path}`, {
        method: frame.method,
        headers,
        ...(frame.body && frame.method !== 'GET' && frame.method !== 'HEAD' ? { body: Buffer.from(frame.body, 'base64') } : {}),
        redirect: 'manual',
      });
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k)) out[k] = v; });
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.byteLength > MAX_RESPONSE_BYTES) {
        // One oversized frame would close the whole tunnel and every session with it (review L2).
        this.send({ type: 'response', id: frame.id, status: 502, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ error: `Response too large for the relay (${bytes.byteLength} bytes).` })).toString('base64') });
        return;
      }
      this.send({ type: 'response', id: frame.id, status: res.status, headers: out, body: bytes.toString('base64') });
    } catch (err) {
      this.send({ type: 'response', id: frame.id, status: 502, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ error: `Workplace unreachable on loopback: ${err instanceof Error ? err.message : String(err)}` })).toString('base64') });
    }
  }

  /** One relay client socket → one socket to our own /ws. */
  private openLocal(id: string, path: string): void {
    const local = new WebSocket(`${this.options.local.replace(/^http/, 'ws')}${path}`);
    this.locals.set(id, local);
    local.on('message', data => this.send({ type: 'ws-frame', id, data: data.toString() }));
    local.on('close', code => { if (this.locals.delete(id)) this.send({ type: 'ws-close', id, code }); });
    local.on('error', () => local.close());
  }
}

/**
 * Resolve the relay's name with a direct query to the configured nameservers, falling back to the
 * OS resolver. macOS caches a negative answer for a name that did not exist a minute ago (a fresh
 * DNS record, 27 Sep) and the tunnel would sit on ENOTFOUND for the negative TTL. The resolver is
 * made per call so a Wi-Fi change (new nameservers) is picked up on the next attempt.
 */
function freshLookup(hostname: string, options: unknown, callback: LookupCb): void {
  // net.connect may ask for every address (`all: true`, Node 20+) or for one.
  const all = !!(options && typeof options === 'object' && (options as { all?: boolean }).all);
  const resolver = new Resolver();
  resolver.resolve4(hostname, (err, addresses) => {
    if (!err && addresses.length) {
      return all ? callback(null, addresses.map(address => ({ address, family: 4 }))) : callback(null, addresses[0]!, 4);
    }
    (osLookup as unknown as TunnelLookup)(hostname, options, callback);
  });
}

/** A path the relay may ask for: absolute, on our own origin, never a userinfo trick (review L5). */
export function safePath(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return false;
  try { return new URL(path, 'http://127.0.0.1').origin === 'http://127.0.0.1'; } catch { return false; }
}

const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

/** Headers only this Mac may set: a relayed client never names the tunnel flag or its own author (LLD §19.8 Actor). */
const MAC_ONLY = new Set(['x-via-tunnel', 'x-workplace-actor']);
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate']);

function notifyViaScript(text: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile(join(process.env['HOME'] ?? '', 'iris-ops', 'notify.sh'), [text], { timeout: 15_000 }, (err, stdout) => resolve(!err && String(stdout).includes('sent')));
  });
}

/** The tunnel secret from ~/iris-ops/workplace/relay.env (TUNNEL_SECRET=…). Never logged. */
export function readTunnelSecret(opsDir: string): string | null {
  try {
    const line = readFileSync(join(opsDir, 'workplace', 'relay.env'), 'utf8').split('\n').find(l => l.startsWith('TUNNEL_SECRET='));
    const v = line?.slice('TUNNEL_SECRET='.length).trim();
    return v || null;
  } catch {
    return null;
  }
}

export function readRelayUrl(opsDir: string): string | null {
  try {
    const line = readFileSync(join(opsDir, 'workplace', 'relay.env'), 'utf8').split('\n').find(l => l.startsWith('RELAY_URL='));
    const v = line?.slice('RELAY_URL='.length).trim();
    return v || null;
  } catch {
    return null;
  }
}
