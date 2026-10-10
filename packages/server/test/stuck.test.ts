import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as items from '../src/services/items.js';
import * as coo from '../src/services/coo.js';
import * as employees from '../src/services/employees.js';
import * as manager from '../src/services/manager.js';
import * as reviewWake from '../src/services/review-wake.js';
import * as stuck from '../src/services/stuck.js';
import { rawGet } from '../src/services/v2-map.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * The stuck-story rules (dry run, 4 Oct): In progress with no session, In review with no reviewer on
 * it, or assigned to Asha and not routed. Since the October rework they feed the hygiene report only;
 * the sweep raises no alert (the stall chain tells people) and clears what was raised before.
 */

const MIN = 60_000;
const runtime = installFakeRuntime();
after(() => runtime.restore());

function setup() {
  const t = testWorkplace();
  mkdirSync(join(t.tmp.dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(t.tmp.dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token-value\n');
  const epic = items.create(t.wp, { level: 'epic', title: 'Practice' }, 'owner');
  const story = (title: string, assigneeId: string) => items.create(t.wp, { level: 'story', parentId: epic.id, title, assigneeId }, 'owner');
  return { ...t, story, done: async () => { await new Promise(r => setTimeout(r, 20)); t.tmp.cleanup(); } };
}
const alertsFor = (wp: Parameters<typeof manager.list>[0], id: string) => manager.list(wp).filter(a => a.itemId === id && a.key.startsWith('stuck:'));

test('In progress with no session: the condition names the assignee and "wake" (the hygiene report reads it); the sweep raises no alert (LLD-rework W2 §6)', async () => {
  const { wp, story, done } = setup();
  try {
    const s = story('About screen version', 'tara');
    items.update(wp, s.id, { status: 'in-progress', note: 'started by hand' }, 'tara');
    const c = stuck.condition(wp, rawGet(wp, s.id)!)!;
    assert.ok(c.state.startsWith('in-progress:tara:'));
    assert.match(`${c.expected} ${c.why} ${c.action}`, /Tara \(assignee\).*no running or waiting session.*wake Tara/s);
    const t0 = Date.now();
    assert.deepEqual(stuck.sweep(wp, t0), []);
    assert.deepEqual(stuck.sweep(wp, t0 + 11 * MIN), []);
    assert.equal(alertsFor(wp, s.id).length, 0, 'no alert to Asha');
    assert.deepEqual(manager.escalate(wp, t0 + 27 * MIN), []);
    assert.equal(coo.listItems(wp).filter(i => i.itemId === s.id).length, 0);
  } finally { await done(); }
});

test('In progress: a session on the item clears the condition', async () => {
  const { wp, story, done } = setup();
  try {
    const s = story('Footer', 'tara');
    items.update(wp, s.id, { status: 'in-progress', note: 'started by hand' }, 'tara');
    assert.ok(stuck.condition(wp, rawGet(wp, s.id)!));
    employees.assign(wp, s.id);
    assert.ok(employees.sessionOn('tara', s.id));
    assert.equal(stuck.condition(wp, rawGet(wp, s.id)!), null);
  } finally { await done(); }
});

test('In review with no reviewer session that has seen the request: the condition names the reviewer; waking them clears it', async () => {
  const { wp, story, done } = setup();
  try {
    const s = story('Version label', 'tara');
    items.update(wp, s.id, { status: 'in-progress', note: 'started by hand' }, 'tara');
    employees.assign(wp, s.id);
    items.update(wp, s.id, { status: 'in-review', reviewerId: 'nikhil', note: 'ready for review' }, 'tara');
    const c = stuck.condition(wp, rawGet(wp, s.id)!)!;
    assert.match(`${c.status} ${c.expected} ${c.why} ${c.action}`, /In review.*Nikhil \(reviewer\).*no running or waiting session that has seen the review request.*wake Nikhil/s);
    reviewWake.onItem(wp, s.id);
    assert.equal(stuck.condition(wp, rawGet(wp, s.id)!), null, 'the reviewer has a session that has seen it');
  } finally { await done(); }
});

test('assigned to the Chief of Staff and not routed: the condition suggests reassigning; routing clears it', async () => {
  const { wp, story, done } = setup();
  try {
    const s = story('Route me', 'asha');
    const c = stuck.condition(wp, rawGet(wp, s.id)!)!;
    assert.match(`${c.status} ${c.expected} ${c.why} ${c.action}`, /Ready.*Asha \(Chief of Staff, to route it\).*not routed.*reassign it to the owning developer/s);
    items.update(wp, s.id, { assigneeId: 'tara', note: 'mobile charter' }, 'asha');
    assert.equal(stuck.condition(wp, rawGet(wp, s.id)!), null);
  } finally { await done(); }
});

test('the sweep clears records and alerts left from before the rework, so none is escalated later', async () => {
  const { wp, story, done } = setup();
  try {
    const s = story('Old record', 'tara');
    const t0 = Date.now();
    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`stuck:${s.id}`, JSON.stringify({ state: 'in-progress:tara:x', since: new Date(t0).toISOString() }));
    manager.alert(wp, { key: `stuck:${s.id}:in-progress:tara:x`, itemId: s.id, title: 'Stuck', body: 'old', by: 'workplace' }, t0);
    assert.deepEqual(stuck.sweep(wp, t0 + MIN), []);
    assert.equal(wp.db.prepare('select 1 from settings where key = ?').get(`stuck:${s.id}`), undefined);
    assert.equal(alertsFor(wp, s.id)[0]!.resolved, true);
    assert.deepEqual(manager.escalate(wp, t0 + 60 * MIN), []);
  } finally { await done(); }
});

test('In progress while the assignee is working another story: queued, not stuck; no alert (8 Oct)', async () => {
  const { wp, story, done } = setup();
  try {
    const a = story('Story she is on', 'tara');
    const b = story('Second story, queued behind it', 'tara');
    employees.assign(wp, a.id);
    assert.ok(employees.sessionOn('tara', a.id));
    items.update(wp, b.id, { status: 'in-progress', note: 'queued behind A' }, 'tara');
    assert.equal(stuck.condition(wp, rawGet(wp, b.id)!), null, 'busy elsewhere is not stuck');
    const t0 = Date.now();
    stuck.sweep(wp, t0);
    assert.deepEqual(stuck.sweep(wp, t0 + 11 * MIN), []);
    assert.equal(alertsFor(wp, b.id).length, 0);
  } finally { await done(); }
});
