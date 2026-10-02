import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Activity, WorkItem } from '@jkj/shared';
import * as work from '../src/services/work.js';
import * as trail from '../src/services/trail.js';
import * as room from '../src/services/room.js';
import { migrateV2 } from '../src/services/migrate-v2.js';
import { newId, rowsJson } from '../src/services/store.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * QA, 2 Oct (Android): nine activity rows (and the matching history entries) were authored
 * `chief-of-staff` — a charter id, not a person — so the apps showed no name or avatar. RCA:
 * `work.decompose`'s default author was the charter id (the owner's POST /api/features/:id/decompose
 * passes none). Authors are employee ids; the boot migration fixes old rows idempotently.
 */

function specced(wp: ReturnType<typeof testWorkplace>['wp']) {
  const f = work.create(wp, { kind: 'feature', title: 'Phone→Mac errand flow', body: 'x', platformIds: ['ios', 'android', 'mac'], requirementIds: ['REQ-CROSSDEVICE-02'] });
  work.transition(wp, f.id, { to: 'specced', by: 'asha', spec: 'AC1' });
  return f;
}

test('decompose with no author records the Chief of Staff by her employee id, never the charter id', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const f = specced(wp);
    const { feature, assignments } = work.decompose(wp, f.id, { paths: ['iris:services/agent-svc/phone.py'] });
    const authors = new Set([...trail.activityFor(wp, feature.id), ...assignments.flatMap(a => trail.activityFor(wp, a.id))].map(a => a.by));
    assert.ok(!authors.has('chief-of-staff'), [...authors].join(','));
    assert.ok(authors.has('asha'));
    assert.ok(!work.get(wp, feature.id)!.history.some(h => h.by === 'chief-of-staff'));
  } finally {
    tmp.cleanup();
  }
});

test('any write authored by a charter id is recorded under the employee who holds it', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const a = work.create(wp, { kind: 'assignment', title: 'A', body: 'x', employeeId: 'dev', by: 'chief-of-staff' });
    assert.equal(work.get(wp, a.id)!.history[0]!.by, 'asha');
    assert.equal(trail.record(wp, { itemId: a.id, by: 'chief-of-staff', kind: 'note', text: 'x' }).by, 'asha');
    assert.equal(trail.comment(wp, a.id, { by: 'chief-of-staff', text: 'x' }).by, 'asha');
    room.ensureGeneral(wp);
    assert.equal(room.post(wp, room.GENERAL_THREAD_ID, { by: 'chief-of-staff', text: 'x' }).by, 'asha');
    // People and the system keep their ids.
    for (const by of ['owner', 'coo', 'workplace', 'dev']) assert.equal(trail.record(wp, { itemId: a.id, by, kind: 'note', text: 'x' }).by, by);
  } finally {
    tmp.cleanup();
  }
});

test('the boot migration rewrites old charter-id authors to the employee id, idempotently', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const a = work.create(wp, { kind: 'assignment', title: 'A', body: 'x', employeeId: 'dev' });
    // As the live rows were written on 28 Sep.
    const row = work.get(wp, a.id)!;
    wp.db.prepare('update work set json = ? where id = ?').run(JSON.stringify({ ...row, history: [{ ...row.history[0]!, by: 'chief-of-staff' }] }), a.id);
    const act: Activity = { id: newId('act'), at: new Date().toISOString(), itemId: a.id, by: 'chief-of-staff', kind: 'status', to: 'proposed', text: 'created → proposed' };
    wp.db.prepare('insert into activity (id, at, item_id, by, kind, json) values (?, ?, ?, ?, ?, ?)').run(act.id, act.at, act.itemId, act.by, act.kind, JSON.stringify(act));

    migrateV2(wp);
    const rows = rowsJson<Activity>(wp.db.prepare('select json from activity where id = ?').all(act.id));
    assert.equal(rows[0]!.by, 'asha');
    assert.equal((wp.db.prepare('select by from activity where id = ?').get(act.id) as { by: string }).by, 'asha', 'the column too');
    assert.equal(rowsJson<WorkItem>(wp.db.prepare('select json from work where id = ?').all(a.id))[0]!.history[0]!.by, 'asha');
    assert.equal((wp.db.prepare("select count(*) as n from activity where by = 'chief-of-staff'").get() as { n: number }).n, 0);

    const before = wp.db.prepare('select json from activity order by seq').all();
    migrateV2(wp);
    assert.deepEqual(wp.db.prepare('select json from activity order by seq').all(), before, 'a second boot changes nothing');
  } finally {
    tmp.cleanup();
  }
});
