import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Employee, WorkItem } from '@jkj/shared';
import type { Workplace } from '../src/services/workplace.js';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as trail from '../src/services/trail.js';
import * as flow from '../src/services/github-flow.js';
import * as qaDoc from '../src/services/qa-doc.js';
import * as docs from '../src/services/docs.js';
import { employee, workplaceTools } from '../src/services/employees.js';
import { ensureWorktree } from '../src/services/worktrees.js';
import { rawGet } from '../src/services/v2-map.js';
import { createRouter } from '../src/http/routes.js';
import { Auth } from '../src/http/auth.js';
import { testWorkplace, withTree } from './fakes/workplace.js';
import { FakeGitHub } from './fakes/fake-github.js';
import { FakeNotion } from './fakes/fake-notion.js';
import { writePrePr } from './fakes/pre-pr.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';

/**
 * Fixes from the 10 Oct dry run (scratchpad fixes.md), on top of the rework: Blocked → Parked (#3), a
 * review path for stories with no pull request (#11), the COO's developer approval of a CTO-authored PR
 * (#12), QA amending its doc and a recorded live check as evidence (#5), QA opening the evidence before
 * approving (#7), and blind plan-step QA cases (#8).
 */

const runtime = installFakeRuntime();
after(() => runtime.restore());
const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });

function staff(wp: Workplace): void {
  if (wp.org.employees.some(e => e.id === 'arjun')) return;
  const kabir = employee(wp, 'kabir');
  const add = (e: Partial<Employee> & { id: string }) => wp.org.employees.push({ ...kabir, name: e.id[0]!.toUpperCase() + e.id.slice(1), level: 2, ...e } as Employee);
  add({ id: 'arjun', roleId: 'engineer', charterIds: ['memory'], reportsTo: 'kabir' });
  add({ id: 'zoya', roleId: 'engineer', charterIds: ['qa-release'], reportsTo: 'nikhil' });
  add({ id: 'cto', name: 'Vikram', roleId: 'cto', level: 0, charterIds: [], reportsTo: 'coo' });
}

interface Setup {
  wp: Workplace;
  storyId: string;
  wt: string;
  commit(files: Record<string, string>): string;
  done(): Promise<void>;
}

function setup(mode: 'shadow' | 'on' = 'shadow', opts: { author?: string } = {}): Setup {
  const { wp, tmp } = testWorkplace();
  staff(wp);
  const author = employee(wp, opts.author ?? 'kabir');
  writeFileSync(join(wp.config.workplaceDir, 'quality.yaml'), 'maxFileBytes: 100000\nareas: {}\n');
  const gh = new FakeGitHub(author.workspace.repo);
  flow.useGitHub(wp, gh);
  flow.setMode(wp, mode, 'coo');
  const epic = items.create(wp, { level: 'epic', title: 'Memory' }, 'owner');
  const story = items.create(wp, { level: 'story', title: 'Recall the last song', parentId: epic.id, assigneeId: author.id }, 'owner');
  const wt = ensureWorktree(wp.config.workDir, author, story.id).path;
  const commit = (files: Record<string, string>): string => {
    for (const [f, c] of Object.entries(files)) { mkdirSync(join(wt, f, '..'), { recursive: true }); writeFileSync(join(wt, f), c); }
    git(wt, ['add', '-A']);
    git(wt, ['-c', `user.email=${author.id}@iris.local`, '-c', `user.name=${author.id}`, 'commit', '-q', '-m', 'change']);
    const sha = git(wt, ['rev-parse', 'HEAD']).trim();
    writePrePr(wt, sha, { ok: true, by: author.id });
    return sha;
  };
  return { wp, storyId: story.id, wt, commit, done: async () => { await flow.settled(); gh.cleanup(); tmp.cleanup(); } };
}

const evidence = { tests: { passed: 3, failed: 0, command: 'npm test' }, commits: ['abc'], liveVerified: [], notVerified: ['live'] };

async function reviewed(s: Setup, by = 'kabir'): Promise<void> {
  work.reportDone(s.wp, s.storyId, evidence, by);
  await (await flow.onReview(s.wp, s.storyId, by)).tests;
}

const pr = (s: Setup): NonNullable<WorkItem['pr']> => { const p = rawGet(s.wp, s.storyId)!.pr; assert.ok(p, 'the item has a PR record'); return p; };

function proof(wp: Workplace, rel = 'logs/unit.txt'): string {
  const path = join(qaDoc.evidenceDir(wp), rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'ok\n');
  return rel;
}

/** A QA doc whose cases cite proof; `tail` is the evidence line(s) of the report. */
function qaText(wp: Workplace, tail: string[] = [], cases: string[] = []): string {
  return [
    '## Edge cases',
    `- PASS: empty input — unit test evidence: ${proof(wp)}`,
    '- PASS: provider down — killed the provider and checked the reply evidence: https://ci.example.com/runs/42',
    '- N/A: Windows path — no Windows code touched',
    ...cases,
    '## Report',
    'Checked both failure paths by hand and in tests; Windows untouched; residual risk low.',
    ...tail,
  ].join('\n');
}
const NA = ['Evidence: n/a — server-only change with no app surface', 'Tests: npm test 12 passed, 0 failed'];

async function toolsFor(wp: Workplace, employeeId: string, assignmentId?: string) {
  const server = workplaceTools(wp, employeeId, () => ({ agentId: 'a', employeeId, ...(assignmentId ? { assignmentId } : {}), startedAt: '', seen: {}, planCaptured: false }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(st);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(ct);
  return async (name: string, args: Record<string, unknown>) => JSON.stringify((await client.callTool({ name, arguments: args })).content);
}

/* ---------- #3: Blocked → Parked ---------- */

test('#3: a blocked story can be parked (with a reason and resumeWhen), and parking still needs both', () => {
  const { wp, tmp } = testWorkplace();
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Practice' }, 'owner');
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Wait for the store review', assigneeId: 'kabir' }, 'owner');
    items.update(wp, s.id, { status: 'in-progress', reason: 'test: started' }, 'kabir');
    items.update(wp, s.id, { status: 'blocked', blockedReason: 'App Store review', waitingOn: 'external', reason: 'test: store review' }, 'kabir');
    assert.equal(rawGet(wp, s.id)!.status, 'blocked');
    assert.throws(() => items.update(wp, s.id, { status: 'parked', reason: 'resolved elsewhere' }, 'asha'), /Parked needs resumeWhen/);
    assert.equal(rawGet(wp, s.id)!.status, 'blocked');
    items.update(wp, s.id, { status: 'parked', reason: 'store review stalled; set aside', resumeWhen: 'Apple answers the review' }, 'asha');
    const w = rawGet(wp, s.id)!;
    assert.equal(w.status, 'parked');
    assert.equal(w.parked?.resumeWhen, 'Apple answers the review');
  } finally { tmp.cleanup(); }
});

/* ---------- #16: the Chief of Staff moves a story within a team ---------- */

test('#16: the Chief of Staff reassigns within one team (the lead stalled); new or cross-team routing still goes to the lead', () => {
  const { wp, tmp } = testWorkplace();
  withTree(wp);
  try {
    const epic = items.create(wp, { level: 'epic', title: 'Quality' }, 'owner');
    const s = items.create(wp, { level: 'story', parentId: epic.id, title: 'Sweep the release checklist', assigneeId: 'nikhil' }, 'owner');
    assert.equal(items.update(wp, s.id, { assigneeId: 'zoya', reason: 'Nikhil is stalled; Zoya takes it' }, 'asha').assigneeId, 'zoya', 'the QA lead to a QA member');
    assert.equal(items.update(wp, s.id, { assigneeId: 'aditi', reason: 'Zoya is out today' }, 'asha').assigneeId, 'aditi', 'member to member in the same team');
    assert.equal(items.update(wp, s.id, { assigneeId: 'nikhil', reason: 'back to the lead' }, 'asha').assigneeId, 'nikhil');
    const e = items.create(wp, { level: 'story', parentId: epic.id, title: 'Greeting contract', assigneeId: 'arjun' }, 'owner');
    assert.equal(items.update(wp, e.id, { assigneeId: 'sameer', reason: 'Dev is stalled; Sameer knows it' }, 'asha').assigneeId, 'sameer', 'an engineer to a teammate');
    assert.throws(() => items.update(wp, e.id, { assigneeId: 'ira', reason: 'Ira is free' }, 'asha'), /route to the charter lead/, 'across teams: to the lead');
    assert.throws(() => items.update(wp, e.id, { assigneeId: 'zoya', reason: 'QA it' }, 'asha'), /route to the charter lead/, 'to another team\'s member');
    const fresh = items.create(wp, { level: 'story', parentId: epic.id, title: 'Unrouted work' }, 'owner');
    assert.throws(() => items.update(wp, fresh.id, { assigneeId: 'sameer', reason: 'Sameer is free' }, 'asha'), /route to the charter lead/, 'an unassigned story goes to a lead');
    assert.equal(items.update(wp, fresh.id, { assigneeId: 'dev', reason: 'conversation work' }, 'asha').assigneeId, 'dev');
  } finally { tmp.cleanup(); }
});

/* ---------- #11: no pull request ---------- */

function noPrStory(s: Setup, reviewer = 'arjun'): void {
  items.update(s.wp, s.storyId, { status: 'in-progress', reason: 'test: started' }, 'kabir');
  items.update(s.wp, s.storyId, { status: 'in-review', reviewerId: reviewer, reason: 'website copy updated in the iris-alpha repo' }, 'kabir');
}

test('#11: the current reviewer passes a story with no pull request through review_approve, with a note', async () => {
  const s = setup('on');
  try {
    noPrStory(s);
    const arjun = await toolsFor(s.wp, 'arjun');
    assert.match(await arjun('review_approve', { itemId: s.storyId }), /Not approved: .*needs your note/);
    assert.match(await toolsFor(s.wp, 'mira').then(m => m('review_approve', { itemId: s.storyId, note: 'looks fine to me' })), /Not approved: .*Arjun is this story's reviewer/);
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'in-review');
    const out = await arjun('review_approve', { itemId: s.storyId, note: 'checked the live site: the copy matches the brief' });
    assert.match(out, /no pull request/i);
    const w = rawGet(s.wp, s.storyId)!;
    assert.equal(w.status, 'done');
    assert.equal(w.pr, undefined);
    assert.ok(trail.activityFor(s.wp, s.storyId).some(a => a.by === 'arjun' && /checked the live site/.test(a.text)), 'the note is on the story');
  } finally { await s.done(); }
});

test('#11: item_update done by the current reviewer works without a PR; a story with a PR still needs both approvals', async () => {
  const s = setup('on');
  try {
    noPrStory(s);
    items.update(s.wp, s.storyId, { status: 'done', reason: 'non-code story: the research doc answers the ask' }, 'arjun');
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'done');
  } finally { await s.done(); }
  const t = setup('on');
  try {
    t.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(t);
    assert.throws(() => items.update(t.wp, t.storyId, { status: 'done', reason: 'looks right' }, 'arjun'), /done only through review_approve/);
    assert.equal((await flow.approve(t.wp, t.storyId, 'arjun')).stage, 'dev', 'with a PR, review_approve is approval 1 of 2');
    assert.equal(rawGet(t.wp, t.storyId)!.status, 'in-review');
  } finally { await t.done(); }
});

test('#11: a story with commits but no PR yet is not passed without one', async () => {
  const s = setup('on');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    noPrStory(s);
    await assert.rejects(flow.approve(s.wp, s.storyId, 'arjun', 'fine'), /no pull request yet/);
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'in-review');
  } finally { await s.done(); }
});

/* ---------- #12: the COO's developer approval of a CTO-authored PR ---------- */

test('#12: a CTO-authored docs-only PR merges on the COO approval alone', async () => {
  const s = setup('on', { author: 'cto' });
  try {
    s.commit({ 'docs/HLD-recall.md': '# HLD\n', 'docs/tech/recall.md': '# Tech\n' });
    await reviewed(s, 'cto');
    const r = await flow.cooReviewApprove(s.wp, s.storyId, 'reconciled with the product doc');
    assert.equal(r.stage, 'approved');
    assert.equal(pr(s).devApproval?.by, 'coo');
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'done');
    assert.ok(pr(s).merged, 'merged on the COO approval');
    assert.match(r.message, /merged/);
  } finally { await s.done(); }
});

test('#12: a CTO-authored code PR gets approval 1 from the COO, and QA still gives approval 2', async () => {
  const s = setup('on', { author: 'cto' });
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n', 'docs/HLD-recall.md': '# HLD\n' });
    await reviewed(s, 'cto');
    const r = await flow.cooReviewApprove(s.wp, s.storyId, 'design and code match');
    assert.equal(r.stage, 'dev');
    assert.equal(pr(s).devApproval?.by, 'coo');
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'in-review');
    assert.equal(pr(s).merged, undefined);
    assert.ok(pr(s).qaReviewer, 'a QA is named');
    await assert.rejects(flow.cooReviewApprove(s.wp, s.storyId, 'again'), /already has the developer approval/);
    assert.deepEqual(pr(s).extraReviewers?.map(e => e.id), ['kabir'], 'the memory charter\'s lead reviews his files, as on any PR');
    assert.equal((await flow.approve(s.wp, s.storyId, 'kabir')).stage, 'extra');
    const qa = await flow.approve(s.wp, s.storyId, pr(s).qaReviewer!, undefined, qaText(s.wp, NA));
    assert.equal(qa.stage, 'qa');
    assert.ok(pr(s).merged);
  } finally { await s.done(); }
});

test('#12: the COO route refuses a story the CTO did not author, and is loopback only', async () => {
  const s = setup('on');
  try {
    s.commit({ 'docs/HLD-recall.md': '# HLD\n' });
    await reviewed(s);
    await assert.rejects(flow.cooReviewApprove(s.wp, s.storyId, 'fine'), /only for stories the CTO authored/);
    const handle = createRouter({ config: s.wp.config, wp: s.wp, auth: new Auth(join(s.wp.config.workplaceDir, 'ops', 'auth-token')) });
    const server = createServer((req, res) => { void handle(req, res).then(found => { if (!found) { res.statusCode = 404; res.end(); } }); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const post = (headers: Record<string, string> = {}) => fetch(`${base}/api/coo/review-approve`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ itemId: s.storyId, note: 'fine' }) });
      const refused = await post();
      assert.equal(refused.status, 400);
      assert.match(((await refused.json()) as { error: string }).error, /only for stories the CTO authored/);
      const tunnelled = await post({ 'x-via-tunnel': '1' });
      assert.equal(tunnelled.status, 400);
      assert.match(((await tunnelled.json()) as { error: string }).error, /this Mac/);
      assert.equal(pr(s).devApproval, undefined);
    } finally { await new Promise<void>(r => server.close(() => r())); }
  } finally { await s.done(); }
});

test('#12: the COO route gives the approval on a CTO-authored story', async () => {
  const s = setup('on', { author: 'cto' });
  try {
    s.commit({ 'docs/HLD-recall.md': '# HLD\n' });
    await reviewed(s, 'cto');
    const handle = createRouter({ config: s.wp.config, wp: s.wp, auth: new Auth(join(s.wp.config.workplaceDir, 'ops', 'auth-token')) });
    const server = createServer((req, res) => { void handle(req, res).then(found => { if (!found) { res.statusCode = 404; res.end(); } }); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const res = await fetch(`${base}/api/coo/review-approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ itemId: s.storyId, note: 'reconciled' }) });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { stage: string }).stage, 'approved');
      assert.ok(pr(s).merged);
    } finally { await new Promise<void>(r => server.close(() => r())); }
  } finally { await s.done(); }
});

/* ---------- #5: QA amends its doc; a live check as evidence ---------- */

test('#5: QA amends its filed doc while the story is done but unmerged, and the merge gate re-runs', async () => {
  const s = setup('on');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp));
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'done');
    assert.equal(pr(s).merged, undefined, 'held: no evidence and no "Evidence: n/a"');
    const zoya = await toolsFor(s.wp, 'zoya');
    assert.match(await zoya('qa_doc_update', { itemId: s.storyId, qaDoc: qaText(s.wp, NA) }), /Not updated: .*Nikhil/);
    const nikhil = await toolsFor(s.wp, 'nikhil');
    assert.match(await nikhil('qa_doc_update', { itemId: s.storyId, qaDoc: '## Edge cases\n- PASS: x\n## Report\nshort' }), /Not updated: The QA doc is not complete/);
    const out = await nikhil('qa_doc_update', { itemId: s.storyId, qaDoc: qaText(s.wp, NA) });
    assert.match(out, /QA doc updated.*merged/);
    assert.ok(pr(s).merged, 'the amended doc lets the merge go on');
    assert.match(qaDoc.filed(s.wp, s.storyId)!, /Evidence: n\/a/);
  } finally { await s.done(); }
});

test('#5: qa_doc_update is refused on a story still in review (approve instead)', async () => {
  const s = setup('on');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await assert.rejects(flow.amendQaDoc(s.wp, s.storyId, 'nikhil', qaText(s.wp, NA)), /not done/);
  } finally { await s.done(); }
});

test('#5: a recorded live check counts as evidence only once the QA doc cites it, and only for the head it was run on', async () => {
  const s = setup('on');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    const kabir = await toolsFor(s.wp, 'kabir', s.storyId);
    assert.match(await kabir('record_live_check', { itemId: s.storyId, summary: 'spoke two turns on the Mac', logPaths: ['logs/missing.log'] }), /Not recorded: .*logs\/missing\.log/);
    const log = proof(s.wp, 'live/speaker-run.log');
    assert.match(await toolsFor(s.wp, 'nikhil').then(n => n('record_live_check', { itemId: s.storyId, summary: 'x', logPaths: [log] })), /Not recorded: .*author/);
    const out = await kabir('record_live_check', { itemId: s.storyId, summary: 'spoke two turns on the Mac; no echo', logPaths: [log] });
    const id = /\b(lc_[a-z0-9]+)\b/.exec(out)?.[1];
    assert.ok(id, `a live check id in: ${out}`);
    const w = rawGet(s.wp, s.storyId)!;
    assert.equal(w.liveChecks?.[0]?.sha, w.pr!.headSha);
    assert.equal(flow.evidenceOk(s.wp, w), false, 'not evidence on its own');
    await flow.approve(s.wp, s.storyId, 'arjun');
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp, ['Evidence: live check lc_nope'])), /live check lc_nope/);
    const r = await flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp, [`Evidence: live check ${id} — read the run log, lines 3-9 show both turns`]));
    assert.equal(r.stage, 'qa');
    assert.ok(pr(s).merged, 'the cited live check satisfies the evidence gate');
  } finally { await s.done(); }
});

test('#5: a live check on an older head does not count', async () => {
  const s = setup('on');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    const lc = flow.recordLiveCheck(s.wp, s.storyId, 'kabir', 'spoke', [proof(s.wp, 'live/a.log')]);
    s.commit({ 'services/memory-svc/recall.py': 'x = 2\n' });
    await flow.syncHeads(s.wp);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp, [`Evidence: live check ${lc.id}`])), /was recorded on an older commit/);
  } finally { await s.done(); }
});

/* ---------- #7: QA opens the evidence before approving ---------- */

test('#7: review_approve by QA is refused until QA has read the story (and its doc) since they last changed', async () => {
  const s = setup('shadow');
  const notion = new FakeNotion();
  docs.setNotionPort(s.wp, notion);
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    const kabir = await toolsFor(s.wp, 'kabir', s.storyId);
    assert.match(await kabir('doc_write', { itemId: s.storyId, type: 'Design', title: 'Recall design', markdown: '## Context\n\nTwo songs.' }), /Doc created/);
    await flow.approve(s.wp, s.storyId, 'arjun');
    const nikhil = await toolsFor(s.wp, 'nikhil');
    const doc = qaText(s.wp, NA);
    const first = await nikhil('review_approve', { itemId: s.storyId, qaDoc: doc });
    assert.match(first, /Not approved: Open the evidence first.*item_read.*doc_read/);
    await nikhil('item_read', { itemId: s.storyId });
    const second = await nikhil('review_approve', { itemId: s.storyId, qaDoc: doc });
    assert.match(second, /Not approved: .*doc_read/);
    assert.doesNotMatch(second, /item_read/);
    await nikhil('doc_read', { itemId: s.storyId });
    // New evidence after the reads: the story must be read again.
    flow.recordLiveCheck(s.wp, s.storyId, 'kabir', 'spoke two turns', [proof(s.wp, 'live/b.log')]);
    assert.match(await nikhil('review_approve', { itemId: s.storyId, qaDoc: doc }), /Not approved: .*item_read/);
    await nikhil('item_read', { itemId: s.storyId });
    assert.match(await nikhil('review_approve', { itemId: s.storyId, qaDoc: doc }), /QA approval recorded/);
  } finally { await s.done(); }
});

/* ---------- #8: blind QA cases ---------- */

test('#8: QA writes blind cases (hidden from the assignee); approval 2 needs a verdict line for each', async () => {
  const s = setup('shadow');
  const notion = new FakeNotion();
  docs.setNotionPort(s.wp, notion);
  try {
    const kabir = await toolsFor(s.wp, 'kabir', s.storyId);
    assert.match(await kabir('qa_cases_write', { itemId: s.storyId, markdown: '- Two songs in history' }), /Not written: .*QA/);
    const nikhil = await toolsFor(s.wp, 'nikhil');
    const cases = '# Blind cases\n- Two songs in history\n- Real prefetch path escape\n1. Stale prefetch entries cleaned';
    assert.match(await nikhil('qa_cases_write', { itemId: s.storyId, markdown: cases }), /3 blind cases/);
    const w = rawGet(s.wp, s.storyId)!;
    assert.deepEqual(w.qaCases?.titles, ['Two songs in history', 'Real prefetch path escape', 'Stale prefetch entries cleaned']);
    // A separate Notion page, typed "QA report", never the story's doc.
    assert.equal(w.docId, undefined);
    const page = notion.pages.get(w.qaCases!.docId!);
    assert.ok(page, 'the cases page exists in Notion');
    assert.deepEqual((page.properties['Type'] as { select: { name: string } }).select.name, 'QA report');
    // Never shown to the assignee.
    for (const out of [await kabir('item_read', { itemId: s.storyId }), await kabir('doc_read', { itemId: s.storyId }), await kabir('status_of', { q: s.storyId })]) {
      assert.doesNotMatch(out, /Two songs in history|prefetch/i);
    }
    // The assignee's own doc is a new page, not the cases page.
    assert.match(await kabir('doc_write', { itemId: s.storyId, type: 'Design', title: 'Recall design', markdown: '## Context\n\nx' }), /Doc created/);
    assert.notEqual(rawGet(s.wp, s.storyId)!.docId, w.qaCases!.docId);
    assert.doesNotMatch(await kabir('doc_read', { itemId: s.storyId }), /prefetch/i);

    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await assert.rejects(
      flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp, NA, [`- PASS: two songs in history — test evidence: ${proof(s.wp)}`])),
      (err: Error) => /blind case/.test(err.message) && /Real prefetch path escape/.test(err.message) && /Stale prefetch entries cleaned/.test(err.message) && !/Two songs in history/.test(err.message),
    );
    const r = await flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp, NA, [
      `- PASS: Two songs in history — test evidence: ${proof(s.wp)}`,
      `- FAIL: Real prefetch path escape — x evidence: ${proof(s.wp)}`.replace('FAIL', 'PASS'),
      '- N/A: Stale prefetch entries cleaned — no prefetch code in this change',
    ]));
    assert.equal(r.stage, 'qa');
  } finally { await s.done(); }
});

test('#8: blind cases work without Notion (stored on the item only)', async () => {
  const s = setup('shadow');
  try {
    const out = await flow.writeQaCases(s.wp, s.storyId, 'nikhil', '- Empty history');
    assert.match(out, /1 blind case/);
    assert.equal(rawGet(s.wp, s.storyId)!.qaCases?.docId, undefined);
    assert.deepEqual(rawGet(s.wp, s.storyId)!.qaCases?.titles, ['Empty history']);
  } finally { await s.done(); }
});

test('#5b: a live check cited mid-paragraph ("… Evidence: live check lc_x — see above") counts (11 Oct, Aditi)', async () => {
  const { citedLiveChecks } = await import('../src/services/qa-doc.js');
  assert.deepEqual(citedLiveChecks('Checked the diff … Tests: x 5 passed. Evidence: live check lc_mv3nj8s14z4d — see the case line above.'), ['lc_mv3nj8s14z4d']);
  assert.deepEqual(citedLiveChecks('Evidence: live check lc_a\nmore\n  evidence: live check lc_b'), ['lc_a', 'lc_b']);
  assert.deepEqual(citedLiveChecks('no citation here, just evidence: /tmp/log.txt'), []);
});

test('#23: through the tool, QA approval names the evidence or is refused — approval means ready to merge (11 Oct)', async () => {
  const s = setup('shadow');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    const nikhil = await toolsFor(s.wp, 'nikhil');
    await nikhil('item_read', { itemId: s.storyId });
    const refused = await nikhil('review_approve', { itemId: s.storyId, qaDoc: qaText(s.wp, []) });
    assert.match(refused, /Not approved: Name the evidence before approving/);
    assert.match(await nikhil('review_approve', { itemId: s.storyId, qaDoc: qaText(s.wp, NA) }), /QA approval recorded/);
  } finally { await s.done(); }
});
