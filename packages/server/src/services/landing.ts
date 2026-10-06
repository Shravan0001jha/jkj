import type { WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import { branchFor, git } from './worktrees.js';

/**
 * Patches on a story's branch that are not on the trunk, by content (`git cherry`), not by SHA:
 * a change that reached the trunk through another branch or a squash still counts as landed.
 *
 * RCA (6 Oct): 38 stories were marked done while their branch carried changes the trunk never
 * got. The done check only looked at a PR when one existed (review-policy.doneProblem), so a
 * story with commits but no PR could be closed by its reviewer and the work stayed stranded.
 * Prefers origin/<trunk> (what GitHub has) over the local ref, which is never fetched forward.
 * Unknown (no branch, no repo, git failure) counts as 0: this guard never invents a block.
 */
export function unlandedPatches(wp: Workplace, w: WorkItem): number {
  const emp = wp.org.employees.find(e => e.id === w.employeeId);
  if (!emp?.workspace?.repo) return 0;
  const repo = emp.workspace.repo;
  const trunk = emp.workspace.branch ?? wp.config.github.trunk;
  const branch = branchFor(emp, w.id);
  try {
    git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  } catch { return 0; }
  let base = trunk;
  try { git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${trunk}`]); base = `origin/${trunk}`; } catch { /* local trunk only */ }
  try {
    return git(repo, ['cherry', base, branch]).split('\n').filter(l => l.startsWith('+')).length;
  } catch { return 0; }
}
