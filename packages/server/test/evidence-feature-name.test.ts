import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE } from '../src/services/evidence.js';

// 23 Oct: run_evidence(android, "image:make") was refused "is not a feature name" by this syntax check,
// before plan.mjs at the story's commit (which defines image:make) was ever read. Syntax must admit the
// names a plan can define; membership is checked against the plan, not here.
test('feature-name syntax admits case-level names and underscores, still rejects junk', () => {
  for (const ok of ['queries', 'image', 'image:make', 'image_make', 'cap-per-tier', 'image:cap_per_tier']) assert.ok(FEATURE.test(ok), ok);
  for (const bad of ['', 'Image', '1image', 'image make', 'image;rm', '../x', 'a'.repeat(49)]) assert.ok(!FEATURE.test(bad), bad);
});
