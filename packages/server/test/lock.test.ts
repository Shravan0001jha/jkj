import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { acquire, holder, AlreadyRunning, LOCK_FILE } from '../src/services/lock.js';
import { loadConfig } from '../src/config.js';
import { start } from '../src/index.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { tmpWorkplace } from './fakes/tmp-workplace.js';

/** One Workplace per organisation (28 Sep): a live pid in the lock refuses the start; a dead one is taken over. */

test('the lock holds the pid; a live holder refuses a second acquire; a dead holder is taken over; release removes it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp-lock-'));
  try {
    const first = acquire(dir, 1001, () => true);
    assert.equal(readFileSync(join(dir, LOCK_FILE), 'utf8').split('\n')[0], '1001');
    assert.equal(holder(dir), 1001);
    assert.throws(() => acquire(dir, 1002, () => true), (err: unknown) => err instanceof AlreadyRunning && err.pid === 1001 && /refusing to start/.test(err.message));
    // The same pid may re-acquire (a restart of the boot inside one process).
    assert.equal(acquire(dir, 1001, () => true).pid, 1001);
    // The holder died without releasing: the next start takes the lock.
    const second = acquire(dir, 1002, pid => pid !== 1001);
    assert.equal(holder(dir), 1002);
    first.release();
    assert.equal(holder(dir), 1002, 'a stale handle cannot release another pid\'s lock');
    second.release();
    assert.ok(!existsSync(join(dir, LOCK_FILE)));
    // Garbage in the file is treated as no holder.
    writeFileSync(join(dir, LOCK_FILE), 'not a pid\n');
    assert.equal(acquire(dir, 1003, () => true).pid, 1003);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second start against the same organisation is refused; a taken port fails the start and releases the lock', async () => {
  const tmp = tmpWorkplace();
  tmp.db.close();
  mkdirSync(join(tmp.dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(tmp.dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test\n');
  const fake = installFakeRuntime();
  const config = (port: string) => loadConfig(['--no-open', '--no-telegram', '--no-seed', '--port', port], {
    IRIS_WORKPLACE_DIR: tmp.dir, IRIS_OPS_DIR: join(tmp.dir, 'ops'), WORKPLACE_CAP_INR: '1000', WORKPLACE_USD_INR: '88',
  });
  const running = await start(config('0'));
  try {
    assert.equal(holder(tmp.dir), process.pid);
    // Same process, same pid: the lock itself allows it, so the port is what refuses a duplicate here.
    const port = (running.server.address() as { port: number }).port;
    await assert.rejects(start(config(String(port))), /cannot listen on http:\/\/127\.0\.0\.1:\d+: EADDRINUSE/);
    assert.equal(holder(tmp.dir), process.pid, 'the failed start did not steal the lock');
  } finally {
    await running.stop();
    fake.restore();
  }
  assert.equal(holder(tmp.dir), undefined, 'stop releases the lock');

  // Another live process holds the lock: refused before anything is opened.
  writeFileSync(join(tmp.dir, LOCK_FILE), `${process.ppid}\n${new Date().toISOString()}\n`);
  await assert.rejects(start(config('0')), (err: unknown) => err instanceof AlreadyRunning && err.pid === process.ppid);
  assert.equal(holder(tmp.dir), process.ppid, 'untouched');

  // A port taken by something else: the start fails and the lock is released for the next try.
  rmSync(join(tmp.dir, LOCK_FILE));
  const squatter = createServer();
  await new Promise<void>(r => squatter.listen(0, '127.0.0.1', () => r()));
  const taken = (squatter.address() as { port: number }).port;
  try {
    await assert.rejects(start(config(String(taken))), /EADDRINUSE/);
    assert.equal(holder(tmp.dir), undefined);
  } finally {
    await new Promise<void>(r => squatter.close(() => r()));
    tmp.cleanup();
  }
});
