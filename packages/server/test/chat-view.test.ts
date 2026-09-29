import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toChatView } from '@jkj/shared';
import type { LogEntry } from '@jkj/shared';

/**
 * Talk must read like a chat (owner, 29 Sep). `toChatView` is a pure transform (`@jkj/shared/
 * chat-view.ts`) shared by the server (`GET /api/agents/:id/log?view=chat`) and the web (applied
 * live to whatever is already in the store) — tested once, here, at the source.
 */

let n = 0;
const at = (offsetMs: number) => new Date(Date.parse('2026-09-29T10:00:00.000Z') + offsetMs).toISOString();
const entry = (kind: LogEntry['kind'], offsetMs: number, text = '', label = ''): LogEntry =>
  ({ id: `ln_${n++}`, agentId: 'a1', at: at(offsetMs), kind, label, text });

test('owner and employee messages pass through unchanged, with summary/details intact', () => {
  const user = entry('user', 0, 'Ship it');
  const said = { ...entry('assistant', 1000, 'Shipping the 0.2.16 build to TestFlight now.'), summary: 'Shipping 0.2.16 to TestFlight.', details: 'Shipping the 0.2.16 build to TestFlight now.' };
  const out = toChatView([user, said]);
  assert.deepEqual(out, [user, said]);
});

test('a single tool call between two messages is left as it is (not collapsed into a one-step "activity")', () => {
  const single = entry('read', 0, 'services/agent-svc/app.py');
  const out = toChatView([entry('user', -1_000, 'What reads the weather?'), single, entry('assistant', 1_000, 'context/weather.py.')]);
  assert.equal(out[1], single);
  assert.ok(!out.some(e => e.kind === 'activity'));
});

test('a run of two or more consecutive tool calls collapses into one activity line', () => {
  const run = [entry('read', 0, 'a.py'), entry('edit', 5_000, 'a.py'), entry('bash', 72_000, 'npm test')]; // 0s..72s
  const out = toChatView(run);
  assert.equal(out.length, 1);
  const activity = out[0]!;
  assert.equal(activity.kind, 'activity');
  assert.equal(activity.text, 'worked · 3 steps · 1m 12s');
  assert.equal(activity.activity!.count, 3);
  assert.equal(activity.activity!.durationMs, 72_000);
  assert.deepEqual(activity.activity!.entries, run);
});

test('a message in the middle of a tool run ends the run and starts a new one after it', () => {
  const out = toChatView([
    entry('read', 0, 'a.py'), entry('read', 1_000, 'b.py'),
    entry('assistant', 2_000, 'Found it.'),
    entry('bash', 3_000, 'npm test'), entry('bash', 4_000, 'npm run build'),
  ]);
  assert.deepEqual(out.map(e => e.kind), ['activity', 'assistant', 'activity']);
});

test('system and error entries (an approval decided, a rate limit, a session note) are never swallowed into a collapsed run', () => {
  const out = toChatView([
    entry('bash', 0, 'npm test'),
    entry('system', 1_000, 'You allowed the request.', 'Allowed'),
    entry('bash', 2_000, 'npm run build'),
    entry('error', 3_000, 'The tool call failed.', 'Failed'),
  ]);
  assert.deepEqual(out.map(e => e.kind), ['bash', 'system', 'bash', 'error']);
});

test('durations under a minute read as seconds; a clean minute drops the seconds', () => {
  const secs = toChatView([entry('read', 0), entry('read', 45_000)]);
  assert.equal(secs[0]!.text, 'worked · 2 steps · 45s');
  const mins = toChatView([entry('read', 0), entry('read', 120_000)]);
  assert.equal(mins[0]!.text, 'worked · 2 steps · 2m');
});

test('an empty transcript stays empty', () => {
  assert.deepEqual(toChatView([]), []);
});
