import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Employee, WorkItem } from '@jkj/shared';
import { qaReviewer } from '../src/services/review-policy.js';

/**
 * 12 Nov (Asha, as_mwdeulwknuw1c and as_mwdgaozpmtc6r): after approval 1 the Workplace handed the QA
 * review to Nikhil although Aditi had written the blind cases, so nobody could file approval 2 under the
 * blind rule. The QA who holds the qa_cases_write record keeps the review.
 */
const emp = (id: string, roleId: string) => ({ id, name: id, roleId, level: 2, charterIds: id === 'kabir' ? ['memory'] : ['qa-release'], reportsTo: 'cto' }) as unknown as Employee;
const staff = [emp('nikhil', 'qa'), emp('aditi', 'engineer'), emp('zoya', 'engineer'), emp('kabir', 'lead')];
const base = { id: 'as_x', employeeId: 'kabir', reviewerId: 'dev' } as unknown as WorkItem;

test('the blind-case writer keeps the QA review after approval 1, ahead of the board reviewer and of load', () => {
  const w = { ...base, qaCases: { by: 'aditi', markdown: '- a', titles: ['a'], at: '2026-11-12T00:00:00Z' } } as unknown as WorkItem;
  assert.equal(qaReviewer(staff, w, ['dev']), 'aditi');
  assert.equal(qaReviewer(staff, { ...w, reviewerId: 'nikhil' } as WorkItem, ['dev'], { aditi: 9 }), 'aditi', 'even when the board names someone else and Aditi is busy');
});

test('the case writer is skipped when excluded (gave approval 1) or not QA-capable; then the old rule applies', () => {
  const w = { ...base, qaCases: { by: 'aditi', markdown: '- a', titles: ['a'], at: '2026-11-12T00:00:00Z' } } as unknown as WorkItem;
  assert.equal(qaReviewer(staff, w, ['dev', 'aditi']), 'nikhil', 'excluded: back to the load rule');
  const notQa = { ...base, qaCases: { by: 'kabir', markdown: '- a', titles: ['a'], at: '2026-11-12T00:00:00Z' } } as unknown as WorkItem;
  assert.equal(qaReviewer(staff, notQa, ['dev']), 'nikhil', 'a lead who wrote cases is not QA-capable');
  assert.equal(qaReviewer(staff, base, ['dev']), 'nikhil', 'no case record: unchanged behaviour');
});
