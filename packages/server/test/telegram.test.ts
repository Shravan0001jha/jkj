import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Telegram, digest, parseCommand } from '../src/services/telegram.js';
import * as inbox from '../src/services/inbox.js';
import { testWorkplace } from './fakes/workplace.js';

test('commands parse: approve, reject, answer, talk, status, anything else is not ours', () => {
  assert.deepEqual(parseCommand('approve in_abc'), { kind: 'approve', id: 'in_abc' });
  assert.deepEqual(parseCommand('Reject in_abc too risky'), { kind: 'reject', id: 'in_abc', text: 'too risky' });
  assert.deepEqual(parseCommand('answer in_1 raise-today 1500'), { kind: 'answer', id: 'in_1', optionId: 'raise-today', text: '1500' });
  assert.deepEqual(parseCommand('talk Tara how is the composer going?'), { kind: 'talk', employeeId: 'tara', text: 'how is the composer going?' });
  assert.deepEqual(parseCommand('status'), { kind: 'status' });
  assert.deepEqual(parseCommand('OFF'), { kind: 'off' });
  assert.deepEqual(parseCommand('emergency off'), { kind: 'off' });
  assert.equal(parseCommand('Why can\'t we release all?').kind, 'unknown');
});

test('a new Inbox item pings the owner in at most five lines with the reply syntax', async () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_TELEGRAM: '1' });
  try {
    const sent: string[] = [];
    const tg = new Telegram(wp, { send: async t => { sent.push(t); return true; } });
    tg.attach();
    const item = inbox.raise(wp, { kind: 'approval', title: 'Release 0.2.16', body: 'desktop-mac\nline2\nline3\nline4\nline5\nline6', raisedBy: 'nikhil' });
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.split('\n').length <= 5);
    assert.ok(sent[0]!.includes(`approve ${item.id}`));
  } finally {
    tmp.cleanup();
  }
});

test('replies are tailed from the Workplace cursor and applied with via=telegram', async () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_TELEGRAM: '1' });
  try {
    const state = join(tmp.dir, 'ops', 'state');
    mkdirSync(state, { recursive: true });
    const inboxPath = join(state, 'inbox.jsonl');
    const otherCursor = join(state, 'inbox_cursor');
    writeFileSync(inboxPath, JSON.stringify({ ts: 1, text: 'old chatter' }) + '\n');
    writeFileSync(otherCursor, '1');
    const sent: string[] = [];
    const talked: string[] = [];
    const tg = new Telegram(wp, { send: async t => { sent.push(t); return true; }, inboxPath, cursorPath: join(state, 'workplace-cursor'), talk: async (id, text) => { talked.push(`${id}:${text}`); return `${id} says hi`; } });
    tg.start(60_000);
    tg.stop();

    const item = inbox.raise(wp, { kind: 'approval', title: 'Deploy api', body: 'x', raisedBy: 'kabir' });
    appendFileSync(inboxPath, JSON.stringify({ ts: 2, text: `approve ${item.id}` }) + '\n');
    appendFileSync(inboxPath, JSON.stringify({ ts: 3, text: 'talk kabir status?' }) + '\n');
    appendFileSync(inboxPath, JSON.stringify({ ts: 4, text: 'partial line without newline' }));
    const handled = await tg.poll();
    assert.deepEqual(handled.map(h => h.kind), ['approve', 'talk']);
    assert.equal(inbox.get(wp, item.id)!.answer?.via, 'telegram');
    assert.deepEqual(talked, ['kabir:status?']);
    assert.ok(sent.some(s => s.startsWith('Approved: Deploy api')));
    assert.ok(sent.includes('kabir says hi'));
    assert.equal(readFileSync(otherCursor, 'utf8'), '1', 'read_inbox.sh cursor untouched');

    // The partial line is picked up once completed.
    appendFileSync(inboxPath, '\n' + JSON.stringify({ ts: 5, text: 'status' }) + '\n');
    const again = await tg.poll();
    assert.deepEqual(again.map(h => h.kind), ['unknown', 'status']);
    // Answering twice reports the conflict instead of crashing the poller.
    appendFileSync(inboxPath, JSON.stringify({ ts: 6, text: `approve ${item.id}` }) + '\n');
    await tg.poll();
    assert.ok(sent.some(s => s.startsWith('Could not apply "approve"')));
  } finally {
    tmp.cleanup();
  }
});

test('the digest is four lines at most', () => {
  const d = digest({ needsYou: 2, doneYesterday: 3, blocked: 1, spendInr: 412.4, capInr: 1000, open: ['Release 0.2.16', 'Split mobile', 'third'] });
  assert.equal(d.split('\n').length, 5);
  assert.match(d, /Needs you: 2/);
  assert.match(d, /₹412 of ₹1000/);
});
