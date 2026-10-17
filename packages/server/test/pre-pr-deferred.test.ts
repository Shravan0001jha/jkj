import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as prePr from '../src/services/pre-pr.js';

/**
 * Mobile checks on GitHub (cloud migration, 17 Oct): on the Linux server scripts/pre-pr.sh cannot run
 * gradle or Xcode, so it records each mobile area as one check deferred to GitHub. The local run
 * still has to be a full, passing run; the deferred areas are what the Workplace runs on GitHub.
 */

const SHA = 'a'.repeat(40);

function result(areas: prePr.PrePrResult['areas'], extra: Partial<prePr.PrePrResult> = {}): prePr.PrePrResult {
  return { schema: 1, sha: SHA, ok: true, mode: 'full', only: null, areas, ...extra };
}

const deferred = (area: string): prePr.PrePrResult['areas'][number] =>
  ({ area, checks: [{ name: 'github', ok: true, deferred: 'github', passed: null, failed: null }], notes: ['runs on GitHub (mobile-checks.yml)'] });
const local = (area: string): prePr.PrePrResult['areas'][number] =>
  ({ area, checks: [{ name: 'unit', ok: true, passed: 10, failed: 0 }] });

test('deferredAreas lists the areas pre-pr.sh left to GitHub, in order', () => {
  const r = result([deferred('mobile-android'), local('iris-api'), deferred('mobile-ios')]);
  assert.deepEqual(prePr.deferredAreas(r), ['mobile-android', 'mobile-ios']);
  assert.deepEqual(prePr.deferredAreas(result([local('iris-api')])), []);
  assert.deepEqual(prePr.deferredAreas(null), []);
});

test('a full passing run with deferred areas still passes the local gate (the merge waits for GitHub)', () => {
  const r = result([deferred('mobile-android'), local('iris-api')]);
  assert.equal(prePr.passes(r, SHA), true);
  assert.equal(prePr.passes({ ...r, mode: 'fast' }, SHA), false, 'a fast run never passes, deferred or not');
  assert.equal(prePr.passes({ ...r, ok: false }, SHA), false);
});

test('a deferred check reads as "on GitHub" in the status line, not as a pass', () => {
  const r = result([deferred('mobile-android'), local('iris-api')]);
  const line = prePr.describe(r);
  assert.match(line, /mobile-android on GitHub/);
  assert.match(line, /iris-api unit 10 passed/);
});

test('withGitHub swaps the deferred areas for GitHub\'s results; ok only when both are', () => {
  const r = result([deferred('mobile-android'), local('iris-api'), deferred('mobile-ios')]);
  const gh = { sha: SHA, ok: false, runUrl: 'https://github.com/x/actions/runs/9', areas: [
    { area: 'mobile-android', checks: [{ name: 'unit', ok: true, passed: 16, failed: 0 }] },
    { area: 'mobile-ios', checks: [{ name: 'unit', ok: false, passed: 3, failed: 1, tail: 'IrisTests.testChat FAILED' }] },
  ] };
  const merged = prePr.withGitHub(r, gh);
  assert.equal(merged.ok, false);
  assert.deepEqual(merged.areas.map(a => a.area), ['mobile-android', 'iris-api', 'mobile-ios']);
  assert.deepEqual(prePr.deferredAreas(merged), []);
  assert.match(prePr.failureDetails(merged), /mobile-ios unit: 1 failed[\s\S]*IrisTests.testChat FAILED/);
  assert.equal(prePr.withGitHub(r, { ...gh, ok: true, areas: gh.areas.map(a => ({ ...a, checks: a.checks.map(c => ({ ...c, ok: true, failed: 0 })) })) }).ok, true);
  // GitHub said nothing about an area it was asked to run: that area fails, it never passes silently.
  const partial = prePr.withGitHub(r, { ...gh, ok: true, areas: [gh.areas[0]!] });
  assert.equal(partial.ok, false);
  assert.match(prePr.failureDetails(partial), /mobile-ios github: no result from GitHub/);
});
