import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as items from '../src/services/items.js';
import * as trail from '../src/services/trail.js';
import * as hygiene from '../src/services/hygiene.js';
import { wireMentionReplies, resetForTest } from '../src/services/mentions.js';
import { rawGet } from '../src/services/v2-map.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * RCA (owner, 18 Oct): a story sat Waiting for a day after the person it waited on had answered,
 * because only the waiter's own item_update ended a wait and a reply woke them only on an @mention.
 */
const runtime = installFakeRuntime();
after(() => runtime.restore());

function setup(on: string) {
  const t = testWorkplace();
  resetForTest();
  const unwire = wireMentionReplies(t.wp);
  const epic = items.create(t.wp, { level: 'epic', title: 'Practice' }, 'owner');
  const s = items.create(t.wp, { level: 'story', parentId: epic.id, title: 'Needs an answer', assigneeId: 'tara' } as never, 'owner');
  items.update(t.wp, s.id, { status: 'in-progress', reason: 'test: started' }, 'tara');
  items.update(t.wp, s.id, { status: 'waiting', waitingOn: on, reason: 'test: need the schema decision' }, 'tara');
  const status = () => rawGet(t.wp, s.id)!.status;
  return { ...t, s, status, end: async () => { unwire(); await new Promise(r => setTimeout(r, 300)); t.tmp.cleanup(); } };
}

test('a reply by the person it waits on (no @mention) ends the wait and wakes the assignee with the reply', async () => {
  const { wp, s, status, end } = setup('asha');
  try {
    trail.comment(wp, s.id, { by: 'asha', text: 'Already done, a sibling story was filed.' });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(status(), 'in-progress');
    assert.equal(rawGet(wp, s.id)!.waiting, undefined);
    const texts = runtime.sessions.flatMap(x => [x.options.prompt, ...x.sent.map(m => m.text)]);
    const woke = texts.find(x => /Asha replied/.test(x));
    assert.ok(woke, 'tara was woken with the reply');
    assert.match(woke, /Already done, a sibling story was filed/);
  } finally { await end(); }
});

test('a reply by someone else leaves the wait alone', async () => {
  const { wp, s, status, end } = setup('asha');
  try {
    trail.comment(wp, s.id, { by: 'owner', text: 'Any news?' });
    trail.comment(wp, s.id, { by: 'tara', text: 'Still waiting.' });
    assert.equal(status(), 'waiting');
    assert.equal(rawGet(wp, s.id)!.waiting?.on, 'asha');
  } finally { await end(); }
});

test('a wait on the COO ends on a COO comment', async () => {
  const { wp, s, status, end } = setup('coo');
  try {
    trail.comment(wp, s.id, { by: 'coo', text: 'Approved, go ahead.' });
    assert.equal(status(), 'in-progress');
  } finally { await end(); }
});

test('hygiene flags a Waiting story whose awaited person replied and the wait is still open', async () => {
  const t = setup('asha');
  const { wp, s, end } = t;
  try {
    resetForTest();
    assert.ok(!hygiene.conditions(wp).some(x => x.key === `wait-answered:${s.id}`), 'no reply yet: not flagged');
    // Stranded: the reply is stored but nothing acted on it (e.g. made before this fix was deployed).
    const c = { id: 'cm_x', itemId: s.id, at: new Date(Date.now() + 1000).toISOString(), by: 'asha', text: 'Done.', mentions: [] };
    wp.db.prepare('insert into comments (id, item_id, at, by, json) values (?, ?, ?, ?, ?)').run(c.id, s.id, c.at, c.by, JSON.stringify(c));
    assert.equal(rawGet(wp, s.id)!.status, 'waiting');
    assert.ok(hygiene.conditions(wp).some(x => x.key === `wait-answered:${s.id}`), 'flagged');
  } finally { await end(); }
});
