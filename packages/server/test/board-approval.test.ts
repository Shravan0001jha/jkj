import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { WorkItem } from '@jkj/shared';
import type { Workplace } from '../src/services/workplace.js';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as flow from '../src/services/github-flow.js';
import * as board from '../src/services/board.js';
import * as trail from '../src/services/trail.js';
import { doneProblem } from '../src/services/review-policy.js';
import { employee, foreignChanges, workplaceTools, WORKPLACE_TOOLS } from '../src/services/employees.js';
import { AUTOSAVE_SUBJECT, ensureWorktree } from '../src/services/worktrees.js';
import { rawGet } from '../src/services/v2-map.js';
import { testWorkplace } from './fakes/workplace.js';
import { FakeGitHub } from './fakes/fake-github.js';
import { writePrePr } from './fakes/pre-pr.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';

const runtime = installFakeRuntime();
after(() => runtime.restore());
flow.statusRetry.delaysMs = [0, 0];

const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });
const GIT = ['-c', 'user.email=k@iris.local', '-c', 'user.name=kabir'];
const evidence = { tests: { passed: 3, failed: 0, command: 'pytest' }, commits: ['abc'], liveVerified: [], notVerified: ['live'] };

interface Setup { wp: Workplace; gh: FakeGitHub; storyId: string; wt: string; trunkRepo: string; branch: string; commit(file: string, content: string, message?: string): string; done(): Promise<void> }

function setup(mode: 'shadow' | 'on' = 'on'): Setup {
  const { wp, tmp } = testWorkplace();
  const kabir = employee(wp, 'kabir');
  const trunkRepo = kabir.workspace.repo;
  writeFileSync(join(wp.config.workplaceDir, 'quality.yaml'), 'maxFileBytes: 100000\nareas: {}\n');
  wp.org.employees.push({ ...employee(wp, 'nikhil'), id: 'zoya', name: 'Zoya', roleId: 'qa', level: 2, charterIds: ['qa-release'], reportsTo: 'kabir' });
  wp.org.employees.push({ ...kabir, id: 'arjun', name: 'Arjun', roleId: 'engineer', level: 2, charterIds: ['memory'], reportsTo: 'kabir' });
  const gh = new FakeGitHub(trunkRepo);
  flow.useGitHub(wp, gh);
  flow.setMode(wp, mode, 'coo');
  const epic = items.create(wp, { level: 'epic', title: 'Memory' }, 'owner');
  const story = items.create(wp, { level: 'story', title: 'Staging batch sign-off: abc', parentId: epic.id, assigneeId: 'kabir' }, 'owner');
  const wt = ensureWorktree(wp.config.workDir, kabir, story.id).path;
  const commit = (file: string, content: string, message = `add ${file}`): string => {
    mkdirSync(join(wt, file, '..'), { recursive: true });
    writeFileSync(join(wt, file), content);
    git(wt, ['add', '-A']);
    git(wt, [...GIT, 'commit', '-q', '-m', message]);
    const sha = git(wt, ['rev-parse', 'HEAD']).trim();
    writePrePr(wt, sha, { ok: true });
    return sha;
  };
  return { wp, gh, storyId: story.id, wt, trunkRepo, branch: `emp/kabir/${story.id}`, commit, done: async () => { await flow.settled(); gh.cleanup(); tmp.cleanup(); } };
}

async function toReview(s: Setup): Promise<void> {
  work.reportDone(s.wp, s.storyId, evidence, 'kabir');
  const r = await flow.onReview(s.wp, s.storyId, 'kabir');
  await r.tests;
}


async function inReview(s: Setup): Promise<void> {
  s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
  await toReview(s);
}
const ZOYA_NOTE = 'probing approval state';
const wpr = (s: Setup): NonNullable<WorkItem['pr']> => { const p = rawGet(s.wp, s.storyId)!.pr; assert.ok(p); return p; };

test('review_state is read-only and says what review_approve would record for the caller', async () => {
  const s = setup('on');
  try {
    await inReview(s);
    const before = JSON.stringify(rawGet(s.wp, s.storyId)!.pr);
    const out = flow.reviewState(s.wp, s.storyId, 'zoya');
    assert.match(out, /Developer approval \(1 of 2\): none/);
    assert.match(out, /review_approve as Zoya would RECORD developer approval/);
    assert.match(flow.reviewState(s.wp, s.storyId, 'kabir'), /author.*REFUSED|REFUSED.*author/i);
    assert.equal(JSON.stringify(rawGet(s.wp, s.storyId)!.pr), before, 'nothing recorded');
  } finally { await s.done(); }
});

test('approval_revoke removes one recorded approval, comments the reason and restores QA eligibility', async () => {
  const s = setup('on');
  try {
    await inReview(s);
    await flow.approve(s.wp, s.storyId, 'zoya', ZOYA_NOTE);
    assert.equal(wpr(s).devApproval?.by, 'zoya');
    assert.notEqual(wpr(s).qaReviewer, 'zoya', 'the probe cost her the QA seat');
    await assert.rejects(board.revokeApproval(s.wp, s.storyId, 'zoya', 'kabir', 'the author may not revoke'), /Forbidden|ask Asha/);
    await assert.rejects(board.revokeApproval(s.wp, s.storyId, 'zoya', 'asha', 'short'), /reason/);
    await assert.rejects(board.revokeApproval(s.wp, s.storyId, 'arjun', 'asha', 'arjun gave no approval'), /no recorded approval/);
    const r = await board.revokeApproval(s.wp, s.storyId, 'zoya', 'asha', 'Zoya only probed the approval state');
    assert.deepEqual(r.removed, ['dev']);
    assert.equal(wpr(s).devApproval, undefined);
    assert.equal(wpr(s).qaReviewer, 'zoya', 'she is QA again');
    assert.ok(trail.activityFor(s.wp, s.storyId).some(a => /Revoked.*Zoya.*developer approval.*only probed/.test(a.text)), 'audit');
    assert.ok(items.detail(s.wp, s.storyId).comments.some(c => /only probed/.test(c.text)), 'reason commented on the story');
    // The developer approver can still give approval 1; Zoya then gives approval 2.
    await flow.approve(s.wp, s.storyId, 'arjun', 'real review');
    assert.equal(wpr(s).devApproval?.by, 'arjun');
    assert.equal(wpr(s).qaReviewer, 'zoya');
  } finally { await s.done(); }
});

test('approval_revoke is refused on a story with both approvals and on the COO\'s story', async () => {
  const s = setup('on');
  try {
    await inReview(s);
    const w = rawGet(s.wp, s.storyId)!;
    work.saveQuiet(s.wp, { ...w, pr: { ...w.pr!, devApproval: { by: 'arjun', at: 'a', sha: w.pr!.headSha, episode: w.statusSince ?? '' }, qaApproval: { by: 'zoya', at: 'a', sha: w.pr!.headSha, episode: w.statusSince ?? '' } } });
    await assert.rejects(board.revokeApproval(s.wp, s.storyId, 'arjun', 'asha', 'cannot undo a finished review'), /both approvals/);
    work.saveQuiet(s.wp, { ...rawGet(s.wp, s.storyId)!, employeeId: 'coo' });
    await assert.rejects(board.revokeApproval(s.wp, s.storyId, 'arjun', 'asha', 'not the COO story to touch'), /COO/);
  } finally { await s.done(); }
});

test('approval_revoke and review_state are Workplace tools; review_approve says it records', async () => {
  for (const t of ['approval_revoke', 'review_state']) assert.ok((WORKPLACE_TOOLS as readonly string[]).includes(t), t);
  const s = setup('on');
  try {
    const server = workplaceTools(s.wp, 'kabir', () => ({ agentId: 'a', employeeId: 'kabir', assignmentId: s.storyId, startedAt: '', seen: {}, planCaptured: false }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(st);
    const c = new Client({ name: 'test', version: '1' });
    await c.connect(ct);
    const tools = (await c.listTools()).tools;
    assert.ok(tools.find(t => t.name === 'approval_revoke'));
    assert.ok(tools.find(t => t.name === 'review_state'));
    assert.match(tools.find(t => t.name === 'review_approve')!.description ?? '', /RECORDS an approval[\s\S]*review_state/);
    const out = await c.callTool({ name: 'approval_revoke', arguments: { itemId: s.storyId, approver: 'zoya', reason: 'an engineer trying it' } });
    assert.match(JSON.stringify(out.content), /Not done: .*ask Asha/);
    await c.close();
  } finally { await s.done(); }
});
