import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Employee, WorkItem } from '@jkj/shared';
import type { Workplace } from '../src/services/workplace.js';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as trail from '../src/services/trail.js';
import * as flow from '../src/services/github-flow.js';
import * as qaDoc from '../src/services/qa-doc.js';
import * as employees from '../src/services/employees.js';
import * as reviewWake from '../src/services/review-wake.js';
import { employee } from '../src/services/employees.js';
import { ensureWorktree } from '../src/services/worktrees.js';
import { rawGet } from '../src/services/v2-map.js';
import { stage } from '../src/services/review-policy.js';
import { testWorkplace } from './fakes/workplace.js';
import { FakeGitHub } from './fakes/fake-github.js';
import { writePrePr } from './fakes/pre-pr.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';

/**
 * Board bugs 2 and 3 (19 Oct): who acts next on a review is decided in one place.
 *
 * 2. as_mv41lj93y5zzd: the item said reviewer Zoya, review_approve said "Nikhil is this story's QA".
 *    The QA lock (pr.qaReviewer) survived from an earlier round in which Nikhil was QA; this round he gave
 *    the developer approval (approval 1 of 2), so the lock named the one person who could never give
 *    approval 2. He handed QA to Zoya with item_update reviewerId; the gate read the trail for a "decider"
 *    move and ignored his. Two sources of truth for "who is QA".
 * 3. as_mv6varf8ftb1v, as_mve3r4a2t95fq, as_mvdfyrzkj85ap: the extra reviewer was added and the QA gate
 *    waited for her, but nobody woke her: the "Extra review before QA" comment is the Workplace's, and the
 *    Workplace's own @mentions are never delivered; a reset approval was never told again; QA was woken
 *    while the extra reviewer was still pending and never again when she approved.
 */

const runtime = installFakeRuntime();
after(() => runtime.restore());
const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

function staff(wp: Workplace): void {
  if (wp.org.employees.some(e => e.id === 'arjun')) return;
  const kabir = employee(wp, 'kabir');
  const add = (e: Partial<Employee> & { id: string }) => wp.org.employees.push({ ...kabir, name: e.id[0]!.toUpperCase() + e.id.slice(1), level: 2, ...e } as Employee);
  add({ id: 'arjun', roleId: 'engineer', charterIds: ['memory'], reportsTo: 'kabir' });
  add({ id: 'zoya', roleId: 'qa', charterIds: ['qa-release'], reportsTo: 'nikhil' });
  add({ id: 'aditi', roleId: 'qa', charterIds: ['qa-release'], reportsTo: 'nikhil' });
  add({ id: 'cto', name: 'Vikram', roleId: 'cto', level: 0, charterIds: [], reportsTo: 'coo' });
}

interface Setup { wp: Workplace; gh: FakeGitHub; storyId: string; wt: string; commit(files: Record<string, string>): string; done(): Promise<void> }

function setup(author = 'kabir', trunk?: Record<string, string>): Setup {
  const { wp, tmp } = testWorkplace();
  staff(wp);
  const emp = employee(wp, author);
  const repo = emp.workspace.repo;
  if (trunk) {
    for (const [f, c] of Object.entries(trunk)) { mkdirSync(join(repo, f, '..'), { recursive: true }); writeFileSync(join(repo, f), c); }
    git(repo, ['add', '-A']);
    git(repo, ['-c', 'user.email=t@iris.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'trunk files']);
  }
  writeFileSync(join(wp.config.workplaceDir, 'quality.yaml'), 'maxFileBytes: 100000\nareas: {}\n');
  const gh = new FakeGitHub(repo);
  flow.useGitHub(wp, gh);
  flow.setMode(wp, 'shadow', 'coo');
  const epic = items.create(wp, { level: 'epic', title: 'Sign-up' }, 'owner');
  const story = items.create(wp, { level: 'story', title: 'Sign-up QA scenario', parentId: epic.id, assigneeId: author }, 'owner');
  const wt = ensureWorktree(wp.config.workDir, emp, story.id).path;
  // The live wiring: an item change wakes its reviewer (index.ts starts this at boot).
  const stopWake = reviewWake.startReviewWake(wp);
  const commit = (files: Record<string, string>): string => {
    for (const [f, c] of Object.entries(files)) { mkdirSync(join(wt, f, '..'), { recursive: true }); writeFileSync(join(wt, f), c); }
    git(wt, ['add', '-A']);
    git(wt, ['-c', `user.email=${author}@iris.local`, '-c', `user.name=${author}`, 'commit', '-q', '-m', 'change']);
    const sha = git(wt, ['rev-parse', 'HEAD']).trim();
    writePrePr(wt, sha, { ok: true, by: author });
    return sha;
  };
  return { wp, gh, storyId: story.id, wt, commit, done: async () => { stopWake(); await flow.settled(); gh.cleanup(); tmp.cleanup(); } };
}

const evidence = { tests: { passed: 3, failed: 0, command: 'npm test' }, commits: ['abc'], liveVerified: [], notVerified: ['live'] };
async function reviewed(s: Setup, by: string): Promise<void> {
  work.reportDone(s.wp, s.storyId, evidence, by);
  await (await flow.onReview(s.wp, s.storyId, by)).tests;
}
const pr = (s: Setup): NonNullable<WorkItem['pr']> => rawGet(s.wp, s.storyId)!.pr!;
function qaText(wp: Workplace): string {
  const path = join(qaDoc.evidenceDir(wp), 'logs/unit.txt');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'ok\n');
  return [
    '## Edge cases',
    '- PASS: empty input — unit test evidence: logs/unit.txt',
    '- PASS: provider down — killed the provider and checked the reply evidence: https://ci.example.com/runs/42',
    '- N/A: Windows path — no Windows code touched',
    '## Report',
    'Checked both failure paths by hand and in tests; Windows untouched; residual risk low.',
    'Evidence: n/a — server-only change with no app surface',
    'Tests: npm test 12 passed, 0 failed',
  ].join('\n');
}
/** Every text an employee was handed by the fake runtime: opening prompts and follow-up messages. */
const told = (emp: string): string[] => runtime.sessions.filter(x => x.options.cwd.includes(`/${emp}/`)).flatMap(x => [x.options.prompt, ...x.sent.map(m => m.text)]);
const freeAll = (wp: Workplace) => { for (const s of employees.allSessions()) employees.close(wp, s.agentId, 'ended'); };

/* ---------- bug 2: one source of truth for the story's QA ---------- */

test('as_mv41lj93y5zzd: a QA lock left from an earlier round on the person who now gives approval 1 is re-picked at the developer approval', async () => {
  // Aditi (QA team) authors; Nikhil (her lead) is her developer approver; Nikhil was QA in round 1.
  const s = setup('aditi');
  try {
    s.commit({ 'e2e/signup.mjs': 'export const x = 1\n' });
    await reviewed(s, 'aditi');
    work.saveQuiet(s.wp, { ...rawGet(s.wp, s.storyId)!, pr: { ...pr(s), qaReviewer: 'nikhil' } });
    await flow.approve(s.wp, s.storyId, 'nikhil', 'dev approval');
    assert.equal(pr(s).devApproval?.by, 'nikhil');
    assert.equal(pr(s).qaReviewer, 'zoya', 'the QA is never the developer approver');
    assert.equal(rawGet(s.wp, s.storyId)!.reviewerId, 'zoya', 'the board and the gate say the same person');
    assert.equal((await flow.approve(s.wp, s.storyId, 'zoya', undefined, qaText(s.wp))).stage, 'qa');
  } finally { await s.done(); }
});

test('as_mv41lj93y5zzd: the story\'s QA hands QA to another QA with item_update reviewerId; the gate follows', async () => {
  const s = setup('kabir');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s, 'kabir');
    await flow.approve(s.wp, s.storyId, 'arjun');
    assert.equal(pr(s).qaReviewer, 'nikhil');
    items.update(s.wp, s.storyId, { reviewerId: 'zoya', note: 'Zoya takes QA: I am on the release' }, 'nikhil');
    assert.equal(pr(s).qaReviewer, 'zoya');
    assert.ok(trail.activityFor(s.wp, s.storyId).some(a => /QA for this story is now Zoya/.test(a.text)));
    await assert.rejects(flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp)), /Zoya is this story's QA/);
    assert.equal((await flow.approve(s.wp, s.storyId, 'zoya', undefined, qaText(s.wp))).stage, 'qa');
  } finally { await s.done(); }
});

test('class: the board can never name a QA the gate refuses: the author renaming the QA is refused at item_update', async () => {
  const s = setup('kabir');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s, 'kabir');
    await flow.approve(s.wp, s.storyId, 'arjun');
    assert.throws(() => items.update(s.wp, s.storyId, { reviewerId: 'zoya', note: 'zoya is free' }, 'kabir'), /Nikhil is this story's QA/);
    assert.equal(rawGet(s.wp, s.storyId)!.reviewerId, 'nikhil');
    // The Chief of Staff (a decider) moves both at once; so does the COO.
    items.update(s.wp, s.storyId, { reviewerId: 'zoya', note: 'Nikhil is out today' }, 'asha');
    assert.equal(pr(s).qaReviewer, 'zoya');
    items.update(s.wp, s.storyId, { reviewerId: 'aditi', note: 'Aditi knows sign-up' }, 'coo');
    assert.equal(pr(s).qaReviewer, 'aditi');
    // Never to the developer approver, never to someone who is not QA.
    assert.throws(() => items.update(s.wp, s.storyId, { reviewerId: 'arjun', note: 'arjun again' }, 'asha'), /QA|approval 1/);
    // The story chain shows the same QA as the gate.
    assert.equal(items.chain(s.wp, rawGet(s.wp, s.storyId)!).qa, 'aditi');
  } finally { await s.done(); }
});

test('class: the legacy reviewerId-only repair: the COO naming the reviewer the board already shows moves the lock to it', async () => {
  const s = setup('kabir');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s, 'kabir');
    await flow.approve(s.wp, s.storyId, 'arjun');
    // What the live row holds: reviewer Zoya on the board, lock Nikhil.
    work.saveQuiet(s.wp, { ...rawGet(s.wp, s.storyId)!, reviewerId: 'zoya' });
    items.update(s.wp, s.storyId, { reviewerId: 'zoya', note: 'one QA: Zoya' }, 'coo');
    assert.equal(pr(s).qaReviewer, 'zoya');
  } finally { await s.done(); }
});

/* ---------- bug 3: the extra reviewer is woken by the same rule the QA gate checks ---------- */

test('as_mve3r4a2t95fq: an extra reviewer added at the push is woken with a review request naming her files', async () => {
  const s = setup('kabir');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n', 'services/agent-svc/speaker.py': 'def speak():\n    return 1\n' });
    await reviewed(s, 'kabir');
    await tick();
    assert.deepEqual(pr(s).extraReviewers?.map(e => e.id), ['dev']);
    const dev = told('dev').join('\n');
    assert.match(dev, new RegExp(`${s.storyId}`), 'Dev is woken about the story');
    assert.match(dev, /services\/agent-svc\/speaker\.py/);
    assert.match(dev, /review_approve/);
  } finally { await s.done(); }
});

test('as_mvdfyrzkj85ap: QA is not woken while an extra reviewer is pending, and is woken the moment the last one approves', async () => {
  const s = setup('kabir');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n', 'services/agent-svc/speaker.py': 'def speak():\n    return 1\n' });
    await reviewed(s, 'kabir');
    freeAll(s.wp);
    await flow.approve(s.wp, s.storyId, 'arjun');
    await tick();
    assert.equal(rawGet(s.wp, s.storyId)!.reviewerId, 'nikhil');
    assert.equal(told('nikhil').filter(t => t.includes(s.storyId)).length, 0, 'not QA\'s turn yet');
    await flow.approve(s.wp, s.storyId, 'dev', 'speaker is fine');
    await tick();
    assert.equal(told('nikhil').filter(t => t.includes(s.storyId)).length, 1, 'QA is woken once the extra reviewers are done');
  } finally { await s.done(); }
});

test('as_mv6varf8ftb1v: an extra reviewer whose approval a new author commit reset is woken again', async () => {
  const s = setup('kabir');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n', 'services/agent-svc/speaker.py': 'def speak():\n    return 1\n' });
    await reviewed(s, 'kabir');
    await flow.approve(s.wp, s.storyId, 'dev', 'fine');
    freeAll(s.wp);
    const before = told('dev').filter(t => t.includes(s.storyId)).length;
    s.commit({ 'services/agent-svc/speaker.py': 'def speak():\n    return 2\n' });
    await flow.syncHeads(s.wp);
    await tick();
    assert.ok(!pr(s).extraReviewers![0]!.approvedAt, 'the new commit reset her approval');
    assert.equal(told('dev').filter(t => t.includes(s.storyId)).length, before + 1, 'and she is told again');
  } finally { await s.done(); }
});

test('class: an extra reviewer the author asks for (request_review) is woken the same way', async () => {
  const s = setup('kabir');
  try {
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s, 'kabir');
    flow.requestExtraReviewers(s.wp, s.storyId, 'kabir', ['mira']);
    await tick();
    assert.ok(told('mira').some(t => t.includes(s.storyId) && /review_approve/.test(t)), 'Mira is woken');
  } finally { await s.done(); }
});

/* ---------- case 6: Done with an unmerged PR whose approvals do not hold (as_mvdis3x8bn3vj, PR #446) ---------- */

test('as_mvdis3x8bn3vj: during an automatic fallback to local, a story with an open PR still cannot be marked done without approval 2', async () => {
  const s = setup('kabir');
  try {
    flow.setMode(s.wp, 'on', 'coo');
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s, 'kabir');
    await flow.approve(s.wp, s.storyId, 'arjun');
    // Three GitHub failures: the flow falls back to local (as at 16:10 UTC, 18 Oct).
    for (let i = 0; i < 3; i++) flow.recordFailure(s.wp, 'merge', s.storyId, Date.now(), 'Repository rule violation');
    assert.equal(flow.state(s.wp).mode, 'on', 'a repository rule refusing a merge is policy, not an outage');
    for (let i = 0; i < 3; i++) flow.recordFailure(s.wp, 'push', s.storyId, Date.now(), 'GitHub 502');
    assert.equal(flow.state(s.wp).mode, 'local');
    assert.throws(() => items.update(s.wp, s.storyId, { status: 'done', note: 'QA approval 2/2 complete' }, 'nikhil'), /review_approve/);
    // The old engine's transition route is held to the same gate.
    assert.throws(() => work.transition(s.wp, s.storyId, { to: 'done', by: 'nikhil', note: 'verified' }), /review_approve/);
    assert.equal(rawGet(s.wp, s.storyId)!.status, 'in-review');
  } finally { await s.done(); }
});

test('class: a story already Done with an open PR whose approvals do not hold is put back In review by the sweep, its QA woken, a same-head developer approval kept', async () => {
  const s = setup('kabir');
  try {
    flow.setMode(s.wp, 'on', 'coo');
    s.commit({ 'services/memory-svc/recall.py': 'x = 1\n' });
    await reviewed(s, 'kabir');
    await flow.approve(s.wp, s.storyId, 'arjun');
    freeAll(s.wp);
    // What the live row holds: Done, PR open, no QA approval.
    work.saveQuiet(s.wp, { ...rawGet(s.wp, s.storyId)!, status: 'done', resolution: 'done', statusSince: new Date().toISOString() });
    await flow.syncHeads(s.wp);
    await tick();
    const w = rawGet(s.wp, s.storyId)!;
    assert.equal(w.status, 'in-review');
    assert.equal(w.reviewerId, 'nikhil');
    assert.equal(stage(w), 'qa', 'the developer approval on the same head still holds');
    assert.ok(told('nikhil').some(t => t.includes(s.storyId)), 'QA is asked for approval 2');
    assert.equal((await flow.approve(s.wp, s.storyId, 'nikhil', undefined, qaText(s.wp))).stage, 'qa');
  } finally { await s.done(); }
});
