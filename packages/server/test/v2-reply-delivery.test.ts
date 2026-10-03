import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as inbox from '../src/services/inbox.js';
import * as items from '../src/services/items.js';
import * as trail from '../src/services/trail.js';
import * as coo from '../src/services/coo.js';
import * as manager from '../src/services/manager.js';
import * as employees from '../src/services/employees.js';
import * as dispatch from '../src/services/dispatch.js';
import * as delivery from '../src/services/reply-delivery.js';
import { installFakeRuntime, type FakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * Owner, 3 Oct 01:05 UTC (LLD §19.14): a free-text reply on Rohan's decision went into his busy
 * session's in-memory queue and died with it in the 01:06 restart. Each owner reply is now recorded,
 * delivered, re-delivered until the raiser acknowledges it, and escalated (Asha 10 min, COO 20 min).
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
const relayed = (fake: FakeRuntime, emp: string) => told(fake, emp).filter(t => /The owner replied on/.test(t));
const bridge = (wp: Wp) => coo.readInboxFileForTest(wp).trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);

function setup() {
  const t = testWorkplace();
  const fake = installFakeRuntime();
  withOauth(t.tmp.dir);
  const decision = (raisedBy = 'mira', extra: Partial<inbox.RaiseOptions> = {}) => inbox.raise(t.wp, {
    kind: 'decision', title: 'Shipping Iris on Windows', body: 'Cert, test rig, beta-1 scope.', raisedBy,
    options: [{ id: 'approve', label: 'Approve' }, { id: 'hold', label: 'Hold' }], ...extra,
  });
  const ownerSays = (id: string, text: string) => inbox.reply(t.wp, id, { by: 'owner', text }).messages.filter(m => m.by === 'owner').at(-1)!;
  return { ...t, fake, decision, ownerSays, done: () => { fake.restore(); t.tmp.cleanup(); } };
}

test('an owner reply goes into the raiser\'s open session and is recorded as delivered', async () => {
  const { wp, fake, decision, ownerSays, done } = setup();
  try {
    employees.talk(wp, 'mira', 'Keep drafting the HLD.', [], { autonomous: true });
    await tick();
    const session = of(fake, 'mira')[0]!;
    const item = decision();
    const m = ownerSays(item.id, 'Windows is secondary for now; just do the tests we can.');
    await tick();
    assert.equal(of(fake, 'mira').length, 1, 'her open session, not a second one');
    assert.match(session.sent.at(-1)!.text, /The owner replied on "Shipping Iris on Windows".*Windows is secondary/s);
    const d = delivery.get(wp, m.id)!;
    assert.equal(d.target, 'mira');
    assert.equal(d.attempts, 1);
    assert.ok(d.deliveredAt);
    assert.equal(d.agentId, employees.openSession('mira')!.agentId);
    assert.equal(d.ackedAt, undefined, 'delivered is not acknowledged');
  } finally {
    done();
  }
});

test('no open session: a short session is started with the reply', async () => {
  const { wp, fake, decision, ownerSays, done } = setup();
  try {
    const item = decision();
    assert.equal(of(fake, 'mira').length, 0);
    const m = ownerSays(item.id, 'What does the cert cost per year?');
    await tick();
    assert.equal(of(fake, 'mira').length, 1);
    assert.match(of(fake, 'mira')[0]!.options.prompt, /What does the cert cost per year\?.*inbox_reply/s);
    assert.ok(delivery.get(wp, m.id)!.deliveredAt);
  } finally {
    done();
  }
});

test('the incident: delivered into a busy session that a restart then kills — re-delivered on the next sweep, once', async () => {
  const { wp, fake, decision, ownerSays, done } = setup();
  try {
    employees.talk(wp, 'mira', 'Build the update channel.', [], { autonomous: true });
    await tick();
    const item = decision();
    const m = ownerSays(item.id, 'Windows is secondary; final build later.');
    await tick();
    assert.equal(relayed(fake, 'mira').length, 1);

    // A live session still holding it: nothing is sent twice.
    assert.deepEqual(delivery.sweep(wp).redelivered, []);
    assert.equal(relayed(fake, 'mira').length, 1);

    // The 01:06 restart: every session is shut down; the queued message is gone with it.
    employees.closeAll(wp, 'shutdown');
    assert.equal(employees.openSession('mira'), undefined);
    dispatch.sweep(wp); // the boot pass is the dispatcher's first sweep
    await tick();
    const sent = relayed(fake, 'mira');
    assert.equal(sent.length, 2, 'delivered again, in a new session');
    assert.match(sent[1]!, /Sent again/);
    const d = delivery.get(wp, m.id)!;
    assert.equal(d.attempts, 2);
    assert.equal(d.agentId, employees.openSession('mira')!.agentId);
    delivery.sweep(wp);
    assert.equal(relayed(fake, 'mira').length, 2, 'not again while the new session is live');
  } finally {
    done();
  }
});

test('acknowledgement stops re-delivery: an answer in the thread, or activity on the linked item', async () => {
  const { wp, fake, decision, ownerSays, done } = setup();
  try {
    // inbox_reply in the thread.
    const a = decision();
    const ma = ownerSays(a.id, 'Hold the cert for now.');
    await tick();
    inbox.reply(wp, a.id, { by: 'mira', text: 'Holding it; tests only.' });
    const da = delivery.get(wp, ma.id)!;
    assert.ok(da.ackedAt);
    assert.equal(da.ackedBy, 'thread');

    // Activity by the raiser on the work item the decision is about.
    const epic = items.create(wp, { level: 'epic', title: 'Iris on Windows' }, 'owner');
    const story = items.create(wp, { level: 'story', parentId: epic.id, title: 'Windows brief', assigneeId: 'mira' }, 'asha');
    const b = decision('mira', { title: 'Second Windows call', context: { itemId: story.id } });
    const mb = ownerSays(b.id, 'Scope it to voice only.');
    await tick();
    trail.record(wp, { itemId: story.id, by: 'workplace', kind: 'stall', text: 'not an acknowledgement' });
    assert.deepEqual(delivery.checkAcks(wp), []);
    trail.comment(wp, story.id, { by: 'mira', text: 'Scoped to voice only per the owner.' });
    assert.deepEqual(delivery.checkAcks(wp), [mb.id]);
    assert.equal(delivery.get(wp, mb.id)!.ackedBy, 'activity');

    const before = relayed(fake, 'mira').length;
    employees.closeAll(wp, 'shutdown');
    const s = delivery.sweep(wp, Date.now() + 30 * MIN);
    await tick();
    assert.deepEqual(s, { acked: [], redelivered: [], asha: [], coo: [] }, 'acknowledged replies are neither re-sent nor escalated');
    assert.equal(relayed(fake, 'mira').length, before);
  } finally {
    done();
  }
});

test('unacknowledged: Asha is told at 10 minutes, the COO at 20, once each', async () => {
  const { wp, fake, decision, ownerSays, done } = setup();
  try {
    const item = decision();
    const m = ownerSays(item.id, 'Windows is secondary.');
    await tick();
    const t0 = Date.parse(m.at);

    assert.deepEqual(delivery.sweep(wp, t0 + 9 * MIN).asha, []);
    assert.deepEqual(delivery.sweep(wp, t0 + 10 * MIN + 1).asha, [m.id]);
    await tick();
    const rec = manager.list(wp).find(r => r.key === `inbox-reply:${m.id}`)!;
    assert.ok(rec, 'a manager alert, Asha first');
    assert.notEqual(rec.state, 'coo');
    assert.ok(told(fake, 'asha').some(t => /Owner's reply not answered|Mira has not answered/.test(t)), 'Asha hears it');
    assert.equal(coo.listItems(wp).filter(i => /Owner's reply not answered/.test(i.title)).length, 0, 'not the COO yet');
    // manager.escalate's own 15-minute step never doubles the COO alert.
    assert.deepEqual(manager.escalate(wp, t0 + 16 * MIN), []);

    const at20 = delivery.sweep(wp, t0 + 20 * MIN + 1);
    assert.deepEqual(at20.asha, []);
    assert.deepEqual(at20.coo, [m.id]);
    const cooItems = coo.listItems(wp).filter(i => /Owner's reply not answered/.test(i.title));
    assert.equal(cooItems.length, 1);
    assert.match(cooItems[0]!.body, /Windows is secondary/);
    assert.deepEqual(delivery.sweep(wp, t0 + 40 * MIN).coo, [], 'once');
    assert.equal(coo.listItems(wp).filter(i => /Owner's reply not answered/.test(i.title)).length, 1);
  } finally {
    done();
  }
});

test('the COO gets a copy of every reply on a decision; a COO item goes to the bridge only, acknowledged', async () => {
  const { wp, fake, decision, ownerSays, done } = setup();
  try {
    const d1 = decision();
    const m1 = ownerSays(d1.id, 'Windows is secondary.');
    await tick();
    const copy = bridge(wp).find(e => e['messageId'] === m1.id)!;
    assert.equal(copy['kind'], 'inbox-reply');
    assert.equal(copy['copy'], true);
    assert.equal(copy['raisedBy'], 'mira');
    assert.equal(relayed(fake, 'mira').length, 1, 'the raiser still gets it');

    // Not a decision: no copy.
    const q = inbox.raise(wp, { kind: 'question', title: 'Which branch?', body: 'Two candidates.', raisedBy: 'mira' });
    const mq = ownerSays(q.id, 'main');
    assert.equal(bridge(wp).filter(e => e['messageId'] === mq.id).length, 0);

    // Raised by the COO: the bridge is the delivery (not a copy), durable, so acknowledged at once.
    const c = decision('coo', { title: 'COO asks: freeze Fridays?' });
    const mc = ownerSays(c.id, 'Yes, freeze Fridays.');
    const lines = bridge(wp).filter(e => e['messageId'] === mc.id);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!['copy'], undefined);
    const dc = delivery.get(wp, mc.id)!;
    assert.equal(dc.target, 'coo');
    assert.equal(dc.ackedBy, 'bridge');
    assert.ok(!delivery.sweep(wp, Date.now() + 30 * MIN).coo.includes(mc.id), 'the COO is never alerted about its own reply');
  } finally {
    done();
  }
});
