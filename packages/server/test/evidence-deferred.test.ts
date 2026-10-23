import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as items from '../src/services/items.js';
import * as evidence from '../src/services/evidence.js';
import * as deferred from '../src/services/deferred.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * Known infra gaps (23 Oct, as_mviqeldd3fnpd): a BLOCKED case that is listed as deferred to a story
 * that will verify it must not fail an otherwise green run, but stays visible. Unlisted BLOCKED and
 * any FAIL still fail.
 */

const FILE = [
  '# Deferred', '',
  '| Case | Verifying story | Why |', '|---|---|---|',
  '| android / `timer.handoff_to_clock` | as_mvigsuoa9w961 | GitHub emulator cannot receive real FCM |',
  '| other.case | as_other | x |', '',
].join('\n');

const results = (rows: Record<string, string>): string => {
  const tests = Object.fromEntries(Object.entries(rows).map(([id, status]) => [id, { status, note: `${id} note` }]));
  const counts: Record<string, number> = {};
  for (const s of Object.values(rows)) counts[s] = (counts[s] ?? 0) + 1;
  const bad = counts['FAIL'] || counts['BLOCKED'];
  return JSON.stringify({ verdict: bad ? 'FAIL' : 'PASS', counts, platforms: { android: { tests } } });
};
const runDir = (json: string): string => {
  const d = mkdtempSync(join(tmpdir(), 'iris-ev-def-'));
  writeFileSync(join(d, 'results.json'), json);
  writeFileSync(join(d, 'summary.txt'), 'old summary\n\nFAILURES (1)\n  android timer.handoff_to_clock BLOCKED: x\n');
  return d;
};
const listed = deferred.parseDeferredFile(FILE);
const GREEN = { download: 'PASS', 'timer.ring_fired': 'PASS', 'timer.snooze_rearm': 'PASS' };

test('parseDeferredFile reads case, verifying story and reason from the table, ignoring header rows', () => {
  assert.deepEqual(listed.map(e => [e.case, e.storyId]), [['timer.handoff_to_clock', 'as_mvigsuoa9w961'], ['other.case', 'as_other']]);
  assert.match(listed[0]!.reason ?? '', /FCM/);
});

test('a listed BLOCKED case is DEFERRED: the run passes, names the case and story, counts it apart', () => {
  const d = runDir(results({ ...GREEN, 'timer.handoff_to_clock': 'BLOCKED' }));
  const applied = deferred.scoreRun(d, listed, () => true);
  assert.deepEqual(applied.map(a => [a.case, a.storyId]), [['timer.handoff_to_clock', 'as_mvigsuoa9w961']]);
  const o = evidence.readOutcome(d, { exitCode: 1, stderrTail: '' });
  assert.equal(o.state, 'success');
  assert.equal(o.passed, 3);
  assert.equal(o.failed, 0);
  assert.deepEqual(o.deferred?.map(x => x.storyId), ['as_mvigsuoa9w961']);
  assert.match(readFileSync(join(d, 'summary.txt'), 'utf8'), /verdict PASS — deferred: timer\.handoff_to_clock → as_mvigsuoa9w961/);
});

test('a BLOCKED case that is not listed still fails the run', () => {
  const d = runDir(results({ ...GREEN, 'timer.other': 'BLOCKED' }));
  assert.deepEqual(deferred.scoreRun(d, listed, () => true), []);
  assert.equal(evidence.readOutcome(d, { exitCode: 1, stderrTail: '' }).state, 'failure');
});

test('a listed case that FAILs (not BLOCKED) still fails', () => {
  const d = runDir(results({ ...GREEN, 'timer.handoff_to_clock': 'FAIL' }));
  assert.deepEqual(deferred.scoreRun(d, listed, () => true), []);
  assert.equal(evidence.readOutcome(d, { exitCode: 1, stderrTail: '' }).state, 'failure');
});

test('a listed case whose story is not usable (missing, closed) still fails; another failure alongside keeps the run red', () => {
  const a = runDir(results({ ...GREEN, 'timer.handoff_to_clock': 'BLOCKED' }));
  assert.deepEqual(deferred.scoreRun(a, listed, () => false), []);
  assert.equal(evidence.readOutcome(a, { exitCode: 1, stderrTail: '' }).state, 'failure');
  const b = runDir(results({ ...GREEN, 'timer.handoff_to_clock': 'BLOCKED', 'x.y': 'FAIL' }));
  deferred.scoreRun(b, listed, () => true);
  const o = evidence.readOutcome(b, { exitCode: 1, stderrTail: '' });
  assert.equal(o.state, 'failure');
  assert.equal(o.failed, 1);
});

test('the Workplace allowlist: the COO sets case -> story with who set it; the story must exist and be open or awaiting-mac', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Phone' }, 'owner');
    const story = items.create(wp, { level: 'story', title: 'FCM check', parentId: epic.id, assigneeId: 'kabir' }, 'owner');
    assert.throws(() => deferred.allow(wp, { case: 'timer.handoff_to_clock', storyId: 'as_nope', reason: 'r' }, 'coo'), /no story|not found/i);
    assert.throws(() => deferred.allow(wp, { case: '', storyId: story.id, reason: 'r' }, 'coo'), /case/);
    const e = deferred.allow(wp, { case: 'timer.handoff_to_clock', storyId: story.id, reason: 'no FCM on emulator' }, 'coo');
    assert.equal(e.by, 'coo');
    assert.deepEqual(deferred.allowlist(wp).map(x => x.case), ['timer.handoff_to_clock']);
    deferred.allow(wp, { case: 'timer.handoff_to_clock', storyId: story.id, reason: 'again' }, 'coo');
    assert.equal(deferred.allowlist(wp).length, 1, 'same case replaces');
    assert.equal(deferred.usable(wp, story.id), true);
    assert.equal(deferred.usable(wp, 'as_nope'), false);
    const d = runDir(results({ ...GREEN, 'timer.handoff_to_clock': 'BLOCKED' }));
    mkdirSync(d, { recursive: true });
    assert.equal(deferred.scoreRun(d, deferred.allowlist(wp), id => deferred.usable(wp, id)).length, 1);
  } finally { tmp.cleanup(); }
});

test('rescore turns a stored failed run into a pass once its blocked case is allowed; no new run', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Phone' }, 'owner');
    const story = items.create(wp, { level: 'story', title: 'Alarm', parentId: epic.id, assigneeId: 'kabir' }, 'owner');
    const verifier = items.create(wp, { level: 'story', title: 'FCM', parentId: epic.id, assigneeId: 'kabir' }, 'owner');
    const run = 'abcdef012345-20261023094108';
    const dir = join(wp.config.evidence.dir, story.id, run);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'results.json'), results({ ...GREEN, 'timer.handoff_to_clock': 'BLOCKED' }));
    writeFileSync(join(dir, 'summary.txt'), 'x\n');
    const { saveQuiet } = await import('../src/services/work.js');
    const { rawGet } = await import('../src/services/v2-map.js');
    saveQuiet(wp, { ...rawGet(wp, story.id)!, evidenceRun: { run, sha: 'abcdef0123456789', state: 'failure', platforms: ['android'], features: ['timer'], passed: 3, failed: 1, failures: ['x'], durationS: 1, report: '', by: 'kabir', at: new Date().toISOString() } });
    const before = await evidence.rescore(wp, story.id, 'coo');
    assert.equal(before.state, 'failure', 'nothing allowed yet: unchanged');
    deferred.allow(wp, { case: 'timer.handoff_to_clock', storyId: verifier.id, reason: 'no FCM' }, 'coo');
    const after = await evidence.rescore(wp, story.id, 'coo');
    assert.equal(after.state, 'success');
    assert.equal(after.failed, 0);
    assert.equal(rawGet(wp, story.id)!.evidenceRun!.deferred![0]!.storyId, verifier.id);
  } finally { tmp.cleanup(); }
});
