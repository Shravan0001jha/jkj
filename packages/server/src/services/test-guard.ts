import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';

/**
 * Tests never touch the real organisation, the real worktrees or the real repositories (QA B5,
 * 29 Sep: test runs cut 175 `emp/*` branches in the owner's checkouts). Node's test runner marks
 * its children with NODE_TEST_CONTEXT; under it, every path the Workplace would write to must be
 * inside the OS temp directory, or the call is refused before anything is opened or checked out.
 */

export class RealPathInTest extends Error {
  constructor(kind: string, path: string) {
    super(`Refusing to touch the ${kind} ${path} from a test: tests run only against temp directories (set IRIS_WORKPLACE_DIR, IRIS_WORK_DIR and the org's repo roots under ${tmpdir()}).`);
  }
}

export function underTest(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env['NODE_TEST_CONTEXT'] || env['WORKPLACE_TEST_GUARD'] === '1';
}

/** Throws under a test when `path` is outside the temp directory. A no-op outside tests. */
export function assertNotRealPath(kind: string, path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!underTest(env)) return;
  if (!isTemp(path)) throw new RealPathInTest(kind, path);
}

export function isTemp(path: string): boolean {
  const temp = canonical(tmpdir());
  const target = canonical(path);
  return target === temp || target.startsWith(temp + sep);
}

function canonical(p: string): string {
  const abs = resolve(p);
  // The path may not exist yet (a work dir created on first use): canonicalise the longest existing prefix.
  let probe = abs;
  const rest: string[] = [];
  while (!existsSync(probe)) {
    const parent = resolve(probe, '..');
    if (parent === probe) return abs;
    rest.unshift(probe.slice(parent.length + 1));
    probe = parent;
  }
  try { return [realpathSync(probe), ...rest].join(sep); } catch { return abs; }
}
