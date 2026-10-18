import { BadRequest } from '../util/errors.js';
import * as spendCaps from './spend-caps.js';
import { execFileSync } from 'node:child_process';
import { macHost, NO_MAC_REFUSAL } from './mac-host.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { EvidenceRunRecord, EvidenceServer, EvidenceState, StagingServerState, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import type { AppBuilder, EvidenceRunner, Platform, RunnerOutcome, ServerDeployer, Staging, StagingLock } from './evidence-ports.js';
import { BUILDER_VERSION, BuildError, GitHubRunner, killGroupIfOurs, RealBuilder, RealRunner, RealServerDeployer, RealStaging, RealStagingLock } from './evidence-ports.js';
import * as work from './work.js';
import * as trail from './trail.js';
import * as coo from './coo.js';
import * as runs from './runs.js';
import * as employees from './employees.js';
import * as githubFlow from './github-flow.js';
import { now } from './store.js';
import { isAgent, levelOf, nameOf, rawGet } from './v2-map.js';
import { branchFor, excludeLinked } from './worktrees.js';
import { isReviewerRole, isQa } from './review-policy.js';
import { assertNotRealPath, underTest } from './test-guard.js';
import * as evidenceShare from './evidence-share.js';
import { log } from '../util/logger.js';

/**
 * run_evidence (docs/HLD-evidence.md, docs/LLD-evidence.md §3): the robot suite on this Mac's
 * simulators, against staging, for a story branch's head commit.
 *
 * The tool only validates and queues; it returns at once. One FIFO queue, at most `slots` runs at once
 * (the runner's device slots). A run checks out the head in a server-owned checkout for its slot,
 * builds the apps (cached by the app's tree; one build at a time), runs the runner, and records the
 * outcome on the item, on the PR's workplace/evidence status (shadow/on) and in the caller's session.
 *
 * A story that changes services/iris-api or services/cloud-agent (its diff from the trunk merge-base)
 * first deploys THAT commit's server code to staging (`scripts/staging.sh deploy` from the run's
 * checkout), so a server fix is proved before production. Staging is shared, so at most one such run
 * at a time; app-only runs still run beside it and note which server commit staging was on. Staging
 * is left as the last server run left it (GET /api/coo/evidence/staging says what that is).
 */

export const DESKTOP_REFUSAL = 'Mac desktop checks need a live window from the COO; ask on the item.';
const WINDOWS_REFUSAL = 'Windows can\'t run on the Mac: Windows evidence is a cloud robot run that QA schedules, so ask QA on the item.';

const PHONES: readonly Platform[] = ['android', 'ios'];
/** The runner's own list (local-run.sh ALL_FEATURES), used when the commit has no e2e/ runner to read it from. */
export const RUNNER_FEATURES: readonly string[] = ['queries', 'voice', 'memory', 'music', 'dance', 'files', 'timer', 'reminder', 'apps', 'errand'];

/** The features the runner at `sha` accepts: its ALL_FEATURES line, else the shared list. */
export function runnerFeatures(wp: Workplace, repo: string, sha: string): string[] {
  try {
    const src = git(repo, ['show', `${sha}:${wp.config.evidence.runnerInRepo}`]);
    const m = /^ALL_FEATURES=([a-z0-9,-]+)\s*$/m.exec(src);
    if (m) return m[1]!.split(',').filter(Boolean);
  } catch { /* no runner in this commit */ }
  return [...RUNNER_FEATURES];
}

/**
 * What each platform runs (e2e/scripts/local-run.sh supported(), from scripts/plan.mjs PER): the
 * phones run only part of the suite; the Mac app runs all of it, but only in a live check on the
 * owner's Mac (request_mac); Windows is a cloud run QA schedules (plan.mjs PER.windows).
 */
export const PLATFORM_FEATURES: Readonly<Record<'android' | 'ios' | 'desktop' | 'windows', readonly string[]>> = {
  android: ['queries', 'memory', 'files', 'errand'],
  ios: ['queries', 'memory', 'files', 'errand'],
  desktop: RUNNER_FEATURES,
  windows: ['queries', 'voice', 'memory', 'music', 'files', 'timer', 'apps', 'errand', 'update'],
};

/**
 * The features each phone runs with the runner at `sha`: its own supported() line when it has one;
 * a runner without that line restricts nothing (it runs what it lists); no runner in the commit, the
 * shared list.
 */
export function phoneFeatures(wp: Workplace, repo: string, sha: string): Record<Platform, string[]> | null {
  let src: string;
  try { src = git(repo, ['show', `${sha}:${wp.config.evidence.runnerInRepo}`]); }
  catch { return { android: [...PLATFORM_FEATURES.android], ios: [...PLATFORM_FEATURES.ios] }; }
  const line = /^\s*supported\(\)\s*\{(.*)\}\s*;?\s*$/m.exec(src)?.[1];
  if (!line) return null;
  const of = (p: Platform): string[] | null => {
    const m = new RegExp(`(?:^|[\\s;(])${p}\\)\\s*echo\\s+([^;]*);;`).exec(line);
    if (!m) return null;
    const v = m[1]!.trim().replace(/^['"]|['"]$/g, '');
    if (v === '$ALL_FEATURES') return runnerFeatures(wp, repo, sha);
    return v.split(',').map(x => x.trim()).filter(Boolean);
  };
  const android = of('android'), ios = of('ios');
  return android && ios ? { android, ios } : null;
}

/** The refusal when a named feature runs on none of the requested platforms, or null. */
export function unsupportedRefusal(byPlatform: Record<Platform, string[]>, platforms: Platform[], features: string[]): string | null {
  const missing = features.filter(f => f !== 'all' && !platforms.some(p => byPlatform[p].includes(f)));
  if (!missing.length) return null;
  const lists = platforms.map(p => `${p}: ${byPlatform[p].join(', ') || 'none'}`).join('; ');
  return `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not run on ${platforms.join(' or ')} (${lists}); ` +
    (macHost() ? 'for voice or desktop checks ask for the Mac with request_mac and do a live check there, ' : `voice and desktop checks need a Mac: ${NO_MAC_REFUSAL} `) +
    'Call run_evidence again only with features from those lists.';
}

export const featureRefusal = (allowed: readonly string[]): string =>
  `Features must be from ${allowed.join(', ')} (or all); setup always runs, so don't name it, and call run_evidence again with those.`;
const DESKTOP = new Set(['mac', 'macos', 'osx', 'desktop']);
const WINDOWS = new Set(['windows', 'win', 'windows-default']);
const FEATURE = /^[a-z][a-z0-9-]{0,31}$/;
const JOB_KEY = 'evidence:job:';
const KEEP_FINISHED = 30;
const MAX_ATTEMPTS = 2;

export type JobState = 'queued' | 'building' | 'running' | 'done';

export interface EvidenceJob {
  id: string;
  itemId: string;
  /** The caller: their session gets the result. */
  by: string;
  platforms: Platform[];
  features: string[];
  /** Android emulator API level asked for (11 Oct: the Play build needs API 36); absent = 34. */
  androidApi?: '34' | '36';
  state: JobState;
  /** The branch head when it was asked for (dedupe); the run builds the head when it starts. */
  requestedSha?: string;
  slot?: number;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** The commit built and tested. */
  sha?: string;
  run?: string;
  /** The process group in flight (a build or the runner), for a restart to stop it. */
  pid?: number;
  attempts: number;
  phase?: string;
  result?: EvidenceRunRecord;
  delivered?: 'session' | 'item';
  /** The commit changes the server (iris-api, cloud-agent): it deploys to staging, one such run at a time. */
  server?: boolean;
}

/* ---------- the ports ---------- */

export interface EvidencePorts { runner: EvidenceRunner; builder: AppBuilder; staging: Staging; lock: StagingLock; deployer: ServerDeployer }

const ports = new WeakMap<Workplace, Partial<EvidencePorts>>();

/** Tests (and the real gate) hand the service their own runner, builder or staging. */
export function useEvidencePorts(wp: Workplace, p: Partial<EvidencePorts>): void { ports.set(wp, { ...(ports.get(wp) ?? {}), ...p }); }

function portsOf(wp: Workplace): EvidencePorts {
  const p = ports.get(wp) ?? {};
  const cfg = wp.config.evidence;
  // On the Linux server (cloud migration, 17 Oct) GitHub builds the commit and runs the suite.
  p.runner ??= cfg.runOn === 'github' ? new GitHubRunner(() => githubFlow.gitHubPort(wp)) : new RealRunner(cfg);
  p.builder ??= new RealBuilder(cfg);
  p.staging ??= new RealStaging(cfg, join(cfg.dir, '_logs', 'staging.log'));
  // Tests never touch staging or SSM: without a fake, the lock does nothing.
  p.lock ??= underTest() ? { hold: async () => undefined, release: async () => undefined } : new RealStagingLock(cfg);
  // Nor deploy to it.
  p.deployer ??= underTest() ? { deploy: async () => { throw new Error('no staging deploys under test'); } } : new RealServerDeployer(cfg);
  ports.set(wp, p);
  return p as EvidencePorts;
}

/** Evidence runs on GitHub Actions (and so under the daily GitHub cap). */
const onGitHub = (wp: Workplace): boolean => portsOf(wp).runner instanceof GitHubRunner;

/** The ports a Workplace runs with (tests: which runner was chosen). */
export const portsForTest = (wp: Workplace): EvidencePorts => portsOf(wp);

/** Staging as run_evidence starts it (one shared instance, so two callers never run two starts at once). */
export function stagingPort(wp: Workplace): Staging { return portsOf(wp).staging; }

/* ---------- the engine: queue, slots, persistence ---------- */

interface Engine {
  jobs: Map<string, EvidenceJob>;
  queue: string[];
  active: Map<number, { job: EvidenceJob; promise: Promise<void> }>;
  stopped: boolean;
  scheduled: boolean;
  /** The "in use" heartbeat while anything is queued or running. */
  lockTimer?: ReturnType<typeof setInterval>;
  /** Server-touching runs, one at a time: deploy + suite (staging is shared). */
  serverChain: Promise<unknown>;
}

const engines = new WeakMap<Workplace, Engine>();
function engine(wp: Workplace): Engine {
  let e = engines.get(wp);
  if (!e) { e = { jobs: new Map(), queue: [], active: new Map(), stopped: false, scheduled: false, serverChain: Promise.resolve() }; engines.set(wp, e); }
  return e;
}

function persist(wp: Workplace, job: EvidenceJob): void {
  engine(wp).jobs.set(job.id, job);
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(JOB_KEY + job.id, JSON.stringify(job));
}

function storedJobs(wp: Workplace): EvidenceJob[] {
  const rows = wp.db.prepare('select value from settings where key like ?').all(`${JOB_KEY}%`) as { value: string }[];
  const out: EvidenceJob[] = [];
  for (const r of rows) { try { out.push(JSON.parse(r.value) as EvidenceJob); } catch { /* unreadable row: skipped */ } }
  return out;
}

function pruneFinished(wp: Workplace): void {
  const done = storedJobs(wp).filter(j => j.state === 'done').sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
  for (const j of done.slice(KEEP_FINISHED)) {
    wp.db.prepare('delete from settings where key = ?').run(JOB_KEY + j.id);
    engine(wp).jobs.delete(j.id);
  }
}

/** Tests: a job row as a previous Workplace process left it. */
export function persistForTest(wp: Workplace, job: EvidenceJob): void { persist(wp, job); engine(wp).jobs.delete(job.id); }

const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const revParse = (cwd: string, ref: string): string | null => { try { return git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim() || null; } catch { return null; } };
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 300);
const stamp = (d = new Date()): string => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
const newJobId = (): string => `ev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/* ---------- the request (the tool) ---------- */

export type RequestResult = { ok: true; job: EvidenceJob; position: number; message: string } | { ok: false; message: string };

const listOf = (v: string | string[]): string[] =>
  (Array.isArray(v) ? v : String(v ?? '').split(/[,\s]+/)).map(x => x.trim().toLowerCase()).filter(Boolean);

interface StoryCtx { w: WorkItem; repo: string; trunk: string; branch: string; head: string }

/** Where the story's code is: its assignee's branch, with commits past the trunk. A string says why not. */
function storyOf(wp: Workplace, w: WorkItem): StoryCtx | string {
  const emp = w.employeeId ? wp.org.employees.find(e => e.id === w.employeeId) : undefined;
  if (!emp || !isAgent(wp, emp.id)) return 'This story has no agent assignee with a branch, so there is nothing to build; ask Asha to assign it.';
  const repo = emp.workspace.repo;
  const trunk = emp.workspace.branch ?? wp.config.github.trunk;
  const branch = branchFor(emp, w.id);
  const head = revParse(repo, `refs/heads/${branch}`);
  if (!head) return `There is no branch ${branch} yet: commit your change on it, then call run_evidence again.`;
  let own = '0';
  try { own = git(repo, ['rev-list', '--count', `${trunk}..${head}`]).trim(); } catch { /* no trunk: treated as none */ }
  if (own === '0') return `${branch} has no commits past ${trunk} yet: commit your change, then call run_evidence again.`;
  return { w, repo, trunk, branch, head };
}

/** Why these platforms are refused (desktop, Windows, unknown, none), or null. */
export function platformRefusal(given: string | string[]): string | null {
  const platforms = listOf(given);
  if (platforms.some(p => DESKTOP.has(p))) return macHost() ? DESKTOP_REFUSAL : `Mac desktop checks: ${NO_MAC_REFUSAL}`;
  if (platforms.some(p => WINDOWS.has(p))) return WINDOWS_REFUSAL;
  if (!platforms.length) return 'Name the platforms your change touches (android, ios or both), then call run_evidence again.';
  const unknown = platforms.filter(p => p !== 'all' && !(PHONES as string[]).includes(p));
  if (unknown.length) return `${unknown.join(', ').slice(0, 60)} is not a platform the Mac's simulators run; call run_evidence again with android, ios or both.`;
  return null;
}

export function request(wp: Workplace, spec: { itemId: string; by: string; platforms: string | string[]; features: string | string[]; androidApi?: string }): RequestResult {
  const no = (message: string): RequestResult => ({ ok: false, message });
  const refusal = platformRefusal(spec.platforms);
  if (refusal) return no(refusal);
  if (spec.androidApi !== undefined && spec.androidApi !== '34' && spec.androidApi !== '36') return no('androidApi must be 34 or 36 (the emulators the runner has).');
  const androidApi = spec.androidApi as '34' | '36' | undefined;
  let platforms = listOf(spec.platforms);
  if (platforms.includes('all')) platforms = [...PHONES];
  const features = listOf(spec.features);
  if (!features.length) return no('Name the features your change touches (for example queries, memory or files), then call run_evidence again.');
  const badFeature = features.find(f => !FEATURE.test(f));
  if (badFeature) return no(`"${badFeature.slice(0, 40)}" is not a feature name; call run_evidence again with the suite's feature names (for example queries, memory, files).`);

  const w = rawGet(wp, spec.itemId);
  if (!w) return no(`There is no story ${spec.itemId}; find its id with status_of, then call run_evidence again.`);
  if (levelOf(w) === 'epic') return no('An epic has no branch of its own; run evidence on the story that changed the code.');
  const caller = wp.org.employees.find(e => e.id === spec.by);
  const allowed = spec.by === w.employeeId || spec.by === w.reviewerId || isReviewerRole(caller) || isQa(caller) || spec.by === coo.COO_ID;
  if (!allowed) return no(`Only the story's author, its reviewers, a lead or QA run evidence on it; ask ${nameOf(wp, w.employeeId)} on the item.`);
  const ctx = storyOf(wp, w);
  if (typeof ctx === 'string') return no(ctx);
  // Checked now, against the runner the run will use, not minutes later by the runner itself.
  const known = runnerFeatures(wp, ctx.repo, ctx.head);
  if (features.some(f => f !== 'all' && !known.includes(f))) return no(featureRefusal(known));

  // The daily GitHub Actions cap (owner, 18 Oct): a run on GitHub is refused, not queued.
  const capped = onGitHub(wp) ? spendCaps.githubBlock(wp) : null;
  if (capped) return no(`${capped.message}. Call run_evidence again then; carry on with other work meanwhile.`);

  const plats = PHONES.filter(p => platforms.includes(p));
  // Refused before anything is queued: a feature none of these platforms runs would be dropped silently.
  const byPlatform = phoneFeatures(wp, ctx.repo, ctx.head);
  const unsupported = byPlatform ? unsupportedRefusal(byPlatform, plats, features) : null;
  if (unsupported) return no(unsupported);
  const feats = [...new Set(features)];
  const e = engine(wp);
  const same = (j: EvidenceJob): boolean => j.itemId === w.id && j.requestedSha === ctx.head && j.platforms.join() === plats.join() && j.features.join() === feats.join() && (j.androidApi ?? '34') === (androidApi ?? '34');
  const queuedTwin = e.queue.map(id => e.jobs.get(id)!).find(j => j && same(j));
  const activeTwin = [...e.active.values()].map(a => a.job).find(same);
  if (queuedTwin || activeTwin) {
    const job = (queuedTwin ?? activeTwin)!;
    const position = queuedTwin ? e.queue.indexOf(job.id) + 1 : 0;
    return { ok: true, job, position, message: queuedTwin
      ? `Already queued (position ${position}) for ${ctx.head.slice(0, 8)}: don't wait for it; the summary comes back to you and onto the story when it finishes.`
      : `Already running for ${ctx.head.slice(0, 8)}: don't wait for it; the summary comes back to you and onto the story when it finishes.` };
  }

  const server = serverChange(wp, ctx.repo, ctx.trunk, ctx.head).touched;
  const job: EvidenceJob = { id: newJobId(), itemId: w.id, by: spec.by, platforms: plats, features: feats, ...(androidApi && plats.includes('android' as Platform) ? { androidApi } : {}), state: 'queued', requestedSha: ctx.head, queuedAt: now(), attempts: 0, ...(server ? { server } : {}) };
  persist(wp, job);
  e.queue.push(job.id);
  const position = e.queue.length;
  schedulePump(wp);
  log.info('evidence', `${w.id}: queued ${job.id} (${plats.join(',')} / ${feats.join(',')} on ${ctx.head.slice(0, 8)}, position ${position}, by ${spec.by})`);
  return {
    ok: true, job, position,
    message: `Evidence run queued (position ${position}): ${plats.join(',')} / ${feats.join(',')} on ${ctx.head.slice(0, 8)} (${ctx.branch}). ` +
      'It runs on the Mac\'s simulators against the staging server and links a report with screenshots to your story. ' +
      (server ? 'Your commit changes the server, so it deploys your iris-api and cloud-agent to staging first (one such run at a time). ' : '') +
      'Don\'t wait for it: the summary comes back to you and onto the story when it finishes.',
  };
}

/* ---------- the pump ---------- */

function schedulePump(wp: Workplace): void {
  const e = engine(wp);
  if (e.scheduled || e.stopped) return;
  e.scheduled = true;
  setImmediate(() => { e.scheduled = false; pump(wp); });
}

/** The lock outlives a missed beat: held for 25 min, renewed every 10. */
export const LOCK_EVERY_MS = 10 * 60_000;
const LOCK_FOR_MS = 25 * 60_000;

function beat(wp: Workplace): void {
  portsOf(wp).lock.hold(Date.now() + LOCK_FOR_MS).catch(err => log.warn('evidence', errText(err)));
}

/** Staging stays up while a run is queued or running: hold the lock now and every 10 min; release when idle. */
function keepStagingInUse(wp: Workplace): void {
  const e = engine(wp);
  const busy = !e.stopped && (e.queue.length > 0 || e.active.size > 0);
  if (busy && !e.lockTimer) {
    beat(wp);
    e.lockTimer = setInterval(() => beat(wp), LOCK_EVERY_MS);
    e.lockTimer.unref?.();
  } else if (!busy && e.lockTimer) {
    clearInterval(e.lockTimer);
    delete e.lockTimer;
    if (!e.stopped) portsOf(wp).lock.release().catch(err => log.warn('evidence', `staging lock release: ${errText(err)}`));
  }
}

/** local-run.sh's own slot lock ($TMPDIR/iris-e2e-slot-N.lock/pid) held by a live process. */
export function slotHeldOutside(slot: number, dirs: string[] = [process.env['TMPDIR'] ?? '', tmpdir(), '/tmp']): boolean {
  for (const d of new Set(dirs.filter(Boolean))) {
    try {
      const pid = Number(readFileSync(join(d, `iris-e2e-slot-${slot}.lock`, 'pid'), 'utf8').trim());
      if (pid > 0) { try { process.kill(pid, 0); return true; } catch { /* dead: a stale lock the runner clears */ } }
    } catch { /* no lock here */ }
  }
  return false;
}

function pump(wp: Workplace): void {
  const e = engine(wp);
  if (e.stopped) { keepStagingInUse(wp); return; }
  for (let slot = 1; slot <= wp.config.evidence.slots && e.queue.length; slot++) {
    if (e.active.has(slot)) continue;
    // A slot someone runs by hand (scripts/local-run.sh --slot N, outside this queue) holds its lock;
    // starting there fails in seconds (Mira, 7 Oct: four runs died on Nikhil's manual ios-uitests run).
    if (portsOf(wp).runner instanceof RealRunner && slotHeldOutside(slot)) { setTimeout(() => schedulePump(wp), 30_000).unref?.(); continue; }
    // The first queued job that may start: a server-touching one waits while another holds staging.
    const serverBusy = [...e.active.values()].some(a => a.job.server);
    const at = e.queue.findIndex(id => !(serverBusy && e.jobs.get(id)?.server));
    if (at < 0) break;
    const job = e.jobs.get(e.queue.splice(at, 1)[0]!);
    if (!job) { slot--; continue; }
    const entry = { job, promise: Promise.resolve() };
    e.active.set(slot, entry);
    entry.promise = execute(wp, job, slot)
      .catch(err => log.warn('evidence', `${job.id}: ${errText(err)}`))
      .finally(() => { e.active.delete(slot); schedulePump(wp); });
  }
  keepStagingInUse(wp);
}

/** Resolves when nothing is queued or running (tests, shutdown). */
export async function settled(wp: Workplace): Promise<void> {
  const e = engine(wp);
  for (;;) {
    if (e.active.size) { await Promise.all([...e.active.values()].map(a => a.promise)); continue; }
    if (e.scheduled || (e.queue.length && !e.stopped)) { await new Promise(r => setImmediate(r)); continue; }
    return;
  }
}

/* ---------- builds ---------- */

let buildChain: Promise<unknown> = Promise.resolve();
/** One app build at a time on this Mac (with the quality checks' own serial queue: 2 heavy builds at most). */
function underBuildLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = buildChain.then(fn);
  buildChain = next.catch(() => undefined);
  return next;
}

export interface BuildPlan { platform: Platform; source: string; key: string; changed: boolean; appPath: string }

/**
 * What to build for a platform at `sha`: the story's own commit if its diff from the trunk touches the
 * app's path, else the trunk head (its build is shared). The key is the app's git tree there, plus
 * the build options. Null when the commit has no such app.
 */
export function buildPlan(wp: Workplace, repo: string, trunk: string, sha: string, platform: Platform): BuildPlan | null {
  const appPath = wp.config.evidence.appPaths[platform];
  let changed = true;
  try {
    const base = git(repo, ['merge-base', trunk, sha]).trim();
    changed = git(repo, ['diff', '--name-only', base, sha, '--', appPath]).trim() !== '';
  } catch { /* no merge base: build the commit itself */ }
  const source = changed ? sha : (revParse(repo, `refs/heads/${trunk}`) ?? sha);
  let tree: string;
  try { tree = git(repo, ['rev-parse', `${source}:${appPath}`]).trim(); } catch { return null; }
  const options = createHash('sha256').update(`${wp.config.evidence.stagingUrl}|${BUILDER_VERSION}`).digest('hex').slice(0, 8);
  return { platform, source, key: `${tree.slice(0, 16)}-${options}`, changed, appPath };
}

const buildsDir = (wp: Workplace, platform: Platform): string => join(wp.config.evidence.dir, '_builds', platform);

interface CachedBuild { key: string; source: string; artifact: string; builtAt: string; usedAt: string; ms: number }

function cached(wp: Workplace, plan: BuildPlan): string | null {
  const dir = join(buildsDir(wp, plan.platform), plan.key);
  const meta = join(dir, 'build.json');
  if (!existsSync(meta)) return null;
  try {
    const m = JSON.parse(readFileSync(meta, 'utf8')) as CachedBuild;
    const artifact = join(dir, m.artifact);
    if (!existsSync(artifact)) return null;
    writeFileSync(meta, JSON.stringify({ ...m, usedAt: now() }, null, 1));
    return artifact;
  } catch { return null; }
}

function pruneBuilds(wp: Workplace, platform: Platform): void {
  const dir = buildsDir(wp, platform);
  if (!existsSync(dir)) return;
  const metas = readdirSync(dir).filter(d => !d.includes('.tmp-')).map(d => {
    try { return { d, used: (JSON.parse(readFileSync(join(dir, d, 'build.json'), 'utf8')) as CachedBuild).usedAt }; } catch { return { d, used: '' }; }
  }).sort((a, b) => b.used.localeCompare(a.used));
  for (const m of metas.slice(wp.config.evidence.keepBuilds)) rmSync(join(dir, m.d), { recursive: true, force: true });
}

/* ---------- the server on staging ---------- */

/** The scripts a server deploy runs: a story that changes them is never deployed automatically. */
export const DEPLOY_SCRIPTS: readonly string[] = ['scripts/staging.sh', 'scripts/deploy-target.sh', 'scripts/deploy-api.sh', 'scripts/deploy-agent.sh'];

/**
 * Whether the story's diff from the trunk merge-base touches the server (config serverPaths), and
 * which deploy scripts it changes. No merge base: treated as not touching (storyOf already demands
 * commits past the trunk, so there is one).
 */
export function serverChange(wp: Workplace, repo: string, trunk: string, sha: string): { touched: boolean; scripts: string[] } {
  try {
    const base = git(repo, ['merge-base', trunk, sha]).trim();
    const touched = git(repo, ['diff', '--name-only', base, sha, '--', ...wp.config.evidence.serverPaths]).trim() !== '';
    const scripts = touched ? git(repo, ['diff', '--name-only', base, sha, '--', ...DEPLOY_SCRIPTS]).split('\n').map(l => l.trim()).filter(Boolean) : [];
    return { touched, scripts };
  } catch { return { touched: false, scripts: [] }; }
}

const STAGING_SERVER_KEY = 'evidence:staging-server';

/** What staging's iris-api and cloud-agent run, as the last evidence deploy left it. */
export function stagingServer(wp: Workplace): StagingServerState {
  const row = wp.db.prepare('select value from settings where key = ?').get(STAGING_SERVER_KEY) as { value: string } | undefined;
  if (row) { try { return JSON.parse(row.value) as StagingServerState; } catch { /* unreadable: unknown */ } }
  return { state: 'unknown', sha: null };
}

function setStagingServer(wp: Workplace, st: StagingServerState): void {
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(STAGING_SERVER_KEY, JSON.stringify(st));
}

/**
 * A deploy the Workplace did not run itself (the twice-daily batch, staging-follow-trunk.sh) records
 * what staging now runs. Without it, evidence reports repeated a 5 Oct commit for two days
 * (Zoya's RCA, 7 Oct).
 */
export function recordStagingDeploy(wp: Workplace, sha: string, by: string): StagingServerState {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new BadRequest('sha must be a git commit (7-40 hex)');
  const st: StagingServerState = { state: 'deployed', sha, at: now(), run: `external:${by}` };
  setStagingServer(wp, st);
  return st;
}

/** The server commit staging is known to run, or null. */
const knownSha = (st: StagingServerState): string | null => (st.state === 'deployed' ? st.sha : null);

/** One server-touching run (deploy + suite) at a time. */
function underServerLock<T>(wp: Workplace, fn: () => Promise<T>): Promise<T> {
  const e = engine(wp);
  const next = e.serverChain.then(fn);
  e.serverChain = next.catch(() => undefined);
  return next;
}

/* ---------- the checkout ---------- */

function checkoutFor(wp: Workplace, repo: string, slot: number): string {
  return join(wp.config.workDir, '_evidence', basename(repo), `slot-${slot}`);
}

/** The slot's server-owned detached checkout, put on `sha` (never an employee's worktree). */
function prepareCheckout(repo: string, path: string, sha: string): void {
  assertNotRealPath('evidence checkout', path);
  let usable = existsSync(path);
  if (usable) { try { git(path, ['rev-parse', '--git-dir']); } catch { usable = false; rmSync(path, { recursive: true, force: true }); } }
  if (!usable) {
    mkdirSync(join(path, '..'), { recursive: true });
    try { git(repo, ['worktree', 'prune']); } catch { /* nothing to prune */ }
    git(repo, ['worktree', 'add', '--detach', '-f', path, sha]);
  } else {
    git(path, ['checkout', '-q', '--detach', '--force', sha]);
  }
  excludeLinked(path);
  git(path, ['clean', '-fdq']);
}

/* ---------- one run ---------- */

interface Outcome { state: EvidenceState; passed: number; failed: number; failures: string[]; note?: string; server?: EvidenceServer }

async function execute(wp: Workplace, job: EvidenceJob, slot: number): Promise<void> {
  const cfg = wp.config.evidence;
  const p = portsOf(wp);
  const started = Date.now();
  job.state = 'building'; job.slot = slot; job.startedAt = now(); job.attempts += 1; job.phase = 'checkout';
  persist(wp, job);

  const w = rawGet(wp, job.itemId);
  const ctx = w ? storyOf(wp, w) : 'the item is gone';
  if (typeof ctx === 'string') {
    job.sha = job.requestedSha ?? '';
    job.run = `${(job.sha || '0000000').slice(0, 12)}-${stamp()}`;
    return finish(wp, job, { state: 'error', passed: 0, failed: 0, failures: [], note: ctx }, started);
  }
  const sha = ctx.head;
  job.sha = sha;
  job.run = `${sha.slice(0, 12)}-${stamp()}`;
  persist(wp, job);
  const runDir = join(cfg.dir, job.itemId, job.run);
  const logs = join(cfg.dir, '_logs', job.itemId, job.run);
  mkdirSync(logs, { recursive: true });
  const onSpawn = (pid: number): void => { job.pid = pid; persist(wp, job); };
  const errorOf = (note: string): Outcome => ({ state: 'error', passed: 0, failed: 0, failures: [], note });

  // The commit decides, not the request: the branch may have moved since it was queued.
  const server = serverChange(wp, ctx.repo, ctx.trunk, sha);
  if (server.touched !== !!job.server) { if (server.touched) job.server = true; else delete job.server; persist(wp, job); }

  let outcome: Outcome | undefined;
  // Queued before the daily GitHub cap was reached: it does not start the suite on GitHub now.
  const capped = onGitHub(wp) ? spendCaps.githubBlock(wp) : null;
  if (capped) outcome = errorOf(capped.message);
  else if (server.scripts.length) {
    outcome = errorOf(`this story changes the deploy scripts (${server.scripts.join(', ')}), so its server code is not deployed to staging automatically; ask the COO to deploy it by hand`);
  }
  if (!outcome) try {
    const checkout = checkoutFor(wp, ctx.repo, slot);
    prepareCheckout(ctx.repo, checkout, sha);
    const stagingUp = p.staging.ensureUp().then(() => null, (err: unknown) => errText(err));

    const apps: Partial<Record<Platform, string>> = {};
    // A runner that builds the commit itself (GitHub) gets no apps from here.
    for (const platform of p.runner.buildsApps ? [] : job.platforms) {
      job.phase = `building ${platform}`; persist(wp, job);
      const plan = buildPlan(wp, ctx.repo, ctx.trunk, sha, platform);
      if (!plan) { outcome = { state: 'error', passed: 0, failed: 0, failures: [], note: `there is no ${cfg.appPaths[platform]} at ${sha.slice(0, 8)} to build` }; break; }
      try {
        apps[platform] = cached(wp, plan) ?? await underBuildLock(async () => {
          const again = cached(wp, plan);
          if (again) return again;
          const t0 = Date.now();
          if (plan.source !== sha) prepareCheckout(ctx.repo, checkout, plan.source);
          const final = join(buildsDir(wp, platform), plan.key);
          const tmp = `${final}.tmp-${job.id}`;
          rmSync(tmp, { recursive: true, force: true });
          try {
            const artifact = await p.builder.build({ platform, checkout, appDir: plan.appPath, api: cfg.stagingUrl, out: tmp, log: join(logs, `build-${platform}.log`), onSpawn });
            const meta: CachedBuild = { key: plan.key, source: plan.source, artifact: basename(artifact), builtAt: now(), usedAt: now(), ms: Date.now() - t0 };
            writeFileSync(join(tmp, 'build.json'), JSON.stringify(meta, null, 1));
            rmSync(final, { recursive: true, force: true });
            renameSync(tmp, final);
            log.info('evidence', `${job.id}: built ${platform} at ${plan.source.slice(0, 8)} in ${Math.round(meta.ms / 1000)} s (${plan.key})`);
            pruneBuilds(wp, platform);
            return join(final, meta.artifact);
          } finally {
            rmSync(tmp, { recursive: true, force: true });
            if (plan.source !== sha) prepareCheckout(ctx.repo, checkout, sha);
          }
        });
      } catch (err) {
        const why = errText(err);
        // The story's own app code does not build: that is its evidence. The trunk's not building is plumbing.
        outcome = err instanceof BuildError && plan.changed
          ? { state: 'failure', passed: 0, failed: 1, failures: [`${platform} build: ${why}`], note: why }
          : { state: 'error', passed: 0, failed: 0, failures: [], note: why };
        break;
      }
    }

    if (!outcome) {
      job.phase = 'waiting for staging'; persist(wp, job);
      const down = await stagingUp;
      if (down) outcome = { state: 'error', passed: 0, failed: 0, failures: [], note: `staging is not available: ${down}` };
    }
    if (!outcome) {
      const suite = async (): Promise<Outcome> => {
        let srv: EvidenceServer;
        if (job.server) {
          job.phase = 'deploying the server to staging'; persist(wp, job);
          const base = { sha, itemId: job.itemId, run: job.run! };
          setStagingServer(wp, { state: 'deploying', ...base, at: now() });
          try {
            await p.deployer.deploy({ repo: ctx.repo, checkout, sha, log: join(logs, 'deploy.log'), onSpawn });
          } catch (err) {
            const why = `staging deploy of ${sha.slice(0, 8)} failed: ${errText(err)}`;
            setStagingServer(wp, { state: 'failed', ...base, at: now(), note: why });
            return errorOf(why);
          }
          setStagingServer(wp, { state: 'deployed', ...base, at: now() });
          log.info('evidence', `${job.id}: deployed iris-api and cloud-agent at ${sha.slice(0, 8)} to staging`);
          srv = { sha, deployed: true };
        } else {
          srv = { sha: knownSha(stagingServer(wp)), deployed: false };
        }
        const before = JSON.stringify(stagingServer(wp));
        job.state = 'running'; job.phase = 'running the suite'; persist(wp, job);
        const res = await p.runner.run({ checkout, platforms: job.platforms, features: job.features, ...(job.androidApi ? { androidApi: job.androidApi } : {}), api: cfg.stagingUrl, apps, slot, out: runDir, log: join(logs, 'runner.log'), onSpawn, sha, repo: ctx.repo, branch: ctx.branch, requestId: `${job.itemId}-${job.run}` });
        const afterState = stagingServer(wp);
        if (!job.server && JSON.stringify(afterState) !== before) srv.changedTo = knownSha(afterState);
        return { ...readOutcome(runDir, res), server: srv };
      };
      if (job.server) { job.phase = 'waiting for staging (another server run)'; persist(wp, job); }
      outcome = job.server ? await underServerLock(wp, suite) : await suite();
    }
  } catch (err) {
    outcome = { state: 'error', passed: 0, failed: 0, failures: [], note: errText(err) };
  }

  // Evidence belongs to one commit: a branch that moved during the run makes it stale, never success.
  const headNow = revParse(ctx.repo, `refs/heads/${ctx.branch}`);
  if (outcome.state !== 'error' && headNow !== sha) {
    outcome = { ...outcome, state: 'stale', note: `${ctx.branch} moved to ${headNow ? headNow.slice(0, 8) : 'nothing'} during the run` };
  }
  // The build and runner logs go next to the report, so the report route serves them too.
  try {
    mkdirSync(runDir, { recursive: true });
    rmSync(join(runDir, 'workplace'), { recursive: true, force: true });
    renameSync(logs, join(runDir, 'workplace'));
  } catch (err) { log.warn('evidence', `${job.id}: logs not moved: ${errText(err)}`); }
  return finish(wp, job, outcome, started);
}

/** results.json + summary.txt → the outcome. No report = the run did not finish (plumbing). */
export function readOutcome(runDir: string, res: RunnerOutcome): Outcome {
  const lastLine = res.stderrTail.split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? '';
  const summaryFile = join(runDir, 'summary.txt');
  const resultsFile = join(runDir, 'results.json');
  if (res.exitCode === 2 || !existsSync(summaryFile) || !existsSync(resultsFile)) {
    return { state: 'error', passed: 0, failed: 0, failures: [], note: `the runner stopped before its report (exit ${res.exitCode ?? res.signal ?? '?'})${lastLine ? `: ${lastLine.slice(0, 200)}` : ''}` };
  }
  let results: { verdict?: string; counts?: Record<string, number> } = {};
  try { results = JSON.parse(readFileSync(resultsFile, 'utf8')) as typeof results; } catch { /* unreadable: no counts */ }
  const counts = results.counts ?? {};
  const passed = (counts['PASS'] ?? 0) + (counts['FLAKY'] ?? 0);
  const failed = (counts['FAIL'] ?? 0) + (counts['BLOCKED'] ?? 0);
  const lines = readFileSync(summaryFile, 'utf8').split('\n');
  const at = lines.findIndex(l => /^FAILURES \(\d+\)/.test(l));
  const failures = at < 0 ? [] : lines.slice(at + 1).map(l => l.trim()).filter(Boolean).slice(0, 10);
  const pass = results.verdict === 'PASS' && res.exitCode === 0;
  return { state: pass ? 'success' : 'failure', passed, failed, failures, ...(pass || failures.length ? {} : { note: `the suite did not pass (exit ${res.exitCode ?? res.signal ?? '?'})` }) };
}

const dur = (s: number): string => (s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`);

export function reportPath(itemId: string, run: string): string {
  return `/api/evidence/${encodeURIComponent(itemId)}/${encodeURIComponent(run)}/index.html`;
}

const NEXT: Record<EvidenceState, string> = {
  success: 'Evidence belongs to this commit: any new commit makes it stale, so run it again after a change.',
  failure: 'Open the screenshots of the failures only (in the report), fix the cause on your branch, commit, then call run_evidence again.',
  stale: 'Your branch moved during the run, so this evidence is stale: call run_evidence again on the new commit.',
  error: 'That is the test plumbing, not your change: the COO has it, so carry on and call run_evidence again later.',
};
const WORD: Record<EvidenceState, string> = { success: 'PASS', failure: 'FAIL', stale: 'STALE', error: 'ERROR' };

/** The one summary the caller, the item and the COO see. */
export function summaryText(rec: EvidenceRunRecord, title: string): string {
  const link = rec.share ? rec.share.url : 'link unavailable (the upload failed; the evidence still counts)';
  return [
    `Evidence ${WORD[rec.state]} for "${title}" on ${rec.sha.slice(0, 8)} (${rec.platforms.join(',')} / ${rec.features.join(',')}): ${rec.passed} passed, ${rec.failed} failed, ${dur(rec.durationS)}. Report: ${link}`,
    ...(rec.server ? [evidenceShare.serverLine(rec.server)] : []),
    ...(rec.note && rec.state !== 'failure' ? [`Why: ${rec.note}.`] : []),
    ...(rec.failures.length ? ['Failures:', ...rec.failures.slice(0, 5).map(f => `- ${f}`), ...(rec.failures.length > 5 ? [`- … ${rec.failures.length - 5} more in the report`] : [])] : []),
    `Next: ${rec.state === 'error' && rec.note?.startsWith(spendCaps.GITHUB_PAUSED) ? 'Nothing is wrong with your change: call run_evidence again once GitHub Actions resume (tomorrow, or when the owner lifts the cap).' : NEXT[rec.state]}`,
  ].join('\n');
}

async function finish(wp: Workplace, job: EvidenceJob, outcome: Outcome, started: number): Promise<void> {
  const rec: EvidenceRunRecord = {
    run: job.run!, sha: job.sha!, state: outcome.state, platforms: job.platforms, features: job.features,
    passed: outcome.passed, failed: outcome.failed, failures: outcome.failures,
    durationS: Math.round((Date.now() - started) / 1000), report: reportPath(job.itemId, job.run!),
    by: job.by, at: now(), ...(outcome.note ? { note: outcome.note } : {}), ...(outcome.server ? { server: outcome.server } : {}),
  };
  const w = rawGet(wp, job.itemId);
  const title = w?.title ?? job.itemId;
  // The global link (one self-contained HTML in the evidence bucket), then the local copy is slimmed.
  const runDir = join(wp.config.evidence.dir, job.itemId, job.run!);
  if (existsSync(runDir)) {
    const shared = await evidenceShare.share(wp, job.itemId, runDir, rec, title);
    if ('share' in shared) rec.share = shared.share;
    else log.warn('evidence', `${job.id}: no shared link: ${shared.error}`);
    try { evidenceShare.slim(runDir, rec.state); } catch (err) { log.warn('evidence', `${job.id}: not slimmed: ${errText(err)}`); }
  }
  const text = summaryText(rec, title);
  if (w) {
    try {
      const cur = rawGet(wp, job.itemId)!;
      work.saveQuiet(wp, { ...cur, evidenceRun: rec });
      trail.comment(wp, job.itemId, { by: 'workplace', text, ...(rec.failures.length || rec.note ? { details: [...rec.failures, ...(rec.note ? [`note: ${rec.note}`] : []), `logs: ${rec.report.replace(/index\.html$/, 'workplace/')}`].join('\n') } : {}) });
      trail.record(wp, { itemId: job.itemId, by: 'workplace', kind: 'test', text: `Evidence ${WORD[rec.state]} on ${rec.sha.slice(0, 8)}: ${rec.passed} passed, ${rec.failed} failed (${rec.platforms.join(',')})` });
    } catch (err) { log.warn('evidence', `${job.id}: not recorded on the item: ${errText(err)}`); }
    // shadow/on: the PR's workplace/evidence status, only for the commit that was tested.
    const pr = rawGet(wp, job.itemId)?.pr;
    if (githubFlow.mode(wp) !== 'local' && pr && !pr.merged && pr.headSha === rec.sha && rec.state !== 'error') {
      try { await githubFlow.setEvidence(wp, job.itemId, rec.state, `${rec.passed} passed, ${rec.failed} failed on ${rec.platforms.join('+')} (run_evidence)`); }
      catch (err) { log.warn('evidence', `${job.id}: setEvidence: ${errText(err)}`); }
      try { await githubFlow.prComment(wp, job.itemId, text); }
      catch (err) { log.warn('evidence', `${job.id}: PR comment: ${errText(err)}`); }
    }
  }
  if (rec.state === 'error') {
    coo.notifyStall(wp, { itemId: job.itemId, by: 'workplace', title: `Evidence run could not run: ${title}`, body: `${rec.note ?? 'unknown error'}. Run ${rec.run} for ${nameOf(wp, job.by)}; logs at ${rec.report.replace(/index\.html$/, 'workplace/')}.` });
  }
  job.delivered = deliver(wp, job.by, text);
  job.state = 'done'; job.finishedAt = now(); job.result = rec; delete job.phase; delete job.pid;
  persist(wp, job);
  pruneFinished(wp);
  log.info('evidence', `${job.itemId}: ${job.id} ${WORD[rec.state]} on ${rec.sha.slice(0, 8)} (${rec.passed}/${rec.passed + rec.failed}, ${dur(rec.durationS)}, delivered to ${job.delivered})`);
}

/** The caller's open session gets the summary; with none open, the item comment is the delivery. */
function deliver(wp: Workplace, employeeId: string, text: string): 'session' | 'item' {
  const open = employees.openSession(employeeId);
  if (!open) return 'item';
  try { runs.sendMessage(open.agentId, text, [], { from: 'workplace' }); return 'session'; } catch (err) {
    log.warn('evidence', `tell ${employeeId}: ${errText(err)}`);
    return 'item';
  }
}

/* ---------- the queue's state (GET /api/coo/evidence) ---------- */

export interface QueueView {
  slots: { slot: number; job?: EvidenceJob & { title: string } }[];
  queued: (EvidenceJob & { title: string; position: number })[];
  recent: (EvidenceJob & { title: string })[];
  /** Which iris-api + cloud-agent commit staging runs (as the last evidence deploy left it). */
  staging: StagingServerState;
}

export function state(wp: Workplace): QueueView {
  const e = engine(wp);
  const titled = <T extends EvidenceJob>(j: T): T & { title: string } => ({ ...j, title: rawGet(wp, j.itemId)?.title ?? j.itemId });
  return {
    slots: Array.from({ length: wp.config.evidence.slots }, (_, i) => {
      const a = e.active.get(i + 1);
      return { slot: i + 1, ...(a ? { job: titled(a.job) } : {}) };
    }),
    queued: e.queue.map((id, i) => ({ ...titled(e.jobs.get(id)!), position: i + 1 })),
    recent: storedJobs(wp).filter(j => j.state === 'done').sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '')).slice(0, 10).map(titled),
    staging: stagingServer(wp),
  };
}

/* ---------- boot and shutdown ---------- */

/** A path only our runs and builds have on their command line (for killing a leftover safely). */
const markerOf = (wp: Workplace): string => join(wp.config.workDir, '_evidence');

/**
 * Boot: queued jobs queue again in order; one that was building or running when the Workplace
 * stopped has its process group stopped and is queued again once (then recorded as an error).
 */
export function startEvidence(wp: Workplace): () => void {
  const e = engine(wp);
  e.stopped = false;
  const jobs = storedJobs(wp).filter(j => j.state !== 'done').sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  for (const job of jobs) {
    if (e.queue.includes(job.id) || [...e.active.values()].some(a => a.job.id === job.id)) continue;
    if (job.state === 'building' || job.state === 'running') {
      killGroupIfOurs(job.pid, markerOf(wp)) || killGroupIfOurs(job.pid, wp.config.evidence.dir);
      if (job.attempts >= MAX_ATTEMPTS) {
        const sha = job.sha ?? job.requestedSha ?? '';
        const rec: EvidenceRunRecord = { run: job.run ?? `${sha.slice(0, 12)}-${stamp()}`, sha, state: 'error', platforms: job.platforms, features: job.features, passed: 0, failed: 0, failures: [], durationS: 0, report: reportPath(job.itemId, job.run ?? ''), by: job.by, at: now(), note: 'the Workplace restarted during the run twice' };
        persist(wp, { ...job, state: 'done', finishedAt: now(), result: rec });
        try { trail.comment(wp, job.itemId, { by: 'workplace', text: `The Workplace restarted during this evidence run twice, so it was dropped: call run_evidence again.` }); } catch { /* item gone */ }
        continue;
      }
      const again: EvidenceJob = { ...job, state: 'queued' };
      for (const k of ['slot', 'pid', 'phase', 'startedAt'] as const) delete again[k];
      persist(wp, again);
      try { trail.comment(wp, job.itemId, { by: 'workplace', text: 'The Workplace restarted during this evidence run, so it is queued again; the summary still comes back when it finishes.' }); } catch { /* item gone */ }
    } else {
      persist(wp, job);
    }
    e.queue.push(job.id);
  }
  if (e.queue.length) log.info('evidence', `boot: ${e.queue.length} evidence run(s) queued again`);
  schedulePump(wp);
  return () => stopAll(wp);
}

/** Shutdown: stop the runs and builds in flight; their rows stay, so the next boot queues them again. */
export function stopAll(wp: Workplace): void {
  const e = engine(wp);
  e.stopped = true;
  // The lock is left to expire: the next boot queues these runs again and holds it anew.
  if (e.lockTimer) { clearInterval(e.lockTimer); delete e.lockTimer; }
  for (const { job } of e.active.values()) {
    if (job.pid) killGroupIfOurs(job.pid, markerOf(wp)) || killGroupIfOurs(job.pid, wp.config.evidence.dir);
  }
  e.queue = [];
}

/* ---------- the report route (GET /api/evidence/<item>/<run>/<path>) ---------- */

const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RUN_ID = /^[0-9a-f]{7,40}-\d{14}$/;
const SEGMENT = /^[A-Za-z0-9_@+=,()][A-Za-z0-9 _.@+=,()-]{0,127}$/;

/**
 * The file a report request names, or null: ids and every decoded segment validated (no dot
 * segments, slashes, backslashes or hidden files), and the real path (symlinks resolved) inside the
 * run's own directory. Read-only: only regular files are returned.
 */
export function reportFile(wp: Workplace, item: string, run: string, rest: string | undefined): string | null {
  let segments: string[];
  try {
    if (!ITEM_ID.test(item) || !RUN_ID.test(run)) return null;
    segments = (rest ?? '').split('/').filter((s, i, all) => !(s === '' && i === all.length - 1)).map(s => decodeURIComponent(s));
  } catch { return null; }
  if (!segments.length || (segments.length === 1 && segments[0] === '')) segments = ['index.html'];
  if (!segments.every(s => SEGMENT.test(s) && !s.includes('..'))) return null;
  const root = join(wp.config.evidence.dir, item, run);
  const file = join(root, ...segments);
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(file);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
    return statSync(real).isFile() ? real : null;
  } catch { return null; }
}
