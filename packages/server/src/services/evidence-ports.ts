import { log } from '../util/logger.js';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GitHubPort } from './github-port.js';
import type { EvidenceConfig } from '../config.js';
import { linkUntracked } from './worktrees.js';

/**
 * The three things run_evidence drives on this Mac (docs/LLD-evidence.md §2): the robot runner, the
 * app builder and staging. Interfaces, so the queue and the recording are tested with fakes; the real
 * ones shell out. None of them prints or stores a secret: the runner reads its own secrets
 * (local-secrets.sh) and every child gets an allow-listed environment, never the Workplace's.
 */

export type Platform = 'android' | 'ios';

export interface RunnerRequest {
  /** Android API level of the emulator (local-run.sh --android-api 34|36); absent = the runner's default (34). */
  androidApi?: '34' | '36';
  /** The server-owned Iris checkout at the story's head (the suite lives at e2e/ in it, once moved). */
  checkout: string;
  platforms: Platform[];
  features: string[];
  /** The API base the apps and the runner talk to (staging). */
  api: string;
  /** Built apps by platform: an .apk, an .app. */
  apps: Partial<Record<Platform, string>>;
  slot: number;
  /** A new directory: results.json, index.html, summary.txt land here. */
  out: string;
  /** Where the runner's own output goes (outside `out`, which must start empty). */
  log: string;
  onSpawn?: (pid: number) => void;
  /** The commit under test and where it lives: a runner that builds the apps itself (GitHub) pushes and builds it. */
  sha?: string;
  repo?: string;
  branch?: string;
  /** Unique per run; a GitHub run carries it in its run name. */
  requestId?: string;
}

export interface RunnerOutcome {
  exitCode: number | null;
  signal?: string;
  /** The last lines of the runner's output. */
  stderrTail: string;
  /** Which runner script ran. */
  runner?: string;
}

export interface EvidenceRunner {
  run(r: RunnerRequest): Promise<RunnerOutcome>;
  /** True when the runner builds the commit's apps itself (GitHub): run_evidence then builds nothing here. */
  buildsApps?: boolean;
}

export interface BuildRequest {
  platform: Platform;
  /** The checkout, at the commit to build. */
  checkout: string;
  /** The app's directory inside the checkout (mobile/android, mobile/ios). */
  appDir: string;
  api: string;
  /** Directory for the artifact (created). */
  out: string;
  log: string;
  onSpawn?: (pid: number) => void;
}

export interface AppBuilder {
  /** The built artifact's path inside `out`. Throws BuildError when the app does not build. */
  build(r: BuildRequest): Promise<string>;
}

export interface Staging {
  /** Healthy, or started and then healthy. Never stops it. Throws when it does not come up. */
  ensureUp(): Promise<void>;
}

/** `scripts/staging.sh deploy` from the server-owned checkout at the story's commit. */
export interface ServerDeployRequest {
  /** The Iris repo the checkout belongs to (its .venv is linked in for the deploy's local tests). */
  repo: string;
  /** The checkout, at `sha`. */
  checkout: string;
  sha: string;
  log: string;
  onSpawn?: (pid: number) => void;
}

export interface ServerDeployer {
  /** Deploys the checkout's iris-api and cloud-agent to staging. Throws with the reason when it does not. */
  deploy(r: ServerDeployRequest): Promise<void>;
}

/**
 * Staging "in use" while an evidence run is queued or running (owner, 4 Oct). `hold(until)` touches a
 * successful request (which alone keeps the idle stopper away) carrying the lock's expiry, and writes
 * the expiry to the SSM parameter `/iris-staging/in-use`; `staging.sh stop` refuses while it is fresh
 * and the on-box idle stopper reads the expiry from its access log.
 */
export interface StagingLock {
  /** Before a run starts: take the lock, yielding to a deploy; throws StagingBusyError once the bounded wait is over. */
  acquire?(untilMs: number): Promise<void>;
  /** Whether trunk's staging.sh understands the evidence key + STAGING_DEPLOY_FOR_EVIDENCE (#543). Until it does the legacy key is kept too. */
  setNonceAware?(aware: boolean): Promise<void>;
  /** Runs `fn` (the in-run deploy) with the legacy key released, restoring it in a finally. A no-op wrapper once nonce-aware. */
  aroundLegacyDeploy?<T>(fn: () => Promise<T>): Promise<T>;
  hold(untilMs: number): Promise<void>;
  release(): Promise<void>;
}

/** Two keys, one owner each (CTO, 23 Oct): deploy writes DEPLOY_PARAM (staging.sh), evidence writes EVIDENCE_PARAM (here). */
export const STAGING_LOCK_PARAM = '/iris-staging/in-use-evidence';
export const DEPLOY_LOCK_PARAM = '/iris-staging/in-use-deploy';
/** The pre-split shared key: read-only here, honoured as a live lock for one release (migration). */
export const OLD_LOCK_PARAM = '/iris-staging/in-use';

/** SSM as the lock uses it; injectable so the protocol is tested against an atomic in-memory fake. */
export interface SsmPort {
  get(name: string): Promise<string | null>;
  /** Conditional create (put-parameter WITHOUT --overwrite): false when the parameter exists. */
  putIfAbsent(name: string, value: string): Promise<boolean>;
  put(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export class AwsCliSsm implements SsmPort {
  constructor(private readonly region = 'ap-south-1') {}
  private aws(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('aws', ['--region', this.region, ...args], { timeout: 30_000, env: { ...process.env, AWS_PAGER: '' } }, (err, stdout, stderr) => {
        if (err) { const e = err as Error & { stderr?: string }; e.stderr = String(stderr); reject(e); } else resolve(String(stdout));
      });
    });
  }
  async get(name: string): Promise<string | null> {
    try { return (await this.aws(['ssm', 'get-parameter', '--name', name, '--query', 'Parameter.Value', '--output', 'text'])).trim(); }
    catch (err) { if (/ParameterNotFound/.test(String((err as { stderr?: string }).stderr ?? err))) return null; throw err; }
  }
  async putIfAbsent(name: string, value: string): Promise<boolean> {
    try { await this.aws(['ssm', 'put-parameter', '--name', name, '--type', 'String', '--value', value]); return true; }
    catch (err) { if (/ParameterAlreadyExists/.test(String((err as { stderr?: string }).stderr ?? err))) return false; throw err; }
  }
  async put(name: string, value: string): Promise<void> { await this.aws(['ssm', 'put-parameter', '--name', name, '--type', 'String', '--overwrite', '--value', value]); }
  async delete(name: string): Promise<void> {
    try { await this.aws(['ssm', 'delete-parameter', '--name', name]); }
    catch (err) { if (!/ParameterNotFound/.test(String((err as { stderr?: string }).stderr ?? err))) throw err; }
  }
}

/** Staging is held by something that wins over evidence at acquire, or the wait bound was reached. The run is deferred, not failed for its code. */
export class StagingBusyError extends Error {
  constructor(readonly holder: 'deploy' | 'evidence' | 'old', message?: string) {
    super(message ?? (holder === 'deploy' || holder === 'old' ? 'staging busy (deploy), run deferred' : 'staging busy (another evidence run), run deferred'));
    this.name = 'StagingBusyError';
  }
}

/** Backoff bound: 6 tries, jittered ~30-90 s apart (about 6 minutes of waiting, 10 at the outside). */
export interface LockBounds { tries: number; baseMs: number; jitterMs: number; sleep: (ms: number) => Promise<void>; now: () => number }
export const DEFAULT_LOCK_BOUNDS: LockBounds = { tries: 6, baseMs: 30_000, jitterMs: 60_000, sleep: ms => new Promise(r => setTimeout(r, ms)), now: () => Date.now() };

/**
 * Value format of the evidence key: `p:<epoch s>:<nonce>` when created (provisional, before the other keys are checked),
 * `<epoch s>:<nonce>` once the check passed and the run starts (established); refresh rewrites `<new epoch>:<same nonce>`.
 * The nonce (16 hex chars, random, once per run) identifies the holder to the in-run deploy. Deploy and legacy keys stay
 * bare epochs. Anything matching none of the shapes reads as established (fail-safe toward waiting).
 */
export const PROVISIONAL_PREFIX = 'p:';
export const newNonce = (): string => randomBytes(8).toString('hex');

/** Expiry epoch (s) of a lock value if still live; unparseable counts as live (established). 0 = free or expired. */
const liveEpoch = (v: string | null, nowMs: number): number => {
  if (v === null) return 0;
  const m = /^(?:p:)?(\d+)(?::[0-9a-f]+)?$/.exec(v.trim());
  if (!m) return Number.MAX_SAFE_INTEGER;
  const n = Number(m[1]);
  return n * 1000 > nowMs ? n : 0;
};

export class RealStagingLock implements StagingLock {
  private held = false;
  private nonce = '';
  /**
   * MIGRATION: until trunk staging.sh knows the evidence key (it greps for STAGING_DEPLOY_FOR_EVIDENCE), an old staging.sh
   * (batch timer, by hand) only reads the legacy key. Dropping it would show staging FREE mid-run and let a deploy replace
   * the code under a live suite, and `stop` would stop refusing. So we also hold the legacy key (bare epoch, same expiry) and
   * release it only around our own in-run deploy, which that old script would otherwise wait on forever.
   */
  private legacy = true;
  private legacyOn = false;
  private paused = false;
  private lastUntil = 0;
  private inflight: Promise<void> | null = null;
  constructor(
    private readonly cfg: EvidenceConfig,
    private readonly region = 'ap-south-1',
    private readonly ssm: SsmPort = new AwsCliSsm(region),
    private readonly bounds: LockBounds = DEFAULT_LOCK_BOUNDS,
  ) {}

  /** The latest expiry (epoch s) across all three keys, 0 when none is live: "is staging in use at all". */
  async latestExpiry(): Promise<number> {
    const now = this.bounds.now();
    const vals = await Promise.all([STAGING_LOCK_PARAM, DEPLOY_LOCK_PARAM, OLD_LOCK_PARAM].map(k => this.ssm.get(k)));
    return Math.max(...vals.map(v => liveEpoch(v, now)));
  }

  /** One attempt: create own key, then look at the deploy and old keys; yield (delete own) to either. */
  private async tryOnce(until: number): Promise<void> {
    const now = this.bounds.now();
    const nonce = this.held ? this.nonce : newNonce();
    const prov = `${PROVISIONAL_PREFIX}${until}:${nonce}`;
    if (!(await this.ssm.putIfAbsent(STAGING_LOCK_PARAM, prov))) {
      const cur = await this.ssm.get(STAGING_LOCK_PARAM);
      if (cur !== null && liveEpoch(cur, now)) throw new StagingBusyError('evidence');
      // Expired (a crashed run): reclaim by delete + conditional create, so two reclaimers still resolve to one.
      if (cur !== null) await this.ssm.delete(STAGING_LOCK_PARAM);
      if (!(await this.ssm.putIfAbsent(STAGING_LOCK_PARAM, prov))) throw new StagingBusyError('evidence');
    }
    const [d, o] = await Promise.all([this.ssm.get(DEPLOY_LOCK_PARAM), this.ssm.get(OLD_LOCK_PARAM)]);
    const holder = liveEpoch(d, now) ? 'deploy' : liveEpoch(o, now) ? 'old' : null;
    if (holder) { await this.ssm.delete(STAGING_LOCK_PARAM).catch(() => undefined); throw new StagingBusyError(holder); }
    // Nobody else holds staging: confirm (extend to the full TTL). From here on this run is established and never yields.
    // ORDER MATTERS: promote p:<epoch> -> bare <epoch> and read it back BEFORE the run starts any work (acquire() resolves
    // only after this). Starting first would advertise a live suite as provisional, and a deploy may legitimately stomp a
    // provisional hold. A failed or mis-read promotion deletes our key and the run does not start.
    const bare = `${until}:${nonce}`;
    try {
      await this.ssm.put(STAGING_LOCK_PARAM, bare);
      const back = await this.ssm.get(STAGING_LOCK_PARAM);
      if (back !== bare) throw new Error(`read back ${back === null ? 'nothing' : JSON.stringify(back)}`);
    } catch (err) {
      await this.ssm.delete(STAGING_LOCK_PARAM).catch(() => undefined);
      throw new Error(`staging lock not confirmed, run not started: ${String(err).split('\n')[0]!.slice(0, 200)}`);
    }
    this.nonce = nonce;
    this.held = true;
    this.lastUntil = until;
    await this.writeLegacy(until);
  }

  private async writeLegacy(until: number): Promise<void> {
    if (!this.legacy || this.paused) return;
    await this.ssm.put(OLD_LOCK_PARAM, String(until));
    this.legacyOn = true;
  }

  async setNonceAware(aware: boolean): Promise<void> {
    this.legacy = !aware;
    if (aware && this.legacyOn && !this.paused) { this.legacyOn = false; await this.ssm.delete(OLD_LOCK_PARAM).catch(() => undefined); }
  }

  async aroundLegacyDeploy<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.legacy || !this.legacyOn) return fn();
    this.paused = true; this.legacyOn = false;
    await this.ssm.delete(OLD_LOCK_PARAM);
    try { return await fn(); }
    finally {
      this.paused = false;
      if (this.held && this.legacy) await this.writeLegacy(this.lastUntil).catch(() => undefined);
    }
  }

  /**
   * Acquire (the only place evidence yields): bounded retries with jitter; then StagingBusyError.
   * Already held by this process: just extends. Concurrent callers share one attempt.
   */
  acquire(untilMs: number): Promise<void> {
    if (this.held) return this.refresh(untilMs);
    if (!this.inflight) {
      this.inflight = (async () => {
        const until = Math.floor(untilMs / 1000);
        let last: StagingBusyError | undefined;
        for (let i = 0; i < this.bounds.tries; i++) {
          try { await this.tryOnce(until); return; }
          catch (err) { if (!(err instanceof StagingBusyError)) throw err; last = err; }
          if (i < this.bounds.tries - 1) await this.bounds.sleep(this.bounds.baseMs + Math.random() * this.bounds.jitterMs);
        }
        throw new StagingBusyError(last?.holder ?? 'deploy', `${last?.message ?? 'staging busy (deploy), run deferred'} (gave up after ${this.bounds.tries} tries)`);
      })().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  /** Refresh NEVER yields: it only extends our own key, whatever the deploy key says (evidence beats deploy once running). */
  private async refresh(untilMs: number): Promise<void> {
    const until = Math.floor(untilMs / 1000);
    await this.ssm.put(STAGING_LOCK_PARAM, `${until}:${this.nonce}`);
    this.lastUntil = until;
    await this.writeLegacy(until);
  }

  async hold(untilMs: number): Promise<void> {
    const until = Math.floor(untilMs / 1000);
    const [, param] = await Promise.allSettled([
      fetch(`${this.cfg.stagingUrl}/v1/min-version?in-use-until=${until}`, { signal: AbortSignal.timeout(10_000) }).then(r => { if (!r.ok) throw new Error(`touch ${r.status}`); }),
      this.held ? this.refresh(untilMs) : this.inflight ? Promise.resolve() : this.tryOnce(until),
    ]);
    // A staging that is down (queued before the run starts it) or an SSM hiccup is not an error of the run.
    if (param.status === 'rejected') {
      if (param.reason instanceof StagingBusyError) throw param.reason;
      throw new Error(`staging lock not written: ${String(param.reason).split('\n')[0]!.slice(0, 200)}`);
    }
  }

  /** The run's nonce while the evidence key is held (for the in-run deploy), else null. */
  currentNonce(): string | null { return this.held ? this.nonce : null; }

  async release(): Promise<void> {
    this.held = false;
    await this.ssm.delete(STAGING_LOCK_PARAM).catch(() => undefined);
    if (this.legacyOn) { this.legacyOn = false; await this.ssm.delete(OLD_LOCK_PARAM).catch(() => undefined); }
  }
}

export class BuildError extends Error {
  constructor(message: string, readonly logTail = '') { super(message); this.name = 'BuildError'; }
}

/** Bumped when the builder changes what it produces: part of every build cache key. */
export const BUILDER_VERSION = 'b1';

/* ---------- running a command: its own process group, logged, bounded ---------- */

/** What a child gets from the Workplace's environment: what a shell on this Mac needs, no tokens. */
const ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TERM',
  'AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'JAVA_HOME'];

/** Does this checkout's scripts/staging.sh know the evidence key (#543)? */
export function stagingKnowsEvidenceKey(checkout: string): boolean {
  try { return readFileSync(join(checkout, 'scripts', 'staging.sh'), 'utf8').includes('STAGING_DEPLOY_FOR_EVIDENCE'); } catch { return false; }
}

export function childEnvFor(extra: Record<string, string>, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_ALLOW) if (env[k]) out[k] = env[k]!;
  const path = (out['PATH'] ?? '/usr/bin:/bin:/usr/sbin:/sbin').split(':');
  for (const p of ['/usr/local/bin', '/opt/homebrew/bin']) if (!path.includes(p)) path.unshift(p);
  out['PATH'] = path.join(':');
  return { ...out, ...extra };
}

export interface Ran { code: number | null; signal: string | null; tail: string; timedOut: boolean }

/** The last `n` non-empty lines of a log file. */
export function tailOf(file: string, n = 30): string {
  try {
    const size = statSync(file).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
    return buf.toString('utf8').split('\n').filter(l => l.trim()).slice(-n).join('\n');
  } catch { return ''; }
}

/**
 * Run `cmd args` in its own process group (so a timeout or a shutdown stops everything it started),
 * stdout and stderr appended to `logFile`. Resolves with the exit; never rejects.
 */
export function runLogged(cmd: string, args: string[], o: { cwd: string; env: Record<string, string>; logFile: string; timeoutMs: number; onSpawn?: (pid: number) => void }): Promise<Ran> {
  mkdirSync(dirname(o.logFile), { recursive: true });
  appendFileSync(o.logFile, `\n$ ${[cmd, ...args].join(' ')}   (in ${o.cwd})\n`);
  const fd = openSync(o.logFile, 'a');
  return new Promise(resolve => {
    let timedOut = false;
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, detached: true, stdio: ['ignore', fd, fd] });
    if (child.pid) o.onSpawn?.(child.pid);
    const killGroup = (sig: NodeJS.Signals): void => { try { if (child.pid) process.kill(-child.pid, sig); } catch { /* gone */ } };
    const timer = setTimeout(() => {
      timedOut = true;
      appendFileSync(o.logFile, `\n[workplace] stopped after ${Math.round(o.timeoutMs / 60_000)} min\n`);
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 20_000).unref();
    }, o.timeoutMs);
    timer.unref();
    let settled = false;
    const done = (code: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { closeSync(fd); } catch { /* closed */ }
      resolve({ code, signal, tail: tailOf(o.logFile), timedOut });
    };
    child.on('error', err => { appendFileSync(o.logFile, `[workplace] ${err.message}\n`); done(127, null); });
    child.on('close', (code, signal) => done(code, signal));
  });
}

/**
 * Stop a process group we started (a run or a build) if that pid is still one of ours: its command
 * line must contain `marker` (a path only our runs use), so a recycled pid is never touched.
 */
export function killGroupIfOurs(pid: number | undefined, marker: string): boolean {
  if (!pid || pid <= 1) return false;
  try { process.kill(pid, 0); } catch { return false; }
  let command = '';
  try { command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }); } catch { return false; }
  if (!command.includes(marker)) return false;
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { return false; } }
  return true;
}

/* ---------- the real runner ---------- */

export class RealRunner implements EvidenceRunner {
  constructor(private readonly cfg: EvidenceConfig) {}

  /** The runner for this checkout: its own e2e/ (with its dependencies), else the configured clone. */
  private async resolve(checkout: string, log: string): Promise<{ script: string; cwd: string }> {
    const inRepo = join(checkout, this.cfg.runnerInRepo);
    if (existsSync(inRepo)) {
      const e2e = dirname(dirname(inRepo));
      await ensureNodeDeps(e2e, log);
      return { script: inRepo, cwd: e2e };
    }
    if (existsSync(this.cfg.runnerFallback)) return { script: this.cfg.runnerFallback, cwd: dirname(dirname(this.cfg.runnerFallback)) };
    throw new Error(`no robot runner: ${this.cfg.runnerInRepo} is not in this commit and ${this.cfg.runnerFallback} does not exist`);
  }

  async run(r: RunnerRequest): Promise<RunnerOutcome> {
    const { script, cwd } = await this.resolve(r.checkout, r.log);
    const args = [script, '--platforms', r.platforms.join(','), '--features', r.features.join(','), '--api', r.api, '--slot', String(r.slot), '--out', r.out];
    if (r.androidApi) args.push('--android-api', r.androidApi);
    if (r.apps.android) args.push('--app-android', r.apps.android);
    if (r.apps.ios) args.push('--app-ios', r.apps.ios);
    const env = childEnvFor({ IRIS_API: r.api, ANDROID_HOME: this.cfg.androidHome, DEVELOPER_DIR: this.cfg.developerDir });
    const ran = await runLogged('bash', args, { cwd, env, logFile: r.log, timeoutMs: 100 * 60_000, ...(r.onSpawn ? { onSpawn: r.onSpawn } : {}) });
    return { exitCode: ran.code, ...(ran.signal ? { signal: ran.signal } : {}), stderrTail: ran.tail, runner: script };
  }
}

/* ---------- the GitHub runner (cloud migration, 17 Oct) ---------- */

export const SUITE_WORKFLOW = 'suite.yml';
export const SUITE_REPORT = 'suite-report';

/**
 * The robot suite on GitHub Actions, for a machine with no simulators or emulators (the Linux
 * server): push the story's branch, dispatch iris-e2e's suite.yml to build that commit and run it
 * against staging, follow the run, and unpack its report into `out` where the local runner would
 * have written results.json and summary.txt. Exit 0 pass, 1 fail, 2 plumbing (no report), as
 * local-run.sh; it never throws.
 */
export class GitHubRunner implements EvidenceRunner {
  readonly buildsApps = true;
  constructor(private readonly port: () => GitHubPort, private readonly timing: { pollMs: number; timeoutMs: number } = { pollMs: 30_000, timeoutMs: 120 * 60_000 }) {}

  private declared: { at: number; names: string[] } | null = null;
  private lastGood: string[] | null = null;

  /** `optional` filtered to the inputs suite.yml declares: fetched (cached 5 min), else the last good list, else none (warned). */
  private async onlyDeclared(gh: GitHubPort, optional: Record<string, string>, say: (line: string) => void): Promise<Record<string, string>> {
    let names: string[] | null = null;
    if (this.declared && Date.now() - this.declared.at < 5 * 60_000) names = this.declared.names;
    else {
      try {
        if (!gh.workflowInputs) throw new Error('the GitHub port cannot read workflow inputs');
        names = await gh.workflowInputs(SUITE_WORKFLOW);
        this.declared = { at: Date.now(), names };
        this.lastGood = names;
      } catch (err) {
        names = this.lastGood;
        const why = `could not read ${SUITE_WORKFLOW}'s declared inputs (${errLine(err)}); ${names ? 'using the last known list' : 'sending without optional inputs'}`;
        log.warn('evidence', why);
        say(why);
      }
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(optional)) {
      if (names?.includes(k)) out[k] = v; else say(`${SUITE_WORKFLOW} does not declare ${k}; not sending it`);
    }
    return out;
  }

  async run(r: RunnerRequest): Promise<RunnerOutcome> {
    const say = (line: string): void => { try { mkdirSync(dirname(r.log), { recursive: true }); appendFileSync(r.log, `[github] ${line}\n`); } catch { /* best effort */ } };
    const plumbing = (why: string): RunnerOutcome => { say(why); return { exitCode: 2, stderrTail: why, runner: `github:${SUITE_WORKFLOW}` }; };
    if (!r.sha || !r.repo || !r.branch) return plumbing('the GitHub runner needs the commit, its repo and branch');
    const gh = this.port();
    try { await gh.push(r.repo, r.branch); } catch (err) { return plumbing(`could not push ${r.branch} to GitHub: ${errLine(err)}`); }
    const requestId = r.requestId ?? `ev-${Date.now()}`;
    const optional: Record<string, string> = {};
    // iris-e2e refuses macOS platforms unless release_gate is true; evidence.request only lets release-gate stories ask for ios.
    if (r.platforms.includes('ios')) optional['release_gate'] = 'true';
    const inputs = { iris_ref: r.sha, build_ref: r.sha, platforms: r.platforms.join(','), features: r.features.join(','), target: 'staging', account_mode: 'new', windows_default_smoke: 'false', request_id: requestId,
      // GitHub rejects the whole dispatch (422) for any input the workflow doesn't declare, so an optional one is sent only if suite.yml declares it.
      ...(Object.keys(optional).length ? await this.onlyDeclared(gh, optional, say) : {}) };
    try { await gh.dispatchWorkflow(SUITE_WORKFLOW, inputs); } catch (err) { return plumbing(`could not start ${SUITE_WORKFLOW} on GitHub: ${errLine(err)}`); }
    say(`dispatched ${SUITE_WORKFLOW} for ${r.sha.slice(0, 8)} (${requestId})`);
    const end = Date.now() + this.timing.timeoutMs;
    let run = null as Awaited<ReturnType<GitHubPort['findWorkflowRun']>>;
    for (;;) {
      try { run = await gh.findWorkflowRun(SUITE_WORKFLOW, requestId); } catch (err) { say(`polling: ${errLine(err)}`); }
      if (run?.status === 'completed') break;
      if (Date.now() > end) return plumbing(`${SUITE_WORKFLOW} did not finish within ${Math.round(this.timing.timeoutMs / 60_000)} min${run ? `: ${run.url}` : ''}`);
      await new Promise(res => setTimeout(res, this.timing.pollMs));
    }
    say(`${run.url} finished: ${run.conclusion ?? '?'}`);
    try {
      const art = (await gh.listArtifacts(run.id)).find(a => a.name === SUITE_REPORT || a.name.startsWith(`${SUITE_REPORT}-`));
      if (!art) return plumbing(`${run.url} ended ${run.conclusion ?? '?'} with no ${SUITE_REPORT} artifact`);
      mkdirSync(r.out, { recursive: true });
      await gh.downloadArtifact(art.id, r.out);
      resultsFromMatrix(r.out);
      hoistReport(r.out);
      if (!existsSync(join(r.out, 'results.json'))) return plumbing(`${run.url}: the report has no results.json`);
      if (!existsSync(join(r.out, 'summary.txt'))) writeFileSync(join(r.out, 'summary.txt'), summaryFromResults(readFileSync(join(r.out, 'results.json'), 'utf8')));
    } catch (err) {
      return plumbing(`${run.url}: the report could not be fetched: ${errLine(err)}`);
    }
    return { exitCode: run.conclusion === 'success' ? 0 : 1, stderrTail: `GitHub run ${run.url}: ${run.conclusion ?? '?'}`, runner: `github:${SUITE_WORKFLOW}` };
  }
}

const errLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200);

type TestRow = { status?: string; note?: string; ms?: number };

/**
 * iris-e2e's suite-report has no top-level results.json: its verdict lives in matrix.json
 * (`tests.<platform>.<id> = { status, note }`, gathered from every results-<platform> artifact),
 * and the only results.json in it is plan/results.json (account setup rows, no verdict, no counts).
 * Hoisting that one made a green iOS run read as 0 passed / 0 failed / "the suite did not pass"
 * (as_mvcgh9l1mtujs, 17 Oct, run 39043490750). Write results.json as local-run.sh does, from the
 * matrix: PASS only when some platform test ran and none failed or was blocked; a failed account
 * setup row (plan) counts as a failure too.
 */
export function resultsFromMatrix(out: string): void {
  const matrixFile = join(out, 'matrix.json');
  if (existsSync(join(out, 'results.json')) || !existsSync(matrixFile)) return;
  let matrix: { tests?: Record<string, Record<string, TestRow>> } = {};
  try { matrix = JSON.parse(readFileSync(matrixFile, 'utf8')) as typeof matrix; } catch { return; }
  const platforms: Record<string, { tests: Record<string, TestRow> }> = {};
  for (const [p, tests] of Object.entries(matrix.tests ?? {})) {
    platforms[p] = { tests: Object.fromEntries(Object.entries(tests ?? {}).map(([id, t]) => [id, { status: t.status, note: t.note, ms: t.ms }])) };
  }
  const ran = Object.values(platforms).reduce((n, v) => n + Object.keys(v.tests).length, 0);
  const planFile = join(out, 'plan', 'results.json');
  if (existsSync(planFile)) {
    try {
      const plan = JSON.parse(readFileSync(planFile, 'utf8')) as Record<string, TestRow>;
      const bad = Object.entries(plan).filter(([, t]) => t?.status === 'FAIL' || t?.status === 'BLOCKED');
      if (bad.length) platforms['plan'] = { tests: Object.fromEntries(bad.map(([id, t]) => [id, { status: t.status, note: t.note, ms: t.ms }])) };
    } catch { /* unreadable plan rows: the platform rows still decide */ }
  }
  const counts: Record<string, number> = {};
  for (const v of Object.values(platforms)) for (const t of Object.values(v.tests)) { const st = t.status ?? '?'; counts[st] = (counts[st] ?? 0) + 1; }
  const verdict = ran > 0 && !counts['FAIL'] && !counts['BLOCKED'] ? 'PASS' : 'FAIL';
  writeFileSync(join(out, 'results.json'), JSON.stringify({ source: 'matrix.json', verdict, counts, platforms }, null, 1));
}

/** An artifact may wrap the report in one directory: move its contents up to `out`. */
function hoistReport(out: string): void {
  if (existsSync(join(out, 'results.json'))) return;
  const dirs = readdirSync(out, { withFileTypes: true }).filter(e => e.isDirectory());
  const inner = dirs.find(d => existsSync(join(out, d.name, 'results.json')));
  if (!inner) return;
  const from = join(out, inner.name);
  for (const e of readdirSync(from)) renameSync(join(from, e), join(out, e));
  rmSync(from, { recursive: true, force: true });
}

/** summary.txt as local-run.sh writes it, from results.json (platforms.<p>.tests.<id> = { status, note }). */
export function summaryFromResults(json: string): string {
  let res: { verdict?: string; platforms?: Record<string, { tests?: Record<string, { status?: string; note?: string }> }> } = {};
  try { res = JSON.parse(json) as typeof res; } catch { /* unreadable */ }
  const failures: string[] = [];
  for (const [p, v] of Object.entries(res.platforms ?? {})) {
    for (const [id, t] of Object.entries(v.tests ?? {})) if (t.status === 'FAIL' || t.status === 'BLOCKED') failures.push(`  ${p} ${id} ${t.status}: ${t.note ?? ''}`.trimEnd());
  }
  return [`Iris robot suite (GitHub) verdict ${res.verdict ?? '?'}`, '', failures.length ? `FAILURES (${failures.length})` : 'FAILURES none', ...failures, ''].join('\n');
}

/** `npm ci` in the suite's directory when its lockfile changed since the last install there. */
async function ensureNodeDeps(dir: string, log: string): Promise<void> {
  const lock = join(dir, 'package-lock.json');
  if (!existsSync(lock)) return;
  const want = createHash('sha256').update(readFileSync(lock)).digest('hex');
  const marker = join(dir, 'node_modules', '.workplace-lock');
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === want) return;
  const ran = await runLogged('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, env: childEnvFor({ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }), logFile: log, timeoutMs: 10 * 60_000 });
  if (ran.code !== 0) throw new Error(`npm ci in ${dir} failed (exit ${ran.code})`);
  writeFileSync(marker, `${want}\n`);
}

/* ---------- the real builder ---------- */

/** Where iOS takes its API base from (mobile/ios/Iris/Net/Api.swift). */
export const IOS_API_FILE = 'Iris/Net/Api.swift';
export const IOS_API_LINE = 'static let base = "https://api.irisforu.com"';
/** Since 7 Oct (as_muxogbal9wcrd) the prod default is resolveBase's fallback return, with a DEBUG-only env override. */
export const IOS_API_RETURN = 'return "https://api.irisforu.com"';

/** Api.swift with its prod API base pointed at `api`; both the old and the resolveBase form, exactly one hit required. */
export function patchIosApi(original: string, api: string): string {
  const count = (needle: string): number => original.split(needle).length - 1;
  const oldHits = count(IOS_API_LINE), newHits = count(IOS_API_RETURN);
  if (oldHits === 1 && newHits === 0) return original.replace(IOS_API_LINE, `static let base = "${api}"`);
  if (newHits === 1 && oldHits === 0) return original.replace(IOS_API_RETURN, `return "${api}"`);
  throw new BuildError(`ios build refused: expected exactly one prod API base in ${IOS_API_FILE} ('${IOS_API_LINE}' or '${IOS_API_RETURN}'), found ${oldHits} and ${newHits}; the staging patch needs updating (COO)`);
}

export class RealBuilder implements AppBuilder {
  constructor(private readonly cfg: EvidenceConfig) {}

  async build(r: BuildRequest): Promise<string> {
    mkdirSync(r.out, { recursive: true });
    return r.platform === 'android' ? this.android(r) : this.ios(r);
  }

  private async step(r: BuildRequest, what: string, cmd: string, args: string[], cwd: string, env: Record<string, string>, minutes = 30): Promise<void> {
    const ran = await runLogged(cmd, args, { cwd, env, logFile: r.log, timeoutMs: minutes * 60_000, ...(r.onSpawn ? { onSpawn: r.onSpawn } : {}) });
    if (ran.code !== 0) {
      const first = ran.tail.split('\n').find(l => /error|FAILED|What went wrong|fatal/i.test(l)) ?? ran.tail.split('\n').at(-1) ?? '';
      throw new BuildError(`${r.platform} build failed (${what}${ran.timedOut ? ', timed out' : `, exit ${ran.code}`}): ${first.trim().slice(0, 200)}`, ran.tail);
    }
  }

  /** Debug APK with gradle; API_URL overridden by an init script outside the repo, then verified. */
  private async android(r: BuildRequest): Promise<string> {
    const dir = join(r.checkout, r.appDir);
    if (!existsSync(join(dir, 'gradlew'))) throw new BuildError(`android build failed: no gradlew in ${r.appDir}`);
    const props = join(dir, 'local.properties');
    if (!existsSync(props)) writeFileSync(props, `sdk.dir=${this.cfg.androidHome}\n`);
    const init = join(r.out, 'staging-api.init.gradle');
    writeFileSync(init, [
      '// Written by the Iris Workplace (run_evidence): the debug app talks to staging, not production.',
      'allprojects {',
      '  afterEvaluate { p ->',
      "    if (p.plugins.hasPlugin('com.android.application')) {",
      `      p.android.defaultConfig.buildConfigField('String', 'API_URL', '"${r.api}"')`,
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'));
    const env = childEnvFor({ ANDROID_HOME: this.cfg.androidHome, ANDROID_SDK_ROOT: this.cfg.androidHome });
    await this.step(r, 'gradle assembleDebug', './gradlew', ['--no-daemon', '-q', '-I', init, ':app:assembleDebug'], dir, env, 40);
    const gen = join(dir, 'app', 'build', 'generated', 'source', 'buildConfig', 'debug');
    const config = findFile(gen, 'BuildConfig.java');
    if (!config || !readFileSync(config, 'utf8').includes(`"${r.api}"`)) {
      throw new BuildError('android build refused: the built app does not point at staging (BuildConfig.API_URL); nothing was run against production');
    }
    const apk = join(dir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
    if (!existsSync(apk)) throw new BuildError('android build failed: no app-debug.apk');
    const out = join(r.out, 'Iris.apk');
    cpSync(apk, out);
    return out;
  }

  /** Simulator app with full Xcode; the API line patched in the server-owned checkout and restored after. */
  private async ios(r: BuildRequest): Promise<string> {
    const dir = join(r.checkout, r.appDir);
    const apiFile = join(dir, IOS_API_FILE);
    if (!existsSync(apiFile)) throw new BuildError(`ios build failed: no ${r.appDir}/${IOS_API_FILE}`);
    const env = childEnvFor({ DEVELOPER_DIR: this.cfg.developerDir });
    const original = readFileSync(apiFile, 'utf8');
    const patched = patchIosApi(original, r.api);
    const host = new URL(r.api).host;
    const dd = join(dir, 'build', 'evidence-dd');
    try {
      writeFileSync(apiFile, patched);
      if (existsSync(join(dir, 'project.yml'))) await this.step(r, 'xcodegen', 'xcodegen', ['generate', '--spec', 'project.yml'], dir, env, 5);
      await this.step(r, 'xcodebuild', 'xcodebuild', ['-project', 'Iris.xcodeproj', '-scheme', 'Iris', '-configuration', 'Debug', '-sdk', 'iphonesimulator',
        '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', dd, 'build'], dir, env, 40);
    } finally {
      writeFileSync(apiFile, original);
    }
    const app = join(dd, 'Build', 'Products', 'Debug-iphonesimulator', 'Iris.app');
    if (!existsSync(app)) throw new BuildError('ios build failed: no Iris.app in the build products');
    if (!readdirSync(app).some(f => { const p = join(app, f); try { return statSync(p).isFile() && readFileSync(p).includes(host); } catch { return false; } })) {
      throw new BuildError('ios build refused: the built app does not point at staging; nothing was run against production');
    }
    const out = join(r.out, 'Iris.app');
    rmSync(out, { recursive: true, force: true });
    execFileSync('ditto', [app, out]);
    return out;
  }
}

function findFile(dir: string, name: string): string | null {
  if (!existsSync(dir)) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; } else if (e.name === name) return p;
  }
  return null;
}

/* ---------- real staging ---------- */

export class RealStaging implements Staging {
  private inFlight: Promise<void> | null = null;
  constructor(private readonly cfg: EvidenceConfig, private readonly logFile: string, private readonly nameWaitMs = 20 * 60_000, private readonly restartEveryMs = 3 * 60_000, private readonly pollMs = 15_000) {}

  private async healthy(): Promise<boolean> {
    try { return (await fetch(`${this.cfg.stagingUrl}/healthz`, { signal: AbortSignal.timeout(5000) })).ok; } catch { return false; }
  }

  ensureUp(): Promise<void> {
    this.inFlight ??= this.up().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async up(): Promise<void> {
    if (await this.healthy()) return;
    if (!existsSync(this.cfg.stagingScript)) throw new Error(`staging is down and ${this.cfg.stagingScript} does not exist`);
    // `start` is idempotent: it starts the box if stopped, fixes DNS, and waits for https health.
    // staging.sh checks health by IP. By name it can still fail for a while: the A record is deleted at
    // every stop, so resolvers that asked meanwhile cache NXDOMAIN for the zone's negative TTL (900 s),
    // and a stop by someone else in the meantime deletes the record again (4 Oct gate). The apps and
    // the runner need the name, so: `start` (idempotent: it starts the box and rewrites the record),
    // poll by name, and run `start` again every few minutes until the deadline.
    const until = Date.now() + this.nameWaitMs;
    let ran = { code: null as number | null, timedOut: false };
    while (Date.now() < until) {
      ran = await runLogged('bash', [this.cfg.stagingScript, 'start'], { cwd: dirname(this.cfg.stagingScript), env: childEnvFor({}), logFile: this.logFile, timeoutMs: 12 * 60_000 });
      const next = Math.min(until, Date.now() + this.restartEveryMs);
      while (Date.now() < next) {
        if (await this.healthy()) return;
        await new Promise(res => setTimeout(res, this.pollMs));
      }
    }
    throw new Error(`staging did not answer by name within ${Math.round(this.nameWaitMs / 60_000)} min (last staging.sh start exit ${ran.code}${ran.timedOut ? ', timed out' : ''}; see ${this.logFile})`);
  }
}

/* ---------- the story's server code on staging ---------- */

/**
 * `bash <checkout>/scripts/staging.sh deploy`: the checkout's own deploy scripts push its iris-api and
 * cloud-agent to staging (staging.sh exports STAGING_HOST, the one switch deploy-api.sh and
 * deploy-agent.sh have for a non-production target, via scripts/deploy-target.sh; it is also set
 * here). Staging must already be up (ensureUp). Allow-listed environment, so no Workplace token
 * reaches it.
 */
export class RealServerDeployer implements ServerDeployer {
  /**
   * `evidenceKeyValue` gives the nonce of the in-use-evidence value while this process holds it. The deploy runs INSIDE
   * the evidence run, whose own established key would otherwise make staging.sh wait forever: the nonce (only) is passed as
   * STAGING_DEPLOY_FOR_EVIDENCE and staging.sh skips waiting on the evidence key only when its nonce matches.
   */
  constructor(private readonly cfg: EvidenceConfig, private readonly timeoutMs = 25 * 60_000, private readonly evidenceKeyValue: () => Promise<string | null> = async () => null, private readonly around?: <T>(fn: () => Promise<T>) => Promise<T>) {}

  async deploy(r: ServerDeployRequest): Promise<void> {
    const script = join(r.checkout, 'scripts', 'staging.sh');
    if (!existsSync(script)) throw new Error(`there is no scripts/staging.sh at ${r.sha.slice(0, 8)} to deploy with`);
    // deploy-api.sh and deploy-agent.sh run their tests with ../../.venv first.
    linkUntracked(r.repo, r.checkout);
    const held = await this.evidenceKeyValue().catch(() => null);
    const env = childEnvFor({ STAGING_HOST: new URL(this.cfg.stagingUrl).host, ...(held ? { STAGING_DEPLOY_FOR_EVIDENCE: held } : {}) });
    // Until the checkout's staging.sh knows STAGING_DEPLOY_FOR_EVIDENCE, release the legacy key around the deploy (see RealStagingLock).
    const aware = stagingKnowsEvidenceKey(r.checkout);
    const run = (): ReturnType<typeof runLogged> => runLogged('bash', [script, 'deploy'], { cwd: r.checkout, env, logFile: r.log, timeoutMs: this.timeoutMs, ...(r.onSpawn ? { onSpawn: r.onSpawn } : {}) });
    const ran = aware || !this.around ? await run() : await this.around(run);
    if (ran.code !== 0) {
      const lines = ran.tail.split('\n').map(l => l.trim()).filter(Boolean);
      const why = [...lines].reverse().find(l => /❌|error|fail|refus|not running/i.test(l)) ?? lines.at(-1) ?? '';
      throw new Error(`staging.sh deploy ${ran.timedOut ? 'timed out' : `exit ${ran.code ?? ran.signal}`}: ${why.slice(0, 200)}`);
    }
  }
}
