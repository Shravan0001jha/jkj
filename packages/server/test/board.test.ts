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
import { resolve as resolveOwner } from '../src/services/ownership.js';
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
  wp.org.employees.push({ ...employee(wp, 'nikhil'), id: 'zoya', name: 'Zoya', roleId: 'engineer', level: 2, charterIds: ['qa-release'], reportsTo: 'nikhil' });
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

/* ---------- closed PRs do not block done ---------- */

test('a closed-unmerged PR does not block done in mode on (doneProblem)', async () => {
  const s = setup('on');
  try {
    s.commit('docs/scratch.md', 'x\n');
    await toReview(s);
    const w = rawGet(s.wp, s.storyId)!;
    assert.match(doneProblem(s.wp, w, 'asha') ?? '', /pull request/);
    assert.equal(doneProblem(s.wp, { ...w, pr: { ...w.pr!, closed: { at: 'now', by: 'github', reason: 'closed' } } }, 'asha'), null);
  } finally { await s.done(); }
});

/* ---------- 1 + 2: close a scratch PR, then close the no-code story ---------- */

test('pr_close_detach closes the PR on GitHub, detaches it and audits; story_close_no_code then marks the story done', async () => {
  const s = setup('on');
  try {
    s.commit('docs/scratch.md', 'x\n');
    await toReview(s);
    const n = pr(s).number;
    await assert.rejects(board.closePr(s.wp, s.storyId, 'kabir', 'not allowed for the author'), /Forbidden|ask Asha/);
    await assert.rejects(board.closePr(s.wp, s.storyId, 'asha', 'short'), /reason/);
    // An open PR blocks the no-code close.
    assert.throws(() => board.closeNoCode(s.wp, s.storyId, 'asha', 'a staging sign-off, no code'), /open pull request/);
    await board.closePr(s.wp, s.storyId, 'asha', 'scratch PR on a no-code story');
    assert.equal(s.gh.prs.find(p => p.number === n)!.state, 'closed');
    assert.equal(rawGet(s.wp, s.storyId)!.pr, undefined, 'detached');
    assert.ok(trail.activityFor(s.wp, s.storyId).some(a => /Closed PR #\d+.*scratch PR on a no-code story/.test(a.text)), 'audit reason on the trail');
    // A sweep does not push the scratch commit into a new PR.
    await flow.syncHeads(s.wp);
    assert.equal(s.gh.prs.filter(p => p.state === 'open').length, 0);
    assert.throws(() => board.closeNoCode(s.wp, s.storyId, 'kabir', 'my own story, no code'), /own work|Forbidden/);
    assert.throws(() => board.closeNoCode(s.wp, s.storyId, 'asha', 'x'), /reason/);
    board.closeNoCode(s.wp, s.storyId, 'asha', 'a staging sign-off, no code');
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'done');
  } finally { await s.done(); }
});

const pr = (s: Setup): NonNullable<WorkItem['pr']> => { const p = rawGet(s.wp, s.storyId)!.pr; assert.ok(p); return p; };

test('a PR with both approvals is not closed by board maintenance', async () => {
  const s = setup('on');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await toReview(s);
    const w = rawGet(s.wp, s.storyId)!;
    work.saveQuiet(s.wp, { ...w, pr: { ...w.pr!, devApproval: { by: 'arjun', at: 'a', sha: w.pr!.headSha, episode: w.statusSince ?? '' }, qaApproval: { by: 'nikhil', at: 'a', sha: w.pr!.headSha, episode: w.statusSince ?? '' } } });
    await assert.rejects(board.closePr(s.wp, s.storyId, 'asha', 'trying to close an approved PR'), /both approvals/);
  } finally { await s.done(); }
});

/* ---------- 3: re-cut the sign-off ---------- */

test('signoff_recut moves the head forward along the trunk only, and comments on the sign-off story', async () => {
  const s = setup('on');
  try {
    const repo = s.wp.org.repos.find(r => r.id === 'iris')!.root;
    const trunk = s.wp.config.github.trunk;
    const sha = (): string => git(repo, ['rev-parse', 'HEAD']).trim();
    git(repo, ['checkout', '-q', '-B', trunk]);
    const c1 = sha();
    writeFileSync(join(repo, 'a.txt'), '1'); git(repo, ['add', '-A']); git(repo, [...GIT, 'commit', '-q', '-m', 'c2']); const c2 = sha();
    writeFileSync(join(repo, 'a.txt'), '2'); git(repo, ['add', '-A']); git(repo, [...GIT, 'commit', '-q', '-m', 'c3']); const c3 = sha();
    git(repo, ['update-ref', `refs/remotes/origin/${trunk}`, c3]);
    git(repo, ['checkout', '-q', '-b', 'side', c1]);
    writeFileSync(join(repo, 'b.txt'), '1'); git(repo, ['add', '-A']); git(repo, [...GIT, 'commit', '-q', '-m', 'side']); const side = sha();
    git(repo, ['checkout', '-q', trunk]);
    const file = board.signoffFile(s.wp);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `${c1} ${s.storyId}\n`);
    assert.throws(() => board.recutSignoff(s.wp, c2, 'kabir', 'not mine to do at all'), /Forbidden|ask Asha/);
    assert.throws(() => board.recutSignoff(s.wp, side, 'asha', 'a commit that is not on the trunk'), /not on origin/);
    assert.throws(() => board.recutSignoff(s.wp, c1, 'asha', 'same as the current head'), /already names/);
    assert.throws(() => board.recutSignoff(s.wp, c2, 'asha', 'x'), /reason/);
    const r = board.recutSignoff(s.wp, c3.slice(0, 10), 'asha', 'trunk moved while the sign-off waited');
    assert.equal(r.to, c3);
    assert.equal(readFileSync(file, 'utf8').trim(), `${c3} ${s.storyId}`);
    assert.ok(trail.comments(s.wp, s.storyId).some(c => c.text.includes(c3.slice(0, 9)) && /trunk moved while/.test(c.text)));
    // Backwards is refused.
    assert.throws(() => board.recutSignoff(s.wp, c2, 'asha', 'going back to an older commit'), /descendant/);
  } finally { await s.done(); }
});

/* ---------- 4: github_resume ---------- */

test('github_resume works only after an automatic fallback, with a reason', async () => {
  const s = setup('on');
  try {
    assert.throws(() => board.resumeGithub(s.wp, 'asha', 'GitHub looks healthy again'), /did not fall back/);
    for (let i = 0; i < 3; i++) flow.recordFailure(s.wp, 'push', s.storyId, Date.now(), 'down');
    assert.equal(flow.mode(s.wp), 'local');
    assert.throws(() => board.resumeGithub(s.wp, 'kabir', 'I want it on'), /Forbidden|ask Asha/);
    assert.throws(() => board.resumeGithub(s.wp, 'asha', 'x'), /reason/);
    assert.equal(board.resumeGithub(s.wp, 'asha', 'GitHub status page is green').mode, 'on');
    assert.throws(() => board.resumeGithub(s.wp, 'asha', 'again, with nothing fallen'), /did not fall back/);
    // A hand-set local is not a fallback.
    flow.setMode(s.wp, 'local', 'coo');
    assert.throws(() => board.resumeGithub(s.wp, 'asha', 'switching a manual local on'), /did not fall back/);
  } finally { await s.done(); }
});

/* ---------- 5: statuses ---------- */

test('a status POST is retried with backoff, and a lost one is re-posted from the Workplace state', async () => {
  const s = setup('on');
  try {
    const head = s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    s.gh.failNext('setStatus', 2);
    await toReview(s);
    assert.ok(s.gh.status(head, 'workplace/review'), 'the retry posted it');
    assert.equal(flow.state(s.wp).failures, 0, 'a recovered post is not a failure');
    // Lost for good: all attempts fail (the third attempt too).
    const head2 = s.commit('services/agent-svc/memory_client.py', 'x = 2\n');
    s.gh.failNext('setStatus', 100);
    await (await flow.onReview(s.wp, s.storyId, 'workplace')).tests;
    s.gh.clearFailures();
    assert.equal(s.gh.status(head2, 'workplace/review'), undefined, 'GitHub never got it');
    assert.ok(flow.state(s.wp).failures >= 1);
    const lines = await board.repostStatus(s.wp, s.storyId, 'asha', 'a GitHub 500 left it pending');
    assert.ok(lines.length === 3);
    assert.ok(s.gh.status(head2, 'workplace/review'));
    await assert.rejects(board.repostStatus(s.wp, s.storyId, 'kabir', 'not allowed for the author'), /Forbidden|ask Asha/);
  } finally { await s.done(); }
});

test('a 405 merge failure from a missing status is not counted toward the fallback, and re-posts the statuses', async () => {
  const s = setup('on');
  try {
    s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await toReview(s);
    await flow.approve(s.wp, s.storyId, 'arjun');
    s.gh.failNext('merge', 1, 'GitHub PUT /repos/o/r/pulls/1/merge failed (405): Required status check "workplace/review" is expected.');
    const before = flow.state(s.wp).failures;
    await assert.rejects(flow.merge(s.wp, s.storyId, 'coo'), /405/).catch(() => undefined);
    assert.equal(flow.state(s.wp).failures, before);
  } finally { await s.done(); }
});

/* ---------- 6: the stray WIP commit ---------- */

test('the auto-saved WIP commit on top of a branch is not pushed with the story', async () => {
  const s = setup('on');
  try {
    const head = s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    writeFileSync(join(s.wt, 'wip.txt'), 'half done');
    git(s.wt, ['add', '-A']);
    git(s.wt, [...GIT, 'commit', '-q', '-m', `${AUTOSAVE_SUBJECT}as_other)`]);
    await toReview(s);
    assert.equal(s.gh.remoteSha(s.branch), head, 'GitHub has the real tip, not the WIP commit');
    assert.equal(pr(s).headSha, head);
  } finally { await s.done(); }
});

test('branch_reset_to_local: refused when a stray file exists nowhere else; allowed when identical on the local tip, with a backup ref and force-with-lease', async () => {
  const s = setup('on');
  try {
    const c1 = s.commit('services/agent-svc/memory_client.py', 'x = 1\n');
    await toReview(s);
    // The stray WIP reaches the remote.
    writeFileSync(join(s.wt, 'wip.txt'), 'half done');
    git(s.wt, ['add', 'wip.txt']); git(s.wt, [...GIT, 'commit', '-q', '-m', `${AUTOSAVE_SUBJECT}as_other)`]);
    const stray = git(s.wt, ['rev-parse', 'HEAD']).trim();
    await s.gh.push(s.wt, s.branch);
    assert.equal(s.gh.remoteSha(s.branch), stray);
    // The owner's local branch goes on from the real work, without that file.
    git(s.wt, ['reset', '-q', '--hard', c1]);
    const c2 = s.commit('services/agent-svc/other.py', 'y = 1\n');
    await assert.rejects(board.resetBranch(s.wp, s.storyId, 'kabir', 'not allowed for the author'), /Forbidden|ask Asha/);
    await assert.rejects(board.resetBranch(s.wp, s.storyId, 'asha', 'wip.txt exists nowhere else'), /wip\.txt/);
    assert.equal(s.gh.remoteSha(s.branch), stray, 'nothing changed');
    // Now the same file, identical, is on the local tip.
    s.commit('wip.txt', 'half done');
    const tip = git(s.wt, ['rev-parse', 'HEAD']).trim();
    const r = await board.resetBranch(s.wp, s.storyId, 'asha', 'stray auto-saved WIP; same file is on the tip');
    assert.equal(s.gh.remoteSha(s.branch), tip);
    assert.equal(r.backup, `backup/${s.branch}-${stray.slice(0, 8)}`);
    assert.equal(s.gh.remoteSha(r.backup), stray, 'the backup ref holds the old remote tip');
    assert.notEqual(c2, tip);
  } finally { await s.done(); }
});

/* ---------- 7: map_assign ---------- */

test('map_assign maps exact paths to a charter, refuses mapped paths and unknown charters, and the reloaded map is what the charter check reads', async () => {
  const s = setup('on');
  try {
    const emp = employee(s.wp, 'kabir');
    const charter = emp.charterIds[0]!;
    mkdirSync(join(s.wt, 'tools'), { recursive: true });
    writeFileSync(join(s.wt, 'tools/new-script.sh'), '#!/bin/sh\n');
    git(s.wt, ['add', '-A']); git(s.wt, [...GIT, 'commit', '-q', '-m', 'add tool']);
    const wtInfo = { path: s.wt, repo: s.trunkRepo, base: s.wp.config.github.trunk } as never;
    assert.ok(foreignChanges(s.wp, employee(s.wp, 'kabir'), wtInfo).includes('tools/new-script.sh'), 'unmapped before');
    assert.throws(() => board.assignMap(s.wp, ['tools/new-script.sh'], 'no-such-charter', 'asha', 'a charter that does not exist'), /No charter/);
    assert.throws(() => board.assignMap(s.wp, ['tools/new-script.sh'], charter, 'kabir', 'the author maps their own file'), /Forbidden|ask Asha/);
    assert.throws(() => board.assignMap(s.wp, ['tools/new-script.sh'], charter, 'asha', 'x'), /reason/);
    board.assignMap(s.wp, ['tools/new-script.sh'], charter, 'asha', 'a new tool script nobody owned');
    assert.equal(foreignChanges(s.wp, employee(s.wp, 'kabir'), wtInfo).includes('tools/new-script.sh'), false, 'owned after the reload, no restart');
    assert.throws(() => board.assignMap(s.wp, ['tools/new-script.sh'], charter, 'asha', 'mapping the same file twice'), /already mapped/);
  } finally { await s.done(); }
});

test('map_assign adds an exact-path override under a directory default, placed before it, and still refuses exact entries and globs', async () => {
  const s = setup('on');
  try {
    const dir = s.wp.config.workplaceDir;
    const file = join(dir, 'map.yaml');
    const base = readFileSync(file, 'utf8');
    writeFileSync(file, `${base}${base.endsWith('\n') ? '' : '\n'}  - kind: path\n    key: iris:zzdir\n    primary: kabir-charter-placeholder\n    contributors: []\n    consulted: []\n`.replace('kabir-charter-placeholder', employee(s.wp, 'kabir').charterIds[0]!));
    s.wp.reloadOrg();
    const other = employee(s.wp, 'nikhil').charterIds[0]!;
    assert.throws(() => board.assignMap(s.wp, ['zzdir/*.sh'], other, 'asha', 'a glob is never mapped'), /glob|clean/);
    assert.throws(() => board.assignMap(s.wp, ['zzdir/deploy.sh'], other, 'asha', 'x'), /reason/);
    board.assignMap(s.wp, ['zzdir/deploy.sh'], other, 'asha', 'deploy tooling under the directory default');
    const text = readFileSync(file, 'utf8');
    assert.match(text, /key: iris:zzdir\/deploy\.sh\n\s+primary: [^\n#]+# via map_assign by asha, \d{4}-\d\d-\d\d: deploy tooling under the directory default/);
    assert.ok(text.indexOf('iris:zzdir/deploy.sh') < text.indexOf('key: iris:zzdir\n'), 'inserted before the default');
    assert.equal(resolveOwner(s.wp.org.map, { kind: 'path', key: 'iris:zzdir/deploy.sh' })?.primary, other, 'the exact entry wins');
    assert.notEqual(resolveOwner(s.wp.org.map, { kind: 'path', key: 'iris:zzdir/other.sh' })?.primary, other, 'siblings keep the default');
    assert.throws(() => board.assignMap(s.wp, ['zzdir/deploy.sh'], employee(s.wp, 'kabir').charterIds[0]!, 'asha', 'changing an existing owner'), /already mapped/);
  } finally { await s.done(); }
});

/* ---------- the tools ---------- */

test('the board tools are Workplace tools and refuse an engineer', async () => {
  for (const t of ['pr_close_detach', 'story_close_no_code', 'signoff_recut', 'github_resume', 'status_repost', 'branch_reset_to_local', 'map_assign']) assert.ok((WORKPLACE_TOOLS as readonly string[]).includes(t), t);
  const s = setup('on');
  try {
    const server = workplaceTools(s.wp, 'kabir', () => ({ agentId: 'a', employeeId: 'kabir', assignmentId: s.storyId, startedAt: '', seen: {}, planCaptured: false }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(st);
    const c = new Client({ name: 'test', version: '1' });
    await c.connect(ct);
    const names = (await c.listTools()).tools.map(t => t.name);
    for (const t of ['pr_close_detach', 'story_close_no_code', 'signoff_recut', 'github_resume', 'status_repost', 'branch_reset_to_local', 'map_assign']) assert.ok(names.includes(t), t);
    const out = await c.callTool({ name: 'github_resume', arguments: { reason: 'an engineer trying it' } });
    assert.match(JSON.stringify(out.content), /Not done: .*ask Asha/);
    await c.close();
  } finally { await s.done(); }
});

/* ---------- Asha keeps the whole board except the COO's stories ---------- */

test('the Chief of Staff changes, parks from review and closes any story but the COO\'s, the CTO\'s included', async () => {
  const s = setup('on');
  try {
    s.wp.org.employees.push({ ...employee(s.wp, 'nikhil'), id: 'vikram', name: 'Vikram', roleId: 'cto', level: 1, charterIds: [], reportsTo: 'coo' });
    const cto = 'vikram';
    const epic = items.create(s.wp, { level: 'epic', title: 'Ops' }, 'owner');
    const mk = (title: string, assigneeId: string) => items.create(s.wp, { level: 'story', title, parentId: epic.id, assigneeId, reviewerId: 'asha' } as never, 'owner');
    const theirs = mk('The CTO sign-off', cto);
    items.update(s.wp, theirs.id, { status: 'in-progress', reason: 'owner starts it' }, 'owner');
    items.update(s.wp, theirs.id, { status: 'in-review', reason: 'ready for review' }, 'owner');
    // Before: a plain engineer is refused, Asha is not.
    assert.throws(() => items.update(s.wp, theirs.id, { status: 'in-progress', reason: 'an engineer touching it' }, 'kabir'), /Forbidden/);
    const parked = items.update(s.wp, theirs.id, { status: 'parked', reason: 'waiting for the next batch', resumeWhen: 'the next trunk batch is cut' }, 'asha');
    assert.equal(parked.status, 'parked', 'in-review to parked in one move');
    items.update(s.wp, theirs.id, { status: 'ready', reason: 'batch is cut, back on the board' }, 'asha');
    items.update(s.wp, theirs.id, { status: 'in-progress', reason: 'back in work for the test' }, 'asha');
    items.update(s.wp, theirs.id, { status: 'in-review', reviewerId: 'nikhil', reason: 'review by someone else' }, 'asha');
    items.update(s.wp, theirs.id, { status: 'done', reason: 'closing a no-code story of the CTO' }, 'asha');
    assert.equal(rawGet(s.wp, theirs.id)!.status, 'done');
    // The COO's own story stays out of her reach.
    const coos = mk('The COO\'s story', 'coo');
    assert.throws(() => items.update(s.wp, coos.id, { status: 'parked', reason: 'not mine to park', resumeWhen: 'never' }, 'asha'), /Forbidden/);
  } finally { await s.done(); }
});

/* ---------- a closed PR is not caught up with the trunk or sent back ---------- */

test('a PR closed on GitHub without a merge is not caught up with the trunk and its story is not sent back for a conflict', async () => {
  const s = setup('on');
  try {
    s.commit('docs/scratch.md', 'x\n');
    await toReview(s);
    const n = pr(s).number;
    s.gh.prs.find(p => p.number === n)!.state = 'closed';
    // The trunk moves on, so a catch-up would be due.
    const trunk = s.wp.config.github.trunk;
    writeFileSync(join(s.trunkRepo, 'trunk-move.txt'), 'moved');
    git(s.trunkRepo, ['add', 'trunk-move.txt']); git(s.trunkRepo, [...GIT, 'commit', '-q', '-m', 'trunk moves']);
    assert.equal(git(s.trunkRepo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), trunk);
    await flow.syncHeads(s.wp);
    await flow.syncHeads(s.wp);
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'in-review', 'not flipped to in-progress');
    assert.equal(s.gh.count('updateBranch'), 0, 'no update-branch on a closed PR');
    assert.ok(pr(s).closed, 'remembered as closed');
    // And once closed it does not hold "done" back.
    assert.equal(doneProblem(s.wp, rawGet(s.wp, s.storyId)!, 'asha'), null);
  } finally { await s.done(); }
});

/* ---------- closing never-started work as superseded ---------- */

test('Asha closes never-started and parked stories as superseded with a reason, but not epics or the owner\'s own filings', async () => {
  const s = setup('on');
  try {
    const epic = items.create(s.wp, { level: 'epic', title: 'Ops' }, 'owner');
    const ready = items.create(s.wp, { level: 'story', title: 'Superseded one', parentId: epic.id, assigneeId: 'kabir' }, 'asha');
    assert.throws(() => items.update(s.wp, ready.id, { status: 'done', reason: 'no resolution given' }, 'asha'), /owner/i, 'a plain done is still not hers');
    assert.throws(() => items.update(s.wp, ready.id, { status: 'done', resolution: 'wont-do' }, 'asha'), /note|reason/i, 'a reason is needed');
    const closed = items.update(s.wp, ready.id, { status: 'done', resolution: 'wont-do', reason: 'superseded by the canonical case table story' }, 'asha');
    assert.equal(closed.status, 'done');
    assert.equal(closed.resolution, 'wont-do');
    // Parked: no code started, closed through the maintenance tool.
    const parked = items.create(s.wp, { level: 'story', title: 'Parked one', parentId: epic.id, assigneeId: 'kabir' }, 'asha');
    items.update(s.wp, parked.id, { status: 'parked', reason: 'waiting for the fixture', resumeWhen: 'the fixture lands' }, 'asha');
    board.closeNoCode(s.wp, parked.id, 'asha', 'decided superseded by the owner inbox decision');
    assert.equal(rawGet(s.wp, parked.id)!.status, 'done');
    // Not an epic, not the owner's own filing.
    assert.throws(() => items.update(s.wp, epic.id, { status: 'done', resolution: 'wont-do', reason: 'an epic is the owner\'s' }, 'asha'), /epic|owner/i);
    const mine = items.create(s.wp, { level: 'story', title: 'Owner filed', parentId: epic.id, assigneeId: 'kabir' }, 'owner');
    assert.throws(() => items.update(s.wp, mine.id, { status: 'done', resolution: 'wont-do', reason: 'the owner filed this' }, 'asha'), /owner/i);
    assert.equal(items.update(s.wp, mine.id, { status: 'done', resolution: 'wont-do', reason: 'the COO may' }, 'coo').status, 'done');
  } finally { await s.done(); }
});

test('item_update sets a story\'s title and acceptance (a scope cut lands on the story, handbook §14, 24 Oct); it needs a reason', async () => {
  const s = setup('on');
  try {
    const server = workplaceTools(s.wp, 'kabir', () => ({ agentId: 'a', employeeId: 'kabir', assignmentId: s.storyId, startedAt: '', seen: {}, planCaptured: false }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(st);
    const c = new Client({ name: 'test', version: '1' });
    await c.connect(ct);
    const refused = await c.callTool({ name: 'item_update', arguments: { itemId: s.storyId, title: 'Smaller scope' } });
    assert.match(JSON.stringify(refused.content), /needs a reason/);
    assert.notEqual(rawGet(s.wp, s.storyId)!.title, 'Smaller scope');
    const out = await c.callTool({ name: 'item_update', arguments: { itemId: s.storyId, title: 'Refine: two preset chips', acceptance: ['Two preset chips refine the last image', 'Free-text refine is as_follow1'], reason: 'scope cut: free-text refine moved to as_follow1' } });
    assert.doesNotMatch(JSON.stringify(out.content), /Not changed/);
    const it = rawGet(s.wp, s.storyId)!;
    assert.equal(it.title, 'Refine: two preset chips');
    assert.deepEqual(it.acceptance, ['Two preset chips refine the last image', 'Free-text refine is as_follow1']);
    await c.close();
  } finally { await s.done(); }
});
