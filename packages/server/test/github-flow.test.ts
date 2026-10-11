import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { WorkItem } from '@jkj/shared';
import type { Workplace } from '../src/services/workplace.js';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as coo from '../src/services/coo.js';
import * as trail from '../src/services/trail.js';
import * as manager from '../src/services/manager.js';
import * as flow from '../src/services/github-flow.js';
import * as readTools from '../src/services/read-tools.js';
import * as statusAnswers from '../src/services/status.js';
import * as hygiene from '../src/services/hygiene.js';
import { childEnv, employee, workplaceTools } from '../src/services/employees.js';
import * as employees from '../src/services/employees.js';
import { ensureWorktree } from '../src/services/worktrees.js';
import { rawGet } from '../src/services/v2-map.js';
import { testWorkplace } from './fakes/workplace.js';
import { FakeGitHub } from './fakes/fake-github.js';
import { writePrePr } from './fakes/pre-pr.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';

/** A QA doc that allows approval 2 of 2 (owner's review flow, step 2). */
import * as qaDoc from '../src/services/qa-doc.js';
import { qaReviewer } from '../src/services/review-policy.js';
const QA_DOC = '## Edge cases\n- PASS: empty input — unit test evidence: https://ci.example.com/runs/1\n- PASS: provider down — killed the provider and checked the reply evidence: https://ci.example.com/runs/2\n- N/A: Windows path — no Windows code touched\n## Report\nChecked both failure paths by hand and in tests; Windows untouched; residual risk low.\nEvidence: n/a — server-only change, no app surface\nTests: pytest 374 passed, 0 failed';

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
  /** Commits; by default scripts/pre-pr.sh then passes on it (`prePr: false` = not run, 'fail' = failed). */
  commit(file: string, content: string, message?: string, prePr?: boolean | 'fail'): string;
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
  const commit = (file: string, content: string, message = `add ${file}`, prePr: boolean | 'fail' = true): string => {
    mkdirSync(join(wt, file, '..'), { recursive: true });
    writeFileSync(join(wt, file), content);
    git(wt, ['add', '-A']);
    git(wt, ['-c', 'user.email=k@iris.local', '-c', 'user.name=kabir', 'commit', '-q', '-m', message]);
    const sha = git(wt, ['rev-parse', 'HEAD']).trim();
    if (prePr) writePrePr(wt, sha, { ok: prePr !== 'fail' });
    return sha;
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
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    toReview(s);
    const r = await flow.onReview(s.wp, s.storyId, 'kabir');
    assert.equal(r.skipped, 'local');
    assert.equal(s.gh.calls.length, 0, 'GitHub is never touched in local');
    assert.equal(rawGet(s.wp, s.storyId)!.pr, undefined);
    await assert.rejects(flow.approve(s.wp, s.storyId, 'arjun'), /local/);
    await assert.rejects(flow.merge(s.wp, s.storyId, 'coo'), /local/);
    // The old rule holds: the reviewer marks it done.
    const reviewer = rawGet(s.wp, s.storyId)!.reviewerId!;
    assert.equal(items.update(s.wp, s.storyId, { status: 'done', reason: 'test: moved' }, reviewer).status, 'done');
    assert.equal(await flow.syncHeads(s.wp).then(x => x.length), 0);
    assert.equal(s.gh.calls.length, 0);
  } finally { await s.done(); }
});

/* ---------- checkpoint 8: push and PR ---------- */

test('shadow: moving to review pushes emp/<name>/<story>, opens a PR to the trunk, stores its number and posts statuses', async () => {
  const s = setup('shadow');
  try {
    const head = s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
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
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    const server = workplaceTools(s.wp, 'kabir', () => ({ agentId: 'a', employeeId: 'kabir', assignmentId: s.storyId, startedAt: '', seen: {}, planCaptured: false }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(st);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(ct);
    const early = await client.callTool({ name: 'request_review', arguments: { assignmentId: s.storyId } });
    assert.match(JSON.stringify(early.content), /call report_done/);
    assert.equal(s.gh.prs.length, 0, 'request_review never submits');
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
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
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

test('two approvals in order: a member of the author\'s team (not the author), then QA; identities are recorded and QA marks it done', async () => {
  const s = setup('shadow');
  try {
    const head = s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    await assert.rejects(flow.approve(s.wp, s.storyId, 'kabir'), /author/i);
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC), /^BadRequest: QA reviews after a developer approval; ask the author's team to review first\.$/);
    await assert.rejects(flow.approve(s.wp, s.storyId, 'dev'), /not in Kabir's team/);   // rework W3: a lead of another team is not the developer approver
    const dev = await flow.approve(s.wp, s.storyId, 'arjun', 'reads well');
    assert.equal(dev.stage, 'dev');
    assert.equal(pr(s).devApproval?.by, 'arjun');
    assert.equal(pr(s).devApproval?.sha, head);
    assert.equal(rawGet(s.wp, s.storyId)!.reviewerId, 'nikhil', 'the review moves to QA');
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'in-review');
    await assert.rejects(flow.approve(s.wp, s.storyId, 'mira'), /QA/);       // a second lead is not QA
    const qa = await flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC);
    assert.equal(qa.stage, 'qa');
    assert.equal(pr(s).qaApproval?.by, 'nikhil');
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'done');
    assert.equal(rawGet(s.wp, s.storyId)!.verifiedBy, 'nikhil');
    assert.equal(s.gh.status(head, 'workplace/review')?.state, 'success');
  } finally { await s.done(); }
});

test("a lead's own story needs a member of the lead's team (rework W3; was any peer lead); Zoya (quality charter) can give the QA approval when she is the story's QA", async () => {
  const s = setup('shadow');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    await assert.rejects(flow.approve(s.wp, s.storyId, 'tara'), /not in Kabir's team/);
    await flow.approve(s.wp, s.storyId, 'arjun');
    items.update(s.wp, s.storyId, { reviewerId: 'zoya', note: 'Zoya takes QA on this one' }, 'asha');
    const qa = await flow.approve(s.wp, s.storyId, 'zoya', undefined, QA_DOC);
    assert.equal(qa.stage, 'qa');
    assert.equal(pr(s).devApproval?.by, 'arjun');
    assert.equal(pr(s).qaApproval?.by, 'zoya');
  } finally { await s.done(); }
});

test('a new commit resets both approvals, marks evidence stale, and is pushed', async () => {
  const s = setup('shadow');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    const newer = s.commit('services/agent-svc/memory_client.py', 'x = 2\n');
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC), /new commit/i);
    assert.equal(pr(s).headSha, newer);
    assert.equal(s.gh.remoteSha(`emp/kabir/${s.storyId}`), newer);
    assert.equal(pr(s).evidence, 'stale');
    assert.equal(flow.approvalHolds(rawGet(s.wp, s.storyId)!, 'dev'), false);
    // The developer approval is needed again, on the new head.
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC), /developer approval/i);
    await flow.approve(s.wp, s.storyId, 'arjun');
    assert.equal(pr(s).devApproval?.sha, newer);
  } finally { await s.done(); }
});

test('#23: a new head that already has evidence says so; without it the evidence is stale', async () => {
  const s = setup('shadow');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    const pushed = () => trail.activityFor(s.wp, s.storyId).filter(a => /^Pushed .*new commits/.test(a.text)).map(a => a.text);
    s.commit('services/agent-svc/memory_client.py', 'x = 2\n');
    await flow.syncHeads(s.wp);
    assert.match(pushed().at(-1)!, /both approvals reset; the evidence is stale$/);
    assert.equal(pr(s).evidence, 'stale');

    const newer = s.commit('services/agent-svc/memory_client.py', 'x = 3\n');
    const cur = rawGet(s.wp, s.storyId)!;
    work.saveQuiet(s.wp, { ...cur, evidenceRun: { run: 'r', sha: newer, state: 'success', platforms: ['android'], features: ['queries'], passed: 14, failed: 0, failures: [], durationS: 60, report: '/r', by: 'kabir', at: new Date().toISOString() } });
    await flow.syncHeads(s.wp);
    assert.match(pushed().at(-1)!, /both approvals reset; evidence already matches this commit$/);
    assert.doesNotMatch(pushed().at(-1)!, /stale/);
    assert.equal(pr(s).evidence, 'success');
  } finally { await s.done(); }
});

test('the sweep notices a new commit while in review: re-pushed and reset', async () => {
  const s = setup('shadow');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    const newer = s.commit('services/agent-svc/memory_client.py', 'x = 3\n');
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
    on.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(on);
    // Not the reviewer yet (the developer approver is): the tree refuses it before the approval rule (rework, Oct 2026).
    assert.throws(() => items.update(on.wp, on.storyId, { status: 'done', reason: 'test: moved' }, 'nikhil'), /approval|Forbidden/i);
    await flow.approve(on.wp, on.storyId, 'arjun');
    assert.throws(() => items.update(on.wp, on.storyId, { status: 'done', reason: 'test: moved' }, 'nikhil'), /approval/i);
    await flow.approve(on.wp, on.storyId, 'nikhil', undefined, QA_DOC);
    assert.equal(rawGet(on.wp, on.storyId)!.status, 'done');
  } finally { await on.done(); }
  const shadow = setup('shadow');
  try {
    shadow.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(shadow);
    // Shadow routes review to a developer approver first (finding #3) but enforces no approvals: the reviewer marks it done.
    const reviewer = rawGet(shadow.wp, shadow.storyId)!.reviewerId!;
    assert.notEqual(reviewer, 'nikhil');
    assert.equal(items.update(shadow.wp, shadow.storyId, { status: 'done', reason: 'test: moved' }, reviewer).status, 'done');
  } finally { await shadow.done(); }
});

test('a dispute of a QA send-back goes to Asha first (then the COO, then the owner)', async () => {
  const s = setup('shadow');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    await assert.rejects(flow.dispute(s.wp, s.storyId, 'kabir', 'it works'), /send-back/i);
    await flow.approve(s.wp, s.storyId, 'arjun');
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

test('#20: a send-back reaches the author at once: a message into an idle open session, else a session on the story', async () => {
  const s = setup('shadow');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    const kabirs = () => runtime.sessions.filter(x => x.options.cwd.includes('/kabir/'));
    const before = kabirs().length;
    // No open session: one starts on the story, with the note.
    await flow.sendBack(s.wp, s.storyId, 'arjun', 'the recall test is missing');
    assert.equal(kabirs().length, before + 1);
    assert.match(kabirs().at(-1)!.options.prompt, /Sent back by Arjun: .*the recall test is missing/s);
    assert.ok(trail.activityFor(s.wp, s.storyId).some(a => /Send-back delivered to Kabir: a session started/.test(a.text)));

    // An open session sitting idle (waiting) gets it as a message, not a second session.
    kabirs().at(-1)!.result();
    items.update(s.wp, s.storyId, { status: 'in-review', reason: 'test: moved' }, 'kabir');
    await flow.onReview(s.wp, s.storyId, 'kabir');
    await flow.sendBack(s.wp, s.storyId, 'arjun', 'rename the helper');
    assert.equal(kabirs().length, before + 1, 'no second session');
    assert.match(kabirs().at(-1)!.sent.at(-1)!.text, /Sent back by Arjun: .*rename the helper/s);
  } finally { await s.done(); }
});

test('a send-back switches the author\'s open session back to the story when it is on another one (8 Oct)', async () => {
  const s = setup('shadow');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    // Kabir moved on: his one open session is on another story, idle between turns.
    const epicId = rawGet(s.wp, s.storyId)!.parentId!;
    const other = items.create(s.wp, { level: 'story', title: 'Next story', parentId: epicId, assigneeId: 'kabir' }, 'owner');
    employees.assign(s.wp, other.id);
    const kabirs = () => runtime.sessions.filter(x => x.options.cwd.includes('/kabir/'));
    kabirs().at(-1)!.result();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(employees.openSession('kabir')?.assignmentId, other.id);
    const before = kabirs().length;
    await flow.sendBack(s.wp, s.storyId, 'arjun', 'the recall test is missing');
    assert.equal(kabirs().length, before, 'no second session');
    assert.equal(employees.openSession('kabir')?.assignmentId, s.storyId, 'the session is back on the sent-back story');
    assert.match(kabirs().at(-1)!.sent.at(-1)!.text, /Sent back by Arjun: .*the recall test is missing/s);
    assert.ok(trail.activityFor(s.wp, s.storyId).some(a => /switched back to this story/.test(a.text)));
  } finally { await s.done(); }
});

test('a CTO named as reviewer keeps the developer review; it is not swapped for a lead (8 Oct)', async () => {
  const s = setup('shadow');
  try {
    s.wp.org.employees.push({ ...employee(s.wp, 'kabir'), id: 'cto', name: 'Vikram', roleId: 'cto', level: 0, charterIds: [], reportsTo: undefined } as never);
    items.update(s.wp, s.storyId, { reviewerId: 'cto' }, 'coo');
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    assert.equal(rawGet(s.wp, s.storyId)!.reviewerId, 'cto', 'the named CTO stays the reviewer');
  } finally { await s.done(); }
});

test('a send-back puts a story the dispatcher had only just started back to Ready (8 Oct phantom; one story per person)', async () => {
  const s = setup('shadow');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    const epicId = rawGet(s.wp, s.storyId)!.parentId!;
    const other = items.create(s.wp, { level: 'story', title: 'Next story', parentId: epicId, assigneeId: 'kabir' }, 'owner');
    employees.assign(s.wp, other.id);
    const kabirs = () => runtime.sessions.filter(x => x.options.cwd.includes('/kabir/'));
    kabirs().at(-1)!.result();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(items.get(s.wp, other.id)!.status, 'in-progress');
    await flow.sendBack(s.wp, s.storyId, 'arjun', 'the recall test is missing');
    assert.equal(employees.openSession('kabir')?.assignmentId, s.storyId);
    assert.equal(items.get(s.wp, other.id)!.status, 'ready', 'the phantom start is released');
    assert.ok(trail.activityFor(s.wp, other.id).some(a => a.kind === 'status' && a.to === 'ready' && /^system: Kabir moved to /.test(a.text)));
  } finally { await s.done(); }
});

test('a send-back puts even a story that was really begun (it has a plan) back to Ready, plan kept (one story per person, LLD-rework W2 §2)', async () => {
  const s = setup('shadow');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    const epicId = rawGet(s.wp, s.storyId)!.parentId!;
    const other = items.create(s.wp, { level: 'story', title: 'Next story', parentId: epicId, assigneeId: 'kabir' }, 'owner');
    employees.assign(s.wp, other.id);
    const kabirs = () => runtime.sessions.filter(x => x.options.cwd.includes('/kabir/'));
    kabirs().at(-1)!.result();
    await new Promise(r => setTimeout(r, 20));
    work.attachPlan(s.wp, other.id, 'Plan: do it', 'kabir');
    await flow.sendBack(s.wp, s.storyId, 'arjun', 'the recall test is missing');
    assert.equal(employees.openSession('kabir')?.assignmentId, s.storyId);
    assert.equal(items.get(s.wp, other.id)!.status, 'ready', 'nobody is on it now: Ready, and the dispatcher restarts it');
    assert.ok(rawGet(s.wp, other.id)!.plan, 'the plan stays on the story');
  } finally { await s.done(); }
});

test('the evidence hook sets workplace/evidence on the head', async () => {
  const s = setup('shadow');
  try {
    const head = s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    await flow.setEvidence(s.wp, s.storyId, 'success', 'screenshots attached');
    assert.equal(pr(s).evidence, 'success');
    assert.equal(s.gh.status(head, 'workplace/evidence')?.state, 'success');
  } finally { await s.done(); }
});

test('a failed pre-pr.sh result makes workplace/tests fail, with the failing tail on the item', async () => {
  const s = setup('shadow');
  try {
    const head = s.commit('services/agent-svc/memory_client.py', 'x = 1\n', undefined, 'fail');
    await reviewed(s);
    assert.equal(s.gh.status(head, 'workplace/tests')?.state, 'failure');
    assert.match(s.gh.status(head, 'workplace/tests')!.description, /agent-svc unit 372 passed, 2 failed/);
    assert.equal(pr(s).tests?.state, 'failure');
    assert.ok(trail.comments(s.wp, s.storyId).some(c => /pre-pr\.sh failed/.test(c.text) && /test_last_song/.test(c.details ?? '')));
  } finally { await s.done(); }
});

test('workplace/tests reports pre-pr.sh: "mobile-android unit 16 passed · agent-svc syntax ok · agent-svc unit 374 passed — run by kabir on <sha7>"; the server runs no suites', async () => {
  const s = setup('shadow', { quality: 'areas:\n  agent-svc:\n    paths: [services/agent-svc/]\n    checks:\n      - name: never\n        run: touch /tmp/never-ran-by-workplace\n' });
  try {
    const head = s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    const st = s.gh.status(head, 'workplace/tests')!;
    assert.equal(st.state, 'success');
    assert.equal(st.description, `mobile-android unit 16 passed · agent-svc syntax ok · agent-svc unit 374 passed — run by kabir on ${head.slice(0, 7)}`);
    assert.ok(!existsSync(join(s.wp.config.workDir, '_quality')), 'no server-side suite checkout');
  } finally { await s.done(); }
});

test('pre-PR gate: report_done and request_review refuse without a passing pre-pr.sh result for the head; local does nothing new', async () => {
  const s = setup('shadow');
  try {
    const client = await (async () => {
      const server = workplaceTools(s.wp, 'kabir', () => ({ agentId: 'a', employeeId: 'kabir', assignmentId: s.storyId, startedAt: '', seen: {}, planCaptured: false }));
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(st);
      const c = new Client({ name: 'test', version: '1' });
      await c.connect(ct);
      return c;
    })();
    const args = { assignmentId: s.storyId, testsPassed: 3, testsFailed: 0, commits: ['abc'], liveVerified: [], notVerified: [] };
    const refusal = /Run scripts\/pre-pr\.sh on your latest commit first \(results belong to a commit\)\./;
    // Not run at all.
    const first = s.commit('services/agent-svc/memory_client.py', 'x = 1\n', undefined, false);
    assert.match(JSON.stringify((await client.callTool({ name: 'report_done', arguments: args })).content), refusal);
    assert.notEqual(rawGet(s.wp, s.storyId)!.status, 'in-review', 'nothing recorded');
    assert.equal(s.gh.count('push'), 0);
    // Failed.
    writePrePr(s.wt, first, { ok: false });
    assert.match(JSON.stringify((await client.callTool({ name: 'report_done', arguments: args })).content), refusal);
    // Passed, but on an older commit.
    s.commit('services/agent-svc/memory_client.py', 'x = 2\n', undefined, false);
    writePrePr(s.wt, first, { ok: true });
    assert.match(JSON.stringify((await client.callTool({ name: 'report_done', arguments: args })).content), refusal);
    // A file named for the head that describes another commit.
    const head = s.commit('services/agent-svc/memory_client.py', 'x = 3\n', undefined, false);
    writePrePr(s.wt, head, { forSha: first });
    assert.match(JSON.stringify((await client.callTool({ name: 'report_done', arguments: args })).content), refusal);
    // A fast run, or one limited to some areas, never counts.
    writePrePr(s.wt, head, { mode: 'fast' });
    assert.match(JSON.stringify((await client.callTool({ name: 'report_done', arguments: args })).content), refusal);
    writePrePr(s.wt, head, { only: ['agent-svc'] });
    const partial = JSON.stringify((await client.callTool({ name: 'report_done', arguments: args })).content);
    assert.match(partial, refusal);
    assert.match(partial, /partial \(--only agent-svc\)/, 'the refusal says why');
    // Not in review yet: request_review never submits, it points at report_done.
    assert.match(JSON.stringify((await client.callTool({ name: 'request_review', arguments: { assignmentId: s.storyId } })).content), /Not requested: .* not in review.*call report_done/);
    // Passed on the head: recorded, pushed, workplace/tests green.
    writePrePr(s.wt, head);
    assert.match(JSON.stringify((await client.callTool({ name: 'report_done', arguments: args })).content), /in review/);
    assert.equal(s.gh.status(head, 'workplace/tests')?.state, 'success');
    await client.close();
  } finally { await s.done(); }

  const l = setup('local');
  try {
    l.commit('services/agent-svc/memory_client.py', 'x = 1\n', undefined, false);
    assert.equal(flow.prePrGate(l.wp, l.storyId), null, 'local: no gate');
  } finally { await l.done(); }
});

test('employee sessions get ANDROID_HOME, JAVA_HOME (JDK 17) and DEVELOPER_DIR (full Xcode)', () => {
  const s = setup('local');
  try {
    const env = childEnv(s.wp);
    assert.equal(env['ANDROID_HOME'], '/opt/homebrew/share/android-commandlinetools');
    assert.match(env['JAVA_HOME'] ?? '', /17/);
    assert.equal(env['DEVELOPER_DIR'], '/Applications/Xcode.app/Contents/Developer');
  } finally { void s.done(); }
});

/* ---------- fallback ---------- */

test('three GitHub failures within five minutes fall back to local and alert the COO', async () => {
  const s = setup('on');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
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
    sh.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(sh);
    const dry = await flow.merge(sh.wp, sh.storyId, 'coo');
    assert.equal(dry.merged, false);
    assert.equal(dry.mode, 'shadow');
    assert.ok(dry.blockers?.some(b => /approval/i.test(b)));
    assert.equal(sh.gh.count('merge'), 0);
  } finally { await sh.done(); }

  const s = setup('on');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    await assert.rejects(flow.merge(s.wp, s.storyId, 'coo'), /approval/i);
    await flow.approve(s.wp, s.storyId, 'arjun');
    const before = git(s.trunkRepo, ['rev-parse', TRUNK]).trim();
    // The QA approval (2 of 2) with workplace/tests green: the Workplace merges it itself.
    const qa = await flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC);
    assert.match(qa.message, /merged/i);
    assert.equal(s.gh.count('merge'), 1);
    assert.equal(pr(s).merged?.by, 'workplace');
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
  const s = setup('on');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n', undefined, 'fail');
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC);
    assert.equal(pr(s).merged, undefined, 'red tests: no auto-merge');
    await flow.autoMergeSweep(s.wp);
    assert.equal(pr(s).merged, undefined, 'nor from the sweep');
    assert.equal(coo.listItems(s.wp).filter(i => /auto-merge/i.test(i.title) && /tests/.test(i.body)).length, 1, 'approved but red: the COO hears of it once');
    await assert.rejects(flow.merge(s.wp, s.storyId, 'coo'), /tests/i);
    assert.equal(s.gh.count('merge'), 0);
  } finally { await s.done(); }
});

test('auto-merge holds when the CTO commented after the developer approval (8 Oct)', async () => {
  const s = setup('on');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await new Promise(r => setTimeout(r, 5));
    trail.record(s.wp, { itemId: s.storyId, by: 'cto', kind: 'comment', text: 'Restructure: verdicts first.' });
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC);
    assert.equal(pr(s).merged, undefined, 'not merged over the late CTO comment');
    assert.equal(coo.listItems(s.wp).filter(i => /auto-merge/i.test(i.title) && /CTO commented/.test(i.body)).length, 1, 'the COO is told why');
  } finally { await s.done(); }
});

test('auto-merge is not held by a CTO comment from before the developer approval', async () => {
  const s = setup('on');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    trail.record(s.wp, { itemId: s.storyId, by: 'cto', kind: 'comment', text: 'Looks fine to start.' });
    await new Promise(r => setTimeout(r, 5));
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC);
    assert.ok(pr(s).merged, 'merged');
  } finally { await s.done(); }
});

test('auto-merge tells Asha on success', async () => {
  const s = setup('on');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC);
    const told = manager.list(s.wp).find(a => a.key.startsWith(`merged:${s.storyId}`));
    assert.ok(told, 'Asha is told');
    assert.match(told!.text ?? told!.body, /merged/i);
    assert.ok(!coo.listItems(s.wp).some(i => /auto-merge/i.test(i.title)), 'the COO is not bothered');
  } finally { await s.done(); }
});

test('auto-merge: a GitHub merge failure alerts the COO once, forces nothing, is not retried; the manual merge still works', async () => {
  const s = setup('on');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    s.gh.failNext('merge', 1);
    const qa = await flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC);   // never throws on a merge problem
    assert.equal(qa.stage, 'qa');
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'done');
    assert.equal(pr(s).merged, undefined);
    const alerts = () => coo.listItems(s.wp).filter(i => /auto-merge/i.test(i.title) && i.itemId === s.storyId);
    assert.equal(alerts().length, 1, 'the COO is alerted');
    assert.match(alerts()[0]!.body, /POST \/api\/coo\/merge/);
    const calls = s.gh.count('merge');
    await flow.autoMergeSweep(s.wp);
    assert.equal(s.gh.count('merge'), calls, 'the same head is left for the COO');
    assert.equal(alerts().length, 1, 'alerted once');
    const m = await flow.merge(s.wp, s.storyId, 'coo');
    assert.equal(m.merged, true);
    assert.equal(pr(s).merged?.by, 'coo');
  } finally { await s.done(); }
});

test('auto-merge: a conflict with trunk reopens the story to its author instead of leaving it Done', async () => {
  const s = setup('on');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    s.gh.failNext('merge', 1, 'GitHub PUT /repos/o/r/pulls/1/merge failed (405): Pull Request has merge conflicts');
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC);
    const w = rawGet(s.wp, s.storyId)!;
    assert.equal(w.status, 'in-progress', 'back with the author');
    assert.equal(w.employeeId, 'kabir');
    assert.equal(pr(s).merged, undefined);
    assert.ok(!coo.listItems(s.wp).some(i => /auto-merge/i.test(i.title) && i.itemId === s.storyId), 'not left for the COO');
    const calls = s.gh.count('merge');
    await flow.autoMergeSweep(s.wp);
    assert.equal(s.gh.count('merge'), calls, 'not retried');
  } finally { await s.done(); }
});

test('auto-merge: a PR GitHub already shows merged is recorded as merged, not alerted', async () => {
  const s = setup('on');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    const fakePr = s.gh.prs[0]!; fakePr.state = 'closed'; fakePr.merged = true;   // its commits reached trunk via another PR
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC);
    assert.equal(pr(s).merged?.by, 'github');
    assert.ok(!coo.listItems(s.wp).some(i => /auto-merge/i.test(i.title) && i.itemId === s.storyId), 'no alert for the COO');
  } finally { await s.done(); }
});

test('auto-merge: the sweep merges a story approved in shadow once the mode is on; shadow never merges', async () => {
  const s = setup('shadow');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC);
    await flow.autoMergeSweep(s.wp);
    assert.equal(s.gh.count('merge'), 0, 'shadow never merges');
    flow.setMode(s.wp, 'on', 'coo');
    const merged = await flow.autoMergeSweep(s.wp);
    assert.deepEqual(merged, [s.storyId]);
    assert.equal(pr(s).merged?.by, 'workplace');
    assert.equal(git(s.trunkRepo, ['rev-parse', TRUNK]).trim(), s.gh.remoteSha(TRUNK), 'the trunk checkout is fast-forwarded');
  } finally { await s.done(); }
});

test('merge: a trunk checkout that cannot fast-forward alerts the COO and is never forced', async () => {
  const s = setup('on');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    // A local commit on the trunk checkout that GitHub does not have: a pull can only merge, not fast-forward.
    writeFileSync(join(s.trunkRepo, 'LOCAL.md'), 'local only\n');
    git(s.trunkRepo, ['add', '-A']);
    git(s.trunkRepo, ['commit', '-q', '-m', 'local only']);
    const local = git(s.trunkRepo, ['rev-parse', 'HEAD']).trim();
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC);   // merges on GitHub, then the sync refuses to force
    assert.ok(pr(s).merged, 'merged on GitHub');
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
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
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

/* ---------- done means on the trunk (landing.ts RCA, 6 Oct) ---------- */

test('on: a story whose branch has changes the trunk never got cannot be marked done without a PR', async () => {
  const s = setup('on');
  try {
    s.commit('services/agent-svc/landed_check.py', 'x = 1\n');
    items.update(s.wp, s.storyId, { status: 'in-progress', reason: 'test: moved' }, 'kabir');
    items.update(s.wp, s.storyId, { status: 'in-review', reviewerId: 'arjun', reason: 'test: moved' }, 'owner');
    assert.throws(() => items.update(s.wp, s.storyId, { status: 'done', reason: 'test: moved' }, 'arjun'), /never reached the trunk/);
    // The owner can still close it deliberately.
    items.update(s.wp, s.storyId, { status: 'done', reason: 'test: moved' }, 'owner');
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'done');
  } finally { await s.done(); }
});

test('on: a story with no commits of its own (a check, a live verification) can still be closed by its reviewer', async () => {
  const s = setup('on');
  try {
    items.update(s.wp, s.storyId, { status: 'in-progress', reason: 'test: moved' }, 'kabir');
    items.update(s.wp, s.storyId, { status: 'in-review', reviewerId: 'arjun', reason: 'test: moved' }, 'owner');
    items.update(s.wp, s.storyId, { status: 'done', reason: 'test: moved' }, 'arjun');
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'done');
  } finally { await s.done(); }
});

test('done check: a stale origin/<trunk> does not count newer trunk commits the story branch carries as unlanded (7 Oct)', async () => {
  const s = setup('on');
  try {
    const trunk = s.wp.config.github.trunk;
    git(s.trunkRepo, ['remote', 'add', 'origin', s.gh.bare]);
    git(s.trunkRepo, ['fetch', '-q', 'origin']);                     // origin/<trunk> = T0
    // Another story merges on GitHub: the trunk moves to T1, but this repo's origin ref is not fetched forward.
    const other = mkdtempSync(join(tmpdir(), 'iris-other-'));
    git(other, ['clone', '-q', '-b', trunk, s.gh.bare, '.']);
    writeFileSync(join(other, 'other.py'), 'y = 2\n');
    git(other, ['add', '-A']);
    git(other, ['-c', 'user.email=o@iris.local', '-c', 'user.name=other', 'commit', '-q', '-m', 'another story']);
    git(other, ['push', '-q', 'origin', trunk]);
    // The story branch picks up T1 (an agent pulled the trunk), with no commits of its own.
    git(s.wt, ['fetch', '-q', s.gh.bare, trunk]);
    git(s.wt, ['merge', '-q', '--ff-only', 'FETCH_HEAD']);
    items.update(s.wp, s.storyId, { status: 'in-progress', reason: 'test: moved' }, 'kabir');
    items.update(s.wp, s.storyId, { status: 'in-review', reviewerId: 'arjun', reason: 'test: moved' }, 'owner');
    items.update(s.wp, s.storyId, { status: 'done', reason: 'test: moved' }, 'arjun');
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'done');
  } finally { await s.done(); }
});

test("QA's approval needs the QA doc: missing, thin or failing docs are refused; a complete one is filed for the staging cycle", async () => {
  const s = setup('shadow');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil'), /needs the QA doc/);
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil', undefined, '## Edge cases\n- PASS: one\n## Report\nshort'), /not complete/);
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC.replace('- PASS: empty input', '- FAIL: empty input')), /review_send_back/);
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil', undefined, '## Edge cases\n- N/A: a\n- N/A: b\n- PASS: c\n## Report\nNothing was really checked here, only marked not applicable.'), /PASS/);
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'in-review', 'a refused QA approval leaves the story in review');
    assert.equal(pr(s).qaApproval, undefined);
    const qa = await flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC);
    assert.equal(qa.stage, 'qa');
    const filed = qaDoc.since(s.wp, '2000-01-01');
    assert.equal(filed.length, 1);
    assert.equal(filed[0]!.itemId, s.storyId);
    assert.match(filed[0]!.text, /provider down/);
    assert.equal(qaDoc.since(s.wp, '2999-01-01').length, 0, 'only docs approved since the last batch');
  } finally { await s.done(); }
});

test('rework W3 (owner, 10 Oct): a design doc is no longer held for the COO; it auto-merges after both approvals like any change', async () => {
  const s = setup('on');
  try {
    s.commit('docs/tech/grounded-awareness.md', '# Technical doc\n');
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC);
    assert.ok(pr(s).merged, 'merged after both approvals');
    assert.equal(coo.listItems(s.wp).filter(i => /auto-merge/i.test(i.title) && i.itemId === s.storyId).length, 0, 'the COO is not asked');
    assert.equal((flow as Record<string, unknown>)['DESIGN_DOC'], undefined, 'the hold is gone');
  } finally { await s.done(); }
});

test('a full pre-pr.sh result that arrives after approval is re-read: the sweep merges the story instead of waiting forever', async () => {
  const s = setup('on');
  try {
    const head = s.commit('services/agent-svc/memory_client.py', 'x = 1\n', undefined, false);
    writePrePr(s.wt, head, { mode: 'fast' });          // passes the submit gate, but only a full run turns tests green
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC);
    assert.equal(pr(s).tests?.state, 'pending');
    assert.equal(pr(s).merged, undefined, 'approved but waiting for a full run');
    writePrePr(s.wt, head, { mode: 'full' });           // the author (or the COO) runs the full checks later
    await flow.autoMergeSweep(s.wp);
    assert.equal(pr(s).tests?.state, 'success', 'the later result is read');
    assert.ok(pr(s).merged, 'and the story merges');
  } finally { await s.done(); }
});

test('a pre-pr.sh result run only AFTER the push (no workplace/tests at all) is read before merging (11 Oct, gap #19)', async () => {
  const s = setup('on');
  try {
    const head = s.commit('services/agent-svc/memory_client.py', 'x = 1\n', undefined, false);
    writePrePr(s.wt, head, { mode: 'fast' });
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC);
    const w = rawGet(s.wp, s.storyId)!;
    delete (w.pr as { tests?: unknown }).tests;                                // as if the push recorded nothing
    s.wp.db.prepare('update work set json = ? where id = ?').run(JSON.stringify(w), s.storyId);
    assert.equal(pr(s).tests, undefined);
    writePrePr(s.wt, head, { mode: 'full' });
    await flow.autoMergeSweep(s.wp);
    assert.equal(pr(s).tests?.state, 'success', 'the missing tests status is read from the result');
    assert.ok(pr(s).merged, 'and the story merges');
  } finally { await s.done(); }
});

test('approved but not merged reads as "Approved, NOT merged" to agents, and a story starting after it is not flagged as blocked on a closed item (11 Oct, gaps #18/#21)', async () => {
  const s = setup('on');
  try {
    const head = s.commit('services/agent-svc/memory_client.py', 'x = 1\n', undefined, false);
    writePrePr(s.wt, head, { mode: 'fast' });                 // tests stay pending, so it cannot merge yet
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, QA_DOC);
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'done');
    assert.equal(pr(s).merged, undefined);
    assert.match(readTools.readItem(s.wp, s.storyId), /Approved, NOT merged yet/);
    assert.match(statusAnswers.lineFor(s.wp, items.detail(s.wp, s.storyId).item), /^Approved, NOT merged yet/, 'status_of says it too');
    const epicId = rawGet(s.wp, s.storyId)!.parentId!;
    const next = items.create(s.wp, { level: 'story', title: 'Waits for it', parentId: epicId, assigneeId: 'kabir', startsAfter: s.storyId }, 'owner');
    assert.ok(!hygiene.report(s.wp).violations.some(v => v.rule === 'bad-block' && v.itemId === next.id), 'it will finish: not "closed and will never finish"');
  } finally { await s.done(); }
});

test("owner, 7 Oct: the COO may close stale or unlanded work as won't-do or duplicate with a reason; 'done' still needs the trunk", async () => {
  const s = setup('on');
  try {
    s.commit('services/agent-svc/landed_check.py', 'x = 1\n');            // unlanded change on the branch
    assert.throws(() => items.update(s.wp, s.storyId, { status: 'done', reason: 'test: moved' }, 'coo'), /never reached the trunk|owner's call/, "done still means landed");
    assert.throws(() => items.update(s.wp, s.storyId, { status: 'done', resolution: 'wont-do' }, 'coo'), /needs a note|give a reason/);
    assert.throws(() => items.update(s.wp, s.storyId, { status: 'done', resolution: 'wont-do', note: 'stale' }, 'arjun'), /never reached the trunk|owner's call|reviewer|Forbidden/, 'not for anyone else');
    items.update(s.wp, s.storyId, { status: 'done', resolution: 'wont-do', note: 'Superseded by the CTO doc' }, 'coo');
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'done');
    assert.equal(rawGet(s.wp, s.storyId)!.resolution, 'wont-do');
  } finally { await s.done(); }
});

test('QA review goes to the QA-capable person with the fewest reviews waiting, not always the first QA (7 Oct)', () => {
  const emp = (id: string, roleId: string) => ({ id, name: id, roleId, level: 2, charterIds: id === 'kabir' ? ['memory'] : ['qa-release'], reportsTo: 'cto' }) as unknown as import('@jkj/shared').Employee;
  const staff = [emp('nikhil', 'qa'), emp('zoya', 'engineer'), emp('kabir', 'lead')];
  const w = { id: 'as_x', employeeId: 'kabir', reviewerId: 'dev' } as unknown as WorkItem;
  assert.equal(qaReviewer(staff, w, ['dev']), 'nikhil', 'quiet floor: the qa role first, as before');
  assert.equal(qaReviewer(staff, w, ['dev'], { nikhil: 3, zoya: 0 }), 'zoya', 'Nikhil has three waiting: Zoya takes it');
  assert.equal(qaReviewer(staff, w, ['dev'], { nikhil: 1, zoya: 1 }), 'nikhil', 'a tie keeps the qa role first');
  assert.equal(qaReviewer(staff, { ...w, reviewerId: 'zoya' }, ['dev'], { zoya: 5 }), 'zoya', 'a QA already named on the item keeps it');
});
