import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as trail from '../src/services/trail.js';
import * as areas from '../src/services/areas.js';
import * as room from '../src/services/room.js';
import * as spend from '../src/services/spend.js';
import * as employees from '../src/services/employees.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * QA, 2 Oct (Android): the P0 stories flipped Blocked ↔ Unblocked within a second, flooding the
 * Updates feed and the epic's thread. RCA: every Workplace restart moved each building story to
 * Blocked ("session … was shut down by the Workplace") and the boot moved it straight back
 * ("resumed automatically"). A restart is not a transition of the work: the status stays put, and
 * repeated identical lines inside a short window are posted once.
 */

const tick = () => new Promise(r => setTimeout(r, 5));

function withOauth(dir: string): void {
  mkdirSync(join(dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test-token-value\n');
}

function setup(wp: ReturnType<typeof testWorkplace>['wp']) {
  const area = areas.create(wp, { title: 'Voice & audio' }, 'owner');
  const epic = items.create(wp, { level: 'epic', title: 'Iris during music', areaId: area.id, ownerId: 'asha' }, 'owner');
  const story = items.create(wp, { level: 'story', parentId: epic.id, title: 'Mic stays live at volume 0', assigneeId: 'dev', points: 3 }, 'asha');
  const thread = room.getThread(wp, room.epicThreadId(epic.id))!;
  return { epic, story, thread };
}

const lines = (wp: ReturnType<typeof testWorkplace>['wp'], itemId: string) => trail.updates(wp, { limit: 200 }).filter(u => u.itemId === itemId).map(u => u.kind).reverse();
const roomLines = (wp: ReturnType<typeof testWorkplace>['wp'], threadId: string) => room.messages(wp, threadId).filter(m => m.kind === 'update').map(m => m.text);

test('a Workplace shutdown and the boot after it never move the story: no Blocked/Unblocked lines, the session comes back', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    withOauth(tmp.dir);
    const { story, thread } = setup(wp);
    work.attachPlan(wp, story.id, 'p', 'dev');
    employees.assign(wp, story.id);
    await tick();
    assert.equal(items.require$(wp, story.id).status, 'in-progress');
    const feedBefore = lines(wp, story.id);
    const roomBefore = roomLines(wp, thread.id);

    employees.closeAll(wp, 'shutdown');
    assert.equal(items.require$(wp, story.id).status, 'in-progress', 'a restart is not a block');
    assert.equal(work.get(wp, story.id)!.state, 'building');
    assert.ok(trail.activityFor(wp, story.id).some(a => a.kind === 'note' && /shut down by the Workplace/.test(a.text)), 'the interruption is on the record');

    const result = await employees.resumeAfterShutdown(wp, 5);
    await tick();
    assert.deepEqual(result.resumed, [story.id]);
    assert.ok(employees.openSession('dev'), 'resumed in a fresh session');
    assert.equal(items.require$(wp, story.id).status, 'in-progress');

    assert.deepEqual(lines(wp, story.id), feedBefore, 'no Blocked, no Unblocked in the feed');
    assert.deepEqual(roomLines(wp, thread.id), roomBefore, 'and none in the epic thread');
    assert.ok(!trail.activityFor(wp, story.id).some(a => a.kind === 'status' && a.to === 'blocked'), 'no status flip at all');

    // Idempotent: the marker is consumed; a second boot does nothing.
    assert.deepEqual((await employees.resumeAfterShutdown(wp, 5)).resumed, []);
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('a crash (open session rows found on boot) leaves the story in progress too, and the boot resumes it', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    withOauth(tmp.dir);
    const { story } = setup(wp);
    work.attachPlan(wp, story.id, 'p', 'dev');
    employees.assign(wp, story.id);
    await tick();
    // The process dies: the session row is still open when the next boot looks.
    employees.recoverAfterRestart(wp);
    employees.closeAll(wp, 'test teardown of the dead process');
    assert.equal(items.require$(wp, story.id).status, 'in-progress');
    const result = await employees.resumeAfterShutdown(wp, 5);
    assert.deepEqual(result.resumed, [story.id]);
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('a capped employee is not resumed after a restart; its story stays in progress and is tried again on the next boot', async () => {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  try {
    withOauth(tmp.dir);
    const { story } = setup(wp);
    work.attachPlan(wp, story.id, 'p', 'dev');
    employees.assign(wp, story.id);
    await tick();
    employees.closeAll(wp, 'shutdown');
    const day = spend.dayOf();
    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`paused:${day}:employee:dev`, new Date().toISOString());
    const capped = await employees.resumeAfterShutdown(wp, 5);
    assert.deepEqual(capped.resumed, []);
    assert.equal(capped.skipped[0]!.id, story.id);
    assert.equal(items.require$(wp, story.id).status, 'in-progress');
    wp.db.prepare('delete from settings where key = ?').run(`paused:${day}:employee:dev`);
    assert.deepEqual((await employees.resumeAfterShutdown(wp, 5)).resumed, [story.id], 'the next boot takes it');
  } finally {
    fake.restore();
    tmp.cleanup();
  }
});

test('repeated identical transitions inside the window post one feed line and one room line each', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { story, thread } = setup(wp);
    items.update(wp, story.id, { status: 'in-progress', reason: 'test: moved' }, 'dev');
    const block = { status: 'blocked' as const, blockedReason: 'needs the Speaker API', waitingOn: 'external' };
    for (let i = 0; i < 3; i++) {
      items.update(wp, story.id, block, 'dev');
      items.update(wp, story.id, { status: 'in-progress', reason: 'test: moved' }, 'dev');
    }
    assert.deepEqual(lines(wp, story.id), ['started', 'blocked', 'unblocked']);
    assert.deepEqual(roomLines(wp, thread.id), [
      "Story 'Mic stays live at volume 0' started — Dev",
      "Story 'Mic stays live at volume 0' is blocked: waiting on someone outside the team",
      "Story 'Mic stays live at volume 0' is unblocked",
    ]);
    // Every transition is still in the activity log: only the announcements are deduplicated.
    assert.equal(trail.activityFor(wp, story.id).filter(a => a.kind === 'status' && a.to === 'blocked').length, 3);

    // A different reason is a different line.
    items.update(wp, story.id, { status: 'blocked', blockedReason: 'waiting on the TTS voice', waitingOn: 'owner', reason: 'test: moved' }, 'dev');
    assert.equal(lines(wp, story.id).at(-1), 'blocked');

    // Outside the window the same line posts again.
    items.update(wp, story.id, { status: 'in-progress', reason: 'test: moved' }, 'owner');
    const old = new Date(Date.now() - (wp.config.updateDedupeMinutes + 1) * 60_000).toISOString();
    wp.db.prepare('update updates set at = ? where item_id = ?').run(old, story.id);
    items.update(wp, story.id, block, 'dev');
    assert.equal(trail.updates(wp)[0]!.kind, 'blocked');
    assert.equal(trail.updates(wp)[0]!.line, 'Blocked: Mic stays live at volume 0 — waiting on someone outside the team: needs the Speaker API');
  } finally {
    tmp.cleanup();
  }
});

test('an Unblocked line is posted only for a block that was announced', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { story, thread } = setup(wp);
    items.update(wp, story.id, { status: 'in-progress', reason: 'test: moved' }, 'dev');
    // A block written without an announcement (as a legacy shutdown block was): leaving it says nothing.
    const row = work.get(wp, story.id)!;
    work.saveQuiet(wp, { ...row, state: 'blocked', status: 'blocked', blockedReason: 'old', waitingOn: 'coo', blockedSince: new Date().toISOString() });
    const before = roomLines(wp, thread.id).length;
    items.update(wp, story.id, { status: 'in-progress', reason: 'test: moved' }, 'owner');
    assert.ok(!lines(wp, story.id).includes('unblocked'));
    assert.equal(roomLines(wp, thread.id).length, before);
  } finally {
    tmp.cleanup();
  }
});
