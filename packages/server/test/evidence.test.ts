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
import { FakeBuilder, FakeDeployer, FakeLock, FakeRunner, FakeStaging, FakeStore } from './fakes/fake-evidence.js';
import { useEvidenceStore } from '../src/services/evidence-share.js';
import { setMacHostForTest } from '../src/services/mac-host.js';

// These cover behaviour on a Mac; mac-host.test.ts covers the cloud server with no Mac attached.
setMacHostForTest(true);

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
  lock: FakeLock;
  deployer: FakeDeployer;
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
  const lock = new FakeLock();
  const deployer = new FakeDeployer(checkout => git(checkout, ['rev-parse', 'HEAD']).trim(), () => runner.calls.length);
  evidence.useEvidencePorts(wp, { runner, builder, staging, lock, deployer });
  const store = new FakeStore();
  useEvidenceStore(wp, store);

  const epic = items.create(wp, { level: 'epic', title: 'Memory' }, 'owner');
  const make = (title: string): { id: string; wt: string } => {
    const s = items.create(wp, { level: 'story', title, parentId: epic.id, assigneeId: 'kabir' }, 'owner');
    return { id: s.id, wt: ensureWorktree(wp.config.workDir, kabir, s.id).path };
  };
  const first = make('Release gate: recall the last song');
  const st: Setup = {
    wp, runner, builder, staging, store, lock, deployer, repo, storyId: first.id, wt: first.wt,
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

test('run_evidence refuses ios (and all) for an ordinary story; a "Release gate" story may run it', async () => {
  const s = setup();
  try {
    const plain = s.story('Ring an alarm');
    s.commit('mobile/ios/Iris/Api.swift', 'let x = 2\n', plain.id);
    for (const platforms of ['ios', 'android,ios', 'all']) {
      const r = evidence.request(s.wp, { itemId: plain.id, by: 'kabir', platforms, features: 'queries' });
      assert.equal(r.ok, false, platforms);
      assert.match(r.ok ? '' : r.message, /release gate/i);
    }
    assert.ok(evidence.request(s.wp, { itemId: plain.id, by: 'kabir', platforms: 'android', features: 'queries' }).ok, 'android is unaffected');
    s.commit('mobile/ios/Iris/Api.swift', 'let x = 3\n');
    assert.ok(evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'ios', features: 'queries' }).ok, 'release-gate story (control)');
    assert.equal(evidence.isReleaseGate({ title: 'Release gate: iPhone UI verification' }), true);
    assert.equal(evidence.isReleaseGate({ title: 'Fix the release gate banner' }), false);
  } finally { await s.done(); }
});

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
    const b = s.story('Release gate: second story'); s.commit('services/agent-svc/b.py', 'b = 1\n', b.id);
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

test('features a platform does not support are refused before queueing, naming each platform\'s list and pointing voice and desktop checks to request_mac (gap #15)', async () => {
  const s = setup();
  try {
    s.commit('services/agent-svc/a.py', 'a = 1\n');
    for (const [p, f] of [['android', 'voice'], ['ios', 'apps'], ['android,ios', 'voice'], ['android', 'memory,music'], ['all', 'reminder']] as const) {
      const r = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: p, features: f });
      assert.equal(r.ok, false, `${p} / ${f}`);
      const m = r.ok ? '' : r.message;
      const bad = f.split(',').at(-1)!;
      assert.match(m, new RegExp(`\\b${bad}\\b`), 'names the unsupported feature');
      assert.doesNotMatch(m, /\bmemory is not\b/, 'a supported feature is not named as unsupported');
      for (const plat of p === 'all' ? ['android', 'ios'] : p.split(',')) assert.match(m, new RegExp(`${plat}: queries, memory, files, errand`), `lists ${plat}'s features`);
      assert.match(m, /request_mac/, 'points voice and desktop checks to the Mac queue');
      assert.match(m, /live check/i);
    }
    assert.equal(s.runner.calls.length, 0, 'nothing ran');
    assert.equal(s.builder.builds.length, 0, 'nothing was built');
    // Supported on at least one requested platform: queued (the runner runs each platform's share).
    const ok = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android,ios', features: 'queries,memory,files,errand' });
    assert.ok(ok.ok, ok.ok ? '' : ok.message);
    assert.ok(evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'ios', features: 'all' }).ok, '"all" means whatever each platform supports');
    // The list comes from the runner's own supported() in the story's commit when it has one.
    s.commit('e2e/scripts/local-run.sh', '#!/usr/bin/env bash\nALL_FEATURES=queries,voice,memory\nsupported() { case $1 in android) echo queries,voice;; ios) echo queries,memory;; mac) echo $ALL_FEATURES;; ios-uitests) echo \'\';; esac; }\n');
    assert.ok(evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'voice' }).ok, 'that runner supports voice on android');
    const ios = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'ios', features: 'voice' });
    assert.equal(ios.ok, false);
    assert.match(ios.ok ? '' : ios.message, /ios: queries, memory\b/);
    // Through the tool: the refusal, and the per-platform lists in its description.
    const client = await toolClient(s.wp, 'kabir', s.storyId);
    const desc = (await client.listTools()).tools.find(t => t.name === 'run_evidence')!.description!;
    assert.match(desc, /android: queries, memory, files, errand/);
    assert.match(desc, /ios: queries, memory, files, errand/);
    assert.match(desc, /desktop[^.]*queries, voice, memory, music, dance, files, timer, reminder, apps, errand/i);
    assert.match(desc, /windows[^.]*QA/i);
    assert.match(desc, /request_mac/);
    assert.match(text(await client.callTool({ name: 'run_evidence', arguments: { platforms: 'ios', features: 'voice' } })), /Not queued[\s\S]*request_mac/);
    await client.close();
  } finally { await s.done(); }
});

test('reminder on android is accepted when the trunk plan.mjs runs it (the plan is the source of truth, not a Workplace copy)', async () => {
  const s = setup();
  try {
    s.commit('services/agent-svc/a.py', 'a = 1\n');
    const before = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'reminder' });
    assert.equal(before.ok, false, 'no plan on trunk: the built-in fallback list refuses it');
    const plan = "export const PER = {\n  mac: { queries: 2, reminder: 2 },\n  android: { queries: 3, memory: 4, files: 4, errand: 5, reminder: 2 },\n  ios: { queries: 2, memory: 2 },\n  'windows-default': { queries: 1 },\n};\n";
    mkdirSync(join(s.repo, 'e2e/scripts'), { recursive: true });
    writeFileSync(join(s.repo, 'e2e/scripts/plan.mjs'), plan);
    git(s.repo, ['add', '-A']);
    git(s.repo, ['-c', 'user.email=t@iris.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'plan']);
    const r = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'reminder' });
    assert.ok(r.ok, r.ok ? '' : r.message);
    const ios = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'ios', features: 'reminder' });
    assert.equal(ios.ok, false, 'ios is not in the plan for reminder');
    assert.match(ios.ok ? '' : ios.message, /ios: queries, memory\b/);
  } finally { await s.done(); }
});

test('plan.mjs is read from the story\'s own commit: a story that adds reminder to android is accepted while trunk\'s plan lacks it', async () => {
  const s = setup();
  try {
    const per = (extra: string) => `export const PER = {\n  mac: { queries: 2 },\n  android: { queries: 3, memory: 4, files: 4, errand: 5${extra} },\n  ios: { queries: 2, memory: 2 },\n};\n`;
    mkdirSync(join(s.repo, 'e2e/scripts'), { recursive: true });
    writeFileSync(join(s.repo, 'e2e/scripts/plan.mjs'), per(''));
    git(s.repo, ['add', '-A']);
    git(s.repo, ['-c', 'user.email=t@iris.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'plan']);
    s.commit('e2e/scripts/plan.mjs', per(', reminder: 2'));
    const r = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'reminder' });
    assert.ok(r.ok, r.ok ? '' : r.message);
    // A story that does not touch plan.mjs uses its head's plan (= the trunk's).
    const b = s.story('Other plan story'); s.commit('services/agent-svc/b.py', 'b = 1\n', b.id);
    const no = evidence.request(s.wp, { itemId: b.id, by: 'kabir', platforms: 'android', features: 'reminder' });
    assert.equal(no.ok, false);
    assert.match(no.ok ? '' : no.message, /android: queries, memory, files, errand\b/);
    assert.ok(evidence.request(s.wp, { itemId: b.id, by: 'kabir', platforms: 'android', features: 'errand' }).ok);
  } finally { await s.done(); }
});

test('iris-e2e plan.mjs (what GitHub runs) is the source; the story\'s copy wins only when its commit changes it', async () => {
  const s = setup();
  try {
    const per = (extra: string) => `export const PER = {\n  mac: { queries: 2 },\n  android: { queries: 3, memory: 4, files: 4, errand: 5${extra} },\n  ios: { queries: 2, memory: 2 },\n};\n`;
    mkdirSync(join(s.repo, 'e2e/scripts'), { recursive: true });
    writeFileSync(join(s.repo, 'e2e/scripts/plan.mjs'), per(', reminder: 2'));
    git(s.repo, ['add', '-A']);
    git(s.repo, ['-c', 'user.email=t@iris.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'plan']);
    s.commit('services/agent-svc/a.py', 'a = 1\n');
    evidence.setE2ePlanFetcher(() => per(', timer: 3'));
    const timer = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'timer' });
    assert.ok(timer.ok, timer.ok ? '' : timer.message);
    const rem = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'reminder' });
    assert.equal(rem.ok, false, 'iris copy lists reminder but GitHub does not run it');
    // A story whose commit changes plan.mjs is honoured.
    const b = s.story('Plan story'); s.commit('e2e/scripts/plan.mjs', per(', reminder: 2, voice: 1'), b.id);
    assert.ok(evidence.request(s.wp, { itemId: b.id, by: 'kabir', platforms: 'android', features: 'voice' }).ok);
  } finally { evidence.setE2ePlanFetcher(null); await s.done(); }
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
    assert.match(pr.body, new RegExp(`${s.storyId}.*[Rr]ecall the last song`));
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

/* ---------- staging "in use" ---------- */

test('staging is held "in use" while a run is queued or running (about 25 min ahead, renewed), and released when the queue is empty', async () => {
  const s = setup();
  try {
    s.commit('services/agent-svc/a.py', 'a = 1\n');
    assert.equal(s.lock.holds.length, 0);
    const t0 = Date.now();
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await until(() => s.lock.holds.length === 1, 'the lock to be held at once');
    assert.ok(s.lock.holds[0]! - t0 >= 20 * 60_000 && s.lock.holds[0]! - t0 <= 30 * 60_000, 'held well past the 10-min renewal');
    assert.ok(evidence.LOCK_EVERY_MS <= 10 * 60_000, 'renewed at least every 10 min');
    await until(() => s.runner.calls.length === 1, 'the run');
    // A second request while one runs does not start a second heartbeat.
    s.commit('services/agent-svc/a.py', 'a = 2\n');
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'ios', features: 'queries' });
    await new Promise(r => setImmediate(r));
    assert.equal(s.lock.holds.length, 1);
    assert.equal(s.lock.releases, 0, 'not released while anything is queued or running');
    s.runner.finish();
    await until(() => s.runner.calls.length === 2, 'the second run');
    assert.equal(s.lock.releases, 0);
    s.runner.finish();
    await evidence.settled(s.wp);
    await until(() => s.lock.releases === 1, 'the release');
  } finally { await s.done(); }
});

/* ---------- the story's own server code on staging (Kabir via Asha, 5 Oct) ---------- */

const short = (sha: string): string => sha.slice(0, 8);

test('a story that changes iris-api deploys THAT commit to staging before the suite; the report and the PR comment name it; GET shows staging\'s commit', async () => {
  const s = setup({ auto: true });
  const gh = shadow(s);
  try {
    const head = s.commit('services/iris-api/app.py', 'ROUTE = "/v1/new"\n');
    work.reportDone(s.wp, s.storyId, { tests: { passed: 1, failed: 0 }, commits: ['x'], liveVerified: [], notVerified: [] }, 'kabir');
    await (await flow.onReview(s.wp, s.storyId, 'kabir')).tests;
    const r = evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    assert.ok(r.ok, r.ok ? '' : r.message);
    await evidence.settled(s.wp);
    assert.equal(s.deployer.calls.length, 1, 'deployed once');
    assert.equal(s.deployer.heads[0], head, 'from the evidence checkout at the story\'s commit');
    assert.equal(s.deployer.runsBefore[0], 0, 'before the suite ran');
    assert.ok(s.deployer.calls[0]!.checkout.includes('_evidence'), 'the server-owned checkout, never the employee worktree');
    assert.equal(s.runner.calls.length, 1);
    const rec = rawGet(s.wp, s.storyId)!.evidenceRun!;
    assert.equal(rec.state, 'success');
    assert.deepEqual(rec.server, { sha: head, deployed: true });
    const line = `server: iris-api and cloud-agent at ${short(head)} on staging`;
    assert.ok(comments(s.wp, s.storyId).some(c => c.includes(line)), 'the item comment names the deployed commit');
    const posted = gh.comments.get(gh.prs[0]!.number) ?? [];
    assert.ok(posted.some(c => c.includes(line)), 'the PR comment names the deployed commit');
    const st = evidence.state(s.wp).staging;
    assert.equal(st.state, 'deployed');
    assert.equal(st.sha, head);
    assert.equal(st.itemId, s.storyId);
    assert.deepEqual(evidence.stagingServer(s.wp), st);
  } finally { await flow.settled(); gh.cleanup(); await s.done(); }
});

test('a cloud-agent change deploys too; an app-only story never deploys and its report says which server commit staging was on', async () => {
  const s = setup({ auto: true });
  try {
    // Before any evidence deploy, staging's server commit is unknown.
    s.commit('mobile/android/app/Main.kt', 'fun main() { println(2) }\n');
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await evidence.settled(s.wp);
    assert.equal(s.deployer.calls.length, 0, 'app-only: no deploy');
    let rec = rawGet(s.wp, s.storyId)!.evidenceRun!;
    assert.deepEqual(rec.server, { sha: null, deployed: false });
    assert.ok(comments(s.wp, s.storyId).some(c => /server: staging's iris-api and cloud-agent commit is unknown/.test(c)));
    assert.equal(evidence.state(s.wp).staging.state, 'unknown');

    const b = s.story('Agent change');
    const agentHead = s.commit('services/cloud-agent/agent.py', 'x = 1\n', b.id);
    evidence.request(s.wp, { itemId: b.id, by: 'kabir', platforms: 'android', features: 'queries' });
    await evidence.settled(s.wp);
    assert.equal(s.deployer.calls.length, 1, 'cloud-agent change: deployed');
    assert.equal(s.deployer.heads[0], agentHead);

    s.commit('mobile/android/app/Main.kt', 'fun main() { println(3) }\n');
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await evidence.settled(s.wp);
    assert.equal(s.deployer.calls.length, 1, 'still no deploy for the app-only story');
    rec = rawGet(s.wp, s.storyId)!.evidenceRun!;
    assert.deepEqual(rec.server, { sha: agentHead, deployed: false });
    assert.ok(comments(s.wp, s.storyId).some(c => c.includes(`server: staging was on iris-api and cloud-agent at ${short(agentHead)}`)), 'the app-only report names staging\'s commit');
  } finally { await s.done(); }
});

test('server-touching runs are serialised; an app-only run still takes the free slot meanwhile', async () => {
  const s = setup();
  try {
    const aHead = s.commit('services/iris-api/a.py', 'a = 1\n');
    const b = s.story('Second server story'); const bHead = s.commit('services/iris-api/b.py', 'b = 1\n', b.id);
    const c = s.story('App-only story'); s.commit('services/agent-svc/c.py', 'c = 1\n', c.id);
    assert.ok(evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' }).ok);
    assert.ok(evidence.request(s.wp, { itemId: b.id, by: 'kabir', platforms: 'android', features: 'memory' }).ok);
    assert.ok(evidence.request(s.wp, { itemId: c.id, by: 'kabir', platforms: 'android', features: 'files' }).ok);
    await until(() => s.runner.calls.length === 2, 'two runs');
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(s.runner.calls.map(x => x.features[0]).sort(), ['files', 'queries'], 'the second server story waits; the app-only one runs');
    assert.deepEqual(s.deployer.heads, [aHead], 'one deploy so far');
    assert.deepEqual(evidence.state(s.wp).queued.map(j => j.itemId), [b.id]);

    const first = s.runner.pending.find(p => p.request.features[0] === 'queries')!;
    first.release();
    await until(() => s.runner.calls.length === 3, 'the second server story');
    assert.deepEqual(s.deployer.heads, [aHead, bHead], 'redeployed for the next server story');
    assert.equal(s.deployer.runsBefore[1], 2, 'its deploy came after the first server run finished');
    while (s.runner.pending.length) s.runner.finish();
    await evidence.settled(s.wp);
    const appOnly = rawGet(s.wp, c.id)!.evidenceRun!.server!;
    assert.equal(appOnly.deployed, false);
    assert.equal(appOnly.changedTo, bHead, 'the app-only run notes that staging was redeployed under it');
    assert.ok(comments(s.wp, c.id).some(t => t.includes(`staging was redeployed to ${short(bHead)} during the run`)));
    assert.equal(evidence.state(s.wp).staging.sha, bHead, 'staging is left as the last server run left it');
  } finally { await s.done(); }
});

test('a failed deploy is an error with the reason, never a pass; nothing runs against the old server', async () => {
  const s = setup({ auto: true });
  const gh = shadow(s);
  try {
    const head = s.commit('services/iris-api/app.py', 'broken = (\n');
    work.reportDone(s.wp, s.storyId, { tests: { passed: 1, failed: 0 }, commits: ['x'], liveVerified: [], notVerified: [] }, 'kabir');
    await (await flow.onReview(s.wp, s.storyId, 'kabir')).tests;
    s.deployer.failNext = 'staging.sh deploy exit 1: ❌ /healthz did not come back green';
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await evidence.settled(s.wp);
    assert.equal(s.runner.calls.length, 0, 'the suite never ran');
    const rec = rawGet(s.wp, s.storyId)!.evidenceRun!;
    assert.equal(rec.state, 'error');
    assert.match(rec.note ?? '', new RegExp(`staging deploy of ${short(head)} failed: .*healthz did not come back green`));
    assert.notEqual(gh.status(head, 'workplace/evidence')?.state, 'success');
    const st = evidence.state(s.wp).staging;
    assert.equal(st.state, 'failed');
    assert.equal(st.sha, head);
    assert.match(st.note ?? '', /healthz/);
  } finally { await flow.settled(); gh.cleanup(); await s.done(); }
});

test('a story that changes the deploy scripts themselves is refused as an error; nothing is deployed', async () => {
  const s = setup({ auto: true });
  try {
    s.commit('services/iris-api/app.py', 'x = 1\n');
    s.commit('scripts/deploy-target.sh', 'EIP=production\n');
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await evidence.settled(s.wp);
    assert.equal(s.deployer.calls.length, 0);
    assert.equal(s.runner.calls.length, 0);
    const rec = rawGet(s.wp, s.storyId)!.evidenceRun!;
    assert.equal(rec.state, 'error');
    assert.match(rec.note ?? '', /deploy scripts.*scripts\/deploy-target\.sh/);
  } finally { await s.done(); }
});

test('a deploy-script story whose head is what the COO hand-deployed to staging runs without auto-deploy', async () => {
  const s = setup({ auto: true });
  try {
    s.commit('services/iris-api/app.py', 'x = 1\n');
    const head = s.commit('scripts/deploy-target.sh', 'EIP=production\n');
    evidence.recordStagingDeploy(s.wp, head, 'external:coo');
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await until(() => s.runner.calls.length === 1, 'the run to start');
    while (s.runner.pending.length) s.runner.finish();
    await evidence.settled(s.wp);
    assert.equal(s.deployer.calls.length, 0, 'nothing is auto-deployed');
    const rec = rawGet(s.wp, s.storyId)!.evidenceRun!;
    assert.notEqual(rec.state, 'error', rec.note);
    assert.equal(rec.server?.sha, head);
  } finally { await s.done(); }
});

test('a deploy-script story whose head differs from what staging runs is refused with both shas', async () => {
  const s = setup({ auto: true });
  try {
    s.commit('services/iris-api/app.py', 'x = 1\n');
    const head = s.commit('scripts/deploy-target.sh', 'EIP=production\n');
    const other = 'a94dcb9c31a6ca5d2eeccd4f212ce066bf6e9aa5';
    evidence.recordStagingDeploy(s.wp, other, 'external:coo');
    evidence.request(s.wp, { itemId: s.storyId, by: 'kabir', platforms: 'android', features: 'queries' });
    await evidence.settled(s.wp);
    assert.equal(s.runner.calls.length, 0);
    const rec = rawGet(s.wp, s.storyId)!.evidenceRun!;
    assert.equal(rec.state, 'error');
    assert.ok((rec.note ?? '').includes(`staging runs ${other.slice(0, 8)}, your head is ${head.slice(0, 8)}: ask the COO to hand-deploy ${head}`), rec.note);
  } finally { await s.done(); }
});

test('a deploy the Workplace did not run (the twice-daily batch) records what staging runs, so reports stop citing a stale commit', async () => {
  const { testWorkplace } = await import('./fakes/workplace.js');
  const evidence = await import('../src/services/evidence.js');
  const { wp, tmp } = testWorkplace();
  try {
    assert.equal(evidence.stagingServer(wp).state, 'unknown');
    evidence.recordStagingDeploy(wp, 'a94dcb9c31a6ca5d2eeccd4f212ce066bf6e9aa5', 'staging-batch');
    const st = evidence.stagingServer(wp);
    assert.equal(st.state, 'deployed');
    assert.equal(st.sha, 'a94dcb9c31a6ca5d2eeccd4f212ce066bf6e9aa5');
    assert.throws(() => evidence.recordStagingDeploy(wp, 'not-a-sha', 'x'), /git commit/);
  } finally { tmp.cleanup(); }
});

test('a slot held by a manual local-run.sh (its lock pid alive) is skipped; a stale lock is not (Mira, 7 Oct)', async () => {
  const evidence = await import('../src/services/evidence.js');
  const { mkdtempSync, mkdirSync: mk, writeFileSync: wf } = await import('node:fs');
  const { tmpdir: td } = await import('node:os');
  const dir = mkdtempSync(join(td(), 'slotlock-'));
  mk(join(dir, 'iris-e2e-slot-1.lock')); wf(join(dir, 'iris-e2e-slot-1.lock', 'pid'), String(process.pid));
  mk(join(dir, 'iris-e2e-slot-2.lock')); wf(join(dir, 'iris-e2e-slot-2.lock', 'pid'), '999999');
  assert.equal(evidence.slotHeldOutside(1, [dir]), true, 'live pid holds the slot');
  assert.equal(evidence.slotHeldOutside(2, [dir]), false, 'a dead pid is a stale lock');
  assert.equal(evidence.slotHeldOutside(3, [dir]), false, 'no lock');
});

test('iOS staging patch handles the old static base line and the 7 Oct resolveBase form; refuses anything ambiguous', async () => {
  const ports = await import('../src/services/evidence-ports.js');
  const old = 'struct Api {\n    static let base = "https://api.irisforu.com"\n}\n';
  assert.match(ports.patchIosApi(old, 'https://staging.irisforu.com'), /static let base = "https:\/\/staging\.irisforu\.com"/);
  const now = 'static func resolveBase(env: [String: String]) -> String {\n    #if DEBUG\n    if let o = env["IRIS_API_URL"], !o.isEmpty { return o }\n    #endif\n    return "https://api.irisforu.com"\n}\n';
  const patched = ports.patchIosApi(now, 'https://staging.irisforu.com');
  assert.match(patched, /return "https:\/\/staging\.irisforu\.com"/);
  assert.doesNotMatch(patched, /api\.irisforu\.com/);
  assert.throws(() => ports.patchIosApi('nothing here', 'https://staging.irisforu.com'), /exactly one prod API base/);
  assert.throws(() => ports.patchIosApi(old + now, 'https://staging.irisforu.com'), /found 1 and 1/);
});

test('run_evidence androidApi "36" reaches the runner as the Android 16 emulator; a bad value is refused (11 Oct, Play needs API 36)', async () => {
  const s = setup();
  try {
    s.commit('mobile/android/app/build.gradle.kts', '// targetSdk 36\n');
    const client = await toolClient(s.wp, 'kabir', s.storyId);
    const bad = text(await client.callTool({ name: 'run_evidence', arguments: { platforms: 'android', features: 'queries', androidApi: '35' } }));
    assert.match(bad, /34|36|Invalid|enum/i);
    const reply = text(await client.callTool({ name: 'run_evidence', arguments: { platforms: 'android', features: 'queries', androidApi: '36' } }));
    assert.match(reply, /queued \(position 1\)/);
    await until(() => s.runner.calls.length === 1, 'the run to start');
    assert.equal(s.runner.calls[0]!.androidApi, '36');
  } finally { await s.done(); }
});
