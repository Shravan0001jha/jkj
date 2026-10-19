import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkItem } from '@jkj/shared';
import type { Workplace } from '../src/services/workplace.js';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as trail from '../src/services/trail.js';
import * as flow from '../src/services/github-flow.js';
import { employee } from '../src/services/employees.js';
import { ensureWorktree } from '../src/services/worktrees.js';
import { rawGet } from '../src/services/v2-map.js';
import { testWorkplace } from './fakes/workplace.js';
import { FakeGitHub } from './fakes/fake-github.js';
import { writePrePr } from './fakes/pre-pr.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';

/**
 * Mobile checks on GitHub (cloud migration, 17 Oct): on the Linux server pre-pr.sh leaves the mobile
 * areas to GitHub. Once the branch is pushed the Workplace dispatches mobile-checks.yml for the head;
 * workplace/tests stays pending until that run finishes, then carries both results, and the automatic
 * merge waits for it. A new head dispatches again; a failed dispatch is retried, never a crash.
 */

const runtime = installFakeRuntime();
after(() => runtime.restore());
const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });

const QA_DOC = '## Edge cases\n- PASS: empty input — unit test evidence: https://ci.example.com/runs/1\n- PASS: provider down — killed the provider and checked the reply evidence: https://ci.example.com/runs/2\n- N/A: Windows path — no Windows code touched\n## Report\nChecked both failure paths by hand and in tests; Windows untouched; residual risk low.\nEvidence: n/a — server-only change, no app surface\nTests: pytest 374 passed, 0 failed';

interface Setup {
  wp: Workplace; gh: FakeGitHub; storyId: string; wt: string;
  commit(file: string, content: string, deferred?: string[]): string;
  done(): void;
}

function setup(mode: 'shadow' | 'on' = 'on'): Setup {
  const { wp, tmp } = testWorkplace();
  const kabir = employee(wp, 'kabir');
  wp.org.employees.push({ ...kabir, id: 'arjun', name: 'Arjun', roleId: 'engineer', level: 2, charterIds: ['memory'], reportsTo: 'kabir' });
  writeFileSync(join(wp.config.workplaceDir, 'quality.yaml'), 'maxFileBytes: 100000\nareas: {}\n');
  const gh = new FakeGitHub(kabir.workspace.repo);
  flow.useGitHub(wp, gh);
  flow.setMode(wp, mode, 'coo');
  const epic = items.create(wp, { level: 'epic', title: 'Phone' }, 'owner');
  const story = items.create(wp, { level: 'story', title: 'Ring an alarm on the phone', parentId: epic.id, assigneeId: 'kabir' }, 'owner');
  const wt = ensureWorktree(wp.config.workDir, kabir, story.id).path;
  const commit = (file: string, content: string, deferred: string[] = ['mobile-android']): string => {
    mkdirSync(join(wt, file, '..'), { recursive: true });
    writeFileSync(join(wt, file), content);
    git(wt, ['add', '-A']);
    git(wt, ['-c', 'user.email=k@iris.local', '-c', 'user.name=kabir', 'commit', '-q', '-m', `add ${file}`]);
    const sha = git(wt, ['rev-parse', 'HEAD']).trim();
    writePrePr(wt, sha, { deferred });
    return sha;
  };
  return { wp, gh, storyId: story.id, wt, commit, done: () => { gh.cleanup(); tmp.cleanup(); } };
}

const evidence = { tests: { passed: 3, failed: 0, command: 'pytest' }, commits: ['abc'], liveVerified: [], notVerified: ['live'] };
async function reviewed(s: Setup): Promise<void> {
  work.reportDone(s.wp, s.storyId, evidence, 'kabir');
  const r = await flow.onReview(s.wp, s.storyId, 'kabir');
  await r.tests;
}
const pr = (s: Setup): NonNullable<WorkItem['pr']> => rawGet(s.wp, s.storyId)!.pr!;
const result = (sha: string, ok: boolean): Record<string, string> => ({
  'result.json': JSON.stringify({ sha, ok, runUrl: 'https://github.com/x/actions/runs/1', areas: [
    { area: 'mobile-android', checks: [{ name: 'unit', ok, passed: ok ? 16 : 15, failed: ok ? 0 : 1, tail: ok ? '' : 'AlarmTest > rings FAILED' }] },
  ] }),
});

test('a head whose pre-pr left mobile areas to GitHub dispatches mobile-checks.yml once and waits (tests pending)', async () => {
  const s = setup('on');
  try {
    const head = s.commit('mobile/android/app/Alarm.kt', 'class Alarm\n');
    await reviewed(s);
    assert.equal(s.gh.count('dispatchWorkflow'), 1);
    const run = s.gh.runs[0]!;
    assert.equal(run.workflow, 'mobile-checks.yml');
    assert.deepEqual(run.inputs, { iris_ref: head, areas: 'mobile-android', request_id: `${s.storyId}-${head.slice(0, 8)}` });
    assert.equal(pr(s).tests?.state, 'pending');
    assert.match(pr(s).tests!.summary, /mobile checks .*on GitHub/i);
    assert.equal(s.gh.status(head, 'workplace/tests')?.state, 'pending');
    // The sweep sees it still running: no second dispatch, still pending.
    await flow.syncHeads(s.wp);
    await flow.syncHeads(s.wp);
    assert.equal(s.gh.count('dispatchWorkflow'), 1);
    assert.equal(pr(s).tests?.state, 'pending');
    assert.match(s.gh.status(head, 'workplace/tests')!.targetUrl ?? '', /actions\/runs\/900/, 'the status links the run');
  } finally { s.done(); }
});

test('a finished green run turns workplace/tests green with both results; the merge then goes on its own', async () => {
  const s = setup('on');
  try {
    const head = s.commit('mobile/android/app/Alarm.kt', 'class Alarm\n');
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await flow.approve(s.wp, s.storyId, 'tara');   // the Android code's charter lead approves their files first
    const qa = await flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC);
    assert.match(qa.message, /approved is not merged/, 'it does not merge while the mobile checks run');
    assert.equal(await flow.autoMerge(s.wp, s.storyId), 'waiting');
    assert.equal(s.gh.count('merge'), 0);
    s.gh.finishRun('success', { 'mobile-checks-result': result(head, true) });
    assert.equal(await flow.autoMerge(s.wp, s.storyId), 'merged');
    assert.equal(pr(s).tests?.state, 'success');
    assert.match(pr(s).tests!.summary, /mobile-android unit 16 passed/);
    assert.match(pr(s).tests!.summary, /agent-svc unit 374 passed/);
  } finally { s.done(); }
});

test('a red run fails workplace/tests with the failing tails on the item; nothing merges', async () => {
  const s = setup('on');
  try {
    const head = s.commit('mobile/android/app/Alarm.kt', 'class Alarm\n');
    await reviewed(s);
    s.gh.finishRun('failure', { 'mobile-checks-result': result(head, false) });
    await flow.syncHeads(s.wp);
    assert.equal(pr(s).tests?.state, 'failure');
    assert.equal(s.gh.status(head, 'workplace/tests')?.state, 'failure');
    const notes = trail.comments(s.wp, s.storyId).map(c => `${c.text}\n${c.details ?? ''}`).join('\n');
    assert.match(notes, /mobile checks on GitHub failed/i);
    assert.match(notes, /AlarmTest > rings FAILED/);
    assert.equal(s.gh.count('merge'), 0);
  } finally { s.done(); }
});

test('a run that ends without its result artifact is an error, never a pass', async () => {
  const s = setup('on');
  try {
    s.commit('mobile/android/app/Alarm.kt', 'class Alarm\n');
    await reviewed(s);
    s.gh.finishRun('cancelled', {});
    await flow.syncHeads(s.wp);
    assert.equal(pr(s).tests?.state, 'error');
    assert.match(pr(s).tests!.summary, /cancelled|no result/i);
  } finally { s.done(); }
});

test('a new head dispatches again for that head; a failed dispatch is retried on a later sweep', async () => {
  const s = setup('on');
  const saved = { ...flow.mobileCiTiming };
  try {
    s.commit('mobile/android/app/Alarm.kt', 'class Alarm\n');
    await reviewed(s);
    const head2 = s.commit('mobile/android/app/Alarm.kt', 'class Alarm { fun ring() {} }\n');
    s.gh.failNext('dispatchWorkflow', 1, 'GitHub POST .../dispatches failed (503)');
    await flow.syncHeads(s.wp);          // the new head: pushed again, dispatch refused
    assert.equal(pr(s).tests?.state, 'pending');
    assert.match(pr(s).tests!.summary, /could not start/i);
    assert.equal(s.gh.runs.length, 1, 'only the first head\'s run exists');
    flow.mobileCiTiming.retryMs = 0;
    await flow.syncHeads(s.wp);          // retried
    assert.equal(s.gh.runs.length, 2);
    assert.equal(s.gh.runs[1]!.inputs['iris_ref'], head2);
    assert.equal(s.gh.runs[1]!.requestId, `${s.storyId}-${head2.slice(0, 8)}`);
  } finally { Object.assign(flow.mobileCiTiming, saved); s.done(); }
});

test('a dispatch whose run never appears is dispatched again once it is given up as lost', async () => {
  const s = setup('on');
  const saved = { ...flow.mobileCiTiming };
  try {
    s.commit('mobile/android/app/Alarm.kt', 'class Alarm\n');
    s.gh.runsAppear = false;
    await reviewed(s);
    await flow.syncHeads(s.wp);
    assert.equal(s.gh.count('dispatchWorkflow'), 1, 'not given up yet');
    flow.mobileCiTiming.lostMs = 0;
    s.gh.runsAppear = true;
    await flow.syncHeads(s.wp);
    assert.equal(s.gh.count('dispatchWorkflow'), 2);
  } finally { Object.assign(flow.mobileCiTiming, saved); s.done(); }
});

test('a head with no deferred areas never touches GitHub Actions (the Mac path is unchanged)', async () => {
  const s = setup('on');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n', []);
    // writePrePr with no deferred areas writes the classic local mobile-android result.
    writePrePr(s.wt, git(s.wt, ['rev-parse', 'HEAD']).trim());
    await reviewed(s);
    assert.equal(s.gh.count('dispatchWorkflow'), 0);
    assert.equal(pr(s).tests?.state, 'success');
  } finally { s.done(); }
});

/* ---------- 18 Oct (as_mvcghfuyq2bi8, PR #400): a finished run was never picked up ---------- */

/** The trunk moves on and the author merges it in: a trunk-only head move (the PR diff is unchanged). */
function trunkOnlyMove(s: Setup): string {
  const repo = employee(s.wp, 'kabir').workspace.repo;
  const trunk = s.wp.config.github.trunk;
  writeFileSync(join(repo, `trunk-${Date.now()}.txt`), 'trunk moves\n');
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.email=t@iris.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'trunk moves']);
  git(s.wt, ['-c', 'user.email=k@iris.local', '-c', 'user.name=k', 'merge', '-q', '--no-edit', trunk]);
  return git(s.wt, ['rev-parse', 'HEAD']).trim();
}
const comments = (s: Setup): string => trail.comments(s.wp, s.storyId).map(c => `${c.text}\n${c.details ?? ''}`).join('\n');

test('PR #400: a trunk-only head move while the run is going carries the run over; its result lands on the new head, no second dispatch', async () => {
  const s = setup('on');
  try {
    const head = s.commit('mobile/android/app/Alarm.kt', 'class Alarm\n');
    await reviewed(s);
    const head2 = trunkOnlyMove(s);
    assert.deepEqual(await flow.syncHeads(s.wp), [s.storyId]);
    assert.equal(pr(s).headSha, head2);
    assert.equal(pr(s).tests?.state, 'pending');
    s.gh.finishRun('failure', { 'mobile-checks-result': result(head, false) });
    await flow.syncHeads(s.wp);
    assert.equal(s.gh.count('dispatchWorkflow'), 1, 'the run for the old head counts: the PR diff is the same');
    assert.equal(pr(s).tests?.state, 'failure');
    assert.equal(pr(s).tests?.sha, head2);
    assert.equal(s.gh.status(head2, 'workplace/tests')?.state, 'failure');
    assert.match(comments(s), /AlarmTest > rings FAILED/);
  } finally { s.done(); }
});

test('PR #400: a run that finishes after the story was sent back (building, then blocked) is still picked up', async () => {
  const s = setup('on');
  try {
    const head = s.commit('mobile/android/app/Alarm.kt', 'class Alarm\n');
    await reviewed(s);
    items.update(s.wp, s.storyId, { status: 'in-progress', note: 'sent back: wait for the GitHub run' }, 'owner');
    items.update(s.wp, s.storyId, { status: 'blocked', blockedReason: 'waiting for the GitHub run', waitingOn: 'external', note: 'waiting for the run' }, 'owner');
    s.gh.finishRun('success', { 'mobile-checks-result': result(head, true) });
    await flow.syncHeads(s.wp);
    assert.equal(pr(s).tests?.state, 'success');
    assert.equal(pr(s).mobileCi?.state, 'success');
    assert.equal(s.gh.status(head, 'workplace/tests')?.state, 'success');
  } finally { s.done(); }
});

test('PR #400 as stored: a record left on the old head by an earlier trunk-only carry heals on the next sweep', async () => {
  const s = setup('on');
  try {
    const head = s.commit('mobile/android/app/Alarm.kt', 'class Alarm\n');
    await reviewed(s);
    const old = pr(s).mobileCi!;
    const head2 = trunkOnlyMove(s);
    await flow.syncHeads(s.wp);
    // What the live DB holds: tests carried to the new head, the run record still on the old one.
    const w = rawGet(s.wp, s.storyId)!;
    work.saveQuiet(s.wp, { ...w, pr: { ...w.pr!, mobileCi: old } });
    items.update(s.wp, s.storyId, { status: 'in-progress', note: 'sent back' }, 'owner');
    s.gh.finishRun('failure', { 'mobile-checks-result': result(head, false) });
    await flow.syncHeads(s.wp);
    assert.equal(pr(s).tests?.state, 'failure');
    assert.equal(pr(s).tests?.sha, head2);
    assert.equal(s.gh.count('dispatchWorkflow'), 1);
  } finally { s.done(); }
});

test('a finished run whose result cannot be applied is said on the story once, never silent', async () => {
  const s = setup('on');
  try {
    const head = s.commit('mobile/android/app/Alarm.kt', 'class Alarm\n');
    await reviewed(s);
    // The local pre-pr result is gone (worktree cleaned): the GitHub result has nothing to merge into.
    rmSync(join(s.wt, '.workplace', 'pre-pr', `${head}.json`));
    s.gh.finishRun('failure', { 'mobile-checks-result': result(head, false) });
    await flow.syncHeads(s.wp);
    await flow.syncHeads(s.wp);
    const said = trail.comments(s.wp, s.storyId).filter(c => /mobile checks run .*finished .*could not/i.test(c.text));
    assert.equal(said.length, 1, comments(s));
    assert.match(said[0]!.text, /actions\/runs\/900/);
  } finally { s.done(); }
});

test('mobile-ios is never dispatched pre-merge: a mobile-ios-only change goes green on the Linux checks with a post-merge note', async () => {
  const s = setup('on');
  try {
    const head = s.commit('mobile/ios/Iris/Alarm.swift', 'struct Alarm {}\n', ['mobile-ios']);
    await reviewed(s);
    assert.equal(s.gh.count('dispatchWorkflow'), 0, 'no macOS runner is started');
    assert.equal(pr(s).tests?.state, 'success');
    assert.match(pr(s).tests!.summary, /post-merge review on the Mac/);
    assert.equal(s.gh.status(head, 'workplace/tests')?.state, 'success');
  } finally { s.done(); }
});

test('android and ios both deferred: only mobile-android is dispatched', async () => {
  const s = setup('on');
  try {
    s.commit('mobile/android/app/Alarm.kt', 'class Alarm\n', ['mobile-android', 'mobile-ios']);
    await reviewed(s);
    assert.equal(s.gh.runs[0]!.inputs['areas'], 'mobile-android');
  } finally { s.done(); }
});
