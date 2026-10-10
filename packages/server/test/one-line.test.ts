import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER_LINE_MAX } from '@jkj/shared';
import { oneLine, withOwnerLine } from '../src/services/one-line.js';
import * as inbox from '../src/services/inbox.js';
import * as room from '../src/services/room.js';
import * as digestService from '../src/services/digest.js';
import { Telegram, ping, digest } from '../src/services/telegram.js';
import { testWorkplace } from './fakes/workplace.js';

/** One line to the owner (HLD D16): summary ≤ 120 chars, the rest behind details. */

test('a short plain sentence is its own summary, with no details', () => {
  assert.deepEqual(oneLine('Weather source: agreed on open-meteo, Mira to wire it.'), { summary: 'Weather source: agreed on open-meteo, Mira to wire it.' });
});

test('process narration becomes one outcome line; the whole text is kept as details', () => {
  const text = [
    '## What I did',
    '',
    '- Read `greeting.py` and the **Speaker** contract.',
    '- Ran the tests: 14 passing.',
    '',
    'The greeting now speaks one sentence and never reopens the bubble. Next I will wire the weather facts.',
    '```',
    'npm test',
    '```',
  ].join('\n');
  const line = oneLine(text);
  assert.equal(line.summary, 'What I did');
  assert.equal(line.details, text.trim());
  // The first line is the summary even when it is a heading: the guard is deterministic; the handbook asks employees to lead with the outcome.
  const better = oneLine('Greeting speaks one sentence now, 14 tests green; wiring the weather facts next.\n\nDetails: the bubble no longer reopens because the Speaker call is awaited.');
  assert.equal(better.summary, 'Greeting speaks one sentence now, 14 tests green; wiring the weather facts next.');
  assert.ok(better.details?.includes('Details: the bubble'));
});

test('a long line is trimmed at a word to the limit, ending with an ellipsis; a tiny first sentence keeps the line', () => {
  const long = 'The composer is finished and tested on device with the keyboard covering the send button fixed by the safe-area inset and the tests for it';
  const { summary, details } = oneLine(long);
  assert.ok(summary.length <= OWNER_LINE_MAX, `${summary.length}`);
  assert.ok(summary.endsWith('…'));
  assert.ok(!summary.includes('  '));
  assert.equal(details, long);
  assert.equal(oneLine('Done. The release is cut and the tag pushed to origin.').summary, 'Done. The release is cut and the tag pushed to origin.');
  assert.equal(oneLine('The build passed. Next: TestFlight upload after your approval.').summary, 'The build passed.');
});

test('assistant transcript entries carry the owner line; tool entries do not', () => {
  const base = { id: 'ln_1', agentId: 'a', at: '2026-09-28T00:00:00.000Z', label: '' };
  const said = withOwnerLine({ ...base, kind: 'assistant', text: 'Handoff written.\n\nIt lists the three open contracts.' });
  assert.equal(said.summary, 'Handoff written.');
  assert.ok(said.details?.startsWith('Handoff written.'));
  const ran = withOwnerLine({ ...base, kind: 'bash', label: 'Bash', text: 'npm test\nmore' });
  assert.equal(ran.summary, undefined);
});

test('Inbox items carry summary and details; the ping is one line; old items get a summary on read', () => {
  const { wp, tmp } = testWorkplace({ WORKPLACE_TELEGRAM: '1' });
  try {
    const sent: string[] = [];
    const telegram = new Telegram(wp, { send: async t => { sent.push(t); return true; } });
    telegram.attach();
    const body = 'Should the greeting use open-meteo or the system weather?\n\nopen-meteo is free and has no key; the system weather needs location permission on macOS.\n\nI recommend open-meteo.';
    const item = inbox.raise(wp, { kind: 'decision', title: 'Weather source', body, raisedBy: 'mira', options: [{ id: 'open-meteo', label: 'open-meteo' }, { id: 'system', label: 'System weather' }] });
    assert.equal(item.summary, 'Should the greeting use open-meteo or the system weather?');
    assert.equal(item.details, body);
    assert.equal(inbox.get(wp, item.id)!.summary, item.summary);
    // Rework W4: Telegram pings only a cap and a ring; an Inbox item reaches the owner by push.
    assert.equal(sent.length, 0);
    assert.equal(ping(item.title, item.summary, item.id).split('\n').length, 1);
    assert.ok(ping(item.title, item.summary, item.id).startsWith(`Iris Workplace · Should the greeting use open-meteo or the system weather? — reply: approve ${item.id}`));
    wp.emit({ type: 'alert', level: 'cap', title: 'Cap reached: company', body });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.split('\n').length, 1, `one line: ${sent[0]}`);
    assert.ok(sent[0]!.startsWith('Iris Workplace · Should the greeting use open-meteo or the system weather?'));

    // A raiser's own one line wins over the derived one.
    const given = inbox.raise(wp, { kind: 'question', title: 'Q', body: 'Long body\nwith lines', summary: 'Kabir needs the errand contract signed off today.', raisedBy: 'kabir' });
    assert.equal(given.summary, 'Kabir needs the errand contract signed off today.');
    assert.equal(given.details, 'Long body\nwith lines');

    // An item written before D16 (no summary in its JSON) reads with one.
    wp.db.prepare("update inbox set json = json_remove(json, '$.summary', '$.details') where id = ?").run(item.id);
    const old = inbox.get(wp, item.id)!;
    assert.equal(old.summary, 'Should the greeting use open-meteo or the system weather?');
    assert.ok(inbox.list(wp, 'open').every(i => i.summary.length > 0 && i.summary.length <= OWNER_LINE_MAX));
  } finally {
    tmp.cleanup();
  }
});

test('Team Room threads carry a one-line headline for the owner; posts and the resolution update it', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { thread } = room.createThread(wp, { title: 'Weather source contract', text: 'Long discussion...\n\nMany lines.', by: 'mira', charterIds: ['experts'] });
    assert.equal(thread.headline, 'Weather source contract');
    room.post(wp, thread.id, { text: 'I checked both; open-meteo needs no key and covers IN cities.\n\nThe system weather needs location permission.', by: 'mira', headline: 'Weather source: agreed on open-meteo, Mira to wire it' });
    assert.equal(room.getThread(wp, thread.id)!.headline, 'Weather source: agreed on open-meteo, Mira to wire it');
    room.post(wp, thread.id, { text: 'Fine by me.', by: 'dev' });
    assert.equal(room.getThread(wp, thread.id)!.headline, 'Weather source: agreed on open-meteo, Mira to wire it', 'a post without a headline keeps it');
    room.resolve(wp, thread.id, { summary: 'open-meteo it is; Mira wires it under experts.', by: 'asha' });
    assert.equal(room.getThread(wp, thread.id)!.headline, 'open-meteo it is; Mira wires it under experts.');
    // Threads written before D16 read as their title.
    wp.db.prepare("update threads set json = json_remove(json, '$.headline') where id = ?").run(thread.id);
    assert.equal(room.listThreads(wp)[0]!.headline, 'Weather source contract');
  } finally {
    tmp.cleanup();
  }
});

test('the digest is a few one-liners at most', () => {
  const { wp, tmp } = testWorkplace();
  try {
    for (let i = 0; i < 6; i++) inbox.raise(wp, { kind: 'question', title: `Q${i}`, body: `Question ${i} about the ${'very '.repeat(30)}long contract\nwith detail`, raisedBy: 'asha' });
    const text = digestService.build(wp);
    const lines = text.split('\n');
    assert.ok(lines.length <= 4, text);
    assert.ok(lines.every(l => l.length <= OWNER_LINE_MAX + 20), text);
    assert.match(lines[0]!, /^Iris Workplace · needs you 6 · done yesterday 0 · blocked \d+ · real money ₹0 of ₹1000$/);
    assert.equal(digest({ needsYou: 0, doneYesterday: 2, blocked: 0, spendInr: 12, capInr: 1000, open: [] }).split('\n').length, 1);
    assert.equal(ping('Cap', 'Spend cap reached: employee:kabir', 'in_1'), 'Iris Workplace · Spend cap reached: employee:kabir — reply: approve in_1 / reject in_1');
  } finally {
    tmp.cleanup();
  }
});
