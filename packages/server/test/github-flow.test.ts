import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { WorkItem } from '@jkj/shared';
import type { Workplace } from '../src/services/workplace.js';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as coo from '../src/services/coo.js';
import * as manager from '../src/services/manager.js';
import * as flow from '../src/services/github-flow.js';
import { employee, workplaceTools } from '../src/services/employees.js';
import { ensureWorktree } from '../src/services/worktrees.js';
import { rawGet } from '../src/services/v2-map.js';
import { testWorkplace } from './fakes/workplace.js';
import { FakeGitHub } from './fakes/fake-github.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';

/**
 * Checkpoints 8 and 9 (docs/HLD-github-flow.md): the server pushes a story's branch and opens its PR
 * when it moves to review, two approvals in order gate "done" and the merge, a new commit resets
 * them, GitHub trouble falls back to local, and `local` (the default) does nothing new at all.
 */

const TRUNK = 'feat/iris-character';

// Asha is told of disputes (manager.alert): never a real agent session from a test.
const runtime = installFakeRuntime();
after(() => runtime.restore());
const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });

interface Setup {
  wp: Workplace;
  gh: FakeGitHub;
  storyId: string;
  /** Kabir's worktree on emp/kabir/<story>. */
  wt: string;
  trunkRepo: string;
  commit(file: string, content: string, message?: string): string;
  done(): Promise<void>;
}

function setup(mode: 'local' | 'shadow' | 'on' = 'shadow', opts: { quality?: string } = {}): Setup {
  const { wp, tmp } = testWorkplace();
  const kabir = employee(wp, 'kabir');
  const trunkRepo = kabir.workspace.repo;
  // Zoya: the quality-charter engineer (live org, 3 Oct); not in the seed.
  wp.org.employees.push({ ...employee(wp, 'nikhil'), id: 'zoya', name: 'Zoya', roleId: 'engineer', level: 2, charterIds: ['qa-release'], reportsTo: 'nikhil' });
  wp.org.employees.push({ ...kabir, id: 'arjun', name: 'Arjun', roleId: 'engineer', level: 2, charterIds: ['memory'], reportsTo: 'kabir' });
  writeFileSync(join(wp.config.workplaceDir, 'quality.yaml'), opts.quality ?? [
    'maxFileBytes: 100000',
    'areas:',
    '  agent-svc:',
    '    paths: [services/agent-svc/]',
    '    checks:',
    '      - name: lint',
    '        run: test -n "{files}"',
    '        extensions: [.py]',
  ].join('\n') + '\n');
  const gh = new FakeGitHub(trunkRepo);
  flow.useGitHub(wp, gh);
  if (mode !== 'local') flow.setMode(wp, mode, 'coo');

  const epic = items.create(wp, { level: 'epic', title: 'Memory' }, 'owner');
  const story = items.create(wp, { level: 'story', title: 'Recall the last song', parentId: epic.id, assigneeId: 'kabir' }, 'owner');
  const wt = ensureWorktree(wp.config.workDir, kabir, story.id).path;
  const commit = (file: string, content: string, message = `add ${file}`): string => {
    mkdirSync(join(wt, file, '..'), { recursive: true });
    writeFileSync(join(wt, file), content);
    git(wt, ['add', '-A']);
    git(wt, ['-c', 'user.email=k@iris.local', '-c', 'user.name=kabir', 'commit', '-q', '-m', message]);
    return git(wt, ['rev-parse', 'HEAD']).trim();
  };
  return {
    wp, gh, storyId: story.id, wt, trunkRepo, commit,
    done: async () => { await flow.settled(); gh.cleanup(); tmp.cleanup(); },
  };
}

const evidence = { tests: { passed: 3, failed: 0, command: 'pytest' }, commits: ['abc'], liveVerified: [], notVerified: ['live'] };
const toReview = (s: Setup): void => { work.reportDone(s.wp, s.storyId, evidence, 'kabir'); };
const pr = (s: Setup): NonNullable<WorkItem['pr']> => { const p = rawGet(s.wp, s.storyId)!.pr; assert.ok(p, 'the item has a PR record'); return p; };

async function reviewed(s: Setup): Promise<flow.ReviewResult> {
  toReview(s);
  const r = await flow.onReview(s.wp, s.storyId, 'kabir');
  await r.tests;
  return r;
}

/* ---------- local: exactly today ---------- */

test('local is the default: a review move pushes nothing, opens no PR, and the new tools and merge refuse', async () => {
  const s = setup('local');
  try {
    assert.equal(flow.mode(s.wp), 'local');
    s.commit('services/agent-svc/recall.py', 'x = 1\n');
    toReview(s);
    const r = await flow.onReview(s.wp, s.storyId, 'kabir');
    assert.equal(r.skipped, 'local');
    assert.equal(s.gh.calls.length, 0, 'GitHub is never touched in local');
    assert.equal(rawGet(s.wp, s.storyId)!.pr, undefined);
    await assert.rejects(flow.approve(s.wp, s.storyId, 'dev'), /local/);
    await assert.rejects(flow.merge(s.wp, s.storyId, 'coo'), /local/);
    // The old rule holds: the reviewer marks it done.
    const reviewer = rawGet(s.wp, s.storyId)!.reviewerId!;
    assert.equal(items.update(s.wp, s.storyId, { status: 'done' }, reviewer).status, 'done');
    assert.equal(await flow.syncHeads(s.wp).then(x => x.length), 0);
    assert.equal(s.gh.calls.length, 0);
  } finally { await s.done(); }
});

/* ---------- checkpoint 8: push and PR ---------- */

test('shadow: moving to review pushes emp/<name>/<story>, opens a PR to the trunk, stores its number and posts statuses', async () => {
  const s = setup('shadow');
  try {
    const head = s.commit('services/agent-svc/recall.py', 'x = 1\n');
    const r = await reviewed(s);
    assert.equal(r.refused, undefined);
    const branch = `emp/kabir/${s.storyId}`;
    assert.equal(s.gh.remoteSha(branch), head, 'the branch is on GitHub at its head');
    assert.equal(s.gh.prs.length, 1);
    const ghPr = s.gh.prs[0]!;
    assert.equal(ghPr.base, TRUNK);
    assert.equal(ghPr.head, branch);
    assert.match(ghPr.title, /Recall the last song/);
    assert.ok(ghPr.title.includes(s.storyId));
    assert.ok(ghPr.body.includes(s.storyId));
    assert.doesNotMatch(ghPr.body, /127\.0\.0\.1|\/api\/items\//, 'no loopback link: the story title and id only');
    assert.match(ghPr.body, /Evidence/i, 'an evidence placeholder');
    const p = pr(s);
    assert.equal(p.number, ghPr.number);
    assert.equal(p.url, ghPr.url);
    assert.equal(p.branch, branch);
    assert.equal(p.headSha, head);
    assert.equal(p.base, TRUNK);
    assert.equal(s.gh.status(head, 'workplace/review')?.state, 'pending');
    assert.equal(s.gh.status(head, 'workplace/tests')?.state, 'success', 'quality green');
    assert.equal(s.gh.status(head, 'workplace/evidence')?.state, 'pending');
    // A second review move reuses the PR.
    await flow.onReview(s.wp, s.storyId, 'kabir');
    assert.equal(s.gh.prs.length, 1);
    assert.equal(s.gh.count('openPr'), 1);
  } finally { await s.done(); }
});

test('report_done and request_review drive the push through the Workplace tools', async () => {
  const s = setup('shadow');
  try {
    s.commit('services/agent-svc/recall.py', 'x = 1\n');
    const server = workplaceTools(s.wp, 'kabir', () => ({ agentId: 'a', employeeId: 'kabir', assignmentId: s.storyId, startedAt: '', seen: {}, planCaptured: false }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(st);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(ct);
    const done = await client.callTool({ name: 'report_done', arguments: { assignmentId: s.storyId, testsPassed: 3, testsFailed: 0, commits: ['abc'], liveVerified: [], notVerified: ['live'] } });
    assert.match(JSON.stringify(done.content), /in review/);
    assert.match(JSON.stringify(done.content), /pull request #\d+/);
    assert.match(JSON.stringify(done.content), /developer approver \(approval 1 of 2/);
    assert.equal(s.gh.prs.length, 1);
    const again = await client.callTool({ name: 'request_review', arguments: { assignmentId: s.storyId } });
    assert.match(JSON.stringify(again.content), /Review requested/);
    assert.equal(s.gh.count('push'), 2);
    assert.equal(s.gh.prs.length, 1);
    await client.close();
  } finally { await s.done(); }
});

test('the push guard refuses a branch that is not emp/<assignee>/<story>', () => {
  assert.equal(flow.branchProblem('emp/kabir/as_x1', 'emp/kabir/as_x1'), null);
  assert.match(flow.branchProblem('feat/iris-character', 'emp/kabir/as_x1')!, /emp\//);
  assert.match(flow.branchProblem('emp/dev/as_x1', 'emp/kabir/as_x1')!, /emp\/kabir\/as_x1/);
  assert.match(flow.branchProblem('emp/kabir/as_x1;rm', 'emp/kabir/as_x1;rm')!, /not a story branch/);
  assert.match(flow.branchProblem('emp/kabir/../main', 'emp/kabir/../main')!, /not a story branch/);
});

test('gate: a commit adding dist-x build output is refused and nothing reaches GitHub', async () => {
  const s = setup('shadow');
  try {
    s.commit('services/agent-svc/recall.py', 'x = 1\n');
    s.commit('services/agent-svc/dist-x/iris-agent.bin', 'binary\n');
    const r = await reviewed(s);
    assert.ok(r.refused?.some(x => /dist-x\/iris-agent\.bin/.test(x)), JSON.stringify(r.refused));
    assert.equal(s.gh.count('push'), 0);
    assert.equal(s.gh.remoteSha(`emp/kabir/${s.storyId}`), null);
    assert.equal(rawGet(s.wp, s.storyId)!.pr?.number, undefined);
    assert.ok(rawGet(s.wp, s.storyId)!.prRefused?.reasons.length);
  } finally { await s.done(); }
});

test('gate: a planted fake key is refused (even when a later commit deletes it) and never echoed', async () => {
  const s = setup('shadow');
  try {
    // A GitHub-token-shaped string built at run time, so this file holds no key-shaped literal.
    const key = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    s.commit('services/agent-svc/settings.py', `GITHUB_TOKEN = "${key}"\n`);
    rmSync(join(s.wt, 'services/agent-svc/settings.py'));
    git(s.wt, ['add', '-A']);
    git(s.wt, ['-c', 'user.email=k@iris.local', '-c', 'user.name=kabir', 'commit', '-q', '-m', 'remove it']);
    const r = await reviewed(s);
    assert.ok(r.refused?.some(x => /secret/i.test(x) && /settings\.py/.test(x)), JSON.stringify(r.refused));
    assert.equal(s.gh.count('push'), 0);
    const everything = JSON.stringify([r, rawGet(s.wp, s.storyId), items.detail(s.wp, s.storyId)]);
    assert.ok(!everything.includes(key), 'the key is never echoed');
  } finally { await s.done(); }
});

/* ---------- checkpoint 9: two approvals, in order ---------- */

test('two approvals in order: a lead who is not the author, then QA; identities are recorded and QA marks it done', async () => {
  const s = setup('shadow');
  try {
    const head = s.commit('services/agent-svc/recall.py', 'x = 1\n');
    await reviewed(s);
    await assert.rejects(flow.approve(s.wp, s.storyId, 'kabir'), /author/i);
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil'), /^BadRequest: QA reviews after a developer approval; ask a lead to review first\.$/);
    await assert.rejects(flow.approve(s.wp, s.storyId, 'arjun'), /lead/i);   // an engineer is not a developer approver
    const dev = await flow.approve(s.wp, s.storyId, 'dev', 'reads well');
    assert.equal(dev.stage, 'dev');
    assert.equal(pr(s).devApproval?.by, 'dev');
    assert.equal(pr(s).devApproval?.sha, head);
    assert.equal(rawGet(s.wp, s.storyId)!.reviewerId, 'nikhil', 'the review moves to QA');
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'in-review');
    await assert.rejects(flow.approve(s.wp, s.storyId, 'mira'), /QA/);       // a second lead is not QA
    const qa = await flow.approve(s.wp, s.storyId, 'nikhil');
    assert.equal(qa.stage, 'qa');
    assert.equal(pr(s).qaApproval?.by, 'nikhil');
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'done');
    assert.equal(rawGet(s.wp, s.storyId)!.verifiedBy, 'nikhil');
    assert.equal(s.gh.status(head, 'workplace/review')?.state, 'success');
  } finally { await s.done(); }
});

test("a lead's own story needs a peer lead; Zoya (quality charter) can give the QA approval", async () => {
  const s = setup('shadow');
  try {
    s.commit('services/agent-svc/recall.py', 'x = 1\n');
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'tara');
    const qa = await flow.approve(s.wp, s.storyId, 'zoya');
    assert.equal(qa.stage, 'qa');
    assert.equal(pr(s).devApproval?.by, 'tara');
    assert.equal(pr(s).qaApproval?.by, 'zoya');
  } finally { await s.done(); }
});

test('a new commit resets both approvals, marks evidence stale, and is pushed', async () => {
  const s = setup('shadow');
  try {
    s.commit('services/agent-svc/recall.py', 'x = 1\n');
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'dev');
    const newer = s.commit('services/agent-svc/recall.py', 'x = 2\n');
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil'), /new commit/i);
    assert.equal(pr(s).headSha, newer);
    assert.equal(s.gh.remoteSha(`emp/kabir/${s.storyId}`), newer);
    assert.equal(pr(s).evidence, 'stale');
    assert.equal(flow.approvalHolds(rawGet(s.wp, s.storyId)!, 'dev'), false);
    // The developer approval is needed again, on the new head.
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil'), /developer approval/i);
    await flow.approve(s.wp, s.storyId, 'dev');
    assert.equal(pr(s).devApproval?.sha, newer);
  } finally { await s.done(); }
});

test('the sweep notices a new commit while in review: re-pushed and reset', async () => {
  const s = setup('shadow');
  try {
    s.commit('services/agent-svc/recall.py', 'x = 1\n');
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'dev');
    const newer = s.commit('services/agent-svc/recall.py', 'x = 3\n');
    const moved = await flow.syncHeads(s.wp);
    assert.deepEqual(moved, [s.storyId]);
    assert.equal(s.gh.remoteSha(`emp/kabir/${s.storyId}`), newer);
    assert.equal(flow.approvalHolds(rawGet(s.wp, s.storyId)!, 'dev'), false);
    assert.equal(s.gh.status(newer, 'workplace/review')?.state, 'pending');
  } finally { await s.done(); }
});

test('on: done needs both approvals (the owner excepted); shadow enforces nothing', async () => {
  const on = setup('on');
  try {
    on.commit('services/agent-svc/recall.py', 'x = 1\n');
    await reviewed(on);
    assert.throws(() => items.update(on.wp, on.storyId, { status: 'done' }, 'nikhil'), /approval/i);
    await flow.approve(on.wp, on.storyId, 'dev');
    assert.throws(() => items.update(on.wp, on.storyId, { status: 'done' }, 'nikhil'), /approval/i);
    await flow.approve(on.wp, on.storyId, 'nikhil');
    assert.equal(rawGet(on.wp, on.storyId)!.status, 'done');
  } finally { await on.done(); }
  const shadow = setup('shadow');
  try {
    shadow.commit('services/agent-svc/recall.py', 'x = 1\n');
    await reviewed(shadow);
    // Shadow routes review to a developer approver first (finding #3) but enforces no approvals: the reviewer marks it done.
    const reviewer = rawGet(shadow.wp, shadow.storyId)!.reviewerId!;
    assert.notEqual(reviewer, 'nikhil');
    assert.equal(items.update(shadow.wp, shadow.storyId, { status: 'done' }, reviewer).status, 'done');
  } finally { await shadow.done(); }
});

test('a dispute of a QA send-back goes to Asha first (then the COO, then the owner)', async () => {
  const s = setup('shadow');
  try {
    s.commit('services/agent-svc/recall.py', 'x = 1\n');
    await reviewed(s);
    await assert.rejects(flow.dispute(s.wp, s.storyId, 'kabir', 'it works'), /send-back/i);
    await flow.approve(s.wp, s.storyId, 'dev');
    await assert.rejects(flow.sendBack(s.wp, s.storyId, 'kabir', 'nope'), /author/i);
    await flow.sendBack(s.wp, s.storyId, 'nikhil', 'the recall test is missing');
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'in-progress');
    assert.equal(pr(s).sendBack?.by, 'nikhil');
    assert.equal(flow.approvalHolds(rawGet(s.wp, s.storyId)!, 'dev'), false, 'a send-back ends the approvals');
    await assert.rejects(flow.dispute(s.wp, s.storyId, 'dev', 'disagree'), /author/i);
    await flow.dispute(s.wp, s.storyId, 'kabir', 'the test exists: test_recall.py');
    await assert.rejects(flow.dispute(s.wp, s.storyId, 'kabir', 'again'), /already disputed/i, 'once per send-back');
    const alert = manager.list(s.wp).find(a => a.key.startsWith(`dispute:${s.storyId}`));
    assert.ok(alert, 'a manager alert (Asha first)');
    assert.match(alert!.title, /disput/i);
    assert.match(alert!.text ?? alert!.body, /COO/);
    assert.ok(pr(s).sendBack?.disputedAt);
  } finally { await s.done(); }
});

test('the evidence hook sets workplace/evidence on the head', async () => {
  const s = setup('shadow');
  try {
    const head = s.commit('services/agent-svc/recall.py', 'x = 1\n');
    await reviewed(s);
    await flow.setEvidence(s.wp, s.storyId, 'success', 'screenshots attached');
    assert.equal(pr(s).evidence, 'success');
    assert.equal(s.gh.status(head, 'workplace/evidence')?.state, 'success');
  } finally { await s.done(); }
});

test('quality failures make workplace/tests fail', async () => {
  const s = setup('shadow', { quality: 'areas:\n  agent-svc:\n    paths: [services/agent-svc/]\n    checks:\n      - name: lint\n        run: "false"\n' });
  try {
    const head = s.commit('services/agent-svc/recall.py', 'x = 1\n');
    await reviewed(s);
    assert.equal(s.gh.status(head, 'workplace/tests')?.state, 'failure');
    assert.match(s.gh.status(head, 'workplace/tests')!.description, /agent-svc/);
    assert.equal(pr(s).tests?.state, 'failure');
  } finally { await s.done(); }
});

/* ---------- fallback ---------- */

test('three GitHub failures within five minutes fall back to local and alert the COO', async () => {
  const s = setup('on');
  try {
    s.commit('services/agent-svc/recall.py', 'x = 1\n');
    toReview(s);
    s.gh.failNext('push', 3);
    for (let i = 0; i < 2; i++) {
      const r = await flow.onReview(s.wp, s.storyId, 'kabir');
      assert.ok(r.error);
      assert.equal(flow.mode(s.wp), 'on');
    }
    await flow.onReview(s.wp, s.storyId, 'kabir');
    assert.equal(flow.mode(s.wp), 'local');
    assert.ok(flow.state(s.wp).fallback, 'the fallback is recorded');
    assert.ok(coo.listItems(s.wp).some(i => /GitHub/.test(i.title) && /local/.test(i.body)), 'the COO is alerted');
  } finally { await s.done(); }
});

test('failures spread over more than five minutes do not fall back', async () => {
  const s = setup('on');
  try {
    const t0 = Date.parse('2026-10-04T10:00:00Z');
    flow.recordFailure(s.wp, 'push', s.storyId, t0);
    flow.recordFailure(s.wp, 'push', s.storyId, t0 + 2 * 60_000);
    flow.recordFailure(s.wp, 'push', s.storyId, t0 + 6 * 60_000);
    assert.equal(flow.mode(s.wp), 'on');
    flow.recordFailure(s.wp, 'push', s.storyId, t0 + 7 * 60_000);
    assert.equal(flow.mode(s.wp), 'local');
  } finally { await s.done(); }
});

test('a refusal (planted dist-x) is not a GitHub failure', async () => {
  const s = setup('on');
  try {
    s.commit('dist-x/a.js', 'x\n');
    toReview(s);
    for (let i = 0; i < 4; i++) await flow.onReview(s.wp, s.storyId, 'kabir');
    assert.equal(flow.mode(s.wp), 'on');
  } finally { await s.done(); }
});

/* ---------- merge ---------- */

test('merge: dry run in shadow; in on refused until review and tests are green, then a merge commit, the branch deleted, the trunk fast-forwarded', async () => {
  const sh = setup('shadow');
  try {
    sh.commit('services/agent-svc/recall.py', 'x = 1\n');
    await reviewed(sh);
    const dry = await flow.merge(sh.wp, sh.storyId, 'coo');
    assert.equal(dry.merged, false);
    assert.equal(dry.mode, 'shadow');
    assert.ok(dry.blockers?.some(b => /approval/i.test(b)));
    assert.equal(sh.gh.count('merge'), 0);
  } finally { await sh.done(); }

  const s = setup('on');
  try {
    s.commit('services/agent-svc/recall.py', 'x = 1\n');
    await reviewed(s);
    await assert.rejects(flow.merge(s.wp, s.storyId, 'coo'), /approval/i);
    await flow.approve(s.wp, s.storyId, 'dev');
    await flow.approve(s.wp, s.storyId, 'nikhil');
    const before = git(s.trunkRepo, ['rev-parse', TRUNK]).trim();
    const m = await flow.merge(s.wp, s.storyId, 'coo');
    assert.equal(m.merged, true);
    assert.equal(m.synced, true);
    assert.equal(s.gh.remoteSha(`emp/kabir/${s.storyId}`), null, 'the branch is deleted');
    const after = git(s.trunkRepo, ['rev-parse', TRUNK]).trim();
    assert.notEqual(after, before);
    assert.equal(after, s.gh.remoteSha(TRUNK), 'the trunk checkout is fast-forwarded to GitHub');
    assert.equal(git(s.trunkRepo, ['rev-list', '--parents', '-n1', after]).trim().split(' ').length, 3, 'a merge commit');
    assert.ok(pr(s).merged);
    await assert.rejects(flow.merge(s.wp, s.storyId, 'coo'), /already merged/i);
  } finally { await s.done(); }
});

test('merge: refused when tests are red, or the head moved since the approvals', async () => {
  const s = setup('on', { quality: 'areas:\n  agent-svc:\n    paths: [services/agent-svc/]\n    checks:\n      - name: lint\n        run: "false"\n' });
  try {
    s.commit('services/agent-svc/recall.py', 'x = 1\n');
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'dev');
    await flow.approve(s.wp, s.storyId, 'nikhil');
    await assert.rejects(flow.merge(s.wp, s.storyId, 'coo'), /tests/i);
    assert.equal(s.gh.count('merge'), 0);
  } finally { await s.done(); }
});

test('merge: a trunk checkout that cannot fast-forward alerts the COO and is never forced', async () => {
  const s = setup('on');
  try {
    s.commit('services/agent-svc/recall.py', 'x = 1\n');
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'dev');
    await flow.approve(s.wp, s.storyId, 'nikhil');
    // A local commit on the trunk checkout that GitHub does not have: a pull can only merge, not fast-forward.
    writeFileSync(join(s.trunkRepo, 'LOCAL.md'), 'local only\n');
    git(s.trunkRepo, ['add', '-A']);
    git(s.trunkRepo, ['commit', '-q', '-m', 'local only']);
    const local = git(s.trunkRepo, ['rev-parse', 'HEAD']).trim();
    const m = await flow.merge(s.wp, s.storyId, 'coo');
    assert.equal(m.merged, true);
    assert.equal(m.synced, false);
    assert.equal(git(s.trunkRepo, ['rev-parse', 'HEAD']).trim(), local, 'nothing forced, nothing merged locally');
    assert.ok(coo.listItems(s.wp).some(i => /fast-forward/i.test(i.body)), 'the COO is alerted');
  } finally { await s.done(); }
});

test('an approval holds only for its commit and its stay in review', () => {
  const a = { by: 'dev', at: 't', sha: 'aaa', episode: 'e1' };
  const base = { status: 'in-review', statusSince: 'e1', pr: { number: 1, url: 'u', branch: 'b', base: TRUNK, headSha: 'aaa', pushedAt: 't', evidence: 'pending', devApproval: a } } as unknown as WorkItem;
  assert.equal(flow.approvalHolds(base, 'dev'), true);
  assert.equal(flow.approvalHolds({ ...base, pr: { ...base.pr!, headSha: 'bbb' } }, 'dev'), false, 'another commit');
  assert.equal(flow.approvalHolds({ ...base, statusSince: 'e2' }, 'dev'), false, 'a new stay in review');
  assert.equal(flow.approvalHolds({ ...base, status: 'in-progress' }, 'dev'), false, 'sent back');
});

test('a first push GitHub failed is retried by the sweep; a refused head is not', async () => {
  const s = setup('shadow');
  try {
    s.commit('services/agent-svc/recall.py', 'x = 1\n');
    toReview(s);
    s.gh.failNext('push', 1);
    assert.ok((await flow.onReview(s.wp, s.storyId, 'kabir')).error);
    assert.equal(rawGet(s.wp, s.storyId)!.pr, undefined);
    await flow.syncHeads(s.wp);
    assert.equal(pr(s).number, s.gh.prs[0]!.number, 'pushed and opened on the retry');
  } finally { await s.done(); }
  const r = setup('shadow');
  try {
    r.commit('dist-x/a.js', 'x\n');
    toReview(r);
    await flow.onReview(r.wp, r.storyId, 'kabir');
    const pushes = r.gh.count('push');
    await flow.syncHeads(r.wp);
    assert.equal(r.gh.count('push'), pushes, 'a refused head is not retried');
    assert.equal(r.gh.calls.length, 0);
  } finally { await r.done(); }
});
