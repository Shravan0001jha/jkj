import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BacklogView, EpicDetail, Feature, PlannedEpic, TeamBoard, TodayView, TrackedDay } from '@jkj/shared';
import * as items from '../src/services/items.js';
import * as inbox from '../src/services/inbox.js';
import * as sprints from '../src/services/sprints.js';
import { testWorkplace, withTree } from './fakes/workplace.js';
import { loadConfig } from '../src/config.js';
import { start } from '../src/index.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { tmpWorkplace } from './fakes/tmp-workplace.js';
import { setMacHostForTest } from '../src/services/mac-host.js';

setMacHostForTest(true);

/** docs/LLD-sprint-board.md §7. Clock: an IST instant built from a date and an hour. */
const ist = (date: string, hh = 12, mm = 0): number => Date.parse(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`);

test('calendar: IST dates and two-week sprints from Sat 7 Nov 2026', () => {
  assert.equal(sprints.istDate(Date.parse('2026-11-06T18:29:00Z')), '2026-11-06', '23:59 IST is still the 6th');
  assert.equal(sprints.istDate(Date.parse('2026-11-06T18:31:00Z')), '2026-11-07');
  const s1 = sprints.sprintForDate('2026-11-07');
  assert.deepEqual({ id: s1.id, number: s1.number, start: s1.start, end: s1.end }, { id: 'sp_1', number: 1, start: '2026-11-07', end: '2026-11-20' });
  assert.equal(sprints.sprintForDate('2026-11-20').number, 1);
  assert.equal(sprints.sprintForDate('2026-11-21').number, 2);
  assert.equal(sprints.sprintForDate('2026-12-05').start, '2026-12-05');
  assert.equal(sprints.sprintForDate('2026-11-01').number, 1, 'before Sprint 1 counts as Sprint 1');
});

test('migration: open epics become features with themselves as containers; done epics skipped; idempotent; stories untouched', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const big = items.create(wp, { level: 'epic', title: 'Phone works without the Mac', targetDate: '2026-11-06' }, 'owner');
    const story = items.create(wp, { level: 'story', parentId: big.id, title: 'Alarm rings', assigneeId: 'dev' }, 'asha');
    const old = items.create(wp, { level: 'epic', title: 'Old finished epic' }, 'owner');
    items.update(wp, old.id, { status: 'done', reason: 'test: finished' }, 'owner');

    const t = ist('2026-11-07');
    const feats = sprints.features(wp, t);
    assert.equal(feats.length, 1);
    assert.equal(feats[0]!.title, 'Phone works without the Mac');
    assert.deepEqual(feats[0]!.containerEpicIds, [big.id]);
    assert.equal(feats[0]!.dueDate, '2026-11-06');
    assert.equal(sprints.features(wp, t).length, 1, 'idempotent');
    assert.equal(items.require$(wp, story.id).parentId, big.id, 'the story keeps its parent');
    const backlog = sprints.backlog(wp, t);
    assert.equal(backlog.planned.length + backlog.backlog.length, 0, 'a container is never on the epic board');
    assert.equal(backlog.unplanned.length, 0);
  } finally { tmp.cleanup(); }
});

function planned(wp: ReturnType<typeof testWorkplace>['wp'], t: number, title: string, due: string, sprint: 'current' | 'backlog' = 'current'): { feature: Feature; epic: PlannedEpic } {
  const feature = sprints.createFeature(wp, { title: `${title} feature`, dueDate: '2026-11-28' }, 'owner', t);
  const epic = sprints.createEpic(wp, { title, featureId: feature.id, dueDate: due, sprint }, 'owner', t);
  return { feature, epic };
}

test('creating an epic makes a level-epic item agents can file stories under, with its plan row', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const t = ist('2026-11-07');
    const { feature, epic } = planned(wp, t, 'Image gaps', '2026-11-12');
    const item = items.require$(wp, epic.id);
    assert.equal(item.level, 'epic');
    assert.equal(epic.featureId, feature.id);
    assert.equal(epic.sprintId, 'sp_1');
    assert.equal(epic.planState, 'planned');
    assert.equal(epic.dueDate, '2026-11-12');
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Hinglish image ask reaches image.generate', assigneeId: 'dev' }, 'asha');
    assert.equal(items.require$(wp, s.id).epicId, epic.id);
    assert.throws(() => sprints.createEpic(wp, { title: 'x', featureId: 'fe_nope', dueDate: '2026-11-12' }, 'owner', t), /feature/i);
    assert.throws(() => sprints.createEpic(wp, { title: 'x', featureId: feature.id, dueDate: '12 Nov' }, 'owner', t), /date/i);
  } finally { tmp.cleanup(); }
});

test('derived epic state: planned, in-progress, at-risk, overdue, blocked on the owner, done, parked, backlog', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const t = ist('2026-11-09');
    const a = planned(wp, t, 'A', '2026-11-14').epic;
    assert.equal(sprints.epic(wp, a.id, t).epic.state, 'planned');

    const s = items.create(wp, { level: 'story', parentId: a.id, title: 'a1', assigneeId: 'dev' }, 'asha');
    items.update(wp, s.id, { status: 'in-progress', reason: 'test: start' }, 'dev');
    assert.equal(sprints.epic(wp, a.id, t).epic.state, 'in-progress');

    const b = planned(wp, t, 'B', '2026-11-10').epic;
    items.create(wp, { level: 'story', parentId: b.id, title: 'b1', assigneeId: 'dev' }, 'asha');
    assert.equal(sprints.epic(wp, b.id, t).epic.state, 'at-risk', 'due tomorrow at 0%');

    const c = planned(wp, t, 'C', '2026-11-08').epic;
    const c1 = sprints.epic(wp, c.id, t).epic;
    assert.equal(c1.state, 'at-risk');
    assert.equal(c1.overdue, true);

    const d = planned(wp, t, 'D', '2026-11-18').epic;
    const d1 = items.create(wp, { level: 'story', parentId: d.id, title: 'd1', assigneeId: 'dev' }, 'asha');
    items.update(wp, d1.id, { status: 'blocked', blockedReason: 'which TTS voice ships?', waitingOn: 'owner', recommendation: 'Keep it', reason: 'test: blocked' }, 'dev');
    const dd = sprints.epic(wp, d.id, t).epic;
    assert.equal(dd.state, 'blocked');
    assert.equal(dd.waitingOnOwner, true);
    assert.equal(dd.blockers.length, 1);
    assert.equal(dd.blockers[0]!.storyId, d1.id);

    const e = planned(wp, t, 'E', '2026-11-09').epic;
    const e1 = items.create(wp, { level: 'story', parentId: e.id, title: 'e1', assigneeId: 'dev' }, 'asha');
    items.update(wp, e1.id, { status: 'done', resolution: 'done', reason: 'test: done' }, 'owner');
    const ee = sprints.epic(wp, e.id, t).epic;
    assert.equal(ee.state, 'done');
    assert.equal(ee.dueToday, false, 'a done epic is not "due today"');

    const f = planned(wp, t, 'F', '2026-11-20').epic;
    sprints.updateEpic(wp, f.id, { planState: 'parked' }, 'owner', t);
    const ff = sprints.epic(wp, f.id, t).epic;
    assert.equal(ff.state, 'parked');
    assert.equal(ff.sprintId, null);

    const g = planned(wp, t, 'G', '2026-11-25', 'backlog').epic;
    assert.equal(sprints.epic(wp, g.id, t).epic.state, 'backlog');
  } finally { tmp.cleanup(); }
});

test('dates: a reason is required to change an existing date, not to set the first; every change is logged', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const t = ist('2026-11-07');
    const feature = sprints.createFeature(wp, { title: 'Notifications' }, 'owner', t);
    sprints.updateFeature(wp, feature.id, { dueDate: '2026-11-28' }, 'owner', t);
    assert.throws(() => sprints.updateFeature(wp, feature.id, { dueDate: '2026-12-05' }, 'owner', t), /reason/i);
    sprints.updateFeature(wp, feature.id, { dueDate: '2026-12-05', reason: 'Phone Agent first' }, 'owner', t);
    const epic = sprints.createEpic(wp, { title: 'Design', featureId: feature.id, dueDate: '2026-11-12' }, 'coo', t);
    assert.throws(() => sprints.updateEpic(wp, epic.id, { dueDate: '2026-11-13' }, 'owner', t), /reason/i);
    sprints.updateEpic(wp, epic.id, { dueDate: '2026-11-13', reason: 'owner review on the 12th' }, 'owner', t);
    const log = sprints.dates(wp, epic.id);
    assert.deepEqual(log.map(d => [d.from ?? null, d.to, d.by, d.reason]), [
      [null, '2026-11-12', 'coo', 'Set when the epic was created'],
      ['2026-11-12', '2026-11-13', 'owner', 'owner review on the 12th'],
    ]);
    assert.equal(sprints.dates(wp, feature.id).length, 2);
  } finally { tmp.cleanup(); }
});

test('rank and plan moves: rank sets the order, a past sprint is refused, unknown ids refused', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const t = ist('2026-11-07');
    const a = planned(wp, t, 'A', '2026-11-12', 'backlog').epic;
    const b = planned(wp, t, 'B', '2026-11-12', 'backlog').epic;
    const c = planned(wp, t, 'C', '2026-11-12', 'backlog').epic;
    sprints.rank(wp, { epicIds: [c.id, a.id, b.id] }, 'owner', t);
    assert.deepEqual(sprints.backlog(wp, t).backlog.map(e => e.id), [c.id, a.id, b.id]);
    assert.throws(() => sprints.rank(wp, { epicIds: ['as_nope'] }, 'owner', t), /unknown|no planned/i);
    sprints.updateEpic(wp, a.id, { planState: 'planned' }, 'owner', t);
    assert.equal(sprints.epic(wp, a.id, t).epic.sprintId, 'sp_1');
    sprints.updateEpic(wp, b.id, { planState: 'planned', sprintId: 'sp_2' }, 'owner', t);
    assert.equal(sprints.backlog(wp, t).later[0]!.id, b.id);
    const later = ist('2026-11-22');
    assert.throws(() => sprints.updateEpic(wp, c.id, { planState: 'planned', sprintId: 'sp_1' }, 'owner', later), /past/i);
  } finally { tmp.cleanup(); }
});

test('rollover: the ended sprint is frozen into the archive; unfinished epics carry over with a reason; idempotent', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const t = ist('2026-11-10');
    const done = planned(wp, t, 'Done one', '2026-11-12').epic;
    const s = items.create(wp, { level: 'story', parentId: done.id, title: 'x', assigneeId: 'dev' }, 'asha');
    items.update(wp, s.id, { status: 'done', resolution: 'done', reason: 'test: done' }, 'owner');
    const slip = planned(wp, t, 'Slipped one', '2026-11-19').epic;
    items.create(wp, { level: 'story', parentId: slip.id, title: 'y', assigneeId: 'dev' }, 'asha');
    sprints.updateSprint(wp, 'sp_1', { goal: 'Alarms live' }, 'owner', t);

    const next = ist('2026-11-22');
    const review = sprints.review(wp, next);
    assert.equal(review.current.number, 2);
    assert.equal(review.last?.number, 1);
    assert.equal(review.last?.goal, 'Alarms live');
    assert.deepEqual(review.last?.done.map(e => e.id), [done.id]);
    assert.deepEqual(review.last?.slipped.map(e => e.id), [slip.id]);
    const moved = sprints.epic(wp, slip.id, next).epic;
    assert.equal(moved.sprintId, 'sp_2');
    assert.equal(moved.carried?.length, 1);
    assert.match(moved.carried![0]!.reason, /Sprint 1/);
    sprints.review(wp, next);
    assert.equal(sprints.epic(wp, slip.id, next).epic.carried?.length, 1, 'idempotent');
    sprints.updateEpic(wp, slip.id, { carryReason: 'waited on the Mac bug bash' }, 'owner', next);
    assert.equal(sprints.epic(wp, slip.id, next).epic.carried![0]!.reason, 'waited on the Mac bug bash');
    assert.equal(sprints.review(wp, next).archive.length, 1);
  } finally { tmp.cleanup(); }
});

test('today: due today, overdue, done today, waiting on you, and the empty state', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const t = ist('2026-11-12', 10);
    let today: TodayView = sprints.today(wp, t);
    assert.equal(today.empty, true);
    assert.equal(today.date, '2026-11-12');

    const due = planned(wp, t, 'Due today', '2026-11-12').epic;
    const late = planned(wp, t, 'Late', '2026-11-10').epic;
    const blockedEpic = planned(wp, t, 'Needs the owner', '2026-11-18').epic;
    const st = items.create(wp, { level: 'story', parentId: blockedEpic.id, title: 'voice?', assigneeId: 'dev' }, 'asha');
    items.update(wp, st.id, { status: 'blocked', blockedReason: 'which voice?', waitingOn: 'owner', recommendation: 'Keep', reason: 'test: blocked' }, 'dev');
    inbox.raise(wp, { kind: 'decision', title: 'Switch plan limits on in the live app?', body: 'Limits are stable on staging.', raisedBy: 'asha', recommendation: 'Yes' });

    today = sprints.today(wp, t);
    assert.equal(today.empty, false);
    assert.deepEqual(today.dueToday.map(e => e.id), [due.id]);
    assert.equal(today.dueToday[0]!.dueToday, true);
    assert.deepEqual(today.overdue.map(e => e.id), [late.id]);
    assert.deepEqual(today.blocked.map(e => e.id), [blockedEpic.id]);
    assert.ok(today.waitingOnYou.some(w => w.kind === 'inbox' && /plan limits/.test(w.title)));
    // The blocked story waits on the owner: listed once, as its own Inbox item when the block raised one, else as the item.
    const forStory = today.waitingOnYou.filter(w => w.id === st.id || /which voice/.test(`${w.title} ${w.line}`));
    assert.equal(forStory.length, 1, JSON.stringify(today.waitingOnYou));

    const tracked: TrackedDay = sprints.tracked(wp, '2026-11-12', t);
    const ids = new Set(tracked.tracked.map(e => e.id));
    assert.ok(ids.has(due.id) && ids.has(late.id));
  } finally { tmp.cleanup(); }
});

test('teams: derived from the tree (leads with 2+ reports; the rest share one board); teams.yaml overrides; board columns', () => {
  const { wp, tmp } = testWorkplace();
  try {
    withTree(wp);
    const t = ist('2026-11-09');
    const teams = sprints.teams(wp);
    const ids = teams.map(x => x.id);
    assert.ok(ids.includes('dev'), 'dev leads arjun and sameer');
    assert.ok(ids.includes('nikhil'), 'nikhil leads zoya and aditi');
    assert.ok(ids.includes('small'));
    assert.ok(!ids.includes('mira'), 'mira has one report: on the shared board');
    assert.ok(teams.find(x => x.id === 'small')!.memberIds.includes('ira'));
    assert.ok(!teams.some(x => x.memberIds.includes('asha')), 'the Chief of Staff is cross-team');

    const { epic } = planned(wp, t, 'Team epic', '2026-11-14');
    const todo = items.create(wp, { level: 'story', parentId: epic.id, title: 'todo', assigneeId: 'arjun' }, 'asha');
    const prog = items.create(wp, { level: 'story', parentId: epic.id, title: 'prog', assigneeId: 'sameer' }, 'asha');
    items.update(wp, prog.id, { status: 'in-progress', reason: 'test: start' }, 'sameer');
    const board: TeamBoard = sprints.teamBoard(wp, 'dev', t);
    assert.ok(board.columns.todo.some(i => i.id === todo.id));
    assert.ok(board.columns.progress.some(i => i.id === prog.id));
    assert.throws(() => sprints.teamBoard(wp, 'nope', t), /team/i);

    writeFileSync(join(wp.config.workplaceDir, 'teams.yaml'), '- id: experts\n  name: Experts\n  leads: [mira]\n- id: dev\n  name: Conversation\n  leads: [dev]\n');
    const over = sprints.teams(wp);
    assert.deepEqual(over.map(x => x.id), ['experts', 'dev']);
    assert.deepEqual(over[0]!.memberIds.sort(), ['ira', 'mira']);
  } finally { tmp.cleanup(); }
});

test('epic detail: blocked stories first, then open, then done; dates included', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const t = ist('2026-11-09');
    const { epic } = planned(wp, t, 'Detail', '2026-11-14');
    const done = items.create(wp, { level: 'story', parentId: epic.id, title: 'done', assigneeId: 'dev' }, 'asha');
    items.update(wp, done.id, { status: 'done', resolution: 'done', reason: 'test: done' }, 'owner');
    const open = items.create(wp, { level: 'story', parentId: epic.id, title: 'open', assigneeId: 'dev' }, 'asha');
    const blk = items.create(wp, { level: 'story', parentId: epic.id, title: 'blocked', assigneeId: 'dev' }, 'asha');
    items.update(wp, blk.id, { status: 'blocked', blockedReason: 'AWS quota', waitingOn: 'external', reason: 'test: blocked' }, 'dev');
    const d: EpicDetail = sprints.epic(wp, epic.id, t);
    assert.deepEqual(d.stories.map(s => s.id), [blk.id, open.id, done.id]);
    assert.equal(d.dates.length, 1);
    assert.throws(() => sprints.epic(wp, 'as_nope', t), /No planned epic|not found/i);
  } finally { tmp.cleanup(); }
});

test('routes: owner and COO write; any other actor header is 403; writes emit sprint.changed; tracked is readable', async () => {
  const tmp = tmpWorkplace();
  tmp.db.close();
  mkdirSync(join(tmp.dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(tmp.dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-test\n');
  const fake = installFakeRuntime();
  const config = loadConfig(['--no-open', '--no-telegram', '--no-seed', '--port', '0'], {
    IRIS_WORKPLACE_DIR: tmp.dir, IRIS_OPS_DIR: join(tmp.dir, 'ops'), IRIS_WORK_DIR: tmp.workDir, WORKPLACE_CAP_INR: '1000', WORKPLACE_USD_INR: '88',
  });
  const running = await start(config);
  const address = running.server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const events: string[] = [];
  const stopListen = running.wp.on(e => { events.push(e.type); });
  const call = async <T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() as T };
  };
  try {
    const f = await call<Feature>('POST', '/api/sprint/features', { title: 'Phone Agent R1', dueDate: '2026-11-20' });
    assert.equal(f.status, 201);
    assert.ok(events.includes('sprint.changed'));
    const e = await call<PlannedEpic>('POST', '/api/sprint/epics', { title: 'Home screen listens', featureId: f.body.id, dueDate: '2026-11-13', sprint: 'current' }, { 'x-workplace-actor': 'coo' });
    assert.equal(e.status, 201);
    const refused = await call<{ error: string }>('POST', `/api/sprint/epics/${e.body.id}`, { planState: 'parked' }, { 'x-workplace-actor': 'kabir' });
    assert.equal(refused.status, 403);
    const moved = await call<PlannedEpic>('POST', `/api/sprint/epics/${e.body.id}`, { planState: 'backlog' });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.planState, 'backlog');
    const backlog = await call<BacklogView>('GET', '/api/sprint/backlog');
    assert.equal(backlog.status, 200);
    assert.ok(backlog.body.backlog.some(x => x.id === e.body.id));
    for (const path of ['/api/sprint/today', '/api/sprint/current', '/api/sprint/review', '/api/sprint/teams', '/api/sprint/features', `/api/sprint/features/${f.body.id}`, `/api/sprint/epics/${e.body.id}`, '/api/sprint/tracked']) {
      const r = await call<unknown>('GET', path);
      assert.equal(r.status, 200, path);
    }
    const bad = await call<{ error: string }>('POST', `/api/sprint/epics/${e.body.id}`, { dueDate: '2026-11-14' });
    assert.equal(bad.status, 400, 'a changed date needs a reason');
  } finally {
    stopListen();
    await running.stop();
    fake.restore();
    tmp.cleanup();
  }
});
