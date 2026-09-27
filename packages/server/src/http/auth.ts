import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { log } from '../util/logger.js';

/**
 * Reaching the Workplace from anywhere but this Mac (HLD D11).
 *
 * Loopback is trusted: it is the owner's machine. Everything else must carry
 * `Authorization: Bearer <token>` (or `?token=` on the socket upgrade). The
 * token lives in ~/iris-ops/workplace/api-token, mode 600, generated once,
 * never shown in the UI. A phone gets it by pairing: a one-time code minted
 * from loopback, exchanged within five minutes.
 */

export class Auth {
  private readonly token: Buffer;
  private readonly codes = new Map<string, number>();

  constructor(private readonly tokenPath: string, private readonly now: () => number = Date.now) {
    this.token = Buffer.from(loadOrCreateToken(tokenPath), 'utf8');
  }

  /** True when the request may proceed. */
  allows(req: IncomingMessage): boolean {
    if (isLoopback(req.socket.remoteAddress)) return true;
    return this.check(bearerOf(req));
  }

  check(presented: string | null): boolean {
    if (!presented) return false;
    const given = Buffer.from(presented, 'utf8');
    return given.length === this.token.length && timingSafeEqual(given, this.token);
  }

  /** Only from loopback. Six digits, five minutes, one use. */
  pair(req: IncomingMessage): { code: string; expiresAt: string } {
    if (!isLoopback(req.socket.remoteAddress)) throw new Error('Pairing codes are minted from this Mac only.');
    const code = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0');
    const expiresAt = this.now() + 5 * 60 * 1000;
    this.codes.set(code, expiresAt);
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  exchange(code: string): string | null {
    const expiresAt = this.codes.get(code);
    if (!expiresAt) return null;
    this.codes.delete(code);
    if (expiresAt < this.now()) return null;
    return this.token.toString('utf8');
  }

  get path(): string {
    return this.tokenPath;
  }
}

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.');
}

export function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get('token');
}

function loadOrCreateToken(path: string): string {
  if (existsSync(path)) {
    const token = readFileSync(path, 'utf8').trim();
    if (token.length >= 32) return token;
  }
  mkdirSync(join(path, '..'), { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  log.info('auth', `created the API token at ${path}`);
  return token;
}
