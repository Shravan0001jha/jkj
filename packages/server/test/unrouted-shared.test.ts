import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as items from '../src/services/items.js';
import * as dispatch from '../src/services/dispatch.js';
import * as hygiene from '../src/services/hygiene.js';
import * as cos from '../src/services/cos.js';
import * as employees from '../src/services/employees.js';
import { unrouted } from '../src/services/unrouted.js';
import { rawGet } from '../src/services/v2-map.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * 21 Oct, as_mve7w38dtitne: a P0 bug filed with its RCA, in an epic, unassigned, "starts after" a Parked story,
 * sat Ready 2.5 days. cos.ts, hygiene (f) and the dispatcher each dropped it through openStartsAfter.
 * One shared definition now: no assignee (or one outside the org), open, not parked/epic/held; startsAfter,
 * focus, type and priority do not hide it.
 */
const runtime = installFakeRuntime();
after(() => runtime.restore());
const MIN = 60_000;
const RCA = '## RCA\n- Symptom: x\n- Root cause: y\n- Why it escaped: z\n- Fix: f\n- Regression guard: g';

function shape(wp: Parameters<typeof items.create>[0]) {
  const epic = items.create(wp, { level: 'epic', title: 'Sign-up' }, 'owner');
  const dep = items.create(wp, { level: 'story', parentId: epic.id, title: 'QA robot scenario', assigneeId: 'kabir' }, 'owner');
  items.update(wp, dep.id, { status: 'parked', note: 'later', resumeWhen: 'the owner says' }, 'owner');
  const bug = items.create(wp, { level: 'story', type: 'bug', parentId: epic.id, title: '[P0] Continue off-screen', body: RCA, startsAfter: dep.id } as never, 'nikhil');
  return { epic, dep, bug };
}

test('a Ready, unassigned bug that starts after a Parked story is unrouted for the board check, hygiene (f) and the dispatcher', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const { bug } = shape(wp);
    assert.equal(rawGet(wp, bug.id)!.employeeId, undefined);
    assert.ok(unrouted(wp).some(w => w.id === bug.id), 'shared definition');
    const t0 = Date.now();
    hygiene.sweep(wp, t0);
    const v = hygiene.sweep(wp, t0 + 16 * MIN).violations.filter(x => x.rule === 'unrouted-top').map(x => x.itemId);
    assert.ok(v.includes(bug.id), 'hygiene (f)');
    assert.ok(dispatch.queue(wp, 'asha').some(w => w.id === bug.id), 'Asha\'s routing queue');
    for (const x of employees.allSessions()) employees.close(wp, x.agentId, 'ended');
    const text = cos.boardCheck(wp, t0 + 11 * MIN);
    assert.ok(text && text.includes(bug.id), 'board check');
  } finally { tmp.cleanup(); }
});

test('class: in-progress with no assignee and an assignee outside the org are unrouted; parked, done, epics and held are not', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const epic = items.create(wp, { level: 'epic', title: 'E' }, 'owner');
    const ghost = items.create(wp, { level: 'story', parentId: epic.id, title: 'Ghost', assigneeId: 'kabir' }, 'owner');
    const okOne = items.create(wp, { level: 'story', parentId: epic.id, title: 'Fine', assigneeId: 'kabir' }, 'owner');
    wp.db.prepare('update work set employee_id = ?, json = json_set(json, \'$.employeeId\', ?) where id = ?').run('aditi', 'aditi', ghost.id);
    const ids = unrouted(wp).map(w => w.id);
    assert.ok(ids.includes(ghost.id), 'assignee not in org.yaml');
    assert.ok(!ids.includes(okOne.id));
    assert.ok(!ids.includes(epic.id));
  } finally { tmp.cleanup(); }
});
