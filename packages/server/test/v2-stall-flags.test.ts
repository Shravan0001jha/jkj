import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as items from '../src/services/items.js';
import * as watch from '../src/services/watch.js';
import { humanDuration } from '../src/services/v2-map.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * QA, 2 Oct (Android): a stalled flag on the Plan had no `waitingOn` (blocked flags do) and its reason
 * read "In review for 5760 min, untouched". The flag now names who acts — the COO by default, the
 * assignee once it flagged its own stall — and says the time the way a person would.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function setup(wp: ReturnType<typeof testWorkplace>['wp']) {
  const epic = items.create(wp, { level: 'epic', title: 'Iris during music' }, 'owner');
  const story = items.create(wp, { level: 'story', parentId: epic.id, title: 'Mic stays live', assigneeId: 'dev' }, 'asha');
  return { epic, story };
}

const flagOf = (wp: ReturnType<typeof testWorkplace>['wp'], epicId: string, itemId: string, nowMs: number) =>
  items.plan(wp, undefined, nowMs).unfiled.find(c => c.epic.id === epicId)!.flags.find(f => f.itemId === itemId);

test('human time: minutes, then hours, then days', () => {
  assert.equal(humanDuration(1 * MIN), '1 min');
  assert.equal(humanDuration(45 * MIN), '45 min');
  assert.equal(humanDuration(1 * HOUR + 5 * MIN), '1 hour');
  assert.equal(humanDuration(3 * HOUR), '3 hours');
  assert.equal(humanDuration(47 * HOUR), '47 hours');
  assert.equal(humanDuration(2 * DAY), '2 days');
  assert.equal(humanDuration(4 * DAY + 3 * HOUR), '4 days');
});

test('a stalled flag waits on the COO by default and reads as human time', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { epic, story } = setup(wp);
    items.update(wp, story.id, { status: 'in-progress' }, 'dev');
    const idle = flagOf(wp, epic.id, story.id, Date.now() + 3 * HOUR + MIN)!;
    assert.equal(idle.kind, 'stalled');
    assert.equal(idle.waitingOn, 'coo');
    assert.equal(idle.reason, 'In progress 3 hours, no activity');

    items.update(wp, story.id, { status: 'in-review', reviewerId: 'nikhil' }, 'dev');
    const review = flagOf(wp, epic.id, story.id, Date.now() + 4 * DAY + MIN)!;
    assert.equal(review.reason, 'In review 4 days, untouched');
    assert.equal(review.waitingOn, 'coo');
  } finally {
    tmp.cleanup();
  }
});

test('after the assignee flags its own stall (no one named), the flag waits on the assignee', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { epic, story } = setup(wp);
    items.update(wp, story.id, { status: 'in-progress' }, 'dev');
    watch.flag(wp, story.id, { by: 'dev', reason: 'the Speaker has no one-sentence primitive' });
    const f = flagOf(wp, epic.id, story.id, Date.now() + 2 * HOUR)!;
    assert.equal(f.kind, 'stalled');
    assert.equal(f.waitingOn, 'dev');
    assert.equal(f.reason, 'In progress 2 hours, no activity');
  } finally {
    tmp.cleanup();
  }
});

test('a Ready story not started reads the same way', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { epic, story } = setup(wp);
    const f = flagOf(wp, epic.id, story.id, Date.now() + 90 * MIN)!;
    assert.equal(f.reason, 'Ready 1 hour, not started');
    assert.equal(f.waitingOn, 'coo');
  } finally {
    tmp.cleanup();
  }
});
