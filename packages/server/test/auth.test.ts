import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { Auth, isLoopback } from '../src/http/auth.js';

const req = (remote: string, headers: Record<string, string> = {}, url = '/api/office'): IncomingMessage =>
  ({ socket: { remoteAddress: remote }, headers, url } as unknown as IncomingMessage);

test('the token is created once, mode 600, and reused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-'));
  try {
    const path = join(dir, 'workplace', 'api-token');
    const a = new Auth(path);
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600);
    const token = readFileSync(path, 'utf8').trim();
    assert.equal(token.length, 64);
    const b = new Auth(path);
    assert.equal(b.check(token), true);
    assert.equal(a.check(token), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopback passes; off-loopback needs the exact bearer token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-'));
  try {
    const path = join(dir, 'api-token');
    const auth = new Auth(path);
    const token = readFileSync(path, 'utf8').trim();
    assert.equal(auth.allows(req('127.0.0.1')), true);
    assert.equal(auth.allows(req('::1')), true);
    assert.equal(auth.allows(req('::ffff:127.0.0.1')), true);
    assert.equal(auth.allows(req('100.64.0.7')), false);
    assert.equal(auth.allows(req('100.64.0.7', { authorization: `Bearer ${token}` })), true);
    assert.equal(auth.allows(req('100.64.0.7', { authorization: `Bearer ${token.slice(0, -1)}x` })), false);
    assert.equal(auth.allows(req('100.64.0.7', { authorization: `Bearer ${token}extra` })), false);
    assert.equal(auth.allows(req('100.64.0.7', {}, `/ws?token=${token}`)), true);
    assert.equal(isLoopback(undefined), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pairing codes are minted from loopback only, single use, and expire', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-'));
  try {
    let now = 1_790_000_000_000;
    const auth = new Auth(join(dir, 'api-token'), () => now);
    assert.throws(() => auth.pair(req('100.64.0.7')), /this Mac only/);
    const { code } = auth.pair(req('127.0.0.1'));
    assert.match(code, /^\d{6}$/);
    assert.equal(auth.exchange('000000' === code ? '111111' : '000000'), null);
    const token = auth.exchange(code);
    assert.ok(token && auth.check(token));
    assert.equal(auth.exchange(code), null, 'single use');
    const second = auth.pair(req('127.0.0.1'));
    now += 6 * 60 * 1000;
    assert.equal(auth.exchange(second.code), null, 'expired');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
