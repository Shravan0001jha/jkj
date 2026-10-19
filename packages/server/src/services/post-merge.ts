import type { WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import * as items from './items.js';
import * as trail from './trail.js';
import { leadOfCharter } from './org.js';
import { macHost } from './mac-host.js';
import { rawGet } from './v2-map.js';
import { rowsJson } from './store.js';
import * as work from './work.js';
import { now } from './store.js';
import { log } from '../util/logger.js';

/**
 * The post-merge iPhone review (owner's final rule, 19 Oct): no macOS runs on GitHub per story. A story
 * that changes mobile/ios merges on the Linux checks, review, QA doc and the Android counterpart's
 * evidence, and then stays Merged (never Done). On that merge the Workplace files a linked story
 * "Post-merge iPhone review: <title>" under the same epic, charter mobile-ios, whose acceptance is the
 * build + unit tests of the merged trunk commit on the owner's Mac. It waits Parked until a Mac is
 * attached (macHost()); the sweep lifts the park then.
 *
 *   review closed done            -> the original is closed (Merged -> Done)
 *   review closed won't do        -> the review FAILED: a bug is filed against the original, which stays Merged
 *
 * Idempotent: the original carries `postMerge`, the review carries `postMergeOf`.
 */

export const IOS_CHARTER = 'mobile-ios';
export const REVIEW_PREFIX = 'Post-merge iPhone review: ';
export const RESUME_WHEN = 'A Mac is attached';

export const needsReview = (w: WorkItem): boolean => !!w.pr?.merged && !!w.pr.iosChange && !w.closedAt;

function reviewBody(orig: WorkItem): string {
  const sha = orig.pr?.merged?.sha ? ` (${orig.pr.merged.sha.slice(0, 8)})` : '';
  return [
    `Post-merge verification of ${orig.id} "${orig.title}", PR #${orig.pr?.number}, which changed mobile/ios and merged WITHOUT a macOS run (owner rule, 19 Oct: no macOS on GitHub per story). The story stays Merged, not Done, until this passes.`,
    '',
    `1. On the owner's Mac (request_mac), check out the merged trunk commit${sha} and run the iPhone build and unit tests (xcodebuild build + test for mobile/ios).`,
    `2. Run whatever is iPhone-specific in ${orig.id}'s QA doc ("iPhone: post-merge review on the Mac").`,
    '',
    `Pass: close this story as done; ${orig.id} then moves to Done by itself.`,
    `Fail: close this story with resolution wont-do and a note saying what failed; a bug is filed against ${orig.id} and it stays Merged.`,
    '',
    `Waits Parked until a Mac is attached to the Workplace.`,
  ].join('\n');
}

/** File the review for a merged iPhone story, once. Returns the review id, or null when none is due. */
export function file(wp: Workplace, id: string): string | null {
  const orig = rawGet(wp, id);
  if (!orig || !needsReview(orig) || orig.postMerge) return orig?.postMerge?.reviewId ?? null;
  const lead = leadOfCharter(wp.org, IOS_CHARTER);
  const review = items.create(wp, {
    level: 'story',
    title: `${REVIEW_PREFIX}${orig.title}`,
    body: reviewBody(orig),
    ...(orig.parentId ? { parentId: orig.parentId } : {}),
    ...(lead ? { assigneeId: lead } : {}),
    acceptance: [
      `Build and unit tests of the merged trunk commit pass on the owner's Mac`,
      `The iPhone-specific lines of ${orig.id}'s QA doc are checked`,
    ],
  }, 'workplace', { reason: `Filed on the merge of ${orig.id}: the iPhone change is verified on the Mac after the merge` });
  const r = rawGet(wp, review.id)!;
  work.put(wp, r, { ...r, charterId: IOS_CHARTER, postMergeOf: id }, 'workplace');
  const now$ = rawGet(wp, review.id)!;
  park(wp, now$.id);
  const fresh = rawGet(wp, id)!;
  work.put(wp, fresh, { ...fresh, postMerge: { reviewId: review.id, filedAt: now(), state: 'waiting' } }, 'workplace', `Merged; the iPhone review ${review.id} must pass before this is Done`);
  trail.record(wp, { itemId: id, by: 'workplace', kind: 'note', text: `Merged without a macOS run. Post-merge iPhone review filed: ${review.id}. This story stays Merged until it passes.` });
  if (macHost()) unpark(wp, review.id);
  return review.id;
}

function park(wp: Workplace, id: string): void {
  try { items.update(wp, id, { hold: true, note: `Needs the owner's Mac: build + unit tests of the merged commit`, resumeWhen: RESUME_WHEN }, 'coo'); }
  catch (err) { log.warn('post-merge', `${id}: could not park: ${err instanceof Error ? err.message : err}`); }
}

function unpark(wp: Workplace, id: string): void {
  try { items.update(wp, id, { status: 'ready', note: 'A Mac is attached: the post-merge iPhone review can run' }, 'coo'); }
  catch (err) { log.warn('post-merge', `${id}: could not lift the park: ${err instanceof Error ? err.message : err}`); }
}

/** Reviews parked for a Mac that has since attached are lifted; reviews of merges not yet filed are filed. */
export function sweep(wp: Workplace): void {
  for (const w of rowsJson<WorkItem>(wp.db.prepare("select json from work where json_extract(json, '$.pr.iosChange') = 1 and json_extract(json, '$.pr.merged') is not null and json_extract(json, '$.postMerge') is null").all())) {
    try { file(wp, w.id); } catch (err) { log.warn('post-merge', `${w.id}: ${err instanceof Error ? err.message : err}`); }
  }
  if (!macHost()) return;
  for (const w of rowsJson<WorkItem>(wp.db.prepare("select json from work where status = 'parked' and json_extract(json, '$.postMergeOf') is not null").all())) {
    if (w.parked?.resumeWhen === RESUME_WHEN) unpark(wp, w.id);
  }
}

/** A review story changed: closed done passes it, closed won't do fails it. */
export function onReviewItem(wp: Workplace, id: string): 'passed' | 'failed' | null {
  const rev = rawGet(wp, id);
  if (!rev?.postMergeOf || rev.status !== 'done') return null;
  const orig = rawGet(wp, rev.postMergeOf);
  if (!orig?.postMerge || orig.postMerge.reviewId !== id || orig.postMerge.state !== 'waiting') return null;
  const res = rev.resolution ?? 'done';
  if (res === 'done') {
    const w1 = rawGet(wp, orig.id)!;
    work.put(wp, w1, { ...w1, postMerge: { ...orig.postMerge, state: 'passed' } }, 'workplace');
    trail.record(wp, { itemId: orig.id, by: 'workplace', kind: 'note', text: `Post-merge iPhone review ${id} passed: closing.` });
    if (!rawGet(wp, orig.id)!.closedAt) items.update(wp, orig.id, { status: 'done', note: `Post-merge iPhone review ${id} passed` }, 'coo');
    return 'passed';
  }
  if (res !== 'wont-do') return null;
  const lastNote = trail.comments(wp, id).slice(-1)[0]?.text ?? '';
  const bug = items.create(wp, {
    level: 'story', type: 'bug', ...(orig.parentId ? { parentId: orig.parentId } : {}),
    title: `Post-merge iPhone review failed: ${orig.title}`,
    body: `The post-merge iPhone review ${id} of ${orig.id} "${orig.title}" (PR #${orig.pr?.number}) failed on the owner's Mac.\n\n${lastNote}\n\n${orig.id} stays Merged until this is fixed and the iPhone review passes again.`,
  }, 'workplace', { reason: `The iPhone review of ${orig.id} failed` });
  const w1 = rawGet(wp, orig.id)!;
  work.put(wp, w1, { ...w1, postMerge: { ...orig.postMerge, state: 'failed', bugId: bug.id } }, 'workplace');
  trail.record(wp, { itemId: orig.id, by: 'workplace', kind: 'note', text: `Post-merge iPhone review ${id} FAILED. Bug filed: ${bug.id}. This story stays Merged.` });
  return 'failed';
}
