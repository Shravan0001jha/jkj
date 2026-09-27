import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import WebSocket from 'ws';
import { log } from '../util/logger.js';

/**
 * The Mac's outbound tunnel to the relay (HLD D11b, LLD §17).
 *
 * Nothing listens on the Mac off loopback. The Workplace opens one WSS to
 * the relay, authenticated with the tunnel secret, and answers the relay's
 * frames by calling its own loopback port: HTTP requests as requests, relay
 * client sockets as local sockets. The relay asks the Mac to send Telegram
 * codes, so the bot token never leaves this machine. Reconnects with backoff.
 */

export type Frame =
  | { type: 'http'; id: string; method: string; path: string; headers: Record<string, string>; body?: string }
  | { type: 'response'; id: string; status: number; headers: Record<string, string>; body?: string }
  | { type: 'ws-open'; id: string; path: string }
  | { type: 'ws-frame'; id: string; data: string }
  | { type: 'ws-close'; id: string; code?: number }
  | { type: 'telegram'; text: string }
  | { type: 'off' }
  | { type: 'on' }
  | { type: 'enrol-on' }
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'hello'; relay: string };

export interface TunnelOptions {
  /** wss://work.irisforu.com/tunnel */
  url: string;
  secret: string;
  /** The Workplace's own loopback origin, e.g. http://127.0.0.1:4317 */
  local: string;
  /** Sends a Telegram message; defaults to notify.sh. */
  notify?: (text: string) => Promise<boolean>;
  /** Backoff bounds, ms. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  onStatus?: (status: TunnelStatus) => void;
}

export type TunnelStatus = 'connecting' | 'connected' | 'offline' | 'off';

export class Tunnel {
  private ws: WebSocket | null = null;
  private locals = new Map<string, WebSocket>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backoff: number;
  private stopped = false;
  private _status: TunnelStatus = 'offline';
  private lastPong = Date.now();

  constructor(private readonly options: TunnelOptions) {
    this.backoff = options.minBackoffMs ?? 1000;
  }

  get status(): TunnelStatus {
    return this._status;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    this.setStatus('offline');
  }

  /** Re-enable passkey enrolment on the relay after it disabled itself. */
  enrolOn(): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.send({ type: 'enrol-on' });
    return true;
  }

  /** The emergency off switch: tell the relay to drop everything, then close. */
  off(): void {
    this.send({ type: 'off' });
    this.setStatus('off');
    this.stopped = true;
    setTimeout(() => this.ws?.close(), 200);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus('connecting');
    const ws = new WebSocket(this.options.url, { headers: { authorization: `Bearer ${this.options.secret}` } });
    this.ws = ws;

    ws.on('open', () => {
      this.backoff = this.options.minBackoffMs ?? 1000;
      this.lastPong = Date.now();
      this.setStatus('connected');
      log.info('tunnel', `connected to ${this.options.url}`);
    });
    ws.on('message', raw => { void this.handle(raw.toString()); });
    ws.on('close', code => {
      if (this.ws === ws) this.ws = null;
      for (const local of this.locals.values()) local.close();
      this.locals.clear();
      if (this._status !== 'off') this.setStatus('offline');
      if (!this.stopped) this.schedule(`closed (${code})`);
    });
    ws.on('error', err => {
      log.warn('tunnel', `error: ${err.message}`);
      ws.close();
    });
  }

  private schedule(reason: string): void {
    if (this.stopped) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs ?? 30_000);
    log.info('tunnel', `${reason}; reconnecting in ${Math.round(wait / 1000)} s`);
    this.timer = setTimeout(() => this.connect(), wait);
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

    switch (frame.type) {
      case 'ping': this.send({ type: 'pong' }); break;
      case 'pong': this.lastPong = Date.now(); break;
      case 'hello': break;
      case 'http': await this.proxyHttp(frame); break;
      case 'ws-open': this.openLocal(frame.id, frame.path); break;
      case 'ws-frame': this.locals.get(frame.id)?.send(frame.data); break;
      case 'ws-close': { const l = this.locals.get(frame.id); this.locals.delete(frame.id); l?.close(); break; }
      case 'telegram': await (this.options.notify ?? notifyViaScript)(frame.text); break;
      default: break;
    }
  }

  /** One relay request → one request to our own loopback port. */
  private async proxyHttp(frame: Extract<Frame, { type: 'http' }>): Promise<void> {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(frame.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    }
    try {
      const res = await fetch(`${this.options.local}${frame.path}`, {
        method: frame.method,
        headers,
        ...(frame.body && frame.method !== 'GET' && frame.method !== 'HEAD' ? { body: Buffer.from(frame.body, 'base64') } : {}),
        redirect: 'manual',
      });
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k)) out[k] = v; });
      const body = Buffer.from(await res.arrayBuffer()).toString('base64');
      this.send({ type: 'response', id: frame.id, status: res.status, headers: out, body });
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
