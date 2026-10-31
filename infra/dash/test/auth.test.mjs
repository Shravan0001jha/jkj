import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start, verify, check, logout, SESSION_MS } from '../lambda/auth.mjs';

const OWNER = 'shravan0001jha@gmail.com';
function env() {
  const data = new Map();
  let t = Date.parse('2026-11-01T00:00:00Z');
  const sent = [];
  let n = 0;
  const store = {
    async get(k) { const v = data.get(k); return v && v.ttl > t ? structuredClone(v.item) : null; },
    async put(k, item, ttl) { data.set(k, { item: structuredClone(item), ttl }); },
    async del(k) { data.delete(k); },
  };
  return {
    data, sent,
    tick: ms => { t += ms; },
    ctx: { store, owner: OWNER, now: () => t, mail: async (to, code) => sent.push({ to, code }), randomCode: () => String(123456 + n++), randomToken: () => `tok${n++}`, device: 'iPhone' },
  };
}

test('only the owner email gets a code; every answer looks the same', async () => {
  const e = env();
  assert.deepEqual(await start('someone@else.com', e.ctx), { ok: true });
  assert.equal(e.sent.length, 0);
  assert.deepEqual(await start(' Shravan0001jha@Gmail.com ', e.ctx), { ok: true });
  assert.equal(e.sent.length, 1);
  assert.equal(e.sent[0].to, OWNER);
});

test('the right code gives a session; the code works once', async () => {
  const e = env();
  await start(OWNER, e.ctx);
  const r = await verify(OWNER, e.sent[0].code, e.ctx);
  assert.equal(r.ok, true);
  assert.equal(await check(r.token, e.ctx), true);
  assert.equal((await verify(OWNER, e.sent[0].code, e.ctx)).ok, false);
});

test('codes expire after 10 minutes', async () => {
  const e = env();
  await start(OWNER, e.ctx);
  e.tick(10 * 60_000 + 1);
  assert.equal((await verify(OWNER, e.sent[0].code, e.ctx)).ok, false);
});

test('five wrong codes lock login for 15 minutes, even with the right code', async () => {
  const e = env();
  await start(OWNER, e.ctx);
  for (let i = 0; i < 5; i++) assert.equal((await verify(OWNER, '000000', e.ctx)).ok, false);
  await start(OWNER, e.ctx);
  assert.equal(e.sent.length, 1, 'no new code while locked');
  e.tick(15 * 60_000 + 1);
  await start(OWNER, e.ctx);
  assert.equal(e.sent.length, 2);
  assert.equal((await verify(OWNER, e.sent[1].code, e.ctx)).ok, true);
});

test('rate limit: at most 3 codes per 15 minutes', async () => {
  const e = env();
  for (let i = 0; i < 5; i++) await start(OWNER, e.ctx);
  assert.equal(e.sent.length, 3);
  e.tick(15 * 60_000 + 1);
  await start(OWNER, e.ctx);
  assert.equal(e.sent.length, 4);
});

test('a wrong email never verifies, even with a valid code', async () => {
  const e = env();
  await start(OWNER, e.ctx);
  assert.equal((await verify('x@y.z', e.sent[0].code, e.ctx)).ok, false);
});

test('sessions slide for 90 days of use; logout ends them; no plaintext token is stored', async () => {
  const e = env();
  await start(OWNER, e.ctx);
  const { token } = await verify(OWNER, e.sent[0].code, e.ctx);
  assert.ok(![...e.data.keys()].some(k => k.includes(token)));
  e.tick(60 * 86_400_000);
  assert.equal(await check(token, e.ctx), true);
  e.tick(60 * 86_400_000);
  assert.equal(await check(token, e.ctx), true, 'renewed by use');
  e.tick(SESSION_MS + 1);
  assert.equal(await check(token, e.ctx), false);
  await start(OWNER, e.ctx);
  const s2 = await verify(OWNER, e.sent.at(-1).code, e.ctx);
  await logout(s2.token, e.ctx);
  assert.equal(await check(s2.token, e.ctx), false);
});
