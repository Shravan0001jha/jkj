import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What scripts/pre-pr.sh leaves in a worktree for a commit (the Iris repo's script, faked). */
export function writePrePr(worktree: string, sha: string, opts: { ok?: boolean; by?: string; forSha?: string; mode?: 'full' | 'fast'; only?: string[] | null; deferred?: string[] } = {}): void {
  const ok = opts.ok ?? true;
  const dir = join(worktree, '.workplace', 'pre-pr');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sha}.json`), JSON.stringify({
    schema: 1, sha: opts.forSha ?? sha, base: 'feat/iris-character', at: new Date().toISOString(), by: opts.by ?? 'kabir', ok,
    mode: opts.mode ?? 'full', only: opts.only === undefined ? null : opts.only, changedFiles: ['services/agent-svc/recall.py'],
    areas: [
      // On the Linux server (cloud migration, 17 Oct) mobile areas are one placeholder check left to GitHub.
      ...(opts.deferred ?? []).map(area => ({ area, checks: [{ name: 'github', cmd: null, ok: true, passed: null, failed: null, skipped: null, durationSec: 0, exitCode: 0, timedOut: false, tail: '', deferred: 'github' }], notes: ['runs on GitHub (mobile-checks.yml)'] })),
      ...(opts.deferred ? [] : [{ area: 'mobile-android', checks: [{ name: 'unit', cmd: './gradlew test', ok: true, passed: 16, failed: 0, skipped: 0, durationSec: 40, exitCode: 0, timedOut: false, tail: '' }], notes: [] }]),
      { area: 'agent-svc', checks: [
        { name: 'syntax', cmd: 'python -m py_compile', ok: true, passed: null, failed: null, skipped: null, durationSec: 1, exitCode: 0, timedOut: false, tail: '' },
        { name: 'unit', cmd: 'pytest', ok, passed: ok ? 374 : 372, failed: ok ? 0 : 2, skipped: 1, durationSec: 30, exitCode: ok ? 0 : 1, timedOut: false, tail: ok ? '' : 'FAILED test_recall.py::test_last_song' },
      ], notes: [] },
    ],
  }));
}
