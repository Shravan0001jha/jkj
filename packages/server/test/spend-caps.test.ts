import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workplace } from '../src/services/workplace.js';
import * as caps from '../src/services/spend-caps.js';
import * as spend from '../src/services/spend.js';
import * as floor from '../src/services/floor.js';
import * as inbox from '../src/services/inbox.js';
import * as coo from '../src/services/coo.js';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as trail from '../src/services/trail.js';
import * as flow from '../src/services/github-flow.js';
import * as evidence from '../src/services/evidence.js';
import * as costWatch from '../src/services/cost-watch.js';
import { GitHubRunner } from '../src/services/evidence-ports.js';
import { employee } from '../src/services/employees.js';
import { ensureWorktree } from '../src/services/worktrees.js';
import { rawGet } from '../src/services/v2-map.js';
import { testWorkplace } from './fakes/workplace.js';
import { FakeGitHub } from './fakes/fake-github.js';
import { writePrePr } from './fakes/pre-pr.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { FakeDeployer, FakeLock, FakeStaging, FakeBuilder, FakeStore } from './fakes/fake-evidence.js';
import { useEvidenceStore } from '../src/services/evidence-share.js';

/**
 * Hard daily spend limits (owner, 18 Oct), per IST day:
 *  1. GitHub Actions $5/day: past it the Workplace starts no GitHub Actions (evidence, mobile checks,
 *     any dispatch); a PR waiting on a mobile check stays pending, not failed.
 *  2. Agents' work $10/day (GitHub Actions + AI/API credits; AWS platform cost excluded, owner 18 Oct):
 *     the floor pauses, the COO is told, ONE owner decision "Resume for today" / "Keep paused";
 *     the next day starts unpaused.
 */

const runtime = installFakeRuntime();
after(() => runtime.restore());
const DAY = 86_400_000;
const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });
const capItems = (wp: Workplace) => inbox.list(wp).filter(i => i.context['spendCap'] === true);
const mac = (minutes: number) => ({ labels: ['macos-14'], startedAt: '2026-10-18T05:00:00Z', completedAt: new Date(Date.parse('2026-10-18T05:00:00Z') + minutes * 60_000).toISOString() });

/** Book `usd` of estimated GitHub spend for today (macOS minutes). */
function githubSpent(wp: Workplace, usd: number, runId = 1): void {
  const minutes = Math.round(usd / caps.RATES_USD_PER_MIN.macos);
  caps.recordRunCost(wp, { id: runId, workflow: 'suite.yml' }, [{ ...mac(minutes), completedAt: new Date().toISOString(), startedAt: new Date(Date.now() - minutes * 60_000).toISOString() }]);
}

test('job cost: rounded up to the minute, priced by runner OS', () => {
  assert.equal(caps.jobCostUsd({ labels: ['macos-14'], startedAt: '2026-10-18T05:00:00Z', completedAt: '2026-10-18T05:01:01Z' }), 0.124);
  assert.equal(caps.jobCostUsd({ labels: ['ubuntu-latest'], startedAt: '2026-10-18T05:00:00Z', completedAt: '2026-10-18T05:10:00Z' }), 0.06);
  assert.equal(caps.jobCostUsd({ labels: ['windows-2022'], startedAt: '2026-10-18T05:00:00Z', completedAt: '2026-10-18T05:00:10Z' }), 0.01);
  assert.equal(caps.jobCostUsd({ labels: ['self-hosted', 'macOS'], startedAt: null, completedAt: null }), 0, 'a job that never ran costs nothing');
});

test('GitHub spend today is the max of billed and estimated; $5 blocks; lifting unblocks; a new day resets', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const day = spend.dayOf();
    githubSpent(wp, 3);
    assert.equal(caps.githubBlock(wp), null);
    githubSpent(wp, 3, 1);
    assert.equal(caps.githubToday(wp).estimatedUsd, 2.976, 'the same run is counted once');
    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`cost:github:live:${day}`, '5.40');
    const t = caps.githubToday(wp);
    assert.equal(t.billedUsd, 5.4);
    assert.equal(t.usd, 5.4);
    const b = caps.githubBlock(wp);
    assert.ok(b);
    assert.equal(b.message, 'GitHub Actions paused for today: $5.40 spent of the $5 daily cap; resumes tomorrow or when the owner lifts it');
    assert.equal(caps.githubBlock(wp, Date.now() + DAY), null, 'tomorrow starts unblocked');
    caps.liftGithub(wp, 'owner');
    assert.equal(caps.githubBlock(wp), null, 'the owner lifted it for today');
  } finally { tmp.cleanup(); }
});

test('a completed run seen through the Workplace port is costed from its jobs, once', async () => {
  const { wp, tmp } = testWorkplace();
  const gh = new FakeGitHub(employee(wp, 'kabir').workspace.repo);
  try {
    flow.useGitHub(wp, gh);
    const port = flow.gitHubPort(wp);
    await port.dispatchWorkflow('suite.yml', { request_id: 'r1' });
    gh.jobs[900] = [{ labels: ['macos-14'], startedAt: new Date(Date.now() - 50 * 60_000).toISOString(), completedAt: new Date().toISOString() }, { labels: ['ubuntu-latest'], startedAt: new Date(Date.now() - 60_000).toISOString(), completedAt: new Date().toISOString() }];
    assert.equal((await port.findWorkflowRun('suite.yml', 'r1'))?.status, 'queued');
    assert.equal(caps.githubToday(wp).estimatedUsd, 0, 'nothing until it completes');
    gh.finishRun('success');
    await port.findWorkflowRun('suite.yml', 'r1');
    await port.findWorkflowRun('suite.yml', 'r1');
    assert.equal(caps.githubToday(wp).estimatedUsd, 3.106, '50 macOS min + 1 Linux min, once');
  } finally { gh.cleanup(); tmp.cleanup(); }
});

test('over $5 every workflow dispatch through the Workplace port is refused with the cap message', async () => {
  const { wp, tmp } = testWorkplace();
  const gh = new FakeGitHub(employee(wp, 'kabir').workspace.repo);
  try {
    flow.useGitHub(wp, gh);
    githubSpent(wp, 5.1);
    await assert.rejects(flow.gitHubPort(wp).dispatchWorkflow('anything.yml', {}), /GitHub Actions paused for today: \$5\.\d\d spent of the \$5 daily cap/);
    assert.equal(gh.count('dispatchWorkflow'), 0);
  } finally { gh.cleanup(); tmp.cleanup(); }
});

test('over $5 run_evidence on GitHub is refused clearly, and a queued run does not start the suite', async () => {
  const { wp, tmp } = testWorkplace();
  const kabir = employee(wp, 'kabir');
  const gh = new FakeGitHub(kabir.workspace.repo);
  try {
    flow.useGitHub(wp, gh);
    evidence.useEvidencePorts(wp, { runner: new GitHubRunner(() => flow.gitHubPort(wp), { pollMs: 5, timeoutMs: 2000 }), builder: new FakeBuilder(), staging: new FakeStaging(), lock: new FakeLock(), deployer: new FakeDeployer(() => '', () => 0) });
    useEvidenceStore(wp, new FakeStore());
    const epic = items.create(wp, { level: 'epic', title: 'Phone' }, 'owner');
    const story = items.create(wp, { level: 'story', title: 'Alarm', parentId: epic.id, assigneeId: 'kabir' }, 'owner');
    const wt = ensureWorktree(wp.config.workDir, kabir, story.id).path;
    writeFileSync(join(wt, 'Alarm.kt'), 'class Alarm\n');
    git(wt, ['add', '-A']);
    git(wt, ['-c', 'user.email=k@iris.local', '-c', 'user.name=kabir', 'commit', '-q', '-m', 'alarm']);
    githubSpent(wp, 5.5);
    const r = evidence.request(wp, { itemId: story.id, by: 'kabir', platforms: 'android', features: 'queries' });
    assert.equal(r.ok, false);
    assert.match(r.message, /GitHub Actions paused for today: \$5\.\d\d spent of the \$5 daily cap; resumes tomorrow or when the owner lifts it/);
    assert.equal(gh.count('dispatchWorkflow'), 0);
    assert.equal(gh.count('push'), 0);
    evidence.stopAll(wp);
  } finally { gh.cleanup(); tmp.cleanup(); }
});

test('over $5 a PR needing a mobile check stays pending (not failed), says why on the story, and dispatches once unblocked', async () => {
  const { wp, tmp } = testWorkplace();
  const kabir = employee(wp, 'kabir');
  wp.org.employees.push({ ...kabir, id: 'arjun', name: 'Arjun', roleId: 'engineer', level: 2, charterIds: ['memory'], reportsTo: 'kabir' });
  writeFileSync(join(wp.config.workplaceDir, 'quality.yaml'), 'maxFileBytes: 100000\nareas: {}\n');
  const gh = new FakeGitHub(kabir.workspace.repo);
  try {
    flow.useGitHub(wp, gh);
    flow.setMode(wp, 'on', 'coo');
    const epic = items.create(wp, { level: 'epic', title: 'Phone' }, 'owner');
    const story = items.create(wp, { level: 'story', title: 'Ring an alarm', parentId: epic.id, assigneeId: 'kabir' }, 'owner');
    const wt = ensureWorktree(wp.config.workDir, kabir, story.id).path;
    mkdirSync(join(wt, 'mobile/android/app'), { recursive: true });
    writeFileSync(join(wt, 'mobile/android/app/Alarm.kt'), 'class Alarm\n');
    git(wt, ['add', '-A']);
    git(wt, ['-c', 'user.email=k@iris.local', '-c', 'user.name=kabir', 'commit', '-q', '-m', 'alarm']);
    const head = git(wt, ['rev-parse', 'HEAD']).trim();
    writePrePr(wt, head, { deferred: ['mobile-android'] });
    githubSpent(wp, 5.2);

    work.reportDone(wp, story.id, { tests: { passed: 3, failed: 0, command: 'pytest' }, commits: ['abc'], liveVerified: [], notVerified: ['live'] }, 'kabir');
    await (await flow.onReview(wp, story.id, 'kabir')).tests;
    await flow.syncHeads(wp);
    assert.equal(gh.count('dispatchWorkflow'), 0, 'no mobile-checks dispatch while blocked');
    const pr = rawGet(wp, story.id)!.pr!;
    assert.equal(pr.tests?.state, 'pending', 'pending, not failed');
    assert.match(pr.tests!.summary, /GitHub Actions paused for today/);
    assert.equal(gh.status(head, 'workplace/tests')?.state, 'pending');
    const said = trail.comments(wp, story.id).filter(c => /GitHub Actions paused for today/.test(c.text));
    assert.equal(said.length, 1, 'said on the story once');
    assert.equal(flow.state(wp).mode, 'on', 'a cap refusal is not a GitHub failure: no fallback to local');

    caps.liftGithub(wp, 'owner');
    await flow.syncHeads(wp);
    assert.equal(gh.count('dispatchWorkflow'), 1, 'dispatched once the cap is lifted');
    assert.equal(rawGet(wp, story.id)!.pr!.tests?.state, 'pending');
  } finally { gh.cleanup(); tmp.cleanup(); }
});

test('$10 combined pauses the floor, tells the COO and raises ONE owner decision at once', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const usdInr = wp.config.usdInr;
    spend.record(wp, { employeeId: 'kabir', source: 'anthropic-api', basis: 'metered', what: 'api', inr: 6 * usdInr });
    assert.equal(floor.paused(wp), false);
    githubSpent(wp, 3.1);
    assert.equal(floor.paused(wp), false, '$9.10: not yet');
    spend.record(wp, { employeeId: 'kabir', source: 'third-party', basis: 'metered', what: 'deepgram', inr: 1 * usdInr });
    assert.equal(floor.paused(wp), true, '$10: paused');
    assert.match(floor.state(wp).reason ?? '', /\$10\.\d\d spent of the \$10 daily cap/);
    spend.record(wp, { employeeId: 'kabir', source: 'anthropic-api', basis: 'metered', what: 'api', inr: 1 * usdInr });
    caps.tick(wp);
    const items_ = capItems(wp);
    assert.equal(items_.length, 1, 'one decision');
    assert.equal(items_[0]!.kind, 'decision');
    assert.equal(items_[0]!.state, 'open', 'not held for the COO');
    assert.deepEqual(items_[0]!.options.map(o => o.label), ['Resume for today', 'Keep paused']);
    assert.equal(coo.listItems(wp).filter(i => /daily spend cap/i.test(i.title)).length, 1, 'the COO is told once');
    const s = caps.today(wp);
    assert.equal(s.floorPausedBySpend, true);
    assert.equal(s.combinedUsd.github, 3.1);
    assert.equal(s.combinedUsd.anthropicApi, 7);
    assert.equal(s.combinedUsd.thirdParty, 1);
  } finally { tmp.cleanup(); }
});

test('AWS platform cost never counts toward the combined cap', () => {
  const { wp, tmp } = testWorkplace();
  try {
    spend.record(wp, { employeeId: 'workplace', source: 'aws', basis: 'metered', what: 'server', inr: 50 * wp.config.usdInr });
    caps.tick(wp);
    assert.equal(floor.paused(wp), false);
    const s = caps.today(wp);
    assert.equal(s.combinedUsd.total, 0);
    assert.equal('aws' in s.combinedUsd, false);
  } finally { tmp.cleanup(); }
});

test('"Resume for today" lifts the pause for the rest of the day; the next day starts unpaused', () => {
  const { wp, tmp } = testWorkplace();
  try {
    spend.record(wp, { employeeId: 'kabir', source: 'anthropic-api', basis: 'metered', what: 'api', inr: 11 * wp.config.usdInr });
    assert.equal(floor.paused(wp), true);
    inbox.answer(wp, capItems(wp)[0]!.id, 'resume-today', undefined, 'phone');
    assert.equal(floor.paused(wp), false);
    spend.record(wp, { employeeId: 'kabir', source: 'anthropic-api', basis: 'metered', what: 'api', inr: 5 * wp.config.usdInr });
    caps.tick(wp);
    assert.equal(floor.paused(wp), false, 'stays resumed for today');
    assert.equal(capItems(wp).length, 1, 'no second decision today');
  } finally { tmp.cleanup(); }
});

test('"Keep paused" holds until the next IST day, which unpauses on its own and closes nothing new', () => {
  const { wp, tmp } = testWorkplace();
  try {
    spend.record(wp, { employeeId: 'kabir', source: 'anthropic-api', basis: 'metered', what: 'api', inr: 11 * wp.config.usdInr });
    inbox.answer(wp, capItems(wp)[0]!.id, 'keep-paused', undefined, 'phone');
    caps.tick(wp);
    assert.equal(floor.paused(wp), true);
    caps.tick(wp, Date.now() + DAY);
    assert.equal(floor.paused(wp), false, 'the next day starts unpaused');
    assert.equal(caps.today(wp, Date.now() + DAY).floorPausedBySpend, false);
  } finally { tmp.cleanup(); }
});

test('a pause someone else set is never lifted by the cap', () => {
  const { wp, tmp } = testWorkplace();
  try {
    floor.setPaused(wp, true, 'owner wants a break', 'owner');
    spend.record(wp, { employeeId: 'kabir', source: 'anthropic-api', basis: 'metered', what: 'api', inr: 11 * wp.config.usdInr });
    assert.equal(capItems(wp).length, 1, 'the owner still gets the decision');
    inbox.answer(wp, capItems(wp)[0]!.id, 'resume-today', undefined, 'phone');
    caps.tick(wp, Date.now() + DAY);
    assert.equal(floor.state(wp).by, 'owner');
    assert.equal(floor.paused(wp), true);
  } finally { tmp.cleanup(); }
});

test("today's GitHub bill is polled live (throttled) into cost:github:live:<day>", async () => {
  const { wp, tmp } = testWorkplace();
  try {
    let calls = 0;
    const port = { usageUsd: async (q: { year: number; month: number; day?: number }) => { calls += 1; assert.ok(q.day); return 4.25; } };
    const nowMs = Date.now();
    assert.equal(await costWatch.pollToday(wp, nowMs, port), 4.25);
    assert.equal(await costWatch.pollToday(wp, nowMs + 60_000, port), null, 'throttled');
    assert.equal(calls, 1);
    assert.equal(caps.githubToday(wp, nowMs).billedUsd, 4.25);
  } finally { tmp.cleanup(); }
});
