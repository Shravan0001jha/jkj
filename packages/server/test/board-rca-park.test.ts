import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import { rawGet } from '../src/services/v2-map.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * Board bug 1 (19 Oct, as_mve83mird4wvh): Tara parked her story 34 s after its session started; 6 s
 * later her session's first "## Plan" reply was captured (work.attachPlan), the old engine moved
 * proposed → planned, and its old → v2 map turned that into In progress, over her Parked. The map
 * predates Waiting and Parked: recording a plan, or the old engine's start move, is not a status move
 * and never lifts a status a person set.
 */

type Wp = ReturnType<typeof testWorkplace>['wp'];
function story(wp: Wp, assigneeId = 'kabir') {
  const epic = items.create(wp, { level: 'epic', title: 'Phone without a Mac' }, 'owner');
  return items.create(wp, { level: 'story', parentId: epic.id, title: 'Live ring check on iOS', assigneeId }, 'owner');
}
const status = (wp: Wp, id: string) => rawGet(wp, id)!.status;

test('a parked story stays parked when the session\'s "## Plan" reply is captured after the park (as_mve83mird4wvh)', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const s = story(wp);
    items.markStarted(wp, s.id, 'workplace');
    items.update(wp, s.id, { status: 'parked', note: 'no Mac attached', resumeWhen: 'a Mac is attached' }, 'kabir');
    work.attachPlan(wp, s.id, '1. ring\n2. snooze', 'kabir');
    const w = rawGet(wp, s.id)!;
    assert.equal(w.status, 'parked');
    assert.equal(w.parked?.resumeWhen, 'a Mac is attached');
    assert.equal(w.plan, '1. ring\n2. snooze', 'the plan is still recorded');
  } finally { tmp.cleanup(); }
});

test('class: a Waiting story keeps its wait when its plan is captured', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const s = story(wp);
    items.markStarted(wp, s.id, 'workplace');
    items.update(wp, s.id, { status: 'waiting', waitingOn: 'mira', note: 'which expert owns snooze' }, 'kabir');
    work.attachPlan(wp, s.id, '1. ask Mira', 'kabir');
    assert.equal(status(wp, s.id), 'waiting');
    assert.equal(rawGet(wp, s.id)!.waiting?.on, 'mira');
  } finally { tmp.cleanup(); }
});

test('class: a Ready story (a lead\'s routing session replying "## Plan") is not started by the plan capture', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const s = story(wp);
    work.attachPlan(wp, s.id, '1. give it to Arjun', 'kabir');
    assert.equal(status(wp, s.id), 'ready');
    // A Backlog one neither.
    const b = items.create(wp, { level: 'story', parentId: rawGet(wp, s.id)!.parentId!, title: 'Later', assigneeId: 'kabir', status: 'backlog' }, 'owner');
    work.attachPlan(wp, b.id, '1. later', 'kabir');
    assert.equal(status(wp, b.id), 'backlog');
  } finally { tmp.cleanup(); }
});

test('class: the old engine\'s start move (planned → building) does not lift a park; real moves still move', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const s = story(wp);
    items.markStarted(wp, s.id, 'workplace');
    work.attachPlan(wp, s.id, '1. build', 'kabir');
    assert.equal(rawGet(wp, s.id)!.state, 'planned');
    items.update(wp, s.id, { status: 'parked', note: 'set aside', resumeWhen: 'the owner says' }, 'kabir');
    // A park sets the old state back to proposed; force the planned → building move the way a session start does.
    work.saveQuiet(wp, { ...rawGet(wp, s.id)!, state: 'planned' });
    work.transition(wp, s.id, { to: 'building', by: 'kabir' });
    assert.equal(status(wp, s.id), 'parked', 'a start move never lifts a park');

    // Real moves still move: report_done goes to review, a restart's resume of a block goes to In progress.
    const evidence = { tests: { passed: 1, failed: 0 }, commits: ['abc'], liveVerified: [], notVerified: [] };
    work.reportDone(wp, s.id, evidence, 'kabir');
    assert.equal(status(wp, s.id), 'in-review');
    const t = items.create(wp, { level: 'story', parentId: rawGet(wp, s.id)!.parentId!, title: 'Blocked by the restart', assigneeId: 'kabir' }, 'owner');
    items.markStarted(wp, t.id, 'workplace');
    work.transition(wp, t.id, { to: 'blocked', by: 'workplace', note: 'shut down', cause: 'workplace-shutdown' });
    assert.equal(status(wp, t.id), 'blocked');
    work.transition(wp, t.id, { to: 'building', by: 'workplace', note: 'resumed' });
    assert.equal(status(wp, t.id), 'in-progress');
  } finally { tmp.cleanup(); }
});
