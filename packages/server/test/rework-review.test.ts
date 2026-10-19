import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Employee, WorkItem } from '@jkj/shared';
import type { Workplace } from '../src/services/workplace.js';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as trail from '../src/services/trail.js';
import * as inbox from '../src/services/inbox.js';
import * as readTools from '../src/services/read-tools.js';
import * as flow from '../src/services/github-flow.js';
import * as qaDoc from '../src/services/qa-doc.js';
import * as employees from '../src/services/employees.js';
import { employee, workplaceTools } from '../src/services/employees.js';
import { assembleContext } from '../src/services/context-layers.js';
import { writeEmployeeFile } from '../src/services/org.js';
import { ensureWorktree } from '../src/services/worktrees.js';
import { rawGet } from '../src/services/v2-map.js';
import { testWorkplace } from './fakes/workplace.js';
import { FakeGitHub } from './fakes/fake-github.js';
import { writePrePr } from './fakes/pre-pr.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';

/**
 * W3 of the October rework (docs/TDD-rework-2026-10.md §W3): comments are capped and never cut, plans
 * and RCAs are captured and pinned, a bug writes no code before its RCA, the developer approval comes
 * from the author's team, other teams' leads approve their files, one QA per story with proof per case,
 * evidence before merge, trunk catch-up keeps approvals, and merges need the COO only for spend.
 */

const runtime = installFakeRuntime();
after(() => runtime.restore());
const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });
const TRUNK = 'feat/iris-character';

/* ---------- the org the tests use: two teams, QA with an engineer, a CTO ---------- */

function staff(wp: Workplace): void {
  if (wp.org.employees.some(e => e.id === 'arjun')) return;
  const kabir = employee(wp, 'kabir');
  const add = (e: Partial<Employee> & { id: string }) => wp.org.employees.push({ ...kabir, name: e.id[0]!.toUpperCase() + e.id.slice(1), level: 2, ...e } as Employee);
  add({ id: 'arjun', roleId: 'engineer', charterIds: ['memory'], reportsTo: 'kabir' });          // Kabir's team
  add({ id: 'neel', roleId: 'engineer', charterIds: ['conversation'], reportsTo: 'dev' });       // Dev's team
  add({ id: 'zoya', roleId: 'engineer', charterIds: ['qa-release'], reportsTo: 'nikhil' });      // QA's team
  add({ id: 'cto', name: 'Vikram', roleId: 'cto', level: 0, charterIds: [], reportsTo: 'coo' });
}

interface Setup {
  wp: Workplace;
  gh: FakeGitHub;
  storyId: string;
  wt: string;
  trunkRepo: string;
  commit(files: Record<string, string>, message?: string): string;
  done(): Promise<void>;
}

function setup(mode: 'shadow' | 'on' = 'shadow', opts: { author?: string; trunk?: Record<string, string> } = {}): Setup {
  const { wp, tmp } = testWorkplace();
  staff(wp);
  const author = employee(wp, opts.author ?? 'kabir');
  const trunkRepo = author.workspace.repo;
  if (opts.trunk) {
    for (const [f, c] of Object.entries(opts.trunk)) { mkdirSync(join(trunkRepo, f, '..'), { recursive: true }); writeFileSync(join(trunkRepo, f), c); }
    git(trunkRepo, ['add', '-A']);
    git(trunkRepo, ['-c', 'user.email=t@iris.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'trunk files']);
  }
  writeFileSync(join(wp.config.workplaceDir, 'quality.yaml'), 'maxFileBytes: 100000\nareas: {}\n');
  const gh = new FakeGitHub(trunkRepo);
  flow.useGitHub(wp, gh);
  flow.setMode(wp, mode, 'coo');
  const epic = items.create(wp, { level: 'epic', title: 'Memory' }, 'owner');
  const story = items.create(wp, { level: 'story', title: 'Recall the last song', parentId: epic.id, assigneeId: author.id }, 'owner');
  const wt = ensureWorktree(wp.config.workDir, author, story.id).path;
  const commit = (files: Record<string, string>, message = 'change'): string => {
    for (const [f, c] of Object.entries(files)) { mkdirSync(join(wt, f, '..'), { recursive: true }); writeFileSync(join(wt, f), c); }
    git(wt, ['add', '-A']);
    git(wt, ['-c', `user.email=${author.id}@iris.local`, '-c', `user.name=${author.id}`, 'commit', '-q', '-m', message]);
    const sha = git(wt, ['rev-parse', 'HEAD']).trim();
    writePrePr(wt, sha, { ok: true, by: author.id });
    return sha;
  };
  return { wp, gh, storyId: story.id, wt, trunkRepo, commit, done: async () => { await flow.settled(); gh.cleanup(); tmp.cleanup(); } };
}

const evidence = { tests: { passed: 3, failed: 0, command: 'npm test' }, commits: ['abc'], liveVerified: [], notVerified: ['live'] };

async function reviewed(s: Setup, by = 'kabir'): Promise<void> {
  work.reportDone(s.wp, s.storyId, evidence, by);
  await (await flow.onReview(s.wp, s.storyId, by)).tests;
}

const pr = (s: Setup): NonNullable<WorkItem['pr']> => { const p = rawGet(s.wp, s.storyId)!.pr; assert.ok(p, 'the item has a PR record'); return p; };

/** A proof file under the evidence folder (~/iris-workplace/evidence in production). */
function proof(wp: Workplace, rel = 'logs/unit.txt'): string {
  const path = join(qaDoc.evidenceDir(wp), rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'ok\n');
  return rel;
}

/** A QA doc whose cases cite proof; `na` adds "Evidence: n/a" with its tests line (merge may go on without robot evidence). */
function qaText(wp: Workplace, na = true): string {
  return [
    '## Edge cases',
    `- PASS: empty input — unit test evidence: ${proof(wp)}`,
    '- PASS: provider down — killed the provider and checked the reply evidence: https://ci.example.com/runs/42',
    '- N/A: Windows path — no Windows code touched',
    '## Report',
    'Checked both failure paths by hand and in tests; Windows untouched; residual risk low.',
    ...(na ? ['Evidence: n/a — server-only change with no app surface', 'Tests: npm test 12 passed, 0 failed'] : []),
  ].join('\n');
}

async function toolsFor(wp: Workplace, employeeId: string, assignmentId?: string) {
  const server = workplaceTools(wp, employeeId, () => ({ agentId: 'a', employeeId, ...(assignmentId ? { assignmentId } : {}), startedAt: '', seen: {}, planCaptured: false }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(st);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(ct);
  return async (name: string, args: Record<string, unknown>) => JSON.stringify((await client.callTool({ name, arguments: args })).content);
}

function plainStory(wp: Workplace, assigneeId: string, type?: 'bug' | 'rca'): WorkItem {
  staff(wp);
  const epic = items.create(wp, { level: 'epic', title: 'Quality' }, 'owner');
  const s = items.create(wp, { level: 'story', title: type === 'rca' ? 'Why did recall break' : 'Recall returns the wrong song', parentId: epic.id, assigneeId }, 'owner');
  if (type) work.saveQuiet(wp, { ...rawGet(wp, s.id)!, type });
  return rawGet(wp, s.id)!;
}

const RCA = [
  '## RCA',
  '- Symptom: recall returned the second-last song',
  '- Root cause: an off-by-one in the history index',
  '- Why QA missed it: the suite only had one song in history',
  '- Fix: index from the end, with a test of two songs',
  '- Regression: test_recall_two_songs in the memory suite',
].join('\n');

/* ---------- comments ---------- */

test('1: an agent comment over 1200 characters is refused with the doc hint, through the tool and the Inbox too', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const s = plainStory(wp, 'dev');
    const long = 'x'.repeat(1201);
    assert.throws(() => trail.comment(wp, s.id, { by: 'dev', text: long }), /^BadRequest: Not posted: comments are capped at 1200 characters \(yours: 1201\)\. Put the detail in a doc \(doc_write\) and link it\.$/);
    assert.equal(trail.comments(wp, s.id).length, 0, 'nothing posted');
    const call = await toolsFor(wp, 'dev', s.id);
    assert.match(await call('item_comment', { itemId: s.id, text: long }), /Not posted: comments are capped at 1200 characters \(yours: 1201\).*doc_write/);
    const ask = inbox.raise(wp, { kind: 'decision', title: 'Which voice?', body: 'Two.', raisedBy: 'dev', recommendation: 'Nova' } as never);
    assert.throws(() => inbox.reply(wp, ask.id, { by: 'dev', text: long }), /capped at 1200 characters \(yours: 1201\)/);
  } finally { tmp.cleanup(); }
});

test('2: a 1200-character agent comment is stored whole, with no "…" and no details', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const s = plainStory(wp, 'dev');
    const text = Array.from({ length: 12 }, (_, i) => `line ${String(i).padStart(2, '0')} ${'y'.repeat(91)}`).join('\n').padEnd(1200, 'y');
    assert.equal(text.length, 1200);
    const c = trail.comment(wp, s.id, { by: 'dev', text });
    assert.equal(c.text, text);
    assert.equal(c.details, undefined);
    assert.ok(!c.text.includes('…'));
    const ask = inbox.raise(wp, { kind: 'decision', title: 'Which voice?', body: 'Two.', raisedBy: 'dev', recommendation: 'Nova' } as never);
    const t = inbox.reply(wp, ask.id, { by: 'dev', text });
    assert.equal(t.messages.at(-1)!.text, text, 'an Inbox reply is stored whole too');
  } finally { tmp.cleanup(); }
});

test('3: an owner (or COO) comment of any length is fine', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const s = plainStory(wp, 'dev');
    const long = 'z'.repeat(5000);
    assert.equal(trail.comment(wp, s.id, { by: 'owner', text: long }).text, long);
    assert.equal(trail.comment(wp, s.id, { by: 'coo', text: long }).text, long);
  } finally { tmp.cleanup(); }
});

/* ---------- reads ---------- */

test('4: item_read keeps a "## Plan" and a "## RCA" comment when older comments are dropped', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const s = plainStory(wp, 'arjun', 'bug');
    trail.comment(wp, s.id, { by: 'arjun', text: '## Plan\n- PLAN-MARKER: index from the end\n- test two songs' });
    trail.comment(wp, s.id, { by: 'nikhil', text: RCA.replace('Symptom:', 'Symptom: RCA-MARKER') });
    for (let i = 0; i < 60; i++) trail.comment(wp, s.id, { by: 'owner', text: `Comment ${i}: ${'w'.repeat(400)}` });
    const out = readTools.readItem(wp, s.id);
    assert.ok(out.length <= readTools.MAX_CHARS, `${out.length} chars`);
    assert.match(out, /older comments? omitted/, 'old comments are dropped');
    assert.ok(!out.includes('Comment 0:'), 'the oldest ordinary comment is gone');
    assert.match(out, /PLAN-MARKER/, 'the plan is pinned');
    assert.match(out, /RCA-MARKER/, 'the RCA is pinned');
    assert.match(out, /Regression: test_recall_two_songs/, 'the whole RCA');
    assert.ok(out.indexOf('PLAN-MARKER') < out.indexOf('Comments ('), 'pinned after the head, before the comments');
  } finally { tmp.cleanup(); }
});

/* ---------- plan and RCA capture ---------- */

test('5: a "## Plan" comment from the assignee sets item.plan, and there is no plan warning', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const s = plainStory(wp, 'arjun');
    items.update(wp, s.id, { status: 'in-progress', note: 'starting' }, 'arjun');
    assert.equal(work.planWarning(rawGet(wp, s.id)!), 'no plan was posted before the work');
    // Someone else's plan is only a comment.
    await (await toolsFor(wp, 'kabir'))('item_comment', { itemId: s.id, text: '## Plan\nnot mine to write' });
    assert.equal(rawGet(wp, s.id)!.plan, undefined);
    const out = await (await toolsFor(wp, 'arjun', s.id))('item_comment', { itemId: s.id, text: 'Starting.\n## Plan: index from the end\n- add a two-song test' });
    assert.match(out, /plan is recorded/);
    const w = rawGet(wp, s.id)!;
    assert.match(w.plan ?? '', /index from the end[\s\S]*two-song test/);
    assert.equal(work.planWarning(w), null);
  } finally { tmp.cleanup(); }
});

test('6: a five-part "## RCA" comment from the assignee sets item.rca', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const s = plainStory(wp, 'nikhil', 'bug');
    const out = await (await toolsFor(wp, 'nikhil', s.id))('item_comment', { itemId: s.id, text: `Found it.\n${RCA}` });
    assert.match(out, /RCA is recorded/);
    const rca = rawGet(wp, s.id)!.rca;
    assert.ok(rca, 'the RCA is on the item');
    assert.equal(rca.by, 'nikhil');
    assert.match(rca.text, /^## RCA[\s\S]*Root cause: an off-by-one/);
    assert.ok(!rca.text.includes('Found it.'), 'only the RCA section');
  } finally { tmp.cleanup(); }
});

test('7: a four-part RCA does not set it, and the reply says what is missing', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    const s = plainStory(wp, 'nikhil', 'bug');
    const four = RCA.split('\n').filter(l => !l.includes('Regression')).join('\n');
    const out = await (await toolsFor(wp, 'nikhil', s.id))('item_comment', { itemId: s.id, text: four });
    assert.match(out, /RCA is NOT recorded: it is missing Regression/);
    assert.equal(rawGet(wp, s.id)!.rca, undefined);
    assert.equal(trail.comments(wp, s.id).length, 1, 'still posted as a comment');
  } finally { tmp.cleanup(); }
});

/* ---------- the RCA gate ---------- */

function withOauth(dir: string): void {
  mkdirSync(join(dir, 'ops', 'workplace'), { recursive: true });
  writeFileSync(join(dir, 'ops', 'workplace', 'claude-oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=x\n');
}

type HookOut = { hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string } };
function hookOf(s: ReturnType<typeof runtime.last>) {
  const hook = s.options.hooks!.PreToolUse![0]!.hooks[0]!;
  return (tool: string, input: Record<string, unknown>) => hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: s.options.cwd } as never, 't', { signal: new AbortController().signal }) as Promise<HookOut>;
}

test('8 and 9: on a bug with no RCA, Edit and git commit are denied; after the RCA both are allowed', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    staff(wp);
    withOauth(tmp.dir);
    const bug = plainStory(wp, 'arjun', 'bug');
    employees.spawn(wp, 'arjun', { assignment: bug, prompt: 'Fix the bug.' });
    const run = hookOf(runtime.last());
    const file = join(runtime.last().options.cwd!, 'services', 'memory-svc', 'recall.py');
    const edit = await run('Edit', { file_path: file, old_string: 'a', new_string: 'b' });
    assert.equal(edit.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(edit.hookSpecificOutput!.permissionDecisionReason, /RCA first: post a 5-part "## RCA" comment on the story before changing code/);
    const commit = await run('Bash', { command: 'git commit -am "fix"' });
    assert.match(commit.hookSpecificOutput?.permissionDecisionReason ?? '', /RCA first/);
    assert.equal((await run('Read', { file_path: file })).hookSpecificOutput, undefined, 'reading is fine');
    assert.equal((await run('Bash', { command: 'git status' })).hookSpecificOutput, undefined, 'other commands are fine');

    await (await toolsFor(wp, 'arjun', bug.id))('item_comment', { itemId: bug.id, text: RCA });
    assert.ok(rawGet(wp, bug.id)!.rca);
    assert.equal((await run('Edit', { file_path: file, old_string: 'a', new_string: 'b' })).hookSpecificOutput, undefined, 'Edit unlocked at once');
    assert.equal((await run('Bash', { command: 'git commit -am "fix"' })).hookSpecificOutput, undefined, 'git commit unlocked');
  } finally { tmp.cleanup(); }
});

test('10: on an RCA ticket, Edit is always denied, even with the RCA posted', async () => {
  const { wp, tmp } = testWorkplace();
  try {
    staff(wp);
    withOauth(tmp.dir);
    const t = plainStory(wp, 'arjun', 'rca');
    employees.spawn(wp, 'arjun', { assignment: t, prompt: 'Find the root cause.' });
    const run = hookOf(runtime.last());
    const file = join(runtime.last().options.cwd!, 'services', 'memory-svc', 'recall.py');
    assert.match((await run('Write', { file_path: file, content: 'x' })).hookSpecificOutput?.permissionDecisionReason ?? '', /This is an RCA ticket: no code changes; post the RCA and report_done/);
    await (await toolsFor(wp, 'arjun', t.id))('item_comment', { itemId: t.id, text: RCA });
    assert.ok(rawGet(wp, t.id)!.rca);
    assert.match((await run('Edit', { file_path: file, old_string: 'a', new_string: 'b' })).hookSpecificOutput?.permissionDecisionReason ?? '', /RCA ticket/);
    assert.match((await run('Bash', { command: 'git add -A' })).hookSpecificOutput?.permissionDecisionReason ?? '', /RCA ticket/);
  } finally { tmp.cleanup(); }
});

test('11: on an RCA ticket with its RCA, report_done marks it done without a PR; without the RCA, or with commits, it is refused', async () => {
  const s = setup('shadow', { author: 'arjun' });
  try {
    work.saveQuiet(s.wp, { ...rawGet(s.wp, s.storyId)!, type: 'rca' });
    items.update(s.wp, s.storyId, { status: 'in-progress', note: 'investigating' }, 'arjun');
    const call = await toolsFor(s.wp, 'arjun', s.storyId);
    const done = { assignmentId: s.storyId, testsPassed: 0, testsFailed: 0, commits: [], liveVerified: [], notVerified: [], notes: 'RCA only' };
    assert.match(await call('report_done', done), /Not recorded: this is an RCA ticket, so post the five-part \\"## RCA\\"/);
    await call('item_comment', { itemId: s.storyId, text: RCA });
    const out = await call('report_done', done);
    assert.match(out, /is done: an RCA ticket closes when its RCA is posted/);
    const w = rawGet(s.wp, s.storyId)!;
    assert.equal(w.status, 'done');
    assert.equal(w.resolution, 'done');
    assert.equal(w.pr, undefined, 'no pull request');
    assert.equal(s.gh.calls.length, 0, 'GitHub never touched');
    assert.ok(trail.activityFor(s.wp, s.storyId).some(a => a.kind === 'status' && a.to === 'done' && /^system: RCA posted/.test(a.text)));

    // An RCA ticket with code on its branch is refused.
    const t = plainStory(s.wp, 'arjun', 'rca');
    const wt = ensureWorktree(s.wp.config.workDir, employee(s.wp, 'arjun'), t.id);
    writeFileSync(join(wt.path, 'x.py'), 'x = 1\n');
    git(wt.path, ['add', '-A']);
    git(wt.path, ['-c', 'user.email=a@iris.local', '-c', 'user.name=a', 'commit', '-q', '-m', 'oops']);
    const server = workplaceTools(s.wp, 'arjun', () => ({ agentId: 'b', employeeId: 'arjun', assignmentId: t.id, worktree: wt, startedAt: '', seen: {}, planCaptured: false }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(st);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(ct);
    await client.callTool({ name: 'item_comment', arguments: { itemId: t.id, text: RCA } });
    const refused = JSON.stringify((await client.callTool({ name: 'report_done', arguments: { ...done, assignmentId: t.id } })).content);
    assert.match(refused, /RCA ticket, and its branch has 1 commit/);
    assert.notEqual(rawGet(s.wp, t.id)!.status, 'done');
  } finally { await s.done(); }
});

/* ---------- the developer approval: the author's team ---------- */

test("12: a same-team engineer gives the developer approval on a lead's story (and is named the reviewer)", async () => {
  const s = setup();
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    assert.equal(rawGet(s.wp, s.storyId)!.reviewerId, 'arjun', 'a member of Kabir\'s team reviews first');
    assert.equal(pr(s).devReviewer, 'arjun');
    const r = await flow.approve(s.wp, s.storyId, 'arjun', 'reads well');
    assert.equal(r.stage, 'dev');
    assert.equal(pr(s).devApproval?.by, 'arjun');
  } finally { await s.done(); }
});

test("13 and 14: a lead from another team can't give the developer approval; the CTO can", async () => {
  const s = setup();
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    await assert.rejects(flow.approve(s.wp, s.storyId, 'dev'), /Dev is not in Kabir's team.*Arjun/);
    await assert.rejects(flow.approve(s.wp, s.storyId, 'mira'), /not in Kabir's team/);
    assert.equal(pr(s).devApproval, undefined);
    const r = await flow.approve(s.wp, s.storyId, 'cto');
    assert.equal(r.stage, 'dev');
    assert.equal(pr(s).devApproval?.by, 'cto');
  } finally { await s.done(); }
});

/* ---------- extra reviewers ---------- */

test("15 and 17: a diff touching another team's code adds that team's lead; QA waits until they approve", async () => {
  const s = setup();
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n', 'services/agent-svc/speaker.py': 'def speak():\n    return 1\n' });
    await reviewed(s);
    assert.deepEqual(pr(s).extraReviewers?.map(e => ({ id: e.id, files: e.files })), [{ id: 'dev', files: ['services/agent-svc/speaker.py'] }]);
    const ping = trail.comments(s.wp, s.storyId).find(c => c.by === 'workplace' && /Extra review before QA/.test(c.text));
    assert.ok(ping, 'the extra reviewer is told on the item');
    assert.deepEqual(ping.mentions, ['dev']);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp)), /Waiting for Dev to approve their files/);
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'in-review');
    const extra = await flow.approve(s.wp, s.storyId, 'dev', 'speaker change is fine');
    assert.equal(extra.stage, 'extra');
    assert.ok(pr(s).extraReviewers![0]!.approvedAt);
    assert.equal(pr(s).devApproval?.by, 'arjun', 'the extra approval is not the developer approval');
    const qa = await flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp));
    assert.equal(qa.stage, 'qa');
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'done');
  } finally { await s.done(); }
});

test('15b: the author can add an extra reviewer (request_review extraReviewers), never a teammate; QA waits for them too', async () => {
  const s = setup();
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    assert.equal(pr(s).extraReviewers, undefined);
    const call = await toolsFor(s.wp, 'kabir', s.storyId);
    assert.match(await call('request_review', { assignmentId: s.storyId, extraReviewers: ['arjun'] }), /Arjun is in your team/);
    assert.match(await call('request_review', { assignmentId: s.storyId, extraReviewers: ['mira'] }), /Review requested/);
    assert.deepEqual(pr(s).extraReviewers?.map(({ askedAt: _a, ...e }) => e), [{ id: 'mira', files: [], requested: true }]);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp)), /Waiting for Mira/);
    assert.equal((await flow.approve(s.wp, s.storyId, 'mira')).stage, 'extra');
    // A new push keeps an author-requested reviewer (the diff does not name them).
    s.commit({ 'services/memory-svc/recall.py': 'x = 2\n' });
    await flow.syncHeads(s.wp);
    assert.deepEqual(pr(s).extraReviewers?.map(({ askedAt: _a, ...e }) => e), [{ id: 'mira', files: [], requested: true }], 'kept, and the approval reset by the new commit');
  } finally { await s.done(); }
});

test('16: a diff touching only a comment line in another team\'s file, or *.md, adds nothing', async () => {
  const s = setup('shadow', { trunk: { 'services/agent-svc/speaker.py': 'def speak():\n    return 1\n' } });
  try {
    s.commit({
      'services/memory-svc/recall.py': 'x = 1\n',
      'services/agent-svc/speaker.py': '# Speak one line.\ndef speak():\n\n    return 1\n',
      'docs/HLD-responsiveness.md': '# notes\n',
      'services/agent-svc/NOTES.md': 'readme\n',
    });
    await reviewed(s);
    assert.equal(pr(s).extraReviewers, undefined);
    assert.ok(!trail.comments(s.wp, s.storyId).some(c => /Extra review/.test(c.text)));
  } finally { await s.done(); }
});

/* ---------- QA ---------- */

test('18: one QA per story: a second QA is refused while another is assigned; Asha can change it', async () => {
  const s = setup();
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    assert.equal(pr(s).qaReviewer, 'nikhil');
    await assert.rejects(flow.approve(s.wp, s.storyId, 'zoya', undefined, qaText(s.wp)), /Nikhil is this story's QA/);
    // The author cannot swap the QA by renaming the reviewer: refused at the rename (board bug 2, 19 Oct),
    // so the board never names a QA the gate refuses.
    assert.throws(() => items.update(s.wp, s.storyId, { reviewerId: 'zoya', note: 'zoya is free' }, 'kabir'), /Nikhil is this story's QA/);
    await assert.rejects(flow.approve(s.wp, s.storyId, 'zoya', undefined, qaText(s.wp)), /Nikhil is this story's QA/);
    items.update(s.wp, s.storyId, { reviewerId: 'zoya', note: 'Nikhil is out today; Zoya takes QA' }, 'asha');
    const r = await flow.approve(s.wp, s.storyId, 'zoya', undefined, qaText(s.wp));
    assert.equal(r.stage, 'qa');
    assert.equal(pr(s).qaReviewer, 'zoya');
    assert.equal(pr(s).qaApproval?.by, 'zoya');
  } finally { await s.done(); }
});

test('19 and 20: a QA doc whose cases cite no proof is refused; existing paths and URLs are accepted', async () => {
  const s = setup();
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    const bare = '## Edge cases\n- PASS: empty input — unit test\n- PASS: provider down — checked by hand\n- N/A: Windows — none\n## Report\nChecked both failure paths by hand and in tests; residual risk low.';
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil', undefined, bare), /Each case needs proof: add "evidence: <screenshot\/log path or URL>"/);
    const missing = bare.replace('unit test', 'unit test evidence: logs/nowhere.txt').replace('by hand', 'by hand evidence: /no/such/file.png');
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil', undefined, missing), /Each case needs proof/);
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil', undefined, `${qaText(s.wp, false)}\nEvidence: n/a — server only`), /Tests: <command> <counts>/, 'n/a needs its tests line');
    assert.equal(pr(s).qaApproval, undefined);
    // An absolute path, a path in the evidence folder, and one in the author's worktree.
    const abs = join(qaDoc.evidenceDir(s.wp), proof(s.wp, 'shots/recall.png'));
    writeFileSync(join(s.wt, 'qa-run.log'), 'passed\n');
    const good = [
      '## Edge cases',
      `- PASS: empty input — unit test evidence: ${proof(s.wp)}`,
      `- PASS: provider down — screenshot evidence: ${abs}`,
      '- PASS: a rerun — the run log (evidence: qa-run.log)',
      '- N/A: Windows path — no Windows code touched',
      '## Report',
      'Checked both failure paths by hand and in tests; residual risk low.',
    ].join('\n');
    const r = await flow.approve(s.wp, s.storyId, 'nikhil', undefined, good);
    assert.equal(r.stage, 'qa');
  } finally { await s.done(); }
});

/* ---------- merge ---------- */

test("21: autoReady is false when pr.evidence isn't success and the QA doc has no \"Evidence: n/a\"", async () => {
  const s = setup('on');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp, false));
    const w = rawGet(s.wp, s.storyId)!;
    assert.equal(w.status, 'done');
    assert.equal(w.pr!.tests?.state, 'success');
    assert.equal(flow.autoReady(s.wp, w), 'waiting');
    assert.equal(pr(s).merged, undefined, 'not merged without evidence');
    await assert.rejects(flow.merge(s.wp, s.storyId, 'coo'), /workplace\/evidence is pending/, 'the manual merge needs it too');
    await flow.setEvidence(s.wp, s.storyId, 'success', '3 passed on ios');
    assert.equal(flow.autoReady(s.wp, rawGet(s.wp, s.storyId)!), 'ready');
    await flow.autoMergeSweep(s.wp);
    assert.ok(pr(s).merged, 'merged once the evidence passed');
  } finally { await s.done(); }
});

test('22: a head moving through a trunk-only merge keeps both approvals, the tests and the evidence', async () => {
  const s = setup('shadow');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    const before = pr(s);
    // The trunk moves on; the author merges it in (allowed), and nothing else.
    writeFileSync(join(s.trunkRepo, 'services', 'agent-svc', 'other.py'), 'y = 2\n');
    git(s.trunkRepo, ['add', '-A']);
    git(s.trunkRepo, ['-c', 'user.email=t@iris.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'trunk moves']);
    git(s.wt, ['-c', 'user.email=k@iris.local', '-c', 'user.name=k', 'merge', '-q', '--no-edit', TRUNK]);
    const head = git(s.wt, ['rev-parse', 'HEAD']).trim();
    assert.notEqual(head, before.headSha);
    assert.deepEqual(await flow.syncHeads(s.wp), [s.storyId]);
    const after = pr(s);
    assert.equal(after.headSha, head);
    assert.equal(after.devApproval?.by, 'arjun');
    assert.equal(after.devApproval?.sha, head, 'the approval moves to the new head');
    assert.equal(flow.approvalHolds(rawGet(s.wp, s.storyId)!, 'dev'), true);
    assert.equal(after.tests?.state, 'success');
    assert.match(after.tests!.summary, /carried: trunk-only merge/);
    assert.equal(after.evidence, before.evidence, 'evidence is not made stale');
    assert.equal(s.gh.remoteSha(`emp/kabir/${s.storyId}`), head, 'pushed');
    const qa = await flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp));
    assert.equal(qa.stage, 'qa', 'QA approves the merged head without a new developer approval');
    assert.equal(pr(s).devApproval?.sha, head);
  } finally { await s.done(); }
});

test('23: a head moving through a real commit (or a merge that slips in a change) resets them', async () => {
  const s = setup('shadow');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    // A merge of the trunk with an extra change folded into the merge commit is the author's work.
    writeFileSync(join(s.trunkRepo, 'services', 'agent-svc', 'other.py'), 'y = 2\n');
    git(s.trunkRepo, ['add', '-A']);
    git(s.trunkRepo, ['-c', 'user.email=t@iris.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'trunk moves']);
    git(s.wt, ['merge', '-q', '--no-commit', '--no-ff', TRUNK]);
    writeFileSync(join(s.wt, 'services', 'memory-svc', 'recall.py'), 'x = 99\n');
    git(s.wt, ['add', '-A']);
    git(s.wt, ['-c', 'user.email=k@iris.local', '-c', 'user.name=k', 'commit', '-q', '--no-edit']);
    await flow.syncHeads(s.wp);
    assert.equal(pr(s).devApproval, undefined, 'an evil merge resets the approvals');
    assert.equal(pr(s).evidence, 'stale');
    await flow.approve(s.wp, s.storyId, 'arjun');
    s.commit({ 'services/memory-svc/recall.py': 'x = 2\n' });
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp)), /new commit resets both approvals/);
    assert.equal(pr(s).devApproval, undefined);
  } finally { await s.done(); }
});

test('22b: when the trunk advances, the sweep brings the PR up to date through GitHub update-branch, and the approval holds', async () => {
  const s = setup('shadow');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    // Another story lands on the trunk (GitHub's and the local checkout).
    writeFileSync(join(s.trunkRepo, 'services', 'agent-svc', 'other.py'), 'y = 2\n');
    git(s.trunkRepo, ['add', '-A']);
    git(s.trunkRepo, ['-c', 'user.email=t@iris.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'trunk moves']);
    git(s.trunkRepo, ['push', '-q', s.gh.bare, TRUNK]);
    // Kabir has moved on: his worktree is on another branch, which must not move.
    git(s.wt, ['checkout', '-q', '-b', 'emp/kabir/as_other']);
    const other = git(s.wt, ['rev-parse', 'HEAD']).trim();
    await flow.syncHeads(s.wp);
    assert.equal(s.gh.count('updateBranch'), 1, 'GitHub is asked to update the branch');
    await flow.syncHeads(s.wp);
    assert.equal(s.gh.count('updateBranch'), 1, 'once per trunk commit');
    const head = git(s.wt, ['rev-parse', `refs/heads/emp/kabir/${s.storyId}`]).trim();
    assert.equal(head, s.gh.remoteSha(`emp/kabir/${s.storyId}`), 'the local branch fast-forwarded to GitHub\'s merge');
    assert.equal(git(s.wt, ['rev-parse', 'HEAD']).trim(), other, 'the branch Kabir is on now is untouched');
    assert.equal(pr(s).headSha, head);
    assert.equal(pr(s).devApproval?.sha, head, 'still approved');
  } finally { await s.done(); }
});

function trunkCommit(s: Setup, file: string, push: boolean): void {
  writeFileSync(join(s.trunkRepo, 'services', 'agent-svc', file), 'y = 2\n');
  git(s.trunkRepo, ['add', '-A']);
  git(s.trunkRepo, ['-c', 'user.email=t@iris.local', '-c', 'user.name=t', 'commit', '-q', '-m', `trunk ${file}`]);
  if (push) git(s.trunkRepo, ['push', '-q', s.gh.bare, TRUNK]);
}

test('22d: no catch-up when GitHub says the branch is not behind (local trunk has commits GitHub never saw)', async () => {
  const s = setup('shadow');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    trunkCommit(s, 'local_only.py', false);
    await flow.syncHeads(s.wp);
    assert.equal(s.gh.count('updateBranch'), 0, 'behind_by is 0 on GitHub: nothing to merge');
  } finally { await s.done(); }
});

test('22e: no catch-up while workplace/tests is pending for the current head and the trunk change is elsewhere', async () => {
  const s = setup('shadow');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    flow.savePr(s.wp, s.storyId, c => ({ pr: { ...c.pr!, tests: { state: 'pending', sha: c.pr!.headSha, at: new Date().toISOString(), summary: 'waiting' } } }));
    trunkCommit(s, 'other.py', true);
    await flow.syncHeads(s.wp);
    assert.equal(s.gh.count('updateBranch'), 0, 'pre-pr is still running: do not reset it');
    flow.savePr(s.wp, s.storyId, c => ({ pr: { ...c.pr!, tests: { state: 'success', sha: c.pr!.headSha, at: new Date().toISOString(), summary: 'ok' } } }));
    await flow.syncHeads(s.wp);
    assert.equal(s.gh.count('updateBranch'), 1, 'once tests are recorded the catch-up goes ahead');
  } finally { await s.done(); }
});

test('22f: at most one catch-up per branch per 30 minutes', async () => {
  const s = setup('shadow');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    trunkCommit(s, 'a.py', true);
    await flow.syncHeads(s.wp);
    assert.equal(s.gh.count('updateBranch'), 1);
    trunkCommit(s, 'b.py', true);
    await flow.syncHeads(s.wp);
    assert.equal(s.gh.count('updateBranch'), 1, 'throttled: the trunk moved again within the window');
  } finally { await s.done(); }
});

/** The trunk moves on and GitHub's update-branch merges it into the story's branch; the local ref follows. */
async function trunkMergedOnGitHub(s: Setup): Promise<string> {
  writeFileSync(join(s.trunkRepo, 'services', 'agent-svc', 'other.py'), 'y = 2\n');
  git(s.trunkRepo, ['add', '-A']);
  git(s.trunkRepo, ['-c', 'user.email=t@iris.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'trunk moves']);
  git(s.trunkRepo, ['push', '-q', s.gh.bare, TRUNK]);
  const branch = `emp/kabir/${s.storyId}`;
  assert.equal((await s.gh.updateBranch(pr(s).number, pr(s).headSha)).updated, true);
  git(s.wt, ['checkout', '-q', '-b', 'emp/kabir/as_other']);
  await s.gh.fetchBranch(s.wt, branch);
  return git(s.wt, ['rev-parse', `refs/heads/${branch}`]).trim();
}

test('22c: PR #374 (16 Oct): a story done with both approvals, tests and evidence on A, moved to B by a trunk-only update, merges with no new approval', async () => {
  const s = setup('shadow');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp, false));
    await flow.setEvidence(s.wp, s.storyId, 'success', '3 passed on ios');
    const a = pr(s);
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'done');
    assert.equal(a.qaApproval?.sha, a.headSha);
    const b = await trunkMergedOnGitHub(s);
    assert.notEqual(b, a.headSha);
    // The sweep sees the moved head of the approved story and carries everything over.
    await flow.syncHeads(s.wp);
    const after = pr(s);
    assert.equal(after.headSha, b);
    assert.equal(after.devApproval?.sha, b, 'the developer approval moves to B');
    assert.equal(after.qaApproval?.sha, b, 'the QA approval moves to B');
    assert.equal(after.tests?.sha, b);
    assert.equal(after.evidence, 'success');
    const w = rawGet(s.wp, s.storyId)!;
    assert.equal(w.status, 'done');
    assert.equal(flow.approvalHolds(w, 'qa'), true);
    flow.setMode(s.wp, 'on', 'coo');
    assert.equal(flow.autoReady(s.wp, w), 'ready');
    assert.equal(await flow.autoMerge(s.wp, s.storyId), 'merged');
    assert.ok(pr(s).merged, 'merged with no new approval');
  } finally { await s.done(); }
});

test('22d: the COO merge of a done story whose head moved trunk-only (before any sweep) carries the approvals and merges', async () => {
  const s = setup('shadow');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp));
    const b = await trunkMergedOnGitHub(s);
    flow.setMode(s.wp, 'on', 'coo');
    const r = await flow.merge(s.wp, s.storyId, 'coo');
    assert.equal(r.merged, true);
    assert.equal(pr(s).qaApproval?.sha, b);
  } finally { await s.done(); }
});

test('22e: a done story whose head moved by a real author commit keeps refusing the merge (approvals do not move)', async () => {
  const s = setup('shadow');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp));
    const a = pr(s).headSha;
    s.commit({ 'services/memory-svc/recall.py': 'x = 2\n' });
    await flow.syncHeads(s.wp);
    assert.equal(pr(s).headSha, a, 'not carried');
    assert.equal(pr(s).qaApproval?.sha, a);
    flow.setMode(s.wp, 'on', 'coo');
    await assert.rejects(flow.merge(s.wp, s.storyId, 'coo'), /new commits .* approvals reset/);
    assert.equal(pr(s).merged, undefined);
  } finally { await s.done(); }
});

test('24: a PR touching .github/workflows holds until the COO approves the spend', async () => {
  const s = setup('on');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n', '.github/workflows/x.yml': 'on: push\n' });
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    assert.deepEqual(pr(s).extraReviewers?.map(e => e.id), ['rohan'], 'map.yaml gives .github to the windows charter: its lead reviews it');
    await flow.approve(s.wp, s.storyId, 'rohan');
    const qa = await flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp));
    assert.match(qa.message, /merges once the COO approves the spend/);
    assert.equal(pr(s).merged, undefined);
    const held = trail.comments(s.wp, s.storyId).filter(c => /Held for the COO/.test(c.text));
    assert.equal(held.length, 1, 'the hold appears as a comment');
    assert.match(held[0]!.text, /\.github\/workflows\/x\.yml/);
    await flow.autoMergeSweep(s.wp);
    assert.equal(pr(s).merged, undefined, 'the sweep does not merge it');
    assert.equal(trail.comments(s.wp, s.storyId).filter(c => /Held for the COO/.test(c.text)).length, 1, 'commented once');
    const r = await flow.approveSpend(s.wp, s.storyId, 'coo');
    assert.ok(r.spendApprovedAt);
    assert.equal(r.merge, 'merged');
    assert.ok(pr(s).merged);
  } finally { await s.done(); }
});

test('25: a design-doc PR merges after both approvals (no COO hold)', async () => {
  const s = setup('on');
  try {
    s.commit({ 'docs/tech/grounded-awareness.md': '# Technical doc\n', 'docs/HLD-recall.md': '# HLD\n' });
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    const qa = await flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp));
    assert.match(qa.message, /merged it into the trunk/);
    assert.ok(pr(s).merged);
  } finally { await s.done(); }
});

/* ---------- prompt layers ---------- */

test('26: the assignment and workspace layers survive a huge handoff, which is trimmed to its newest part', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const s = plainStory(wp, 'dev');
    writeEmployeeFile(wp.org, 'dev', 'handoff.md', `OLDEST-NOTE\n${'handoff line\n'.repeat(60_000)}NEWEST-NOTE\n`);
    const ctx = assembleContext(wp.org, employee(wp, 'dev'), { assignment: rawGet(wp, s.id)!, maxTokens: 24_000, worktree: '/tmp/wt', ownedPaths: ['iris:services/agent-svc/speaker.py'] });
    assert.ok(ctx.tokens <= 24_000, `${ctx.tokens} tokens`);
    assert.match(ctx.append, new RegExp(`## Assignment: ${s.title}`));
    assert.ok(ctx.append.includes(`Id: ${s.id}`));
    assert.match(ctx.append, /## Your workspace/);
    assert.match(ctx.append, /merging the trunk into your branch is allowed\. The Workplace merges after both approvals\./);
    assert.match(ctx.append, /For a bug: post the 5-part ## RCA first; code edits unlock after it\./);
    assert.ok(ctx.append.includes('NEWEST-NOTE'), 'the newest part of the handoff is kept');
    assert.ok(!ctx.append.includes('OLDEST-NOTE'), 'the oldest part is trimmed');
    assert.equal(ctx.truncated, true);
  } finally { tmp.cleanup(); }
});
