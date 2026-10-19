import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkItem } from '@jkj/shared';
import type { Workplace } from '../src/services/workplace.js';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as flow from '../src/services/github-flow.js';
import * as postMerge from '../src/services/post-merge.js';
import * as lifecycle from '../src/services/lifecycle.js';
import * as lifecycleWatch from '../src/services/lifecycle-watch.js';
import { setMacHostForTest } from '../src/services/mac-host.js';
import { employee } from '../src/services/employees.js';
import { ensureWorktree } from '../src/services/worktrees.js';
import { rawGet } from '../src/services/v2-map.js';
import { testWorkplace } from './fakes/workplace.js';
import { FakeGitHub } from './fakes/fake-github.js';
import { writePrePr } from './fakes/pre-pr.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';

/**
 * The post-merge iPhone review (owner's final rule, 19 Oct): a story that changes mobile/ios merges with no
 * macOS run, stays Merged, files a linked review story that waits Parked until a Mac is attached; when
 * that review passes the original is Done, when it fails a bug is filed and the original stays Merged.
 */

const runtime = installFakeRuntime();
after(() => { runtime.restore(); setMacHostForTest(undefined); });
const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });
const QA_DOC = '## Edge cases\n- PASS: empty input — unit test evidence: https://ci.example.com/runs/1\n- PASS: provider down — killed the provider and checked the reply evidence: https://ci.example.com/runs/2\n- N/A: Windows path — no Windows code touched\n- iPhone: post-merge review on the Mac\n## Report\nChecked both failure paths by hand and in tests; Windows untouched; residual risk low.\nEvidence: n/a — server-only change, no app surface\nTests: pytest 374 passed, 0 failed';

interface S { wp: Workplace; gh: FakeGitHub; epicId: string; storyId: string; done(): void }

async function mergedStory(file: string, content: string, deferred: string[]): Promise<S> {
  const { wp, tmp } = testWorkplace();
  const kabir = employee(wp, 'kabir');
  wp.org.employees.push({ ...kabir, id: 'arjun', name: 'Arjun', roleId: 'engineer', level: 2, charterIds: ['memory'], reportsTo: 'kabir' });
  writeFileSync(join(wp.config.workplaceDir, 'quality.yaml'), 'maxFileBytes: 100000\nareas: {}\n');
  const gh = new FakeGitHub(kabir.workspace.repo);
  flow.useGitHub(wp, gh);
  flow.setMode(wp, 'on', 'coo');
  const epic = items.create(wp, { level: 'epic', title: 'Phone' }, 'owner');
  const story = items.create(wp, { level: 'story', title: 'Ring an alarm on the phone', parentId: epic.id, assigneeId: 'kabir' }, 'owner');
  const wt = ensureWorktree(wp.config.workDir, kabir, story.id).path;
  mkdirSync(join(wt, file, '..'), { recursive: true });
  writeFileSync(join(wt, file), content);
  git(wt, ['add', '-A']);
  git(wt, ['-c', 'user.email=k@iris.local', '-c', 'user.name=kabir', 'commit', '-q', '-m', `add ${file}`]);
  writePrePr(wt, git(wt, ['rev-parse', 'HEAD']).trim(), { deferred });
  work.reportDone(wp, story.id, { tests: { passed: 3, failed: 0, command: 'pytest' }, commits: ['abc'], liveVerified: [], notVerified: ['live'] }, 'kabir');
  const r = await flow.onReview(wp, story.id, 'kabir');
  await r.tests;
  for (const who of ['arjun', 'tara', 'rohan', 'priya']) { try { await flow.approve(wp, story.id, who); } catch { /* not this story's reviewer */ } }
  try { await flow.approve(wp, story.id, 'nikhil', undefined, QA_DOC); } catch { /* checked below */ }
  if (!rawGet(wp, story.id)!.pr!.merged) await flow.autoMerge(wp, story.id);
  assert.ok(rawGet(wp, story.id)!.pr!.merged, 'setup: the story merged');
  await new Promise(r => setImmediate(r));
  return { wp, gh, epicId: epic.id, storyId: story.id, done: () => { gh.cleanup(); tmp.cleanup(); } };
}
const item = (s: S, id: string): WorkItem => rawGet(s.wp, id)!;
const review = (s: S): WorkItem => item(s, item(s, s.storyId).postMerge!.reviewId);

test('an iPhone story merges with no macOS run, stays Merged (not Done), and files a post-merge review parked until a Mac is attached', async () => {
  setMacHostForTest(false);
  const s = await mergedStory('mobile/ios/Iris/Alarm.swift', 'struct Alarm {}\n', ['mobile-ios']);
  try {
    assert.equal(s.gh.count('dispatchWorkflow'), 0, 'no GitHub workflow (so no macOS runner) was dispatched');
    const orig = item(s, s.storyId);
    assert.equal(lifecycle.trueStatus(s.wp, orig), 'merged');
    assert.equal(orig.closedAt, undefined);
    const rev = review(s);
    assert.equal(rev.title, 'Post-merge iPhone review: Ring an alarm on the phone');
    assert.equal(rev.parentId, s.epicId, 'same epic');
    assert.equal(rev.charterId, 'mobile-ios');
    assert.equal(rev.postMergeOf, s.storyId);
    assert.equal(rev.status, 'parked');
    assert.match(rev.parked!.resumeWhen, /A Mac is attached/);
    assert.match(rev.body, /request_mac/);
    // Filing again changes nothing (the sweep and the merge both call it).
    postMerge.sweep(s.wp);
    assert.equal(item(s, s.storyId).postMerge!.reviewId, rev.id);
    // A Mac attaches: the sweep lifts the park.
    setMacHostForTest(true);
    postMerge.sweep(s.wp);
    assert.notEqual(item(s, rev.id).status, 'parked');
  } finally { s.done(); }
});

test('review passes: the original moves to Done by itself', async () => {
  setMacHostForTest(false);
  const s = await mergedStory('mobile/ios/Iris/Alarm.swift', 'struct Alarm {}\n', ['mobile-ios']);
  try {
    const rev = review(s);
    setMacHostForTest(true); postMerge.sweep(s.wp);
    items.update(s.wp, rev.id, { status: 'in-progress', note: 'picked up on the Mac' }, 'coo');
    items.update(s.wp, rev.id, { status: 'done', resolution: 'done', note: 'build + unit tests green on the Mac' }, 'owner');
    lifecycleWatch.onItem(s.wp, rev.id);
    const orig = item(s, s.storyId);
    assert.equal(orig.postMerge!.state, 'passed');
    assert.equal(lifecycle.trueStatus(s.wp, orig), 'done');
  } finally { s.done(); }
});

test('review fails: a bug is filed against the original and it stays Merged', async () => {
  setMacHostForTest(true);
  const s = await mergedStory('mobile/ios/Iris/Alarm.swift', 'struct Alarm {}\n', ['mobile-ios']);
  try {
    const rev = review(s);
    items.update(s.wp, rev.id, { status: 'in-progress', note: 'picked up on the Mac' }, 'coo');
    items.update(s.wp, rev.id, { status: 'done', resolution: 'wont-do', note: 'AlarmTests.testRing failed on the Mac' }, 'owner');
    lifecycleWatch.onItem(s.wp, rev.id);
    const orig = item(s, s.storyId);
    assert.equal(orig.postMerge!.state, 'failed');
    assert.equal(lifecycle.trueStatus(s.wp, orig), 'merged');
    const bug = item(s, orig.postMerge!.bugId!);
    assert.equal(bug.type, 'bug');
    assert.match(bug.title, /Ring an alarm on the phone/);
    assert.equal(bug.parentId, s.epicId);
  } finally { s.done(); }
});

test('control: an Android-only story merges as before and files no iPhone review', async () => {
  setMacHostForTest(false);
  const s = await mergedStory('mobile/android/app/Alarm.kt', 'class Alarm\n', []);
  try {
    assert.equal(item(s, s.storyId).postMerge, undefined);
    assert.equal(lifecycle.trueStatus(s.wp, item(s, s.storyId)), 'merged');
  } finally { s.done(); }
});
