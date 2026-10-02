import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EmployeeDetail, OfficeResponse } from '@jkj/shared';
import * as inbox from '../src/services/inbox.js';
import * as work from '../src/services/work.js';
import { boot, call } from './fakes/boot.js';

/**
 * QA, 2 Oct (Android): Asha's page said 21 items need the owner; 20 were housekeeping (stall
 * notices, "Waiting:" notes, review requests) that never reach his Inbox. `needsYou` on an employee
 * page and on its office card counts only what the Inbox shows: open, owner-facing items.
 */

test('needsYou on GET /api/employees/:id and the office cards is the owner-facing open set, the same as the Inbox', async () => {
  const srv = await boot();
  try {
    const wp = srv.running.wp;
    for (const i of inbox.list(wp, 'open')) inbox.expire(wp, i.id, 'test: a clean slate');
    const a = work.create(wp, { kind: 'assignment', title: 'Composer', body: 'x', charterId: 'mobile' });
    const decision = inbox.raise(wp, { kind: 'decision', title: 'Quiet by default?', body: 'x', raisedBy: 'asha', recommendation: 'yes' });
    inbox.raise(wp, { kind: 'question', title: 'Asha is stalled', body: 'x', raisedBy: 'asha', ownerFacing: false });
    inbox.raise(wp, { kind: 'question', title: 'Review requested: Composer', body: 'x', raisedBy: 'nikhil', context: { assignmentId: a.id }, ownerFacing: false });
    const answered = inbox.raise(wp, { kind: 'decision', title: 'Old', body: 'x', raisedBy: 'asha', recommendation: 'yes' });
    inbox.answer(wp, answered.id, 'yes', undefined, 'web');

    const owner = (await call<{ id: string }[]>(srv.base, 'GET', '/api/inbox')).body.filter(i => (i as { state?: string }).state === 'open').map(i => i.id);
    assert.deepEqual(owner, [decision.id]);

    const asha = (await call<EmployeeDetail>(srv.base, 'GET', '/api/employees/asha')).body;
    assert.deepEqual(asha.needsYou.map(i => i.id), [decision.id], 'housekeeping is not counted');
    const tara = (await call<EmployeeDetail>(srv.base, 'GET', '/api/employees/tara')).body;
    assert.deepEqual(tara.needsYou, [], 'a routine review request for her assignment is not something the owner decides');

    const office = (await call<OfficeResponse>(srv.base, 'GET', '/api/office')).body;
    const card = office.units.flatMap(u => u.employees).find(c => c.employee.id === 'asha')!;
    assert.equal(card.needsYou, 1);
    assert.equal(office.needsYou, 1);
    assert.equal(office.counts.needsYou, 1);
  } finally {
    await srv.stop();
  }
});
