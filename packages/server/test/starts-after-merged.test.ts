import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkItem } from '@jkj/shared';
import { finished } from '../src/services/lifecycle.js';

/**
 * 13 Nov (Asha cleared five dependencies by hand in one day): iPhone stories stay Merged until the post-merge
 * Mac review, so a story that "starts after" one sat Blocked although the code it waited for was on the trunk.
 * A merged PR now counts as finished for whoever starts after it.
 */
const base = { id: 'as_a', title: 't' } as unknown as WorkItem;
const pr = (merged: boolean) => ({ number: 1, url: '', branch: 'b', stage: merged ? 'merged' : 'qa', ...(merged ? { merged: { at: '2026-11-13T00:00:00Z', by: 'workplace' } } : {}) });

test('a merged story that is not Done yet (awaiting its Mac review) counts as finished', () => {
  assert.equal(finished({ ...base, status: 'in-review', pr: pr(true) } as unknown as WorkItem), true);
  assert.equal(finished({ ...base, status: 'awaiting-mac', pr: pr(true) } as unknown as WorkItem), true);
});

test('unchanged: Done without a PR finishes; an open PR does not, Done or not; a closed-as-wont-do does not', () => {
  assert.equal(finished({ ...base, status: 'done' } as WorkItem), true);
  assert.equal(finished({ ...base, status: 'done', pr: pr(false) } as unknown as WorkItem), false);
  assert.equal(finished({ ...base, status: 'in-review', pr: pr(false) } as unknown as WorkItem), false);
  assert.equal(finished({ ...base, status: 'done', resolution: 'wont-do' } as unknown as WorkItem), false);
  assert.equal(finished({ ...base, status: 'in-progress' } as WorkItem), false);
  assert.equal(finished(undefined), false);
});
