import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LogEntry } from '@jkj/shared';
import { toChatView } from '@jkj/shared';
import * as work from '../src/services/work.js';
import * as runs from '../src/services/runs.js';
import * as room from '../src/services/room.js';
import * as employees from '../src/services/employees.js';
import { short } from '../src/services/one-line.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/** Chat hygiene (HLD D22, LLD §19.9): Talk carries only authored messages, and messages stay short. */

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const e = (id: string, kind: LogEntry['kind'], text: string, extra: Partial<LogEntry> = {}): LogEntry =>
  ({ id, agentId: 'a', at: `2026-10-02T10:00:0${id.slice(-1)}.000Z`, kind, label: '', text, ...extra });

test('the chat view folds the Workplace\'s own prompts and system notes into the activity line; the owner\'s words stay', () => {
  const view = toChatView([
    e('e1', 'user', 'Take assignment as_1: Mic stays live. Reply with "## Plan" first.', { from: 'workplace' }),
    e('e2', 'read', 'app.py'),
    e('e3', 'system', 'Stalled: no activity for 10 minutes'),
    e('e4', 'assistant', 'Plan ready.'),
    e('e5', 'user', 'Ship it today please', { from: 'owner' }),
    e('e6', 'user', 'An older entry with no author is the owner\'s'),
  ]);
  assert.deepEqual(view.map(v => v.kind), ['activity', 'assistant', 'user', 'user']);
  assert.equal(view[0]!.activity!.count, 3);
  assert.ok(view[0]!.activity!.entries.some(x => x.from === 'workplace'), 'nothing is lost, only folded');
  assert.equal(view[2]!.text, 'Ship it today please');
});

test('sessions the Workplace starts are prompted as the Workplace; the owner\'s Talk is the owner\'s', async () => {
  const fake = installFakeRuntime();
  const { wp, tmp } = testWorkplace();
  try {
    const a = work.create(wp, { kind: 'assignment', title: 'Composer', body: 'x', employeeId: 'tara' });
    const agent = employees.assign(wp, a.id);
    await tick();
    const first = runs.getRunTranscript(agent.id)!.find(x => x.kind === 'user')!;
    assert.equal(first.from, 'workplace');
    employees.talk(wp, 'tara', 'How is it going?');
    const last = runs.getRunTranscript(agent.id)!.filter(x => x.kind === 'user').at(-1)!;
    assert.equal(last.from, 'owner');
    assert.equal(last.text, 'How is it going?');
    void fake;
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('short(): four lines or 400 characters stay; longer keeps the start and moves the whole to details', () => {
  assert.deepEqual(short('one line'), { text: 'one line' });
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map(x => `${x} is a line`).join('\n');
  const s = short(six);
  assert.equal(s.text, 'a is a line\nb is a line\nc is a line\nd is a line …');
  assert.equal(s.details, six);
  const wide = 'word '.repeat(120).trim();
  const w = short(wide);
  assert.ok(w.text.length <= 402);
  assert.ok(w.text.endsWith('…'));
  assert.equal(w.details, wide);
});

test('an agent\'s long Room post is kept short with the rest in details; the owner\'s never is', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const long = Array.from({ length: 9 }, (_, i) => `point ${i + 1}`).join('\n');
    const { thread } = room.createThread(wp, { title: 'Speaker API', text: long, by: 'rohan' });
    const first = room.messages(wp, thread.id)[0]!;
    assert.equal(first.text.split('\n').length, 4);
    assert.equal(first.details, long);
    const mine = room.post(wp, thread.id, { text: long, by: 'owner' });
    assert.equal(mine.text, long);
    assert.equal(mine.details, undefined);
  } finally {
    tmp.cleanup();
  }
});
