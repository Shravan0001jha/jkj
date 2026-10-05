import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
}

export interface RunnerOutcome {
  exitCode: number | null;
  signal?: string;
  /** The last lines of the runner's output. */
  stderrTail: string;
  /** Which runner script ran. */
  runner?: string;
}

export interface EvidenceRunner { run(r: RunnerRequest): Promise<RunnerOutcome> }

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
  hold(untilMs: number): Promise<void>;
  release(): Promise<void>;
}

export const STAGING_LOCK_PARAM = '/iris-staging/in-use';

export class RealStagingLock implements StagingLock {
  constructor(private readonly cfg: EvidenceConfig, private readonly region = 'ap-south-1') {}

  private aws(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile('aws', ['--region', this.region, ...args], { timeout: 30_000, env: { ...process.env, AWS_PAGER: '' } }, err => (err ? reject(err) : resolve()));
    });
  }

  async hold(untilMs: number): Promise<void> {
    const until = Math.floor(untilMs / 1000);
    const [, param] = await Promise.allSettled([
      fetch(`${this.cfg.stagingUrl}/v1/min-version?in-use-until=${until}`, { signal: AbortSignal.timeout(10_000) }).then(r => { if (!r.ok) throw new Error(`touch ${r.status}`); }),
      this.aws(['ssm', 'put-parameter', '--name', STAGING_LOCK_PARAM, '--type', 'String', '--overwrite', '--value', String(until)]),
    ]);
    // A staging that is down (queued before the run starts it) or an SSM hiccup is not an error of the run.
    if (param.status === 'rejected') throw new Error(`staging lock not written: ${String(param.reason).split('\n')[0]!.slice(0, 200)}`);
  }

  async release(): Promise<void> {
    await this.aws(['ssm', 'delete-parameter', '--name', STAGING_LOCK_PARAM]).catch(() => undefined);
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
    if (r.apps.android) args.push('--app-android', r.apps.android);
    if (r.apps.ios) args.push('--app-ios', r.apps.ios);
    const env = childEnvFor({ IRIS_API: r.api, ANDROID_HOME: this.cfg.androidHome, DEVELOPER_DIR: this.cfg.developerDir });
    const ran = await runLogged('bash', args, { cwd, env, logFile: r.log, timeoutMs: 100 * 60_000, ...(r.onSpawn ? { onSpawn: r.onSpawn } : {}) });
    return { exitCode: ran.code, ...(ran.signal ? { signal: ran.signal } : {}), stderrTail: ran.tail, runner: script };
  }
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

/** The one line iOS takes its API base from (mobile/ios/Iris/Net/Api.swift); no runtime override exists. */
export const IOS_API_FILE = 'Iris/Net/Api.swift';
export const IOS_API_LINE = 'static let base = "https://api.irisforu.com"';

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
    const hits = original.split(IOS_API_LINE).length - 1;
    if (hits !== 1) throw new BuildError(`ios build refused: expected the line '${IOS_API_LINE}' once in ${IOS_API_FILE}, found it ${hits} times; the staging patch needs updating (COO)`);
    const host = new URL(r.api).host;
    const dd = join(dir, 'build', 'evidence-dd');
    try {
      writeFileSync(apiFile, original.replace(IOS_API_LINE, `static let base = "${r.api}"`));
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
  constructor(private readonly cfg: EvidenceConfig, private readonly timeoutMs = 25 * 60_000) {}

  async deploy(r: ServerDeployRequest): Promise<void> {
    const script = join(r.checkout, 'scripts', 'staging.sh');
    if (!existsSync(script)) throw new Error(`there is no scripts/staging.sh at ${r.sha.slice(0, 8)} to deploy with`);
    // deploy-api.sh and deploy-agent.sh run their tests with ../../.venv first.
    linkUntracked(r.repo, r.checkout);
    const env = childEnvFor({ STAGING_HOST: new URL(this.cfg.stagingUrl).host });
    const ran = await runLogged('bash', [script, 'deploy'], { cwd: r.checkout, env, logFile: r.log, timeoutMs: this.timeoutMs, ...(r.onSpawn ? { onSpawn: r.onSpawn } : {}) });
    if (ran.code !== 0) {
      const lines = ran.tail.split('\n').map(l => l.trim()).filter(Boolean);
      const why = [...lines].reverse().find(l => /❌|error|fail|refus|not running/i.test(l)) ?? lines.at(-1) ?? '';
      throw new Error(`staging.sh deploy ${ran.timedOut ? 'timed out' : `exit ${ran.code ?? ran.signal}`}: ${why.slice(0, 200)}`);
    }
  }
}
