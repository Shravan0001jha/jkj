import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Push, inQuietHours, intentFor, scrub, type PushIntent } from '../src/services/push.js';
import * as inbox from '../src/services/inbox.js';
import * as room from '../src/services/room.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * What reaches the phone while the app is closed (LLD-workplace-push §3, §4):
 * one short, safe frame per subject; never secrets, never a flood, never
 * while the Mac is unpublished.
 */

function harness(overrides: Partial<Record<string, string>> = {}) {
  const { wp, tmp } = testWorkplace(overrides);
  const sent: PushIntent[] = [];
  let t = Date.parse('2026-09-28T05:00:00Z');   // 10:30 IST
  let online = true;
  const push = new Push(wp, { send: intent => { if (!online) return false; sent.push(intent); return true; }, now: () => t });
  push.attach();
  return { wp, tmp, sent, push, tick: (ms: number) => { t += ms; }, offline: () => { online = false; }, online: () => { online = true; } };
}

const employee = (wp: ReturnType<typeof testWorkplace>['wp']) => wp.org.employees.find(e => e.level === 1) ?? wp.org.employees[0]!;

test('an Inbox item is one push with a derived body, an inbox deep link and a collapse id', () => {
  const h = harness();
  try {
    const raiser = employee(h.wp);
    const item = inbox.raise(h.wp, { kind: 'approval', title: 'Release desktop-mac 0.2.16', body: 'secret token=sk-abcdefghijklmnop please approve\nmore lines', raisedBy: raiser.id });
    assert.equal(h.sent.length, 1);
    const p = h.sent[0]!;
    assert.equal(p.title, 'Release desktop-mac 0.2.16');
    assert.equal(p.body, `Approval · from ${raiser.name}`, 'the body is derived, never the item text');
    assert.equal(p.collapseId, `inbox:${item.id}`);
    assert.deepEqual(p.data, { link: `inbox/${item.id}`, inboxId: item.id });
    assert.equal(p.category, 'WP_INBOX');
    assert.equal(p.threadId, 'inbox');
    assert.equal(p.level, 'needs-you');
    assert.ok(!JSON.stringify(p).includes('sk-abc'));
    // Answering it does not push.
    inbox.answer(h.wp, item.id, 'approve', undefined, 'phone');
    assert.equal(h.sent.length, 1);
  } finally { h.tmp.cleanup(); }
});

test('a re-raised item with the same dedupe key does not push twice; a different item does', () => {
  const h = harness();
  try {
    inbox.raise(h.wp, { kind: 'cap', title: 'Cap reached', body: 'x', raisedBy: 'asha', dedupeKey: 'cap:today' });
    inbox.raise(h.wp, { kind: 'cap', title: 'Cap reached', body: 'x', raisedBy: 'asha', dedupeKey: 'cap:today' });
    inbox.raise(h.wp, { kind: 'question', title: 'Which colour?', body: 'x', raisedBy: 'asha' });
    assert.deepEqual(h.sent.map(p => p.title), ['Cap reached', 'Which colour?']);
  } finally { h.tmp.cleanup(); }
});

test('alerts: info never pushes; blocked and cap do; a tool approval gets the generic body; secrets are scrubbed', () => {
  const h = harness();
  try {
    const emp = employee(h.wp);
    h.wp.emit({ type: 'alert', level: 'info', title: 'desktop-mac 0.2.16 released', body: 'ok' });
    assert.equal(h.sent.length, 0);
    h.wp.emit({ type: 'alert', level: 'blocked', title: `${emp.name} stalled`, body: 'Interrupted; a question is in the Inbox.' });
    h.wp.emit({ type: 'alert', level: 'cap', title: 'Cap reached: company', body: '₹1000 of ₹1000 real money' });
    h.wp.emit({ type: 'alert', level: 'needs-you', title: `${emp.name} is waiting for a tool approval`, body: 'Bash: curl -H "Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz" https://x — open the employee page' });
    h.wp.emit({ type: 'alert', level: 'blocked', title: 'Deploy failed', body: 'AKIAIOSFODNN7EXAMPLE was rejected' });
    h.wp.emit({ type: 'alert', level: 'blocked', title: 'Build failed', body: 'xcodebuild exited 65 · see the log' });
    assert.deepEqual(h.sent.map(p => [p.level, p.category, p.body, p.data.link]), [
      ['blocked', 'WP_ALERT', 'Interrupted; a question is in the Inbox.', `employee/${emp.id}`],
      ['cap', 'WP_ALERT', '₹1000 of ₹1000 real money', 'office'],
      ['needs-you', 'WP_ALERT', 'Open the employee page to allow or deny.', `employee/${emp.id}`],
      ['blocked', 'WP_ALERT', 'Open the app for details', 'office'],
      ['blocked', 'WP_ALERT', 'xcodebuild exited 65 · see the log', 'office'],
    ]);
    assert.equal(h.sent[2]!.data.employeeId, emp.id);
    assert.ok(!JSON.stringify(h.sent).includes('sk-live'));
    assert.ok(!JSON.stringify(h.sent).includes('AKIA'));
  } finally { h.tmp.cleanup(); }
});

test('scrub: one line, capped, and never a credential shape', () => {
  assert.equal(scrub('line one\n   line two'), 'line one line two');
  assert.equal(scrub('x'.repeat(200)).length, 120);
  assert.equal(scrub('ghp_abcdefghijklmnop123456'), 'Open the app for details');
  assert.equal(scrub('the password is hunter2'), 'Open the app for details');
  assert.equal(scrub('-----BEGIN PRIVATE KEY-----'), 'Open the app for details');
  assert.equal(scrub('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'), 'Open the app for details');
  assert.equal(scrub(''), 'Open the app for details');
  assert.equal(scrub('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh'), 'Open the app for details');
  assert.equal(scrub('/Users/x/iris-work/dev/hivemind-prototype/services/agent-svc/greeting.py'), '/Users/x/iris-work/dev/hivemind-prototype/services/agent-svc/greeting.py');
  assert.equal(scrub('Tests: 12 passed, 0 failed'), 'Tests: 12 passed, 0 failed');
});

test('Team Room: an @owner mention pushes with the thread link; employee-only mentions and the owner\'s own messages do not', () => {
  const h = harness();
  try {
    const emp = employee(h.wp);
    const other = h.wp.org.employees.find(e => e.id !== emp.id)!;
    const { thread } = room.createThread(h.wp, { title: 'Repo split boundaries', text: `@${other.id} what do you own?`, by: emp.id });
    assert.equal(h.sent.length, 0, 'an employee mention is not the owner');
    room.post(h.wp, thread.id, { text: `@owner we need your call on the contracts repo.\nDetails below.`, by: emp.id });
    assert.equal(h.sent.length, 1);
    const p = h.sent[0]!;
    assert.equal(p.title, `${emp.name} mentioned you in "Repo split boundaries"`);
    assert.equal(p.body, '@owner we need your call on the contracts repo.');
    assert.deepEqual(p.data, { link: `room/${thread.id}`, threadId: thread.id });
    assert.equal(p.category, 'WP_ROOM');
    assert.equal(p.level, 'mention');
    room.post(h.wp, thread.id, { text: '@owner here is my answer to myself', by: 'owner' });
    room.post(h.wp, thread.id, { text: 'someone@owner.example is an email, not a mention', by: emp.id });
    room.post(h.wp, thread.id, { text: '@ownership is a word', by: emp.id });
    assert.equal(h.sent.length, 1);
    // A second mention in the same thread inside ten minutes with the same title collapses.
    h.tick(60_000);
    room.post(h.wp, thread.id, { text: '@shravan ping', by: emp.id });
    assert.equal(h.sent.length, 1);
    h.tick(10 * 60_000);
    room.post(h.wp, thread.id, { text: '@Owner still waiting', by: emp.id });
    assert.equal(h.sent.length, 2);
  } finally { h.tmp.cleanup(); }
});

test('a repeat of the same subject within ten minutes is dropped unless its title changed', () => {
  const h = harness();
  try {
    h.wp.emit({ type: 'alert', level: 'blocked', title: 'Deploy failed', body: 'a' });
    h.wp.emit({ type: 'alert', level: 'blocked', title: 'Deploy failed', body: 'b' });
    assert.equal(h.sent.length, 1);
    h.tick(DEDUPE_MINUTES * 60_000 + 1);
    h.wp.emit({ type: 'alert', level: 'blocked', title: 'Deploy failed', body: 'c' });
    assert.equal(h.sent.length, 2);
  } finally { h.tmp.cleanup(); }
});
const DEDUPE_MINUTES = 10;

test('a burst becomes one summary push per minute after the sixth', () => {
  const h = harness();
  try {
    for (let i = 0; i < 9; i++) inbox.raise(h.wp, { kind: 'question', title: `Q${i}`, body: 'x', raisedBy: 'asha' });
    assert.equal(h.sent.length, 7);
    const summary = h.sent[6]!;
    assert.equal(summary.collapseId, 'summary');
    assert.equal(summary.title, '1 more thing needs you');
    assert.deepEqual(summary.data, { link: 'inbox' });
    // A minute later: the window has cleared; the suppressed ones are not replayed (the Inbox is the truth).
    h.tick(61_000);
    inbox.raise(h.wp, { kind: 'question', title: 'Q-later', body: 'x', raisedBy: 'asha' });
    assert.equal(h.sent.length, 8);
    assert.equal(h.sent[7]!.title, 'Q-later');
    assert.equal(h.push.status().suppressedToday, 3, 'the 7th (summarised), 8th and 9th');
    assert.equal(h.push.status().sentToday, 8);
  } finally { h.tmp.cleanup(); }
});

test('nothing is queued while the Mac is not published; the next event for the same subject still pushes once it is', () => {
  const h = harness();
  try {
    h.offline();
    inbox.raise(h.wp, { kind: 'question', title: 'Q1', body: 'x', raisedBy: 'asha' });
    h.wp.emit({ type: 'alert', level: 'blocked', title: 'Deploy failed', body: 'a' });
    assert.equal(h.sent.length, 0);
    h.online();
    h.wp.emit({ type: 'alert', level: 'blocked', title: 'Deploy failed', body: 'a' });
    assert.equal(h.sent.length, 1, 'the offline attempt did not count as seen');
    assert.equal(h.push.status().sentToday, 1);
  } finally { h.tmp.cleanup(); }
});

test('--no-push sends nothing; the status says so', () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_PUSH: '0' });
  try {
    const sent: PushIntent[] = [];
    const push = new Push(wp, { send: i => { sent.push(i); return true; } });
    push.attach();
    inbox.raise(wp, { kind: 'question', title: 'Q1', body: 'x', raisedBy: 'asha' });
    assert.equal(sent.length, 0);
    assert.equal(push.status().enabled, false);
  } finally { tmp.cleanup(); }
});

test('quiet hours hold needs-you and mentions but not cap or blocked', () => {
  assert.equal(inQuietHours('23-07', Date.parse('2026-09-28T18:00:00Z')), true, '23:30 IST');
  assert.equal(inQuietHours('23-07', Date.parse('2026-09-28T05:00:00Z')), false, '10:30 IST');
  assert.equal(inQuietHours('23-07', Date.parse('2026-09-28T01:00:00Z')), true, '06:30 IST');
  assert.equal(inQuietHours(undefined, Date.parse('2026-09-28T18:00:00Z')), false);
  assert.equal(inQuietHours('garbage', Date.parse('2026-09-28T18:00:00Z')), false);
  const { wp, tmp } = testWorkplace({ WORKPLACE_PUSH_QUIET: '23-07' });
  try {
    const sent: PushIntent[] = [];
    const push = new Push(wp, { send: i => { sent.push(i); return true; }, now: () => Date.parse('2026-09-28T18:00:00Z') });
    push.attach();
    inbox.raise(wp, { kind: 'question', title: 'Q1', body: 'x', raisedBy: 'asha' });
    wp.emit({ type: 'alert', level: 'cap', title: 'Cap reached', body: 'x' });
    wp.emit({ type: 'alert', level: 'blocked', title: 'Stalled', body: 'x' });
    assert.deepEqual(sent.map(p => p.level), ['cap', 'blocked']);
  } finally { tmp.cleanup(); }
});

test('intentFor is pure and caps the title', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const p = intentFor(wp, { type: 'alert', level: 'blocked', title: 'T'.repeat(300), body: 'b' }, ['owner']);
    assert.ok(p && p.title.length === 80 && p.title.endsWith('…'));
    assert.equal(intentFor(wp, { type: 'work.updated', item: {} as never }, ['owner']), null);
  } finally { tmp.cleanup(); }
});

test('the relay\'s result is kept for the health line', () => {
  const h = harness();
  try {
    h.push.result({ id: 'p1', sent: 1, dropped: 0, failed: 0 });
    assert.deepEqual(h.push.status().last, { id: 'p1', sent: 1, dropped: 0, failed: 0, at: '2026-09-28T05:00:00.000Z' });
  } finally { h.tmp.cleanup(); }
});
