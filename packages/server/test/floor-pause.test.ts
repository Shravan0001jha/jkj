import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as items from '../src/services/items.js';
import * as employees from '../src/services/employees.js';
import * as runs from '../src/services/runs.js';
import * as dispatch from '../src/services/dispatch.js';
import * as manager from '../src/services/manager.js';
import * as coo from '../src/services/coo.js';
import * as floor from '../src/services/floor.js';
import { installFakeRuntime, type FakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';
import { boot, call } from './fakes/boot.js';

/**
 * "Pause all" (owner, 4 Oct): one switch, `floor:paused`. While it is on nothing unattended starts —
 * the dispatcher, the manager digest, resumes — but the owner and the COO can still talk to anyone,
 * and turns already running finish on their own. One COO alert when it goes on, one when it goes off.
 */

const MIN = 60_000;
const tick = (ms = 15) => new Promise(r => setTimeout(r, ms));

function withOauth(dir: string): void {
  mkdirSync(join(dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token-value\n');
}
const of = (fake: FakeRuntime, emp: string) => fake.sessions.filter(s => s.options.cwd.includes(`/${emp}/`));
const floorAlerts = (wp: Parameters<typeof floor.state>[0]) => coo.listItems(wp).filter(i => i.itemId === 'floor');

function setup() {
  const t = testWorkplace();
  const fake = installFakeRuntime();
  withOauth(t.tmp.dir);
  const epic = items.create(t.wp, { level: 'epic', title: 'Iris during music' }, 'owner');
  items.setFocus(t.wp, [epic.id], 'owner');
  const story = (title: string, assigneeId: string) => items.create(t.wp, { level: 'story', parentId: epic.id, title, assigneeId }, 'asha');
  return { ...t, fake, story, done: () => { fake.restore(); t.tmp.cleanup(); } };
}

test('paused: the dispatcher starts nothing, new or resumed; unpaused it does', async () => {
  const { wp, fake, story, done } = setup();
  try {
    floor.setPaused(wp, true, 'owner is reviewing the plan', 'coo');
    const a = story('Mic gate opens over music', 'dev');
    const r = dispatch.dispatch(wp, 'dev');
    assert.equal(r.action, 'skipped');
    assert.match(r.reason ?? '', /floor is paused/);
    // An In-progress story with no session (the orphan resume) does not start either.
    items.update(wp, a.id, { status: 'in-progress', reason: 'test: moved' }, 'dev');
    dispatch.sweep(wp);
    await tick();
    assert.equal(of(fake, 'dev').length, 0, 'no session started');
    assert.throws(() => employees.assign(wp, a.id), /paused/);

    floor.setPaused(wp, false, 'go', 'coo');
    dispatch.dispatch(wp, 'dev');
    await tick();
    assert.equal(of(fake, 'dev').length, 1, 'started once the floor is back');
  } finally {
    done();
  }
});

test('paused: the manager digest starts no session for Asha', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const blocked = story('QA the bundle', 'nikhil');
    items.update(wp, blocked.id, { status: 'in-progress', reason: 'test: moved' }, 'nikhil');
    items.update(wp, blocked.id, { status: 'blocked', blockedReason: 'Needs the vendor build.', waitingOn: 'external', reason: 'test: moved' }, 'nikhil');
    floor.setPaused(wp, true, 'pause', 'owner');
    manager.digest(wp, Date.now() + 60 * MIN);
    manager.deliver(wp, Date.now() + 61 * MIN);
    await tick();
    assert.equal(of(fake, 'asha').length, 0);
  } finally {
    done();
  }
});

test('paused: the owner and the COO can still talk; autonomous talk cannot start a session', async () => {
  const { wp, fake, done } = setup();
  try {
    floor.setPaused(wp, true, 'pause', 'owner');
    assert.throws(() => employees.talk(wp, 'mira', 'Team Room moderation', [], { autonomous: true }), /paused/);
    employees.talk(wp, 'asha', 'COO: what is blocked right now?');
    await tick();
    assert.equal(of(fake, 'asha').length, 1);
    assert.equal(of(fake, 'mira').length, 0);
  } finally {
    done();
  }
});

test('pausing never interrupts a running turn: it finishes and the session stays open', async () => {
  const { wp, fake, story, done } = setup();
  try {
    const a = story('Mic gate opens over music', 'dev');
    employees.assign(wp, a.id);
    await tick();
    const s = of(fake, 'dev')[0]!;
    const id = employees.openSession('dev')!.agentId;
    assert.equal(runs.getRunAgent(id)!.status, 'running');
    floor.setPaused(wp, true, 'pause', 'owner');
    await tick();
    assert.equal(s.interrupted, 0);
    s.say('## Plan\n1. gate the mic');
    s.result();
    await tick();
    assert.equal(runs.getRunAgent(id)!.status, 'waiting');
    assert.equal(s.closed, false);
  } finally {
    done();
  }
});

test('one COO alert on pause and one on resume; repeats change nothing', () => {
  const { wp, done } = setup();
  try {
    floor.setPaused(wp, true, 'owner is reviewing the plan', 'coo');
    floor.setPaused(wp, true, 'again', 'coo');
    assert.equal(floorAlerts(wp).length, 1);
    assert.match(floorAlerts(wp)[0]!.title, /paused/i);
    assert.match(floorAlerts(wp)[0]!.body, /owner is reviewing the plan/);
    assert.equal(floor.state(wp).reason, 'owner is reviewing the plan', 'a repeat does not overwrite the state');
    floor.setPaused(wp, false, 'plan approved', 'coo');
    floor.setPaused(wp, false, 'again', 'coo');
    assert.equal(floorAlerts(wp).length, 2);
    assert.equal(floorAlerts(wp).filter(i => /resumed/i.test(i.title)).length, 1);
  } finally {
    done();
  }
});

test('the routes, and the state persists across a restart', async () => {
  const b = await boot();
  try {
    assert.deepEqual((await call<{ paused: boolean }>(b.base, 'GET', '/api/coo/floor')).body.paused, false);
    const on = await call<{ paused: boolean; reason: string }>(b.base, 'POST', '/api/coo/floor', { paused: true, reason: 'night freeze' });
    assert.equal(on.status, 200);
    assert.equal(on.body.paused, true);
    assert.equal(on.body.reason, 'night freeze');
    assert.equal((await call(b.base, 'POST', '/api/coo/floor', { paused: 'yes' })).status, 400);
    await new Promise(r => setTimeout(r, 50));   // the boot's own async work (resume after restart) settles first
  } finally {
    await b.running.stop();
  }
  // A second boot on the same Workplace directory reads it back.
  const { loadConfig } = await import('../src/config.js');
  const { start } = await import('../src/index.js');
  const { join: j } = await import('node:path');
  const running = await start(loadConfig(['--no-open', '--no-telegram', '--no-seed', '--port', '0'], {
    IRIS_WORKPLACE_DIR: b.tmp.dir, IRIS_OPS_DIR: j(b.tmp.dir, 'ops'), IRIS_WORK_DIR: b.tmp.workDir, WORKPLACE_CAP_INR: '1000', WORKPLACE_USD_INR: '88',
  }));
  try {
    const base = `http://127.0.0.1:${(running.server.address() as { port: number }).port}`;
    const st = await call<{ paused: boolean; reason: string }>(base, 'GET', '/api/coo/floor');
    assert.equal(st.body.paused, true);
    assert.equal(st.body.reason, 'night freeze');
    await new Promise(r => setTimeout(r, 50));
  } finally {
    await running.stop();
    b.fake.restore();
    b.tmp.cleanup();
  }
});
