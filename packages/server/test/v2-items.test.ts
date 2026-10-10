import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Evidence } from '@jkj/shared';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as trail from '../src/services/trail.js';
import * as areas from '../src/services/areas.js';
import * as room from '../src/services/room.js';
import * as inbox from '../src/services/inbox.js';
import { testWorkplace } from './fakes/workplace.js';

/** v2 work model (LLD §19.2–19.4): the tree, the six states, activity, updates, named room lines. */

const evidence: Evidence = { tests: { passed: 3, failed: 0 }, commits: ['abc123'], liveVerified: [], notVerified: [] };

function tree(wp: ReturnType<typeof testWorkplace>['wp'], opts: { areaId?: string } = {}) {
  const epic = items.create(wp, { level: 'epic', title: 'Iris works while music plays', ownerId: 'asha', ...(opts.areaId ? { areaId: opts.areaId } : {}) }, 'owner');
  const story = items.create(wp, { level: 'story', parentId: epic.id, title: 'Mic stays live at volume 0', assigneeId: 'dev', points: 3, acceptance: ['AC1 mic gate stays open', 'AC2 no echo'] }, 'asha');
  const task = items.create(wp, { level: 'task', parentId: story.id, title: 'Keep the mic gate open during set_volume', assigneeId: 'dev' }, 'dev');
  return { epic, story, task };
}

test('epics, stories and tasks share one shape; the tree resolves; fields are validated', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { epic, story, task } = tree(wp);
    assert.equal(epic.level, 'epic');
    assert.equal(epic.legacy.kind, 'feature', 'an epic is a feature underneath (the old routes still see it)');
    assert.equal(epic.status, 'ready');
    assert.equal(epic.ownerId, 'asha');
    assert.equal(story.level, 'story');
    assert.equal(story.legacy.kind, 'assignment');
    assert.equal(story.legacy.featureId, epic.id, 'the old feature roll-up and pivot still count it');
    assert.equal(story.points, 3);
    assert.deepEqual(story.acceptance, ['AC1 mic gate stays open', 'AC2 no echo']);
    assert.equal(story.status, 'ready');
    assert.equal(story.assigneeId, 'dev');
    const t = items.require$(wp, task.id);
    assert.equal(t.parentId, story.id);
    assert.equal(t.epicId, epic.id);
    assert.equal(items.require$(wp, epic.id).epicId, epic.id);

    const second = items.create(wp, { level: 'story', parentId: epic.id, title: 'Volume ducking', assigneeId: 'mira' }, 'asha');
    assert.ok(second.rank > story.rank, 'new siblings append in rank order');

    assert.throws(() => items.create(wp, { level: 'story', parentId: epic.id, title: 'x', points: 4 as never }, 'asha'), /points/i);
    assert.throws(() => items.create(wp, { level: 'task', title: 'orphan task' }, 'dev'), /parent/i);
    assert.throws(() => items.create(wp, { level: 'story', parentId: task.id, title: 'story under a task' }, 'asha'), /parent/i);
    assert.throws(() => items.create(wp, { level: 'story', parentId: epic.id, title: 'x', assigneeId: 'nobody' }, 'asha'), /No employee/);
    assert.throws(() => items.create(wp, { level: 'story', parentId: epic.id, title: '   ' }, 'asha'), /title/i);

    const mine = items.create(wp, { level: 'story', parentId: epic.id, title: 'Test on your iPhone', assigneeId: 'owner' }, 'asha');
    assert.equal(mine.assigneeId, 'owner', 'the owner can be an assignee');
  } finally {
    tmp.cleanup();
  }
});

test('the six states: reviewer to enter review, reason and waiting-on to block, never done by the assignee, reopen needs a note', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { story } = tree(wp);
    let s = items.update(wp, story.id, { status: 'in-progress' }, 'dev');
    assert.equal(s.status, 'in-progress');
    assert.throws(() => items.update(wp, story.id, { status: 'in-review' }, 'dev'), /reviewer/i);
    assert.throws(() => items.update(wp, story.id, { status: 'in-review', reviewerId: 'dev' }, 'dev'), /assignee/i);
    s = items.update(wp, story.id, { status: 'in-review', reviewerId: 'nikhil' }, 'dev');
    assert.equal(s.status, 'in-review');
    assert.equal(s.reviewerId, 'nikhil');
    assert.equal(s.legacy.state, 'review');
    assert.throws(() => items.update(wp, story.id, { status: 'done' }, 'dev'), /reviewer|assignee/i);
    s = items.update(wp, story.id, { status: 'done' }, 'nikhil');
    assert.equal(s.status, 'done');
    assert.equal(s.resolution, 'done');
    assert.equal(s.legacy.state, 'done');

    assert.throws(() => items.update(wp, story.id, { status: 'in-progress' }, 'owner'), /note/i, 'a reopen says why');
    s = items.update(wp, story.id, { status: 'in-progress', note: 'echo is back on the iPad' }, 'owner');
    assert.equal(s.status, 'in-progress');
    assert.equal(s.resolution, undefined);
    assert.ok(trail.activityFor(wp, story.id).some(a => a.kind === 'reopen' && /iPad/.test(a.text)));

    assert.throws(() => items.update(wp, story.id, { status: 'blocked' }, 'dev'), /reason/i);
    assert.throws(() => items.update(wp, story.id, { status: 'blocked', blockedReason: 'needs the Speaker API' }, 'dev'), /waiting/i);
    assert.throws(() => items.update(wp, story.id, { status: 'blocked', blockedReason: 'x', waitingOn: 'nobody' }, 'dev'), /waiting/i);
    s = items.update(wp, story.id, { status: 'blocked', blockedReason: 'needs the Speaker API', waitingOn: 'external' }, 'dev');
    assert.deepEqual({ reason: s.blocked?.reason, waitingOn: s.blocked?.waitingOn }, { reason: 'needs the Speaker API', waitingOn: 'external' });
    assert.equal(s.legacy.state, 'blocked');
    s = items.update(wp, story.id, { status: 'in-progress' }, 'dev');
    assert.equal(s.blocked, undefined, 'leaving blocked clears the reason');

    const other = items.create(wp, { level: 'story', parentId: s.parentId!, title: 'Never started', assigneeId: 'mira' }, 'asha');
    assert.throws(() => items.update(wp, other.id, { status: 'in-review', reviewerId: 'nikhil' }, 'owner'), /cannot go from ready to in-review/);
    assert.throws(() => items.update(wp, other.id, { status: 'done' }, 'asha'), /owner/i, 'closing unstarted work is the owner\'s call');
    const closed = items.update(wp, other.id, { status: 'done', resolution: 'wont-do', note: 'superseded' }, 'owner');
    assert.equal(closed.resolution, 'wont-do');
    assert.equal(closed.legacy.state, 'rejected');
    const parked = items.create(wp, { level: 'story', parentId: s.parentId!, title: 'Later', assigneeId: 'mira', status: 'backlog' }, 'asha');
    assert.equal(parked.status, 'backlog');
    assert.equal(parked.legacy.state, 'proposed');
  } finally {
    tmp.cleanup();
  }
});

test('blocked on the owner goes to his Inbox with the recommendation; unblocking withdraws it', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { story } = tree(wp);
    items.update(wp, story.id, { status: 'in-progress' }, 'dev');
    items.update(wp, story.id, { status: 'blocked', blockedReason: 'which TTS voice ships?', waitingOn: 'owner', recommendation: 'Keep the current voice' }, 'dev');
    const open = inbox.ownerList(wp, 'open').filter(i => i.context['itemId'] === story.id);
    assert.equal(open.length, 1);
    assert.match(open[0]!.body, /Keep the current voice/);
    items.update(wp, story.id, { status: 'in-progress' }, 'dev');
    assert.equal(inbox.ownerList(wp, 'open').filter(i => i.context['itemId'] === story.id).length, 0);
  } finally {
    tmp.cleanup();
  }
});

test('the old engine keeps both views in step; report_done gets a default reviewer; an old block names its reason', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { epic, story } = tree(wp);
    // An old-style assignment under the feature: proposed → planned → review via report_done.
    const a = work.create(wp, { kind: 'assignment', title: 'Old path story', body: 'x', employeeId: 'mira', featureId: epic.id });
    assert.equal(a.status, 'ready');
    assert.equal(a.level, 'story');
    assert.equal(a.parentId, epic.id);
    assert.equal(a.history[0]!.by, 'workplace', 'nothing is attributed to the owner that he did not do');
    work.attachPlan(wp, a.id, '1. do it', 'mira');
    assert.equal(work.get(wp, a.id)!.status, 'in-progress');
    work.reportDone(wp, a.id, evidence, 'mira');
    const reviewed = work.get(wp, a.id)!;
    assert.equal(reviewed.status, 'in-review');
    assert.equal(reviewed.reviewerId, 'nikhil', 'QA reviews a lead\'s story');

    const q = work.create(wp, { kind: 'assignment', title: 'QA\'s own story', body: 'x', employeeId: 'nikhil', featureId: epic.id });
    work.attachPlan(wp, q.id, 'plan', 'nikhil');
    work.reportDone(wp, q.id, evidence, 'nikhil');
    assert.equal(work.get(wp, q.id)!.reviewerId, 'asha', 'nobody reviews their own work');

    const t = items.create(wp, { level: 'task', parentId: story.id, title: 'Mira helps', assigneeId: 'mira' }, 'dev');
    work.attachPlan(wp, t.id, 'plan', 'mira');
    work.reportDone(wp, t.id, evidence, 'mira');
    assert.equal(work.get(wp, t.id)!.reviewerId, 'dev', 'a task is reviewed by its story\'s assignee');

    const b = work.create(wp, { kind: 'assignment', title: 'Old block', body: 'x', employeeId: 'kabir' });
    work.transition(wp, b.id, { to: 'blocked', by: 'workplace', note: 'spend cap reached' });
    const blocked = items.require$(wp, b.id);
    assert.equal(blocked.status, 'blocked');
    assert.deepEqual({ reason: blocked.blocked?.reason, waitingOn: blocked.blocked?.waitingOn }, { reason: 'spend cap reached', waitingOn: 'coo' });
    work.transition(wp, b.id, { to: 'rejected', by: 'owner' });
    assert.equal(items.require$(wp, b.id).status, 'done');
    assert.equal(items.require$(wp, b.id).resolution, 'wont-do');
  } finally {
    tmp.cleanup();
  }
});

test('reassigning, re-reviewing and re-pointing are activity; every change has a row', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { story } = tree(wp);
    items.update(wp, story.id, { assigneeId: 'mira', reviewerId: 'nikhil', points: 5, title: 'Mic stays live at any volume' }, 'asha');
    const s = items.require$(wp, story.id);
    assert.equal(s.assigneeId, 'mira');
    assert.equal(s.legacy.charterId, 'experts', 'the charter follows the new assignee');
    assert.equal(s.points, 5);
    const kinds = trail.activityFor(wp, story.id).map(a => a.kind);
    for (const k of ['created', 'assigned', 'reviewer', 'points', 'field']) assert.ok(kinds.includes(k as never), `has ${k}`);
    const assigned = trail.activityFor(wp, story.id).find(a => a.kind === 'assigned')!;
    assert.deepEqual([assigned.from, assigned.to, assigned.by], ['dev', 'mira', 'asha']);
    assert.throws(() => items.update(wp, story.id, { points: 7 as never }, 'asha'), /points/i);
    items.update(wp, story.id, { points: null }, 'asha');
    assert.equal(items.require$(wp, story.id).points, undefined);
  } finally {
    tmp.cleanup();
  }
});

test('start, block, unblock and ship are one-line updates with names, and named lines in the epic\'s room thread — never counts', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const area = areas.create(wp, { title: 'Voice & audio' }, 'owner');
    const { epic, story } = tree(wp, { areaId: area.id });
    items.update(wp, story.id, { status: 'in-progress' }, 'dev');
    let feed = trail.updates(wp);
    assert.equal(feed[0]!.kind, 'started');
    assert.equal(feed[0]!.line, 'Started: Mic stays live at volume 0 — Dev, 3 pts');
    assert.equal(feed[0]!.push, true);
    assert.equal(feed[0]!.href, `item/${story.id}`);
    assert.equal(feed[0]!.itemId, story.id);

    const thread = room.getThread(wp, `th_epic_${epic.id}`)!;
    assert.ok(thread, 'the epic has a thread in its area room');
    assert.equal(thread.roomId, `area:${area.id}`);
    assert.equal(thread.epicId, epic.id);
    let last = room.messages(wp, thread.id).at(-1)!;
    assert.equal(last.by, 'workplace');
    assert.equal(last.kind, 'update');
    assert.equal(last.text, "Story 'Mic stays live at volume 0' started — Dev");

    items.update(wp, story.id, { status: 'blocked', blockedReason: 'needs the Speaker API', waitingOn: 'external' }, 'dev');
    feed = trail.updates(wp);
    assert.equal(feed[0]!.line, 'Blocked: Mic stays live at volume 0 — waiting on someone outside the team: needs the Speaker API');
    assert.equal(feed[0]!.push, true);
    assert.equal(room.messages(wp, thread.id).at(-1)!.text, "Story 'Mic stays live at volume 0' is blocked: waiting on someone outside the team");
    items.update(wp, story.id, { status: 'in-progress' }, 'dev');
    assert.equal(trail.updates(wp)[0]!.line, 'Unblocked: Mic stays live at volume 0 — Dev');
    items.update(wp, story.id, { status: 'in-review', reviewerId: 'nikhil' }, 'dev');
    items.update(wp, story.id, { status: 'done' }, 'nikhil');
    feed = trail.updates(wp);
    assert.equal(feed[0]!.kind, 'shipped');
    assert.equal(feed[0]!.line, 'Shipped: Mic stays live at volume 0 — Dev, 3 pts');
    assert.equal(feed[0]!.push, false, 'shipped is feed-only (owner\'s choice: push on start and block)');
    last = room.messages(wp, thread.id).at(-1)!;
    assert.equal(last.text, "Story 'Mic stays live at volume 0' is done");
    for (const m of room.messages(wp, thread.id)) assert.doesNotMatch(m.text, /^\d+\s/, 'never a bare count');
    assert.equal(trail.updates(wp, { limit: 2 }).length, 2);
    const before = trail.updates(wp, { before: feed[0]!.id });
    assert.equal(before[0]!.id, feed[1]!.id);
  } finally {
    tmp.cleanup();
  }
});

test('epic progress is points done over points total; the plan groups epics by area with flags, focus, mine and a board', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const area = areas.create(wp, { title: 'Voice & audio' }, 'owner');
    const { epic, story } = tree(wp, { areaId: area.id });
    const s5 = items.create(wp, { level: 'story', parentId: epic.id, title: 'Duck music under speech', assigneeId: 'mira', points: 5 }, 'asha');
    items.create(wp, { level: 'story', parentId: epic.id, title: 'Unpointed', assigneeId: 'kabir' }, 'asha');
    const dropped = items.create(wp, { level: 'story', parentId: epic.id, title: 'Dropped', assigneeId: 'kabir', points: 8 }, 'asha');
    items.update(wp, dropped.id, { status: 'done', resolution: 'wont-do' }, 'owner');
    items.update(wp, story.id, { status: 'in-progress' }, 'dev');
    items.update(wp, story.id, { status: 'in-review', reviewerId: 'nikhil' }, 'dev');
    items.update(wp, story.id, { status: 'done' }, 'nikhil');
    items.update(wp, s5.id, { status: 'in-progress' }, 'mira');
    items.update(wp, s5.id, { status: 'blocked', blockedReason: 'no ducking API on macOS 15', waitingOn: 'external' }, 'mira');
    const loose = items.create(wp, { level: 'epic', title: 'Unfiled epic' }, 'owner');
    const mine = items.create(wp, { level: 'story', parentId: loose.id, title: 'Approve the 0.2.16 release', assigneeId: 'owner' }, 'asha');

    assert.deepEqual(items.progress(wp, epic.id), { pointsDone: 3, pointsTotal: 8, storiesDone: 1, storiesTotal: 3, pct: 38 });

    items.setFocus(wp, [epic.id], 'owner');
    const plan = items.plan(wp);
    assert.equal(plan.areas.length, 1);
    assert.equal(plan.areas[0]!.area.title, 'Voice & audio');
    const card = plan.areas[0]!.epics[0]!;
    assert.equal(card.epic.id, epic.id);
    assert.equal(card.inFocus, true);
    assert.equal(card.progress.pct, 38);
    assert.deepEqual(card.next, { id: s5.id, title: 'Duck music under speech' });
    assert.deepEqual(card.flags.map(f => [f.kind, f.title, f.reason, f.waitingOn]), [['blocked', 'Duck music under speech', 'no ducking API on macOS 15', 'external']]);
    assert.deepEqual(plan.unfiled.map(c => c.epic.id), [loose.id]);
    assert.deepEqual(plan.mine.map(i => i.id), [mine.id]);
    assert.deepEqual(plan.focus.epicIds, [epic.id]);
    assert.equal(plan.counts.blocked, 1);
    assert.equal(plan.board, undefined);
    const board = items.plan(wp, 'board').board!;
    assert.ok(board.blocked.some(i => i.id === s5.id));
    assert.ok(board.ready.some(i => i.id === mine.id));
    assert.throws(() => items.setFocus(wp, [story.id], 'owner'), /epic/i);
  } finally {
    tmp.cleanup();
  }
});

test('merging a duplicate keeps its history as a comment on the survivor and moves its tasks; nothing is deleted', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { epic } = tree(wp);
    const a = items.create(wp, { level: 'story', parentId: epic.id, title: 'Greeting context contract', assigneeId: 'dev' }, 'asha');
    const b = items.create(wp, { level: 'story', parentId: epic.id, title: 'Greeting context contract (Mira)', assigneeId: 'mira' }, 'mira');
    const t = items.create(wp, { level: 'task', parentId: b.id, title: 'Write the schema', assigneeId: 'mira' }, 'mira');
    items.update(wp, b.id, { status: 'in-progress' }, 'mira');
    const survivor = items.merge(wp, b.id, a.id, 'coo');
    assert.equal(survivor.id, a.id);
    const merged = items.require$(wp, b.id);
    assert.equal(merged.status, 'done');
    assert.equal(merged.resolution, 'duplicate');
    assert.equal(merged.mergedInto, a.id);
    assert.equal(items.require$(wp, t.id).parentId, a.id);
    const note = trail.comments(wp, a.id).find(c => c.by === 'workplace')!;
    assert.match(note.text, /Merged .*Greeting context contract \(Mira\)/);
    assert.match(note.details ?? '', /ready → in-progress/);
    assert.throws(() => items.merge(wp, a.id, a.id, 'coo'), /itself/);
    assert.ok(work.get(wp, b.id), 'still there');
  } finally {
    tmp.cleanup();
  }
});

test('comments carry mentions; an agent comment is stored whole (rework W3: capped at 1200, never cut)', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { story } = tree(wp);
    const c = trail.comment(wp, story.id, { by: 'owner', text: '@dev can this land before Friday?' });
    assert.deepEqual(c.mentions, ['dev']);
    const long = Array.from({ length: 8 }, (_, i) => `line ${i + 1} of the analysis`).join('\n');
    const d = trail.comment(wp, story.id, { by: 'dev', text: long });
    assert.equal(d.text, long, 'stored whole, no "…"');
    assert.equal(d.details, undefined);
    assert.throws(() => trail.comment(wp, story.id, { by: 'dev', text: 'x'.repeat(1201) }), /capped at 1200 characters/);
    const o = trail.comment(wp, story.id, { by: 'owner', text: long });
    assert.equal(o.text, long, 'the owner\'s words are never shortened');
    assert.ok(trail.activityFor(wp, story.id).some(a => a.kind === 'comment'));
    assert.throws(() => trail.comment(wp, 'as_nope', { by: 'owner', text: 'x' }), /No item/);
  } finally {
    tmp.cleanup();
  }
});

test('an epic is in progress once any of its stories is, by either engine', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { epic, story } = tree(wp);
    assert.equal(items.require$(wp, epic.id).status, 'ready');
    items.update(wp, story.id, { status: 'in-progress' }, 'dev');
    assert.equal(items.require$(wp, epic.id).status, 'in-progress');
    assert.ok(trail.activityFor(wp, epic.id).some(a => a.kind === 'status' && a.to === 'in-progress'));
    const other = items.create(wp, { level: 'epic', title: 'Old-path epic' }, 'owner');
    const a = work.create(wp, { kind: 'assignment', title: 'Old path', body: 'x', employeeId: 'mira', featureId: other.id });
    work.attachPlan(wp, a.id, 'plan', 'mira');
    assert.equal(items.require$(wp, other.id).status, 'in-progress');
  } finally {
    tmp.cleanup();
  }
});

test('Plan order: needs the owner, then live work, then focus not started, then the rest, finished last', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const mk = (title: string) => items.create(wp, { level: 'epic', title }, 'owner');
    const idle = mk('Idle, not in focus');
    const done = mk('Finished');
    const fin = items.create(wp, { level: 'story', parentId: done.id, title: 'only story', assigneeId: 'kabir' }, 'asha');
    items.update(wp, fin.id, { status: 'in-progress' }, 'kabir');
    items.update(wp, fin.id, { status: 'in-review', reviewerId: 'nikhil' }, 'kabir');
    items.update(wp, fin.id, { status: 'done' }, 'nikhil');
    const focused = mk('In focus, not started');
    items.create(wp, { level: 'story', parentId: focused.id, title: 'ready story', assigneeId: 'mira' }, 'asha');
    const live = mk('In progress');
    const s = items.create(wp, { level: 'story', parentId: live.id, title: 'working', assigneeId: 'dev' }, 'asha');
    items.update(wp, s.id, { status: 'in-progress' }, 'dev');
    const needs = mk('Needs the owner');
    const b = items.create(wp, { level: 'story', parentId: needs.id, title: 'waiting on owner', assigneeId: 'tara' }, 'asha');
    items.update(wp, b.id, { status: 'in-progress' }, 'tara');
    items.update(wp, b.id, { status: 'blocked', blockedReason: 'needs the Samsung', waitingOn: 'owner' }, 'tara');
    items.setFocus(wp, [focused.id], 'owner');
    assert.deepEqual(items.plan(wp).unfiled.map(c => c.epic.title).filter(t => t !== 'Iris works while music plays'),
      ['Needs the owner', 'In progress', 'In focus, not started', 'Idle, not in focus', 'Finished']);
  } finally {
    tmp.cleanup();
  }
});
