import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkItem } from '@jkj/shared';
import type { Workplace } from '../src/services/workplace.js';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as trail from '../src/services/trail.js';
import * as flow from '../src/services/github-flow.js';
import * as manager from '../src/services/manager.js';
import * as spend from '../src/services/spend.js';
import * as caps from '../src/services/spend-caps.js';
import { employee } from '../src/services/employees.js';
import { ensureWorktree } from '../src/services/worktrees.js';
import { rawGet } from '../src/services/v2-map.js';
import { testWorkplace } from './fakes/workplace.js';
import { FakeGitHub } from './fakes/fake-github.js';
import { writePrePr } from './fakes/pre-pr.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';

/**
 * Board bug 4 (19 Oct, as_mvdis9i3hqz29, PR #449): workplace/tests sat "Waiting for scripts/pre-pr.sh
 * results on dad2494" for 8 hours. Tara's pre-pr passed on her commit; the mobile checks were refused by
 * the GitHub cap, and that refusal was saved as a run record for the next head (dad2494, GitHub's own
 * update-branch merge). The next trunk-only move carried the refused record over and named dad2494 as
 * "the commit the run checks", whose pre-pr result nobody would ever write. After the cap lifted nothing
 * dispatched, and a pending status had no clock: nobody was told.
 */

const runtime = installFakeRuntime();
after(() => runtime.restore());
const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });

interface Setup { wp: Workplace; gh: FakeGitHub; storyId: string; wt: string; commit(file: string, content: string): string; done(): void }
function setup(): Setup {
  const { wp, tmp } = testWorkplace();
  const kabir = employee(wp, 'kabir');
  wp.org.employees.push({ ...kabir, id: 'arjun', name: 'Arjun', roleId: 'engineer', level: 2, charterIds: ['memory'], reportsTo: 'kabir' });
  writeFileSync(join(wp.config.workplaceDir, 'quality.yaml'), 'maxFileBytes: 100000\nareas: {}\n');
  const gh = new FakeGitHub(kabir.workspace.repo);
  flow.useGitHub(wp, gh);
  flow.setMode(wp, 'on', 'coo');
  const epic = items.create(wp, { level: 'epic', title: 'Phone' }, 'owner');
  const story = items.create(wp, { level: 'story', title: 'PhoneErrandRunner parity fixture', parentId: epic.id, assigneeId: 'kabir' }, 'owner');
  const wt = ensureWorktree(wp.config.workDir, kabir, story.id).path;
  const commit = (file: string, content: string): string => {
    mkdirSync(join(wt, file, '..'), { recursive: true });
    writeFileSync(join(wt, file), content);
    git(wt, ['add', '-A']);
    git(wt, ['-c', 'user.email=k@iris.local', '-c', 'user.name=kabir', 'commit', '-q', '-m', `add ${file}`]);
    const sha = git(wt, ['rev-parse', 'HEAD']).trim();
    writePrePr(wt, sha, { deferred: ['mobile-ios'] });
    return sha;
  };
  return { wp, gh, storyId: story.id, wt, commit, done: () => { gh.cleanup(); tmp.cleanup(); } };
}
const pr = (s: Setup): NonNullable<WorkItem['pr']> => rawGet(s.wp, s.storyId)!.pr!;
const evidence = { tests: { passed: 0, failed: 0, command: 'swift test' }, commits: ['abc'], liveVerified: [], notVerified: ['live'] };
/** The trunk moves and the branch merges it in (what GitHub's update-branch does): a trunk-only head move. */
function trunkOnlyMove(s: Setup): string {
  const repo = employee(s.wp, 'kabir').workspace.repo;
  writeFileSync(join(repo, `trunk-${Date.now()}-${Math.random()}.txt`), 'trunk moves\n');
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.email=t@iris.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'trunk moves']);
  git(s.wt, ['-c', 'user.email=k@iris.local', '-c', 'user.name=k', 'merge', '-q', '--no-edit', s.wp.config.github.trunk]);
  return git(s.wt, ['rev-parse', 'HEAD']).trim();
}
const capOn = (wp: Workplace): void => void wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`cost:github:live:${spend.dayOf()}`, '7.27');

test('as_mvdis9i3hqz29: capped mobile checks across two trunk-only moves dispatch for the current head once the cap lifts', async () => {
  const s = setup();
  try {
    s.commit('mobile/ios/PhoneErrandRunner.swift', 'struct Runner {}\n');
    capOn(s.wp);
    work.reportDone(s.wp, s.storyId, evidence, 'kabir');
    await (await flow.onReview(s.wp, s.storyId, 'kabir')).tests;
    assert.equal(pr(s).tests?.state, 'pending');
    assert.equal(s.gh.count('dispatchWorkflow'), 0, 'the cap holds the dispatch');
    // As on PR #449: each move is a sweep that pushes it, then a sweep that re-reads the pending tests.
    trunkOnlyMove(s);
    await flow.syncHeads(s.wp);
    await flow.syncHeads(s.wp);
    const head = trunkOnlyMove(s);
    await flow.syncHeads(s.wp);
    await flow.syncHeads(s.wp);
    assert.equal(pr(s).headSha, head);
    assert.doesNotMatch(pr(s).tests!.summary, /Waiting for scripts\/pre-pr\.sh results/, 'the author\'s pre-pr on her commit covers a trunk-only head');
    caps.liftGithub(s.wp, 'owner');
    await flow.syncHeads(s.wp);
    assert.equal(s.gh.count('dispatchWorkflow'), 1, 'dispatched once the cap lifts');
    assert.equal((s.gh.runs[0]!.inputs as Record<string, string>)['iris_ref'], head, 'for the current head');
    assert.match(pr(s).tests!.summary, /mobile checks .*on GitHub/);
  } finally { s.done(); }
});

test('class: a pre-pr result on the author\'s commit covers a head GitHub reached from it by update-branch (no mobile areas)', async () => {
  const s = setup();
  try {
    const sha = s.commit('services/agent-svc/phone.py', 'x = 1\n');
    writePrePr(s.wt, sha, {});   // a plain run: nothing deferred
    work.reportDone(s.wp, s.storyId, evidence, 'kabir');
    await (await flow.onReview(s.wp, s.storyId, 'kabir')).tests;
    assert.equal(pr(s).tests?.state, 'success');
    // A pending record on a new head (e.g. a sweep that ran before the carry): the covering result settles it.
    const head = trunkOnlyMove(s);
    work.saveQuiet(s.wp, { ...rawGet(s.wp, s.storyId)!, pr: { ...pr(s), headSha: head, tests: { state: 'pending', sha: head, at: new Date().toISOString(), summary: 'Waiting' } } });
    await flow.syncHeads(s.wp);
    assert.equal(pr(s).tests?.state, 'success');
  } finally { s.done(); }
});

test('a pending workplace/tests is never terminal: after an hour Asha is told, once, with what to do', async () => {
  const s = setup();
  try {
    s.commit('mobile/ios/PhoneErrandRunner.swift', 'struct Runner {}\n');
    // The author never ran pre-pr on the head: tests pend for want of a result.
    git(s.wt, ['-c', 'user.email=k@iris.local', '-c', 'user.name=kabir', 'commit', '-q', '--allow-empty', '-m', 'no pre-pr here']);
    work.reportDone(s.wp, s.storyId, evidence, 'kabir');
    await (await flow.onReview(s.wp, s.storyId, 'kabir')).tests;
    assert.equal(pr(s).tests?.state, 'pending');
    assert.ok(pr(s).tests!.pendingSince, 'a pending status carries its clock');
    assert.deepEqual(flow.pendingTestsAlarm(s.wp, Date.now() + 30 * 60_000), [], 'not before the hour');
    const raised = flow.pendingTestsAlarm(s.wp, Date.now() + 61 * 60_000);
    assert.deepEqual(raised, [s.storyId]);
    const alert = manager.list(s.wp).find(r => r.itemId === s.storyId && r.key.startsWith('tests-pending:'));
    assert.ok(alert, 'Asha has an alert (it goes to the COO if she does not act)');
    assert.match(alert.text ?? alert.body, /pre-pr/);
    assert.ok(trail.activityFor(s.wp, s.storyId).some(a => /workplace\/tests has been pending/.test(a.text)));
    assert.deepEqual(flow.pendingTestsAlarm(s.wp, Date.now() + 62 * 60_000), [], 'once per pending episode');
  } finally { s.done(); }
});
