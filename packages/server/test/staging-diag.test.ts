import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stagingDiag, remoteCommand, MAX_LOG_LINES, type DiagRunner } from '../src/services/staging-diag.js';

function fake(opts: { state?: string; sshOut?: string; sshCode?: number; openCode?: number } = {}) {
  const calls: string[][] = [];
  const runner: DiagRunner = {
    async run(args) {
      calls.push(args);
      if (args[0] === 'status') return { code: 0, out: `instance  i-1  ${opts.state ?? 'running'}\n` };
      if (args[0] === 'ssh-open') return { code: opts.openCode ?? 0, out: 'open' };
      if (args[0] === 'ssh') return { code: opts.sshCode ?? 0, out: opts.sshOut ?? 'line' };
      return { code: 0, out: '' };
    },
  };
  return { runner, calls };
}
const W = { since: '2026-10-21T10:00:00Z', until: '2026-10-21T10:05:00Z' };

test('chat refuses a non-e2e account and never touches the network', async () => {
  for (const account of ['owner@gmail.com', 'x@e2e.irisforu.com.evil.com', 'a b@e2e.irisforu.com', "x';id@e2e.irisforu.com", '$(id)@e2e.irisforu.com', '', 'x@sub.e2e.irisforu.com']) {
    const f = fake();
    await assert.rejects(stagingDiag({ kind: 'chat', account, by: 't' }, f.runner), /test accounts/);
    assert.equal(f.calls.length, 0, account);
  }
});

test('chat for an e2e account runs one fixed program with the email as base64', async () => {
  const f = fake();
  const r = await stagingDiag({ kind: 'chat', account: 'Pool-1@E2E.irisforu.com', by: 't' }, f.runner);
  assert.equal(r.ok, true);
  const ssh = f.calls.find(c => c[0] === 'ssh')!;
  assert.equal(ssh.length, 2);
  assert.ok(ssh[1]!.includes(Buffer.from('pool-1@e2e.irisforu.com').toString('base64')));
  assert.ok(!ssh[1]!.includes('pool-1@'));
});

test('logs: window must be explicit, ordered and at most 30 minutes', async () => {
  const f = fake();
  await assert.rejects(stagingDiag({ kind: 'logs', by: 't' }, f.runner), /since must be/);
  await assert.rejects(stagingDiag({ kind: 'logs', since: '2026-10-21 10:00', until: '2026-10-21 10:05', by: 't' }, f.runner), /zone/);
  await assert.rejects(stagingDiag({ kind: 'logs', since: "2026-10-21T10:00:00Z'; id; '", until: W.until, by: 't' }, f.runner), /since must be/);
  await assert.rejects(stagingDiag({ kind: 'logs', since: W.until, until: W.since, by: 't' }, f.runner), /after since/);
  await assert.rejects(stagingDiag({ kind: 'logs', since: '2026-10-21T10:00:00Z', until: '2026-10-21T10:30:01Z', by: 't' }, f.runner), /30 minutes/);
  await stagingDiag({ kind: 'logs', since: '2026-10-21T10:00:00Z', until: '2026-10-21T10:30:00Z', by: 't' }, f.runner);
  assert.equal(f.calls.filter(c => c[0] === 'ssh').length, 1);
});

test('logs: filter is base64, window re-rendered in UTC, lines capped', async () => {
  const f = fake();
  await stagingDiag({ kind: 'logs', since: '2026-10-21T15:30:00+05:30', until: '2026-10-21T15:35:00+05:30', filter: '$(rm -rf /); `x` "q" \'z\'', by: 't' }, f.runner);
  const cmd = f.calls.find(c => c[0] === 'ssh')![1]!;
  assert.match(cmd, /--since '2026-10-21 10:00:00 UTC' --until '2026-10-21 10:05:00 UTC'/);
  assert.ok(!cmd.includes('rm -rf') && !cmd.includes('`x`'));
  assert.ok(cmd.includes(`tail -n ${MAX_LOG_LINES}`));
  await assert.rejects(stagingDiag({ kind: 'logs', ...W, filter: 'a\nb', by: 't' }, f.runner), /one line/);
  await assert.rejects(stagingDiag({ kind: 'logs', ...W, filter: 'x'.repeat(201), by: 't' }, f.runner), /one line/);
});

test('remote command contains only constants, base64 and digits', () => {
  const c = remoteCommand({ kind: 'logs', sinceUtc: '2026-10-21 10:00:00', untilUtc: '2026-10-21 10:05:00', filter: "a'b;c" });
  assert.ok(!c.includes("a'b;c"));
  assert.equal(remoteCommand({ kind: 'version' }), 'cat /opt/iris-api/VERSION');
});

test('ssh-open and ssh-close are paired once, even when the query fails; a failed open is not closed', async () => {
  const f = fake({ sshCode: 255, sshOut: 'boom' });
  await stagingDiag({ kind: 'version', by: 't' }, f.runner);
  assert.deepEqual(f.calls.map(c => c[0]), ['status', 'ssh-open', 'ssh', 'ssh-close']);
  const g = fake({ openCode: 1 });
  const r = await stagingDiag({ kind: 'version', by: 't' }, g.runner);
  assert.equal(r.ok, false);
  assert.deepEqual(g.calls.map(c => c[0]), ['status', 'ssh-open']);
});

test('stopped staging is reported, and started only with start: true', async () => {
  const f = fake({ state: 'stopped' });
  const r = await stagingDiag({ kind: 'version', by: 't' }, f.runner);
  assert.match(r.text, /stopped/);
  assert.deepEqual(f.calls.map(c => c[0]), ['status']);
  const g = fake({ state: 'stopped' });
  await stagingDiag({ kind: 'version', start: true, by: 't' }, g.runner);
  assert.deepEqual(g.calls.map(c => c[0]), ['status', 'start', 'ssh-open', 'ssh', 'ssh-close']);
});
