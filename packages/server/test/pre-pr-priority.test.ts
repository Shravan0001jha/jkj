import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv, prePrPriority } from '../src/services/employees.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * as_mwd3mk0awv6gs follow-up (12 Nov, owner's bug bash): scripts/pre_pr.py has a priority lane
 * (PRE_PR_PRIORITY=1, c706ffe9). The Workplace sets it on the session of a P0 story, or of a story
 * the COO listed in <opsDir>/coo/pre-pr-priority.txt, and never on any other session.
 */

test('a P0 story gets PRE_PR_PRIORITY=1; a normal story and a session with no story do not', () => {
  const { wp, tmp } = testWorkplace();
  try {
    assert.equal(childEnv(wp, 'tara', { id: 'as_a', title: 'P0 Android alarm: nothing is armed' })['PRE_PR_PRIORITY'], '1');
    assert.equal(childEnv(wp, 'tara', { id: 'as_b', title: '[P0] iPhone test target does not compile' })['PRE_PR_PRIORITY'], '1');
    assert.equal(childEnv(wp, 'tara', { id: 'as_c', title: 'P1 Server: alarm list uses bullets' })['PRE_PR_PRIORITY'], undefined);
    assert.equal(childEnv(wp, 'tara', { id: 'as_d', title: 'Fix the P0 wording in docs' })['PRE_PR_PRIORITY'], undefined, 'P0 must lead the title');
    assert.equal(childEnv(wp, 'tara')['PRE_PR_PRIORITY'], undefined);
  } finally {
    tmp.cleanup();
  }
});

test('a story the COO listed gets the lane; comments and blank lines in the list are ignored', () => {
  const { wp, tmp } = testWorkplace();
  try {
    assert.equal(prePrPriority(wp, { id: 'as_bug', title: 'P1 Server: alarm list uses bullets' }), false, 'no list file: no lane');
    mkdirSync(join(wp.config.opsDir, 'coo'), { recursive: true });
    writeFileSync(join(wp.config.opsDir, 'coo', 'pre-pr-priority.txt'), '# bug bash 12 Nov\nas_bug  # bullets\n\n');
    assert.equal(prePrPriority(wp, { id: 'as_bug', title: 'P1 Server: alarm list uses bullets' }), true);
    assert.equal(prePrPriority(wp, { id: 'as_other', title: 'P1 Server: something else' }), false);
  } finally {
    tmp.cleanup();
  }
});

test('the variable is never inherited from the server process', () => {
  const { wp, tmp } = testWorkplace();
  const before = process.env['PRE_PR_PRIORITY'];
  try {
    process.env['PRE_PR_PRIORITY'] = '1';
    assert.equal(childEnv(wp, 'tara', { id: 'as_c', title: 'P1 normal' })['PRE_PR_PRIORITY'], undefined);
  } finally {
    if (before === undefined) delete process.env['PRE_PR_PRIORITY']; else process.env['PRE_PR_PRIORITY'] = before;
    tmp.cleanup();
  }
});
