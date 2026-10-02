import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkItem, WorkState } from '@jkj/shared';
import { migrateV2 } from '../src/services/migrate-v2.js';
import * as items from '../src/services/items.js';
import * as trail from '../src/services/trail.js';
import * as room from '../src/services/room.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * The one-time, non-destructive migration (HLD D25, LLD §19.11). Rows are written exactly as the
 * pre-v2 server wrote them (no v2 fields), then migrated.
 */

function legacy(wp: ReturnType<typeof testWorkplace>['wp'], id: string, kind: WorkItem['kind'], state: WorkState, extra: Partial<WorkItem> = {}, history?: WorkItem['history']): void {
  const at = extra.createdAt ?? '2026-09-28T10:00:00.000Z';
  const item = {
    id, kind, title: extra.title ?? id, body: 'legacy', state, requirementIds: [], platformIds: [], createdAt: at, updatedAt: extra.updatedAt ?? at,
    history: history ?? [{ at, from: null, to: state, by: 'owner' }], ...extra,
  } as WorkItem;
  wp.db.prepare('insert into work (id, kind, state, charter_id, employee_id, feature_id, session_id, created_at, updated_at, json) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, kind, state, item.charterId ?? null, item.employeeId ?? null, item.featureId ?? null, null, at, item.updatedAt, JSON.stringify(item));
}

test('every legacy row gets a level, a parent, a v2 status and a reason; parked work becomes Backlog; nothing is deleted', () => {
  const { wp, tmp } = testWorkplace();
  try {
    legacy(wp, 'ft_music', 'feature', 'in-progress', { title: 'P0 music fix' });
    legacy(wp, 'ft_new', 'feature', 'stated');
    legacy(wp, 'as_prop', 'assignment', 'proposed', { employeeId: 'dev', featureId: 'ft_music', createdAt: '2026-09-28T10:01:00.000Z' });
    legacy(wp, 'as_plan', 'assignment', 'planned', { employeeId: 'mira', featureId: 'ft_music', createdAt: '2026-09-28T10:02:00.000Z' });
    legacy(wp, 'as_rev', 'assignment', 'review', { employeeId: 'dev', featureId: 'ft_music' });
    legacy(wp, 'as_rev_qa', 'assignment', 'review', { employeeId: 'nikhil' });
    legacy(wp, 'as_parked', 'assignment', 'blocked', { employeeId: 'kabir' }, [
      { at: '2026-09-28T10:00:00.000Z', from: null, to: 'proposed', by: 'owner' },
      { at: '2026-10-02T06:00:00.000Z', from: 'proposed', to: 'blocked', by: 'coo', note: 'parked by COO: focus on P0' },
    ]);
    legacy(wp, 'as_blocked', 'assignment', 'blocked', { employeeId: 'rohan' }, [
      { at: '2026-09-28T10:00:00.000Z', from: null, to: 'building', by: 'owner' },
      { at: '2026-09-29T10:00:00.000Z', from: 'building', to: 'blocked', by: 'workplace', note: 'lost on restart' },
    ]);
    legacy(wp, 'as_bare', 'assignment', 'blocked', { employeeId: 'tara' }, [{ at: '2026-09-28T10:00:00.000Z', from: null, to: 'blocked', by: 'workplace' }]);
    legacy(wp, 'as_rej', 'assignment', 'rejected', { employeeId: 'tara' });
    legacy(wp, 'as_bug', 'bug', 'done', { employeeId: 'tara' });
    const rowsBefore = (wp.db.prepare('select count(*) as n from work').get() as { n: number }).n;
    room.ensureGeneral(wp);
    room.createThread(wp, { title: 'Legacy topic', text: 'hello', by: 'mira' });

    const report = migrateV2(wp);
    assert.equal(report.items, 11);
    assert.equal(report.epics, 2);
    assert.equal(report.stories, 9);
    assert.equal(report.parked, 1);
    assert.equal(report.reviewersSet, 2);
    assert.equal(report.byStatusAfter['backlog'], 1);
    assert.equal(report.byStatusBefore['blocked'], 3);
    assert.equal((wp.db.prepare('select count(*) as n from work').get() as { n: number }).n, rowsBefore, 'nothing deleted');

    const it = (id: string) => items.require$(wp, id);
    assert.deepEqual([it('ft_music').level, it('ft_music').status], ['epic', 'in-progress']);
    assert.equal(it('ft_new').status, 'ready');
    assert.deepEqual([it('as_prop').level, it('as_prop').status, it('as_prop').parentId], ['story', 'ready', 'ft_music']);
    assert.equal(it('as_plan').status, 'in-progress');
    assert.ok(it('as_prop').rank < it('as_plan').rank, 'rank keeps creation order');
    assert.deepEqual([it('as_rev').status, it('as_rev').reviewerId], ['in-review', 'nikhil']);
    assert.equal(it('as_rev_qa').reviewerId, 'asha', 'Nikhil does not review himself');
    assert.equal(it('as_parked').status, 'backlog', 'the COO\'s parked items are Backlog, not Blocked');
    assert.equal(it('as_parked').legacy.state, 'proposed');
    assert.deepEqual(it('as_blocked').blocked && [it('as_blocked').blocked!.reason, it('as_blocked').blocked!.waitingOn], ['lost on restart', 'coo']);
    assert.equal(it('as_bare').blocked?.reason, 'No reason recorded before v2');
    assert.deepEqual([it('as_rej').status, it('as_rej').resolution], ['done', 'wont-do']);
    assert.equal(it('as_bug').legacy.kind, 'bug');
    assert.equal(it('as_bug').status, 'done');

    const acts = trail.activityFor(wp, 'as_blocked');
    assert.deepEqual(acts.map(a => [a.at, a.by, a.to]), [['2026-09-28T10:00:00.000Z', 'owner', 'building'], ['2026-09-29T10:00:00.000Z', 'workplace', 'blocked']]);
    assert.equal(acts[1]!.text, 'lost on restart');
    assert.ok(room.listThreads(wp).every(t => (t.roomId ?? 'general') === 'general'));
    assert.ok(room.getThread(wp, room.RELEASES_THREAD_ID), 'the Releases room exists');

    const again = migrateV2(wp);
    assert.equal(again.items, 0, 'idempotent');
    assert.equal(trail.activityFor(wp, 'as_blocked').length, 2, 'history copied once');
  } finally {
    tmp.cleanup();
  }
});
