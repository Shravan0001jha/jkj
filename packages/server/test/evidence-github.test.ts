import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as items from '../src/services/items.js';
import * as evidence from '../src/services/evidence.js';
import { GitHubRunner, type RunnerRequest } from '../src/services/evidence-ports.js';
import { employee } from '../src/services/employees.js';
import { ensureWorktree } from '../src/services/worktrees.js';
import { rawGet } from '../src/services/v2-map.js';
import { testWorkplace } from './fakes/workplace.js';
import { FakeGitHub } from './fakes/fake-github.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { FakeBuilder, FakeDeployer, FakeLock, FakeRunner, FakeStaging, FakeStore } from './fakes/fake-evidence.js';
import { useEvidenceStore } from '../src/services/evidence-share.js';

/**
 * run_evidence on GitHub (cloud migration, 17 Oct): the Linux server has no simulators or emulators,
 * so iris-e2e's suite.yml builds the story's commit and runs the robot suite against staging. The
 * runner pushes the branch, dispatches the suite, follows the run and unpacks its report where the
 * local runner would have written it; the rest of run_evidence is unchanged.
 */

const runtime = installFakeRuntime();
after(() => runtime.restore());
const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });

function repoWithBranch(): { repo: string; sha: string; cleanup(): void } {
  const repo = mkdtempSync(join(tmpdir(), 'iris-ev-gh-'));
  git(repo, ['init', '-q', '-b', 'feat/iris-character']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.email=t@iris.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'a']);
  git(repo, ['checkout', '-q', '-b', 'emp/kabir/as_1']);
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.email=t@iris.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'b']);
  return { repo, sha: git(repo, ['rev-parse', 'HEAD']).trim(), cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

const report = (verdict: 'PASS' | 'FAIL', withSummary = true): Record<string, string> => ({
  'report/results.json': JSON.stringify({ run_id: 'gh-1', verdict, counts: verdict === 'PASS' ? { PASS: 2 } : { PASS: 1, FAIL: 1 },
    platforms: { android: { tests: { 'setup.install': { status: 'PASS', ms: 1, note: '' }, 'queries.ask': verdict === 'PASS' ? { status: 'PASS', ms: 1, note: '' } : { status: 'FAIL', ms: 1, note: 'no reply within 60 s' } } } } }),
  ...(withSummary ? { 'report/summary.txt': `verdict ${verdict}\n\n${verdict === 'PASS' ? 'FAILURES none' : 'FAILURES (1)\n  android queries.ask FAIL: no reply within 60 s'}\n` } : {}),
  'report/shots/a.png': 'png',
});

function request(repo: string, sha: string, out: string): RunnerRequest {
  return { checkout: repo, platforms: ['android'], features: ['queries'], api: 'https://staging.irisforu.com', apps: {}, slot: 1, out, log: join(out, '..', 'runner.log'), sha, repo, branch: 'emp/kabir/as_1', requestId: 'as_1-run1' };
}

async function finishWhenDispatched(gh: FakeGitHub, conclusion: 'success' | 'failure', artifacts: Record<string, Record<string, string>>): Promise<void> {
  const end = Date.now() + 5000;
  while (!gh.runs.length) { if (Date.now() > end) throw new Error('never dispatched'); await new Promise(r => setTimeout(r, 5)); }
  gh.finishRun(conclusion, artifacts);
}

test('GitHubRunner pushes the branch, dispatches suite.yml for the commit and unpacks the report into out', async () => {
  const { repo, sha, cleanup } = repoWithBranch();
  const gh = new FakeGitHub(repo);
  const out = join(mkdtempSync(join(tmpdir(), 'iris-ev-out-')), 'run');
  try {
    const runner = new GitHubRunner(() => gh, { pollMs: 5, timeoutMs: 10_000 });
    assert.equal(runner.buildsApps, true);
    const [res] = await Promise.all([runner.run(request(repo, sha, out)), finishWhenDispatched(gh, 'success', { 'suite-report-900': report('PASS') })]);
    assert.equal(gh.remoteSha('emp/kabir/as_1'), sha, 'the commit is on GitHub before the dispatch');
    const run = gh.runs[0]!;
    assert.equal(run.workflow, 'suite.yml');
    assert.deepEqual(run.inputs, { iris_ref: sha, build_ref: sha, platforms: 'android', features: 'queries', target: 'staging', account_mode: 'new', windows_default_smoke: 'false', request_id: 'as_1-run1' });
    assert.equal(res.exitCode, 0);
    assert.match(res.stderrTail, /actions\/runs\/900/);
    assert.ok(existsSync(join(out, 'results.json')) && existsSync(join(out, 'shots', 'a.png')), 'the report sits where the local runner writes it');
    assert.equal(evidence.readOutcome(out, res).state, 'success');
  } finally { gh.cleanup(); cleanup(); }
});

test('a report without summary.txt gets one from results.json, so a red run lists its failures', async () => {
  const { repo, sha, cleanup } = repoWithBranch();
  const gh = new FakeGitHub(repo);
  const out = join(mkdtempSync(join(tmpdir(), 'iris-ev-out-')), 'run');
  try {
    const runner = new GitHubRunner(() => gh, { pollMs: 5, timeoutMs: 10_000 });
    const [res] = await Promise.all([runner.run(request(repo, sha, out)), finishWhenDispatched(gh, 'failure', { 'suite-report-900': report('FAIL', false) })]);
    assert.equal(res.exitCode, 1);
    const o = evidence.readOutcome(out, res);
    assert.equal(o.state, 'failure');
    assert.deepEqual(o.failures, ['android queries.ask FAIL: no reply within 60 s']);
    assert.equal(o.passed, 1);
  } finally { gh.cleanup(); cleanup(); }
});

test('no report, a refused push or a refused dispatch is plumbing (an error), never a pass', async () => {
  const { repo, sha, cleanup } = repoWithBranch();
  const gh = new FakeGitHub(repo);
  const base = mkdtempSync(join(tmpdir(), 'iris-ev-out-'));
  try {
    const runner = new GitHubRunner(() => gh, { pollMs: 5, timeoutMs: 10_000 });
    const [a] = await Promise.all([runner.run(request(repo, sha, join(base, 'a'))), finishWhenDispatched(gh, 'failure', {})]);
    assert.equal(a.exitCode, 2);
    assert.equal(evidence.readOutcome(join(base, 'a'), a).state, 'error');
    gh.failNext('push', 1, 'rejected: non-fast-forward');
    const b = await runner.run(request(repo, sha, join(base, 'b')));
    assert.equal(b.exitCode, 2);
    assert.match(b.stderrTail, /could not push emp\/kabir\/as_1.*non-fast-forward/);
    gh.failNext('dispatchWorkflow', 1, 'GitHub POST .../dispatches failed (422)');
    const c = await runner.run(request(repo, sha, join(base, 'c')));
    assert.equal(c.exitCode, 2);
    assert.match(c.stderrTail, /could not start suite\.yml.*422/);
  } finally { gh.cleanup(); cleanup(); rmSync(base, { recursive: true, force: true }); }
});

test('a run that never finishes stops at the timeout as an error', async () => {
  const { repo, sha, cleanup } = repoWithBranch();
  const gh = new FakeGitHub(repo);
  const out = join(mkdtempSync(join(tmpdir(), 'iris-ev-out-')), 'run');
  try {
    const runner = new GitHubRunner(() => gh, { pollMs: 5, timeoutMs: 50 });
    const res = await runner.run(request(repo, sha, out));
    assert.equal(res.exitCode, 2);
    assert.match(res.stderrTail, /did not finish/);
  } finally { gh.cleanup(); cleanup(); }
});

test('with a runner that builds the apps itself, run_evidence builds nothing here and hands it the commit and branch', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const kabir = employee(wp, 'kabir');
    const repo = kabir.workspace.repo;
    mkdirSync(join(repo, 'mobile/android/app'), { recursive: true });
    writeFileSync(join(repo, 'mobile/android/app/Main.kt'), 'fun main() {}\n');
    git(repo, ['add', '-A']);
    git(repo, ['-c', 'user.email=t@iris.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'app']);
    const runner = new FakeRunner();
    runner.auto = true;
    (runner as FakeRunner & { buildsApps: boolean }).buildsApps = true;
    const builder = new FakeBuilder();
    evidence.useEvidencePorts(wp, { runner, builder, staging: new FakeStaging(), lock: new FakeLock(), deployer: new FakeDeployer(() => '', () => 0) });
    useEvidenceStore(wp, new FakeStore());
    const epic = items.create(wp, { level: 'epic', title: 'Phone' }, 'owner');
    const story = items.create(wp, { level: 'story', title: 'Alarm', parentId: epic.id, assigneeId: 'kabir' }, 'owner');
    const wt = ensureWorktree(wp.config.workDir, kabir, story.id).path;
    writeFileSync(join(wt, 'mobile/android/app/Alarm.kt'), 'class Alarm\n');
    git(wt, ['add', '-A']);
    git(wt, ['-c', 'user.email=k@iris.local', '-c', 'user.name=kabir', 'commit', '-q', '-m', 'alarm']);
    const head = git(wt, ['rev-parse', 'HEAD']).trim();
    const r = evidence.request(wp, { itemId: story.id, by: 'kabir', platforms: 'android', features: 'queries' });
    assert.ok(!('refused' in r) || !r.refused, JSON.stringify(r));
    await evidence.settled(wp);
    assert.equal(builder.builds.length, 0, 'nothing is built on this machine');
    const call = runner.calls[0]!;
    assert.equal(call.sha, head);
    assert.equal(call.branch, `emp/kabir/${story.id}`);
    assert.equal(call.repo, repo);
    assert.match(call.requestId ?? '', new RegExp(`^${story.id}-${head.slice(0, 12)}-`));
    assert.deepEqual(call.apps, {});
    assert.equal(rawGet(wp, story.id)!.evidenceRun?.state, 'success');
    evidence.stopAll(wp);
  } finally { tmp.cleanup(); }
});

test('the GitHub runner is the default where evidence.runOn is github', () => {
  const { wp, tmp } = testWorkplace();
  try {
    wp.config.evidence.runOn = 'github';
    assert.ok(evidence.portsForTest(wp).runner instanceof GitHubRunner);
  } finally { tmp.cleanup(); }
  const local = testWorkplace();
  try {
    local.wp.config.evidence.runOn = 'local';
    assert.ok(!(evidence.portsForTest(local.wp).runner instanceof GitHubRunner));
  } finally { local.tmp.cleanup(); }
});

void readFileSync;
