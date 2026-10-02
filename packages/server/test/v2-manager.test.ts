import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as items from '../src/services/items.js';
import * as trail from '../src/services/trail.js';
import * as coo from '../src/services/coo.js';
import * as spend from '../src/services/spend.js';
import * as manager from '../src/services/manager.js';
import { installFakeRuntime, type FakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * Owner, 2 Oct (LLD §19.6e): Asha manages every agent and owns stall handling. Operational alerts go
 * to Asha first (a message between turns, a short session when she has none, queued while she is
 * mid-turn); the COO hears only when she has not acted within 15 minutes, when the call is above her
 * authority, or when she herself is stuck. Every 20 minutes while work is active she gets one digest.
 */

const MIN = 60_000;
const tick = (ms = 15) => new Promise(r => setTimeout(r, ms));
type Wp = ReturnType<typeof testWorkplace>['wp'];

function withOauth(dir: string): void {
  mkdirSync(join(dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token-value\n');
}
const of = (fake: FakeRuntime, emp: string) => fake.sessions.filter(s => s.options.cwd.includes(`/${emp}/`));
const told = (fake: FakeRuntime, emp: string) => of(fake, emp).flatMap(s => [s.options.prompt, ...s.sent.map(m => m.text)]);
const cooItems = (wp: Wp, itemId: string) => coo.listItems(wp).filter(i => i.itemId === itemId);

function setup() {
  const t = testWorkplace();
  const fake = installFakeRuntime();
  withOauth(t.tmp.dir);
  const epic = items.create(t.wp, { level: 'epic', title: 'Iris during music' }, 'owner');
  items.setFocus(t.wp, [epic.id], 'owner');
  const story = (title: string, assigneeId: string) => items.create(t.wp, { level: 'story', parentId: epic.id, title, assigneeId }, 'asha');
  return { ...t, fake, epic, story, done: () => { fake.restore(); t.tmp.cleanup(); } };
}

const stalled = (id: string, title: string, key = `idle:${id}:t0`) =>
  ({ key, itemId: id, title: `Stalled: ${title}`, body: `Dev's story has had no activity for 12 min.`, subjectId: 'dev' });

test('an alert reaches Asha: a short session when she has none, queued while she is mid-turn, delivered when her turn ends; once per key', async () => {
  const { wp, fake, story, done } = setup();
  const stop = manager.startManager(wp);
  try {
    const a = story('Mic gate', 'dev');
    assert.equal(manager.alert(wp, stalled(a.id, a.title)), 'asha');
    await tick();
    assert.equal(of(fake, 'asha').length, 1);
    assert.match(of(fake, 'asha')[0]!.options.prompt, new RegExp(`Stalled: Mic gate.*${a.id}`, 's'));
    assert.match(of(fake, 'asha')[0]!.options.prompt, /item_comment/);
    assert.equal(cooItems(wp, a.id).length, 0, 'the COO is not told first');
    assert.ok(trail.activityFor(wp, a.id).some(x => /Told Asha: Stalled: Mic gate/.test(x.text)));
    assert.equal(manager.alert(wp, stalled(a.id, a.title)), 'duplicate', 'once per key');

    // Asha is mid-turn: the next alert waits, then arrives as a message when the turn ends.
    const b = story('Dance tempo', 'dev');
    assert.equal(manager.alert(wp, stalled(b.id, b.title)), 'queued');
    const session = of(fake, 'asha')[0]!;
    assert.equal(session.sent.length, 0, 'nothing pushed into her running turn');
    session.result();
    await tick(30);
    assert.equal(session.sent.length, 1);
    assert.match(session.sent[0]!.text, /Stalled: Dance tempo/);
    assert.equal(of(fake, 'asha').length, 1, 'her open session, not a second one');
  } finally {
    stop();
    done();
  }
});

test('not acted on within 15 minutes: the COO gets one bridge item; an alert Asha acted on is not escalated', async () => {
  const { wp, story, done } = setup();
  try {
    const a = story('Mic gate', 'dev');
    const b = story('Dance tempo', 'dev');
    const t0 = Date.now();
    manager.alert(wp, stalled(a.id, a.title), t0);
    manager.alert(wp, stalled(b.id, b.title), t0);
    await tick();
    trail.comment(wp, b.id, { by: 'asha', text: 'Restarted Dev on it.' });
    assert.deepEqual(manager.escalate(wp, t0 + 10 * MIN), [], 'not before 15 minutes');
    assert.deepEqual(manager.escalate(wp, t0 + 16 * MIN), [`idle:${a.id}:t0`]);
    assert.equal(cooItems(wp, a.id).length, 1);
    assert.equal(cooItems(wp, a.id)[0]!.title, 'Stalled: Mic gate');
    assert.match(cooItems(wp, a.id)[0]!.body, /Asha has not acted on it in 15 min/);
    assert.equal(cooItems(wp, b.id).length, 0, 'Asha acted: no escalation');
    assert.deepEqual(manager.escalate(wp, t0 + 40 * MIN), [], 'once');
    assert.ok(trail.activityFor(wp, a.id).some(x => /Escalated to the COO/.test(x.text)));
  } finally {
    done();
  }
});

test('straight to the COO: a decision above her authority, an alert about Asha, a capped Asha; a notice to a stuck Asha is dropped', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const a = story('Mic gate', 'dev');
    assert.equal(manager.alert(wp, { ...stalled(a.id, a.title, 'k-spend'), title: 'Dev idle with 1 queued item', decision: 'spend' }), 'coo');
    assert.match(cooItems(wp, a.id)[0]!.body, /spend decision/);
    const mine = story('Weekly review', 'asha');
    assert.equal(manager.alert(wp, { ...stalled(mine.id, mine.title, 'k-asha'), subjectId: 'asha' }), 'coo');
    assert.match(cooItems(wp, mine.id)[0]!.body, /about Asha/);

    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`paused:${spend.dayOf()}:employee:asha`, new Date().toISOString());
    const b = story('Dance tempo', 'dev');
    assert.equal(manager.alert(wp, stalled(b.id, b.title)), 'coo');
    assert.match(cooItems(wp, b.id)[0]!.body, /Asha is paused by the employee:asha spend cap/);
    assert.equal(manager.alert(wp, { ...stalled(b.id, b.title, 'k-note'), notice: true }), 'dropped');
    assert.equal(cooItems(wp, b.id).length, 1);
    await tick();
    assert.equal(of(fake, 'asha').length, 0, 'nothing reached Asha');
  } finally {
    done();
  }
});

test('the manager digest: every 20 minutes while work is active; nothing when there is nothing to act on', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const t0 = Date.now();
    assert.equal(manager.digest(wp, t0), null, 'no work: no digest');

    const blocked = story('QA the bundle', 'nikhil');
    items.update(wp, blocked.id, { status: 'in-progress' }, 'nikhil');
    items.update(wp, blocked.id, { status: 'blocked', blockedReason: 'Needs the vendor build. It ships Friday.', waitingOn: 'external' }, 'nikhil');
    const review = story('Mic gate', 'owner');
    items.update(wp, review.id, { status: 'in-progress' }, 'owner');
    items.update(wp, review.id, { status: 'in-review', reviewerId: 'nikhil' }, 'owner');
    story('Dance tempo', 'dev');
    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`paused:${spend.dayOf()}:employee:dev`, new Date().toISOString());

    const text = manager.digest(wp, t0 + 60 * MIN)!;
    assert.ok(text, 'a digest');
    assert.match(text, /Dev.*1 queued.*Dance tempo/s);
    assert.match(text, /Stale reviews:.*Mic gate.*Nikhil/s);
    assert.match(text, /Blocked:.*QA the bundle.*someone outside the team.*Needs the vendor build\./s);
    assert.doesNotMatch(text, /ships Friday/, 'the reason\'s first sentence only');
    await tick();
    assert.ok(told(fake, 'asha').some(t => t.includes('Manager digest')));
    assert.equal(manager.digest(wp, t0 + 70 * MIN), null, 'not again within 20 minutes');
    assert.ok(manager.digest(wp, t0 + 81 * MIN), 'again after 20 minutes');
  } finally {
    done();
  }
});
