import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import { readQaCases } from '../src/services/github-flow.js';
import { WORKPLACE_TOOLS } from '../src/services/employees.js';
import { rawGet } from '../src/services/v2-map.js';
import { testWorkplace } from './fakes/workplace.js';

/** 14 Nov: blind cases were write-only, so a QA whose session was lost could not answer them without rewriting. */
test('QA reads back the blind cases; the assignee and non-QA cannot; none on record says so', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Alarms' }, 'owner');
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'alarm rows', assigneeId: 'kabir' }, 'asha');
    assert.match(readQaCases(wp, s.id, 'nikhil'), /No blind cases are on record/);
    const cur = rawGet(wp, s.id)!;
    work.saveQuiet(wp, { ...cur, qaCases: { markdown: '- 7 dopahar — out of range', titles: ['7 dopahar'], by: 'nikhil', at: '2026-11-14T12:11:00Z' } } as never);
    assert.match(readQaCases(wp, s.id, 'nikhil'), /7 dopahar — out of range/);
    assert.throws(() => readQaCases(wp, s.id, 'kabir'), /Only QA|assignee/);
    assert.throws(() => readQaCases(wp, s.id, 'asha'), /Only QA/);
    assert.ok((WORKPLACE_TOOLS as readonly string[]).includes('qa_cases_read'), 'the tool is offered');
  } finally { tmp.cleanup(); }
});
