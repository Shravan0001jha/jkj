import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as items from '../src/services/items.js';
import * as coo from '../src/services/coo.js';
import * as employees from '../src/services/employees.js';
import * as manager from '../src/services/manager.js';
import * as reviewWake from '../src/services/review-wake.js';
import * as floor from '../src/services/floor.js';
import * as stuck from '../src/services/stuck.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * The stuck-story watchdog (dry run, 4 Oct): In progress with no session, In review with no reviewer
 * on it, or assigned to Asha and not routed, for 10 minutes: one alert to Asha, escalated to the COO
 * by the manager when she does not act in 15. Nothing while the floor is paused.
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

test('In progress with no session for 10 min: one alert to Asha with who, how long and "wake"; deduped; escalated to the COO after 15 min unanswered', async () => {
  const { wp, story, done } = setup();
  try {
    const s = story('About screen version', 'tara');
    items.update(wp, s.id, { status: 'in-progress' }, 'tara');
    const t0 = Date.now();
    assert.deepEqual(stuck.sweep(wp, t0), []);
    assert.deepEqual(stuck.sweep(wp, t0 + 8 * MIN), [], 'not before 10 min');
    const keys = stuck.sweep(wp, t0 + 11 * MIN);
    assert.equal(keys.length, 1);
    const [a] = alertsFor(wp, s.id);
    assert.ok(a);
    assert.notEqual(a!.state, 'coo', 'Asha first');
    assert.match(a!.text!, /"About screen version".*In progress.*Tara \(assignee\).*no running or waiting session.*11 min.*Suggested: wake Tara/s);
    stuck.sweep(wp, t0 + 13 * MIN);
    assert.equal(alertsFor(wp, s.id).length, 1, 'once per item and state');
    assert.deepEqual(manager.escalate(wp, t0 + 27 * MIN), [a!.key], 'Asha did not act in 15 min: to the COO');
    assert.equal(coo.listItems(wp).filter(i => i.itemId === s.id).length, 1);
  } finally { await done(); }
});

test('In progress: a session on the item clears it, and the cleared alert is never escalated', async () => {
  const { wp, story, done } = setup();
  try {
    const s = story('Footer', 'tara');
    items.update(wp, s.id, { status: 'in-progress' }, 'tara');
    const t0 = Date.now();
    stuck.sweep(wp, t0);
    stuck.sweep(wp, t0 + 11 * MIN);
    assert.equal(alertsFor(wp, s.id).length, 1);
    employees.assign(wp, s.id);
    assert.ok(employees.sessionOn('tara', s.id));
    assert.deepEqual(stuck.sweep(wp, t0 + 12 * MIN), []);
    assert.equal(alertsFor(wp, s.id)[0]!.resolved, true);
    assert.deepEqual(manager.escalate(wp, t0 + 30 * MIN), []);
  } finally { await done(); }
});

test('In review with no reviewer session that has seen the request: alert names the reviewer; waking them clears it', async () => {
  const { wp, story, done } = setup();
  try {
    const s = story('Version label', 'tara');
    items.update(wp, s.id, { status: 'in-progress' }, 'tara');
    // Tara has a session on it; Nikhil (reviewer) has none.
    employees.assign(wp, s.id);
    items.update(wp, s.id, { status: 'in-review', reviewerId: 'nikhil' }, 'tara');
    const t0 = Date.now();
    stuck.sweep(wp, t0);
    assert.equal(stuck.sweep(wp, t0 + 11 * MIN).length, 1);
    const [a] = alertsFor(wp, s.id);
    assert.match(a!.text!, /In review.*Nikhil \(reviewer\).*no running or waiting session that has seen the review request.*Suggested: wake Nikhil/s);
    reviewWake.onItem(wp, s.id);
    assert.deepEqual(stuck.sweep(wp, t0 + 12 * MIN), [], 'the reviewer has a session that has seen it');
    assert.equal(alertsFor(wp, s.id)[0]!.resolved, true);
  } finally { await done(); }
});

test('assigned to the Chief of Staff and not routed in 10 min: alert to Asha suggesting reassign; routing clears it', async () => {
  const { wp, story, done } = setup();
  try {
    const s = story('Route me', 'asha');
    const t0 = Date.now();
    stuck.sweep(wp, t0);
    assert.equal(stuck.sweep(wp, t0 + 11 * MIN).length, 1);
    const [a] = alertsFor(wp, s.id);
    assert.notEqual(a!.state, 'coo', 'to Asha, not straight to the COO');
    assert.match(a!.text!, /Ready.*Asha \(Chief of Staff, to route it\).*not routed.*Suggested: reassign it to the owning developer/s);
    items.update(wp, s.id, { assigneeId: 'tara' }, 'asha');
    stuck.sweep(wp, t0 + 12 * MIN);
    assert.equal(alertsFor(wp, s.id)[0]!.resolved, true);
  } finally { await done(); }
});

test('the paused floor: nothing is checked or raised, and the clock starts again after the resume', async () => {
  const { wp, story, done } = setup();
  try {
    const s = story('Paused work', 'tara');
    items.update(wp, s.id, { status: 'in-progress' }, 'tara');
    const t0 = Date.now();
    stuck.sweep(wp, t0);
    floor.setPaused(wp, true, 'test', 'owner');
    assert.deepEqual(stuck.sweep(wp, t0 + 11 * MIN), []);
    assert.deepEqual(stuck.sweep(wp, t0 + 30 * MIN), []);
    assert.equal(alertsFor(wp, s.id).length, 0);
    floor.setPaused(wp, false, 'test', 'owner');
    assert.deepEqual(stuck.sweep(wp, t0 + 31 * MIN), [], 'the clock restarts');
    assert.deepEqual(stuck.sweep(wp, t0 + 35 * MIN), []);
    assert.equal(stuck.sweep(wp, t0 + 42 * MIN).length, 1);
  } finally { await done(); }
});

test('In progress while the assignee is working another story: queued, not stuck; no alert (8 Oct)', async () => {
  const { wp, story, done } = setup();
  try {
    const a = story('Story she is on', 'tara');
    const b = story('Second story, queued behind it', 'tara');
    employees.assign(wp, a.id);
    assert.ok(employees.sessionOn('tara', a.id));
    items.update(wp, b.id, { status: 'in-progress' }, 'tara');
    const t0 = Date.now();
    stuck.sweep(wp, t0);
    assert.deepEqual(stuck.sweep(wp, t0 + 11 * MIN), [], 'busy elsewhere is not stuck');
    assert.equal(alertsFor(wp, b.id).length, 0);
  } finally { await done(); }
});
