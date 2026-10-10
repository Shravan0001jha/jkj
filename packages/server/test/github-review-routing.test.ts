import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workplace } from '../src/services/workplace.js';
import * as items from '../src/services/items.js';
import * as work from '../src/services/work.js';
import * as flow from '../src/services/github-flow.js';
import * as reviewWake from '../src/services/review-wake.js';
import { employee } from '../src/services/employees.js';
import { ensureWorktree } from '../src/services/worktrees.js';
import { canApproveAsDeveloper } from '../src/services/review-policy.js';
import { rawGet } from '../src/services/v2-map.js';
import { testWorkplace } from './fakes/workplace.js';
import { FakeGitHub } from './fakes/fake-github.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';

/**
 * Dry-run finding #3 (4 Oct): a story entered review with QA (Nikhil) as its reviewer, QA refused for
 * lack of a developer approval and moved it back to in-progress: a wasted round. With a PR, review
 * always starts with a developer approver (rework W3: a member of the author's team who is not the
 * author, or the CTO), whoever the author named;
 * QA is set only after the developer approval; a QA woken early is told to wait, and cannot move the
 * story back for that reason.
 */

const runtime = installFakeRuntime();
after(() => runtime.restore());
const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });

async function setup(mode: 'shadow' | 'on'): Promise<{ wp: Workplace; id: string; gh: FakeGitHub; done(): Promise<void> }> {
  const { wp, tmp } = testWorkplace();
  const kabir = employee(wp, 'kabir');
  // Kabir's team (rework W3: the developer approval comes from the author's own team).
  wp.org.employees.push({ ...kabir, id: 'arjun', name: 'Arjun', roleId: 'engineer', level: 2, charterIds: ['memory'], reportsTo: 'kabir' });
  wp.org.employees.push({ ...kabir, id: 'ishan', name: 'Ishan', roleId: 'engineer', level: 2, charterIds: ['server'], reportsTo: 'kabir' });
  writeFileSync(join(wp.config.workplaceDir, 'quality.yaml'), 'maxFileBytes: 100000\nareas: {}\n');
  const gh = new FakeGitHub(kabir.workspace.repo);
  flow.useGitHub(wp, gh);
  flow.setMode(wp, mode, 'coo');
  const epic = items.create(wp, { level: 'epic', title: 'Memory' }, 'owner');
  const story = items.create(wp, { level: 'story', title: 'Recall the last song', parentId: epic.id, assigneeId: 'kabir' }, 'owner');
  const wt = ensureWorktree(wp.config.workDir, kabir, story.id).path;
  mkdirSync(join(wt, 'services'), { recursive: true });
  writeFileSync(join(wt, 'services', 'recall.py'), 'x = 1\n');
  git(wt, ['add', '-A']);
  git(wt, ['-c', 'user.email=k@iris.local', '-c', 'user.name=kabir', 'commit', '-q', '-m', 'recall']);
  return { wp, id: story.id, gh, done: async () => { await flow.settled(); gh.cleanup(); tmp.cleanup(); } };
}

const evidence = { tests: { passed: 1, failed: 0 }, commits: ['x'], liveVerified: [], notVerified: [] };

for (const mode of ['shadow', 'on'] as const) {
  test(`${mode}: the author names QA as reviewer; with a PR the server makes a developer approver (a member of the author's team, not the author) the reviewer and wakes them`, async () => {
    const s = await setup(mode);
    const stop = reviewWake.startReviewWake(s.wp);
    try {
      items.update(s.wp, s.id, { reviewerId: 'nikhil' }, 'kabir');
      work.reportDone(s.wp, s.id, evidence, 'kabir');
      assert.equal(rawGet(s.wp, s.id)!.reviewerId, 'nikhil', 'what the author asked for');
      await (await flow.onReview(s.wp, s.id, 'kabir')).tests;
      const reviewer = rawGet(s.wp, s.id)!.reviewerId!;
      assert.ok(canApproveAsDeveloper(s.wp.org.employees, reviewer, 'kabir'), `${reviewer} is in Kabir's team`);
      assert.equal(rawGet(s.wp, s.id)!.pr?.devReviewer, reviewer);
      assert.notEqual(reviewer, 'kabir', 'never the author');
      await new Promise(r => setImmediate(r));
      assert.equal(reviewWake.wakeOf(s.wp, s.id)?.reviewerId, reviewer, 'the lead is woken');

      // After the developer approval, QA reviews (the existing qaReviewer step) and is woken.
      await flow.approve(s.wp, s.id, reviewer);
      assert.equal(rawGet(s.wp, s.id)!.reviewerId, 'nikhil');
      await new Promise(r => setImmediate(r));
      assert.equal(reviewWake.wakeOf(s.wp, s.id)?.reviewerId, 'nikhil');
    } finally { stop(); await s.done(); }
  });
}

test('a team member the author named stays the reviewer; a lead of another team the author named is replaced by the team (rework W3)', async () => {
  const s = await setup('shadow');
  try {
    items.update(s.wp, s.id, { reviewerId: 'ishan' }, 'kabir');
    work.reportDone(s.wp, s.id, evidence, 'kabir');
    await (await flow.onReview(s.wp, s.id, 'kabir')).tests;
    assert.equal(rawGet(s.wp, s.id)!.reviewerId, 'ishan');
    assert.equal(rawGet(s.wp, s.id)!.pr?.devReviewer, 'ishan');
  } finally { await s.done(); }
  const t = await setup('shadow');
  try {
    items.update(t.wp, t.id, { reviewerId: 'mira' }, 'kabir');
    work.reportDone(t.wp, t.id, evidence, 'kabir');
    await (await flow.onReview(t.wp, t.id, 'kabir')).tests;
    assert.equal(rawGet(t.wp, t.id)!.reviewerId, 'arjun', 'Mira leads another team: the team member with the fewest reviews takes it');
  } finally { await t.done(); }
});

test('QA woken before the developer approval is told to wait, and cannot move the story back or send it back for that', async () => {
  const s = await setup('shadow');
  try {
    work.reportDone(s.wp, s.id, evidence, 'kabir');
    await (await flow.onReview(s.wp, s.id, 'kabir')).tests;
    const lead = rawGet(s.wp, s.id)!.reviewerId!;
    // QA ends up as reviewer anyway (by hand): the prompt says wait.
    const asQa = { ...rawGet(s.wp, s.id)!, reviewerId: 'nikhil' };
    const prompt = reviewWake.reviewPrompt(s.wp, asQa);
    assert.match(prompt, /wait: developer approval first/i);
    assert.doesNotMatch(prompt, /item_update on .* status in-progress/);

    assert.throws(() => items.update(s.wp, s.id, { status: 'in-progress', note: 'no developer approval yet' }, 'nikhil'), /developer approval first|Forbidden/i);
    await assert.rejects(flow.sendBack(s.wp, s.id, 'nikhil', 'no developer approval'), /developer approval first/i);
    assert.equal(rawGet(s.wp, s.id)!.status, 'in-review');

    // The lead can still send it back; and after the developer approval, QA can.
    await flow.approve(s.wp, s.id, lead);
    assert.doesNotMatch(reviewWake.reviewPrompt(s.wp, rawGet(s.wp, s.id)!), /wait: developer approval first/i);
    await flow.sendBack(s.wp, s.id, 'nikhil', 'recall returns the wrong song: off-by-one in history index');
    assert.equal(rawGet(s.wp, s.id)!.status, 'in-progress');
  } finally { await s.done(); }
});
