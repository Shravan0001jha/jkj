import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Workplace } from '../src/services/workplace.js';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as trail from '../src/services/trail.js';
import * as flow from '../src/services/github-flow.js';
import * as evidence from '../src/services/evidence.js';
import * as employees from '../src/services/employees.js';
import { employee, workplaceTools } from '../src/services/employees.js';
import { ensureWorktree } from '../src/services/worktrees.js';
import { rawGet } from '../src/services/v2-map.js';
import { testWorkplace } from './fakes/workplace.js';
import { FakeGitHub } from './fakes/fake-github.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { FakeBuilder, FakeRunner, FakeStaging, FakeStore } from './fakes/fake-evidence.js';
import { useEvidenceStore } from '../src/services/evidence-share.js';

/**
 * Infra checkpoint 7 (docs/HLD-evidence.md): run_evidence queues a robot-suite run for a story's
 * head commit, returns at once, runs at most two at a time, builds the app from a server-owned
 * checkout with a cache, and records the result on the item (and on the PR in shadow/on).
 */

const runtime = installFakeRuntime();
after(() => runtime.restore());
const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });

interface Setup {
  wp: Workplace;
  runner: FakeRunner;
  builder: FakeBuilder;
  staging: FakeStaging;
  store: FakeStore;
  repo: string;
  storyId: string;
  wt: string;
  /** Commit on the story's branch (Kabir has one worktree for all his stories). */
  commit(file: string, content: string, storyId?: string): string;
  story(title: string): { id: string; wt: string };
  done(): Promise<void>;
}

function setup(opts: { auto?: boolean } = {}): Setup {
  const { wp, tmp } = testWorkplace();
  const kabir = employee(wp, 'kabir');
  wp.org.employees.push({ ...kabir, id: 'arjun', name: 'Arjun', roleId: 'engineer', level: 2, charterIds: ['memory'], reportsTo: 'kabir' });
  const repo = kabir.workspace.repo;
  // The trunk carries the app, like the Iris repo.
  for (const [f, c] of [['mobile/android/app/Main.kt', 'fun main() {}\n'], ['mobile/ios/Iris/Api.swift', 'let x = 1\n'], ['services/agent-svc/app.py', 'x = 0\n']]) {
    mkdirSync(join(repo, f!, '..'), { recursive: true });
    writeFileSync(join(repo, f!), c!);
  }
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.email=t@iris.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'app']);

  const runner = new FakeRunner();
  runner.auto = !!opts.auto;
  const builder = new FakeBuilder(checkout => git(checkout, ['rev-parse', 'HEAD']).trim());
  const staging = new FakeStaging();
  evidence.useEvidencePorts(wp, { runner, builder, staging });
  const store = new FakeStore();
  useEvidenceStore(wp, store);

  const epic = items.create(wp, { level: 'epic', title: 'Memory' }, 'owner');
  const make = (title: string): { id: string; wt: string } => {
    const s = items.create(wp, { level: 'story', title, parentId: epic.id, assigneeId: 'kabir' }, 'owner');
    return { id: s.id, wt: ensureWorktree(wp.config.workDir, kabir, s.id).path };
  };
  const first = make('Recall the last song');
  const st: Setup = {
    wp, runner, builder, staging, store, repo, storyId: first.id, wt: first.wt,
    commit: (file, content, storyId = st.storyId) => {
      const at = st.wt;
      git(at, ['checkout', '-q', `emp/kabir/${storyId}`]);
      mkdirSync(join(at, file, '..'), { recursive: true });
      writeFileSync(join(at, file), content);
      git(at, ['add', '-A']);
      git(at, ['-c', 'user.email=k@iris.local', '-c', 'user.name=kabir', 'commit', '-q', '-m', `change ${file}`]);
      return git(at, ['rev-parse', 'HEAD']).trim();
    },
    story: (title: string) => make(title),
    done: async () => {
      runner.auto = true;
      while (runner.pending.length) runner.finish();
      await evidence.settled(wp);
      evidence.stopAll(wp);
      tmp.cleanup();
    },
  };
  return st;
}

const until = async (cond: () => boolean, what: string, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 5));
  }
};

const comments = (wp: Workplace, id: string): string[] => trail.comments(wp, id).map(c => `${c.text}\n${c.details ?? ''}`);

async function toolClient(wp: Workplace, employeeId: string, assignmentId?: string): Promise<Client> {
  const server = workplaceTools(wp, employeeId, () => ({ agentId: 'a', employeeId, ...(assignmentId ? { assignmentId } : {}), startedAt: '', seen: {}, planCaptured: false }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(st);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(ct);
  return client;
}
const text = (r: unknown): string => ((r as { content: { text: string }[] }).content.map(c => c.text).join('\n'));

/* ---------- the tool returns at once ---------- */

test('run_evidence returns at once with "queued (position N)" and never waits for the run', async () => {
  const s = setup();
  try {
    const head = s.commit('services/agent-svc/recall.py', 'x = 1\n');
    const client = await toolClient(s.wp, 'kabir', s.storyId);
    const reply = text(await client.callTool({ name: 'run_evidence', arguments: { platforms: 'android', features: 'queries' } }));
    assert.match(reply, /queued \(position 1\)/);
    assert.match(reply, /simulators against the staging server/);
    assert.match(reply, new RegExp(head.slice(0, 8)));
    // The run is still in flight (the fake runner waits for the test): the reply came first.
    await until(() => s.runner.calls.length === 1, 'the run to start');
    assert.equal(rawGet(s.wp, s.storyId)!.evidenceRun, undefined, 'nothing recorded yet');
    const call = s.runner.calls[0]!;
    assert.deepEqual(call.platforms, ['android']);
    assert.deepEqual(call.features, ['queries']);
    assert.equal(call.api, s.wp.config.evidence.stagingUrl);
    assert.ok(call.apps.android, 'the built APK is handed to the runner');
    assert.ok(call.out.startsWith(join(s.wp.config.evidence.dir, s.storyId, head.slice(0, 12) + '-')), 'stored under evidence/<item>/<sha>-<ts>');
    assert.ok(!call.checkout.startsWith(s.wt) && call.checkout.includes('_evidence'), 'a server-owned checkout, never the employee worktree');
    assert.equal(git(call.checkout, ['rev-parse', 'HEAD']).trim(), head, 'at the branch head');
    assert.equal(s.staging.calls, 1, 'staging is brought up');
    await client.close();
  } finally { await s.done(); }
});

/* ---------- the queue: FIFO, two slots ---------- */

test('at most two runs at once (slots 1 and 2); the third waits FIFO and takes the freed slot; GET state shows it', async () => {
  const s = setup();
  try {
    s.commit('services/agent-svc/a.py', 'a = 1\n');
    const b = s.story('Second story'); s.commit('services/agent-svc/b.py', 'b = 1\n', b.id);
    const c = s.story('Third story'); s.commit('services/agent-svc/c.py', 'c = 1\n', c.id);
    const r1 = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    const r2 = evidence.request(s.wp, { itemId: b.id, by: 'kabir', platforms: 'ios', features: 'memory' });
    const r3 = evidence.request(s.wp, { itemId: c.id, by: 'kabir', platforms: 'android', features: 'files' });
    assert.ok(r1.ok && r2.ok && r3.ok);
    assert.equal(r1.position, 1);
    assert.equal(r2.position, 2);
    assert.equal(r3.position, 3);
    await until(() => s.runner.calls.length === 2, 'two runs');
    await new Promise(r => setTimeout(r, 30));
    assert.equal(s.runner.calls.length, 2, 'never a third at once');
    assert.deepEqual(s.runner.calls.map(c => c.slot).sort(), [1, 2]);
    const st = evidence.state(s.wp);
    assert.equal(st.slots.filter(x => x.job).length, 2);
    assert.deepEqual(st.queued.map(j => j.itemId), [c.id]);
    assert.equal(st.queued[0]!.position, 1);

    const firstSlot = s.runner.calls[0]!.slot;
    s.runner.finish();
    await until(() => s.runner.calls.length === 3, 'the third run');
    assert.equal(s.runner.calls[2]!.slot, firstSlot, 'the third takes the freed slot');
    assert.deepEqual(s.runner.calls.map(c => c.features[0]), ['queries', 'memory', 'files'], 'FIFO');
    s.runner.finish(); s.runner.finish();
    await evidence.settled(s.wp);
    const after = evidence.state(s.wp);
    assert.equal(after.queued.length, 0);
    assert.equal(after.recent.length, 3);
  } finally { await s.done(); }
});

test('the same request twice while it is queued or running returns its place, not a second run', async () => {
  const s = setup();
  try {
    s.commit('services/agent-svc/a.py', 'a = 1\n');
    const a = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    const b = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    assert.ok(a.ok && b.ok);
    assert.equal(b.job.id, a.job.id);
    await until(() => s.runner.calls.length === 1, 'the run');
    s.runner.finish();
    await evidence.settled(s.wp);
    assert.equal(s.runner.calls.length, 1);
  } finally { await s.done(); }
});

/* ---------- delivery ---------- */

test('the result goes to the caller\'s open session as the summary only, and onto the item', async () => {
  const s = setup();
  try {
    s.commit('services/agent-svc/a.py', 'a = 1\n');
    employees.talk(s.wp, 'nikhil', 'Check the recall story');            // QA's open session
    const qaSession = runtime.last();
    const r = evidence.request(s.wp, { itemId: s.storyId, by: 'nikhil', platforms: 'android', features: 'queries' });
    assert.ok(r.ok, r.ok ? '' : r.message);
    await until(() => s.runner.calls.length === 1, 'the run');
    s.runner.finish({ verdict: 'FAIL' });
    await evidence.settled(s.wp);
    const msgs = qaSession.sent.map(m => m.text).filter(t => /Evidence/.test(t));
    assert.equal(msgs.length, 1, 'one message to the caller');
    const m = msgs[0]!;
    assert.match(m, /FAIL/);
    assert.match(m, /1 passed, 1 failed/);
    assert.match(m, /queries\.ask FAIL: no reply within 60 s/);
    assert.match(m, new RegExp(`Report: https://iris-workplace-evidence-\\d+\\.s3\\.ap-south-1\\.amazonaws\\.com/${s.storyId}/[0-9a-f]{12}-\\d{14}/evidence\\.html\\?`), 'the global link');
    assert.doesNotMatch(m, /127\.0\.0\.1/);
    assert.doesNotMatch(m, /shots\//, 'no screenshots in the message');
    const rec = rawGet(s.wp, s.storyId)!.evidenceRun!;
    assert.equal(rec.state, 'failure');
    assert.equal(rec.by, 'nikhil');
    const c = comments(s.wp, s.storyId).find(t => /Evidence/.test(t))!;
    assert.match(c, /FAIL/);
    assert.match(c, /report/i);
    const job = evidence.state(s.wp).recent[0]!;
    assert.equal(job.delivered, 'session');
  } finally { await s.done(); }
});

test('with no open session the result is delivered on the item (comment + record)', async () => {
  const s = setup({ auto: true });
  try {
    const head = s.commit('services/agent-svc/a.py', 'a = 1\n');
    const before = runtime.sessions.length;
    const r = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android,ios', features: 'queries,memory' });
    assert.ok(r.ok);
    await evidence.settled(s.wp);
    assert.equal(runtime.sessions.length, before, 'no session is started for it');
    const rec = rawGet(s.wp, s.storyId)!.evidenceRun!;
    assert.equal(rec.state, 'success');
    assert.equal(rec.sha, head);
    assert.deepEqual(rec.platforms, ['android', 'ios']);
    assert.equal(rec.passed, 4);
    assert.equal(rec.failed, 0);
    const c = comments(s.wp, s.storyId).find(t => /Evidence PASS/.test(t));
    assert.ok(c, 'the summary is on the item');
    assert.match(c!, /4 passed, 0 failed/);
    assert.match(c!, /Report: https:\/\/iris-workplace-evidence-/);
    assert.equal(evidence.state(s.wp).recent[0]!.delivered, 'item');
  } finally { await s.done(); }
});

/* ---------- stale ---------- */

test('a commit on the branch during the run makes the evidence stale, never success', async () => {
  const s = setup();
  try {
    const first = s.commit('services/agent-svc/a.py', 'a = 1\n');
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await until(() => s.runner.calls.length === 1, 'the run');
    s.runner.finish({ verdict: 'PASS', during: () => { s.commit('services/agent-svc/a.py', 'a = 2\n'); } });
    await evidence.settled(s.wp);
    const rec = rawGet(s.wp, s.storyId)!.evidenceRun!;
    assert.equal(rec.sha, first);
    assert.equal(rec.state, 'stale');
    assert.match(comments(s.wp, s.storyId).find(t => /Evidence/.test(t))!, /STALE/);
    assert.match(comments(s.wp, s.storyId).find(t => /Evidence/.test(t))!, /run_evidence again/);
  } finally { await s.done(); }
});

/* ---------- refusals ---------- */

test('refusals: Mac desktop, Windows, no commits, someone else\'s story, no story; each says the next step', async () => {
  const s = setup();
  try {
    for (const p of ['mac', 'desktop', 'android,mac']) {
      const r = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: p, features: 'voice' });
      assert.equal(r.ok, false);
      assert.equal(r.ok ? '' : r.message, 'Mac desktop checks need a live window from the COO; ask on the item.');
    }
    const win = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'windows', features: 'queries' });
    assert.match(win.ok ? '' : win.message, /QA/);
    const none = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    assert.equal(none.ok, false, 'no commits past the trunk yet');
    assert.match(none.ok ? '' : none.message, /commit/i);
    assert.match(none.ok ? '' : none.message, /run_evidence again/);
    s.commit('services/agent-svc/a.py', 'a = 1\n');
    const outsider = evidence.request(s.wp, { itemId: s.storyId, by: 'arjun', platforms: 'android', features: 'queries' });
    assert.equal(outsider.ok, false);
    assert.match(outsider.ok ? '' : outsider.message, /ask/i);
    const bad = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries; rm -rf /' });
    assert.equal(bad.ok, false);
    const missing = evidence.request(s.wp, { itemId: 'as_nope', by: 'kabir', platforms: 'android', features: 'queries' });
    assert.equal(missing.ok, false);
    // Every refusal ends with what to do next, in one sentence.
    for (const r of [win, none, outsider, bad, missing]) assert.match(r.ok ? '' : r.message, /\.$/);
    // Through the tool: no story attached to the session.
    const client = await toolClient(s.wp, 'kabir');
    assert.match(text(await client.callTool({ name: 'run_evidence', arguments: { platforms: 'mac', features: 'voice' } })), /live window from the COO/);
    assert.match(text(await client.callTool({ name: 'run_evidence', arguments: { platforms: 'android', features: 'queries' } })), /Name the story/);
    await client.close();
    assert.equal(s.runner.calls.length, 0, 'nothing ran');
  } finally { await s.done(); }
});

test('features are checked at call time against the runner\'s list: "setup" and unknown names are refused at once, listing the allowed ones', async () => {
  const s = setup();
  try {
    s.commit('services/agent-svc/a.py', 'a = 1\n');
    for (const f of ['setup', 'queries,setup', 'memroy']) {
      const r = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: f });
      assert.equal(r.ok, false, f);
      const m = r.ok ? '' : r.message;
      assert.match(m, /queries, voice, memory, music, dance, files, timer, reminder, apps, errand/);
      assert.match(m, /setup always runs/i);
      assert.equal(m.split(/\.\s/).length, 1, 'one sentence');
    }
    assert.ok(evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'all' }).ok);
    // The list comes from the runner in the story's own commit when it has one (e2e/scripts/local-run.sh).
    const head = s.commit('e2e/scripts/local-run.sh', '#!/usr/bin/env bash\nALL_FEATURES=queries,newthing\n');
    const r = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'ios', features: 'newthing' });
    assert.ok(r.ok, r.ok ? '' : r.message);
    const old = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'ios', features: 'files' });
    assert.match(old.ok ? '' : old.message, /queries, newthing/);
    assert.ok(head);
    // Through the tool, with the allowed values in its description.
    const client = await toolClient(s.wp, 'kabir', s.storyId);
    const tools = await client.listTools();
    const desc = tools.tools.find(t => t.name === 'run_evidence')!.description!;
    assert.match(desc, /queries, voice, memory, music, dance, files, timer, reminder, apps, errand/);
    assert.match(desc, /setup always runs/i);
    assert.match(text(await client.callTool({ name: 'run_evidence', arguments: { platforms: 'android', features: 'setup' } })), /setup always runs/i);
    await client.close();
  } finally { await s.done(); }
});

/* ---------- the build cache ---------- */

test('build cache: a story with no app change reuses the trunk build; an app change builds; the same app tree hits', async () => {
  const s = setup({ auto: true });
  try {
    const trunkHead = git(s.repo, ['rev-parse', 'feat/iris-character']).trim();
    s.commit('services/agent-svc/a.py', 'a = 1\n');
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await evidence.settled(s.wp);
    assert.equal(s.builder.builds.length, 1, 'miss: one build');
    assert.equal(s.builder.heads[0], trunkHead, 'no app change: built from the trunk head');

    // Another commit that touches no app code: the trunk build is reused.
    s.commit('services/agent-svc/a.py', 'a = 2\n');
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await evidence.settled(s.wp);
    assert.equal(s.builder.builds.length, 1, 'hit: no new build');
    assert.equal(s.runner.calls[1]!.apps.android, s.runner.calls[0]!.apps.android);

    // A different story with no app change shares it too.
    const b = s.story('Other story'); s.commit('services/agent-svc/b.py', 'b = 1\n', b.id);
    evidence.request(s.wp, { itemId: b.id, by: 'kabir', platforms: 'android', features: 'queries' });
    await evidence.settled(s.wp);
    assert.equal(s.builder.builds.length, 1);

    // An app change: built from the story's own head.
    const appHead = s.commit('mobile/android/app/Main.kt', 'fun main() { println(1) }\n');
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await evidence.settled(s.wp);
    assert.equal(s.builder.builds.length, 2, 'miss after an app change');
    assert.equal(s.builder.heads[1], appHead);
    assert.notEqual(s.runner.calls[3]!.apps.android, s.runner.calls[0]!.apps.android);

    // A later commit outside the app keeps the same app tree: hit.
    s.commit('services/agent-svc/a.py', 'a = 3\n');
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await evidence.settled(s.wp);
    assert.equal(s.builder.builds.length, 2, 'same app tree: hit');

    // iOS has its own cache key.
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'ios', features: 'queries' });
    await evidence.settled(s.wp);
    assert.equal(s.builder.builds.length, 3);
    assert.equal(s.builder.builds[2]!.platform, 'ios');
  } finally { await s.done(); }
});

test('a build that fails on the story\'s code is a failed run with the build log, and nothing is run', async () => {
  const s = setup({ auto: true });
  try {
    s.commit('mobile/android/app/Main.kt', 'fun main( {\n');
    s.builder.failNext = true;
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await evidence.settled(s.wp);
    assert.equal(s.runner.calls.length, 0);
    const rec = rawGet(s.wp, s.storyId)!.evidenceRun!;
    assert.equal(rec.state, 'failure');
    assert.match(rec.note ?? '', /build failed/);
  } finally { await s.done(); }
});

test('staging that does not come up is an error for the COO, not a failure of the story', async () => {
  const s = setup({ auto: true });
  try {
    s.commit('services/agent-svc/a.py', 'a = 1\n');
    s.staging.fail = true;
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await evidence.settled(s.wp);
    assert.equal(s.runner.calls.length, 0);
    const rec = rawGet(s.wp, s.storyId)!.evidenceRun!;
    assert.equal(rec.state, 'error');
    assert.match(rec.note ?? '', /staging/);
  } finally { await s.done(); }
});

/* ---------- local and shadow ---------- */

test('local mode: the evidence is recorded on the item and GitHub is never called', async () => {
  const s = setup({ auto: true });
  const gh = new FakeGitHub(s.repo);
  flow.useGitHub(s.wp, gh);
  try {
    assert.equal(flow.mode(s.wp), 'local');
    s.commit('services/agent-svc/a.py', 'a = 1\n');
    work.reportDone(s.wp, s.storyId, { tests: { passed: 1, failed: 0 }, commits: ['x'], liveVerified: [], notVerified: [] }, 'kabir');
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await evidence.settled(s.wp);
    assert.equal(rawGet(s.wp, s.storyId)!.evidenceRun!.state, 'success');
    assert.equal(rawGet(s.wp, s.storyId)!.pr, undefined);
    assert.equal(gh.calls.length, 0, 'no status, no push');
  } finally { gh.cleanup(); await s.done(); }
});

function shadow(s: Setup): FakeGitHub {
  writeFileSync(join(s.wp.config.workplaceDir, 'quality.yaml'), 'maxFileBytes: 100000\nareas: {}\n');
  const gh = new FakeGitHub(s.repo);
  flow.useGitHub(s.wp, gh);
  flow.setMode(s.wp, 'shadow', 'coo');
  return gh;
}

test('shadow: a run on the PR\'s head posts workplace/evidence success, or failure', async () => {
  const s = setup({ auto: true });
  const gh = shadow(s);
  try {
    const head = s.commit('services/agent-svc/a.py', 'a = 1\n');
    work.reportDone(s.wp, s.storyId, { tests: { passed: 1, failed: 0 }, commits: ['x'], liveVerified: [], notVerified: [] }, 'kabir');
    const r = await flow.onReview(s.wp, s.storyId, 'kabir');
    await r.tests;
    assert.equal(gh.status(head, 'workplace/evidence')?.state, 'pending');
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await evidence.settled(s.wp);
    assert.equal(gh.status(head, 'workplace/evidence')?.state, 'success');
    assert.equal(rawGet(s.wp, s.storyId)!.pr!.evidence, 'success');

    s.runner.defaultScript = { verdict: 'FAIL' };
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'ios', features: 'queries' });
    await evidence.settled(s.wp);
    assert.equal(gh.status(head, 'workplace/evidence')?.state, 'failure');
  } finally { await flow.settled(); gh.cleanup(); await s.done(); }
});

test('shadow: a stale run leaves workplace/evidence pending; evidence run before the PR is taken over when it opens', async () => {
  const s = setup();
  const gh = shadow(s);
  try {
    const head = s.commit('services/agent-svc/a.py', 'a = 1\n');
    // Handbook order: evidence (step 4) before submitting (step 5).
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await until(() => s.runner.calls.length === 1, 'the run');
    s.runner.finish();
    await evidence.settled(s.wp);
    assert.equal(rawGet(s.wp, s.storyId)!.evidenceRun!.state, 'success');
    work.reportDone(s.wp, s.storyId, { tests: { passed: 1, failed: 0 }, commits: ['x'], liveVerified: [], notVerified: [] }, 'kabir');
    await (await flow.onReview(s.wp, s.storyId, 'kabir')).tests;
    assert.equal(rawGet(s.wp, s.storyId)!.pr!.evidence, 'success', 'taken over from the item');
    assert.equal(gh.status(head, 'workplace/evidence')?.state, 'success');

    // Now a run during which a commit lands: stale; the head's status is not success.
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'ios', features: 'queries' });
    await until(() => s.runner.calls.length === 2, 'the second run');
    let moved = '';
    s.runner.finish({ verdict: 'PASS', during: () => { moved = s.commit('services/agent-svc/a.py', 'a = 9\n'); } });
    await evidence.settled(s.wp);
    assert.equal(rawGet(s.wp, s.storyId)!.evidenceRun!.state, 'stale');
    await flow.syncHeads(s.wp);
    await flow.settled();
    assert.notEqual(gh.status(moved, 'workplace/evidence')?.state, 'success');
  } finally { await flow.settled(); gh.cleanup(); await s.done(); }
});

/* ---------- restart ---------- */

test('a job that was running when the Workplace stopped is queued again on boot, with a note on the item', async () => {
  const s = setup({ auto: true });
  try {
    const head = s.commit('services/agent-svc/a.py', 'a = 1\n');
    evidence.persistForTest(s.wp, {
      id: 'ev_restart1', itemId: s.storyId, by: 'kabir', platforms: ['android'], features: ['queries'],
      state: 'running', slot: 1, queuedAt: new Date(Date.now() - 60_000).toISOString(), startedAt: new Date().toISOString(),
      sha: head, pid: 2_147_000_000, attempts: 1,
    });
    const stop = evidence.startEvidence(s.wp);
    await until(() => s.runner.calls.length === 1, 'the run again');
    await evidence.settled(s.wp);
    stop();
    assert.ok(comments(s.wp, s.storyId).some(t => /restarted/.test(t) && /queued again/.test(t)));
    assert.equal(rawGet(s.wp, s.storyId)!.evidenceRun!.state, 'success');
  } finally { await s.done(); }
});

/* ---------- the global link (one self-contained HTML in the evidence bucket) ---------- */

const noisyRun = (r: { out: string }): void => {
  mkdirSync(join(r.out, 'raw', 'android'), { recursive: true });
  mkdirSync(join(r.out, 'logs', 'android'), { recursive: true });
  writeFileSync(join(r.out, 'raw', 'android', 'maestro-1.log'), 'raw\n');
  writeFileSync(join(r.out, 'logs', 'android', 'logcat.txt'), Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n') + '\n');
};

test('the shared copy is one HTML with the screenshots inlined and summary.txt; a PASS is slimmed locally, a FAIL keeps everything', async () => {
  const s = setup();
  try {
    s.commit('services/agent-svc/a.py', 'a = 1\n');
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await until(() => s.runner.calls.length === 1, 'the run');
    const pass = s.runner.finish({ verdict: 'PASS', during: noisyRun });
    await evidence.settled(s.wp);
    const rec = rawGet(s.wp, s.storyId)!.evidenceRun!;
    assert.ok(rec.share, 'a shared link');
    assert.equal(rec.share!.key, `${s.storyId}/${rec.run}/evidence.html`);
    assert.ok(Date.parse(rec.share!.expiresAt) - Date.now() > 6.9 * 24 * 3600_000, 'valid for 7 days');
    const html = s.store.objects.get(rec.share!.key)!;
    assert.match(html, /<img src="data:image\/png;base64,iVBORw==">/, 'the screenshot is inlined');
    assert.match(html, /summary\.txt/);
    assert.match(html, /verdict PASS/);
    assert.ok(!existsSync(join(pass.out, 'raw')), 'PASS: raw/ is deleted');
    const kept = readFileSync(join(pass.out, 'logs', 'android', 'logcat.txt'), 'utf8').trim().split('\n');
    assert.equal(kept.length, 300, 'PASS: a log keeps its last 300 lines');
    assert.equal(kept.at(-1), 'line 999');

    s.commit('services/agent-svc/a.py', 'a = 2\n');
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await until(() => s.runner.calls.length === 2, 'the second run');
    const fail = s.runner.finish({ verdict: 'FAIL', during: noisyRun });
    await evidence.settled(s.wp);
    assert.ok(existsSync(join(fail.out, 'raw', 'android', 'maestro-1.log')), 'FAIL: raw/ is kept');
    assert.equal(readFileSync(join(fail.out, 'logs', 'android', 'logcat.txt'), 'utf8').trim().split('\n').length, 1000, 'FAIL: logs kept whole');
  } finally { await s.done(); }
});

test('an upload that fails still counts as evidence; the comment says the link is unavailable', async () => {
  const s = setup({ auto: true });
  try {
    s.commit('services/agent-svc/a.py', 'a = 1\n');
    s.store.failPut = true;
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await evidence.settled(s.wp);
    const rec = rawGet(s.wp, s.storyId)!.evidenceRun!;
    assert.equal(rec.state, 'success');
    assert.equal(rec.share, undefined);
    const c = comments(s.wp, s.storyId).find(t => /Evidence PASS/.test(t))!;
    assert.match(c, /link unavailable/);
  } finally { await s.done(); }
});

test('shadow: the link is the evidence status target_url and a PR comment; the PR body has no 127.0.0.1 link; an expired link is re-signed on re-post', async () => {
  const s = setup({ auto: true });
  const gh = shadow(s);
  try {
    const head = s.commit('services/agent-svc/a.py', 'a = 1\n');
    work.reportDone(s.wp, s.storyId, { tests: { passed: 1, failed: 0 }, commits: ['x'], liveVerified: [], notVerified: [] }, 'kabir');
    await (await flow.onReview(s.wp, s.storyId, 'kabir')).tests;
    const pr = gh.prs[0]!;
    assert.doesNotMatch(pr.body, /127\.0\.0\.1|\/api\/items/, 'no loopback link in the PR body');
    assert.match(pr.body, new RegExp(`${s.storyId}.*Recall the last song`));
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await evidence.settled(s.wp);
    const rec = rawGet(s.wp, s.storyId)!.evidenceRun!;
    const st = gh.status(head, 'workplace/evidence')!;
    assert.equal(st.state, 'success');
    assert.equal(st.targetUrl, rec.share!.url);
    const posted = gh.comments.get(pr.number) ?? [];
    assert.equal(posted.length, 1);
    assert.ok(posted[0]!.includes(rec.share!.url), 'the PR comment carries the link');

    // Seven days later the status is re-posted: the link is signed again first.
    const cur = rawGet(s.wp, s.storyId)!;
    work.saveQuiet(s.wp, { ...cur, evidenceRun: { ...cur.evidenceRun!, share: { ...cur.evidenceRun!.share!, expiresAt: new Date(Date.now() - 1000).toISOString() } } });
    const before = s.store.signed;
    await flow.setEvidence(s.wp, s.storyId, 'success', 're-posted');
    assert.equal(s.store.signed, before + 1, 'signed again');
    const again = gh.status(head, 'workplace/evidence')!;
    assert.notEqual(again.targetUrl, rec.share!.url);
    assert.equal(again.targetUrl, rawGet(s.wp, s.storyId)!.evidenceRun!.share!.url, 'the fresh link is stored');
  } finally { await flow.settled(); gh.cleanup(); await s.done(); }
});
