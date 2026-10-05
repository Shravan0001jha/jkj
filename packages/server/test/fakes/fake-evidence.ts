import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppBuilder, BuildRequest, EvidenceRunner, RunnerOutcome, RunnerRequest, ServerDeployer, ServerDeployRequest, Staging } from '../../src/services/evidence-ports.js';
import { BuildError } from '../../src/services/evidence-ports.js';

/**
 * The robot runner, the app builder and staging, faked (docs/LLD-evidence.md §7). The runner writes
 * what the real one writes (results.json, summary.txt, index.html, a screenshot) and then waits until
 * the test releases it, so a test can see runs in flight, the queue behind them, and what happens
 * when the branch moves under a run.
 */

export interface RunScript {
  verdict?: 'PASS' | 'FAIL';
  exitCode?: number;
  /** Write no report at all (a runner that died early). */
  noReport?: boolean;
  stderr?: string;
  /** Called while the run is in flight (before it resolves), e.g. to commit on the branch. */
  during?: (r: RunnerRequest) => void;
}

interface Pending { request: RunnerRequest; release: (s?: RunScript) => void }

export class FakeRunner implements EvidenceRunner {
  readonly calls: RunnerRequest[] = [];
  readonly pending: Pending[] = [];
  /** When true, runs finish at once with `defaultScript`. */
  auto = false;
  defaultScript: RunScript = { verdict: 'PASS' };

  run(r: RunnerRequest): Promise<RunnerOutcome> {
    this.calls.push(r);
    r.onSpawn?.(999_999);
    return new Promise(resolve => {
      const release = (s: RunScript = this.defaultScript): void => {
        const i = this.pending.findIndex(p => p.request === r);
        if (i >= 0) this.pending.splice(i, 1);
        s.during?.(r);
        if (!s.noReport) writeReport(r, s.verdict ?? 'PASS');
        resolve({ exitCode: s.exitCode ?? (s.noReport ? 2 : s.verdict === 'FAIL' ? 1 : 0), stderrTail: s.stderr ?? '' });
      };
      if (this.auto) { queueMicrotask(() => release()); return; }
      this.pending.push({ request: r, release });
    });
  }

  /** Release the oldest run still in flight. */
  finish(s?: RunScript): RunnerRequest {
    const p = this.pending[0];
    if (!p) throw new Error('no run in flight');
    p.release(s);
    return p.request;
  }
}

function writeReport(r: RunnerRequest, verdict: 'PASS' | 'FAIL'): void {
  mkdirSync(join(r.out, 'shots'), { recursive: true });
  const tests: Record<string, { status: string; ms: number; note: string }> = {};
  for (const p of r.platforms) {
    tests[`${p}:setup.install`] = { status: 'PASS', ms: 4000, note: '' };
    tests[`${p}:queries.ask`] = verdict === 'PASS' ? { status: 'PASS', ms: 9000, note: '' } : { status: 'FAIL', ms: 9000, note: 'no reply within 60 s' };
  }
  const pass = Object.values(tests).filter(t => t.status === 'PASS').length;
  const fail = Object.values(tests).length - pass;
  writeFileSync(join(r.out, 'results.json'), JSON.stringify({ run_id: 'run-local-x', verdict, counts: { PASS: pass, ...(fail ? { FAIL: fail } : {}) }, platforms: Object.fromEntries(r.platforms.map(p => [p, { tests }])) }));
  const failures = Object.entries(tests).filter(([, t]) => t.status === 'FAIL').map(([id, t]) => `  ${id.split(':')[0]} ${id.split(':')[1]} FAIL: ${t.note}`);
  writeFileSync(join(r.out, 'summary.txt'), [
    'Iris robot suite (local) run-local-x  slot 1  2026-10-04T00:00:00Z',
    `verdict ${verdict}  tests ${pass} PASS${fail ? `, ${fail} FAIL` : ''}  wall 1m00s`,
    '',
    fail ? `FAILURES (${fail})` : 'FAILURES none',
    ...failures,
    '',
  ].join('\n'));
  writeFileSync(join(r.out, 'index.html'), `<!doctype html><title>report</title><img src="shots/a.png">${verdict}`);
  writeFileSync(join(r.out, 'shots', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
}

export class FakeBuilder implements AppBuilder {
  readonly builds: BuildRequest[] = [];
  /** The commit the checkout was on for each build. */
  readonly heads: string[] = [];
  failNext = false;
  constructor(private readonly headOf: (checkout: string) => string = () => '') {}

  async build(r: BuildRequest): Promise<string> {
    this.builds.push(r);
    this.heads.push(this.headOf(r.checkout));
    if (this.failNext) { this.failNext = false; throw new BuildError(`${r.platform} build failed: Unresolved reference: Foo`, 'e: Unresolved reference: Foo'); }
    mkdirSync(r.out, { recursive: true });
    const file = join(r.out, r.platform === 'android' ? 'Iris.apk' : 'Iris.app');
    if (r.platform === 'android') writeFileSync(file, 'apk');
    else mkdirSync(file, { recursive: true });
    return file;
  }
}

export class FakeStaging implements Staging {
  calls = 0;
  fail = false;
  async ensureUp(): Promise<void> {
    this.calls += 1;
    if (this.fail) throw new Error('staging did not come up within 5 min');
  }
}

/** The evidence bucket, faked: uploads are kept in memory; links are signed with a counter. */
export class FakeStore {
  readonly objects = new Map<string, string>();
  signed = 0;
  failPut = false;
  async put(file: string, key: string): Promise<void> {
    if (this.failPut) throw new Error('fake S3: upload refused (503)');
    const { readFileSync } = await import('node:fs');
    this.objects.set(key, readFileSync(file, 'utf8'));
  }
  async presign(key: string, seconds: number): Promise<string> {
    this.signed += 1;
    return `https://iris-workplace-evidence-000000000000.s3.ap-south-1.amazonaws.com/${key}?X-Amz-Expires=${seconds}&sig=${this.signed}`;
  }
}

/** The staging "in use" lock, faked: every hold and release is recorded. */
export class FakeLock {
  readonly holds: number[] = [];
  releases = 0;
  async hold(untilMs: number): Promise<void> { this.holds.push(untilMs); }
  async release(): Promise<void> { this.releases += 1; }
}

/** `staging.sh deploy` from the evidence checkout, faked: records the commit the checkout was on. */
export class FakeDeployer implements ServerDeployer {
  readonly calls: ServerDeployRequest[] = [];
  /** The commit the checkout was on at each deploy. */
  readonly heads: string[] = [];
  /** How many suite runs had started when each deploy ran (a deploy comes before its run). */
  readonly runsBefore: number[] = [];
  /** When set, the next deploy fails with this message. */
  failNext: string | null = null;
  constructor(private readonly headOf: (checkout: string) => string = () => '', private readonly runsSoFar: () => number = () => 0) {}

  async deploy(r: ServerDeployRequest): Promise<void> {
    this.calls.push(r);
    this.heads.push(this.headOf(r.checkout));
    this.runsBefore.push(this.runsSoFar());
    if (this.failNext) { const why = this.failNext; this.failNext = null; throw new Error(why); }
  }
}
