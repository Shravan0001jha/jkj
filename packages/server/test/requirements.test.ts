import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assignIds, coverage, fromChecklist, fromExtract, importRequirements, readRequirements, withOwners,
} from '../src/services/requirements.js';
import { CHECKLIST } from '../src/seed-data/checklist.js';
import { lint } from '../src/services/ownership.js';
import { tmpWorkplace } from './fakes/tmp-workplace.js';

const extract = readFileSync(fileURLToPath(new URL('../../../docs/product-definition-extract.md', import.meta.url)), 'utf8');

test('the checklist carries the 27 Sep numbers: 110 features in 15 groups', () => {
  assert.equal(CHECKLIST.length, 110);
  assert.equal(new Set(CHECKLIST.map(c => c.group)).size, 15);
  const count = (s: string) => CHECKLIST.filter(c => c.status === s).length;
  // 52 built on the page = 48 built + 4 promoted to verified (tried live that day)
  assert.equal(count('built') + count('verified'), 52);
  assert.equal(count('verified'), 4);
  assert.equal(count('partial'), 16);
  assert.equal(count('missing'), 42);
});

test('the extract yields the non-checklist candidates grouped by section', () => {
  const items = fromExtract(extract);
  assert.equal(items.length, 96);
  const groups = new Set(items.map(i => i.group));
  assert.deepEqual([...groups], ['Theme', 'Platforms', 'Segments', 'Pricing', 'Architecture', 'Legal', 'Observability']);
  const tiers = items.find(i => i.title === 'Three tiers')!;
  assert.match(tiers.note!, /\$6\.99 \(₹199\)/);
  assert.equal(tiers.group, 'Pricing');
});

test('ids are stable across imports and statuses only rise', () => {
  const first = assignIds(fromChecklist());
  assert.equal(first[0]!.id, 'REQ-EXPRESSIONS-01');
  const timers = first.find(r => r.title === 'Timers')!;
  assert.equal(timers.status, 'verified');

  // A re-import where Timers regressed to "built" keeps verified; a missing item that got built rises.
  const changed = fromChecklist().map(i =>
    i.title === 'Timers' ? { ...i, status: 'built' as const }
    : i.title === 'To-dos' ? { ...i, status: 'built' as const } : i);
  const second = assignIds(changed, first);
  assert.equal(second.find(r => r.title === 'Timers')!.id, timers.id);
  assert.equal(second.find(r => r.title === 'Timers')!.status, 'verified');
  assert.equal(second.find(r => r.title === 'To-dos')!.status, 'built');

  // A new item gets the next number in its group, never a reused one.
  const third = assignIds([...changed, { group: 'Memory', section: '§3', title: 'Brand new', segments: [], status: 'missing', evidence: [] }], second);
  assert.equal(third.find(r => r.title === 'Brand new')!.id, 'REQ-MEMORY-08');
});

test('on the seed every requirement is owned and coverage adds up', () => {
  const wp = tmpWorkplace();
  try {
    const all = withOwners(importRequirements(wp.dir, extract), wp.org.map);
    assert.equal(all.length, 206);
    const unowned = all.filter(r => !r.charterId);
    assert.deepEqual(unowned.map(r => r.id), []);
    assert.deepEqual(lint(wp.org, all, { exists: () => true, topLevelDirs: () => [] }).filter(f => f.code === 'unowned-requirement'), []);

    const cov = coverage(all);
    assert.equal(cov.total, 206);
    assert.equal(cov.owned, 206);
    assert.equal(cov.planned, 0);
    assert.equal(cov.built, 52);
    assert.equal(cov.verified, 4);
    assert.equal(cov.released, 0);
    const groupTotal = Object.values(cov.byGroup).reduce((n, g) => n + g.total, 0);
    assert.equal(groupTotal, 206);
    assert.equal(cov.byGroup['Memory']!.built, 3);
    assert.equal(cov.byCharter['memory']!.total, 7);
    assert.equal(cov.byCharter['character']!.total, 9 + 10 + 7 + 4);

    // The file round-trips without the derived owner.
    const reread = readRequirements(wp.dir);
    assert.equal(reread.length, 206);
    assert.equal(reread[0]!.charterId, null);
  } finally {
    wp.cleanup();
  }
});
