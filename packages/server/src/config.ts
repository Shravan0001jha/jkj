import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Everything the Workplace needs to know before it starts. Read once at boot
 * so the rest of the code never touches process.env directly.
 */
export interface Config {
  port: number;
  host: string;
  /** Open the browser on boot. */
  openBrowser: boolean;
  version: string;
  /** The organisation: charters, org.yaml, the work database. Its own git repo. */
  workplaceDir: string;
  /** ~/iris-ops: notify.sh, the Telegram inbox, the OAuth env, App keys, the API token. */
  opsDir: string;
  /** Company cap for all agents combined, ₹ per IST day. A hard contract. */
  capInr: number;
  /** Conversion used for the equivalent-API-cost ledger. */
  usdInr: number;
  /** Per-session runaway guard in notional USD. Subscription turns are free, so this is not a budget. */
  sessionRunawayUsd: number;
  /** Cap on the appended context an employee session is given. */
  contextTokens: number;
  /** Hour (IST) of the daily digest. */
  digestHour: number;
  /** Send Telegram pings. Off in tests. */
  telegram: boolean;
  /** Copy the seed into an empty workplace directory. */
  seed: boolean;
  /** Where employees' git worktrees live: <workDir>/<employee>/<repo>. Never a main checkout. */
  workDir: string;
  /** An assignment in progress with no session activity for this long is stalled. */
  stallMinutes: number;
  /** v2 (LLD §19.6): Ready and not started for this long → Asha starts it or parks it. */
  stallReadyMinutes: number;
  /** v2: In progress with no activity for this long → the COO is told at once. */
  stallIdleMinutes: number;
  /** v2: In review untouched for this long → the COO is told. */
  stallReviewMinutes: number;
  /** A block on anyone but the owner re-tells the COO once after this long (QA, 2 Oct). */
  stallBlockedMinutes: number;
  /** The dispatcher (LLD §19.6d): how often it sweeps for free employees and stale reviews. */
  dispatchSweepMinutes: number;
  /** The dispatcher: idle this long with queued focus work → the COO is told, once per episode. */
  dispatchIdleMinutes: number;
  /** The dispatcher: an owner-talk session this recently active counts as busy (no work pushed into his conversation). */
  dispatchTalkGraceMinutes: number;
  /** The dispatcher's first sweep (stale reviews, free employees) waits this long after boot, so the staggered resumes land first. */
  dispatchBootDelaySeconds: number;
  /** Asha first (LLD §19.6e): an alert she has not acted on this long goes to the COO. */
  managerEscalateMinutes: number;
  /** Asha's manager digest, at most this often while work is active. */
  managerDigestMinutes: number;
  /** v2: an item's identical Updates line (and its room line) is posted once within this many minutes. */
  updateDedupeMinutes: number;
  /** Poll AWS Cost Explorer once a day for the previous day's actual (about ₹1 per call). */
  awsCost: boolean;
  /** Push intents to the owner's phone through the relay (LLD-workplace-push). Off with --no-push or WORKPLACE_PUSH=0. */
  push: boolean;
  /** Handles that count as the owner in a Team Room @mention. */
  ownerHandles: string[];
  /** "23-07": IST hours during which needs-you pushes are held; cap and blocked still go. */
  pushQuiet?: string;
  /** The GitHub pull-request flow (docs/HLD-github-flow.md). The mode itself is a setting, not config. */
  github: GitHubConfig;
  /** run_evidence (docs/LLD-evidence.md §1): the robot suite on this Mac against staging. */
  evidence: EvidenceConfig;
}

export interface EvidenceConfig {
  /** Runs and the build cache: <dir>/<item>/<sha12>-<ts>/, <dir>/_builds/. */
  dir: string;
  /** The staging API the built apps and the runner talk to. */
  stagingUrl: string;
  /** `<script> start` brings staging up (it idles off by itself; never stopped from here). */
  stagingScript: string;
  /** The runner inside an Iris checkout (the suite moves into the repo at e2e/). */
  runnerInRepo: string;
  /** The runner used while the built commit has no e2e/ yet (an iris-e2e clone). */
  runnerFallback: string;
  androidHome: string;
  /** JDK 17 (gradle): builds and every employee session (pre-pr.sh). */
  javaHome: string;
  /** Full Xcode (employee worktrees only have the command-line tools). */
  developerDir: string;
  /** Device slots of the runner: at most this many runs at once. */
  slots: number;
  /** Builds kept per platform in the cache. */
  keepBuilds: number;
  /** Where each app lives in the repo; its tree is the build cache key. */
  appPaths: { android: string; ios: string };
}

export interface GitHubConfig {
  org: string;
  repo: string;
  /** The trunk every story branch is cut from and merged into. */
  trunk: string;
  /** Prints an App installation token for the slug given as its one argument. */
  tokenScript: string;
  /** The Python that runs it (its venv has PyJWT). */
  python: string;
  /** The App that pushes, opens and merges PRs. */
  pushApp: string;
  /** The App that posts the workplace/* commit statuses. */
  reviewApp: string;
  /** Where a PR body links the item (GET <linkBase>/api/items/<id>). */
  linkBase: string;
}

export function loadConfig(argv: string[] = process.argv.slice(2), env = process.env): Config {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (value: string | undefined, fallback: number): number => {
    const n = Number(value);
    return value !== undefined && Number.isFinite(n) ? n : fallback;
  };

  return {
    port: num(flag('port') ?? env['WORKPLACE_PORT'], 4317),
    // Bind to loopback only. Anything else needs an explicit --host, and then
    // every request that is not from loopback needs the bearer token.
    host: flag('host') ?? '127.0.0.1',
    openBrowser: !argv.includes('--no-open'),
    version: '0.1.0',
    workplaceDir: flag('workplace-dir') ?? env['IRIS_WORKPLACE_DIR'] ?? join(homedir(), 'iris-workplace'),
    opsDir: env['IRIS_OPS_DIR'] ?? join(homedir(), 'iris-ops'),
    capInr: num(env['WORKPLACE_CAP_INR'], 1000),
    usdInr: num(env['WORKPLACE_USD_INR'], 88),
    sessionRunawayUsd: num(env['WORKPLACE_SESSION_RUNAWAY_USD'], 25),
    contextTokens: num(env['WORKPLACE_CONTEXT_TOKENS'], 24_000),
    digestHour: num(env['WORKPLACE_DIGEST_HOUR'], 9),
    telegram: !argv.includes('--no-telegram') && env['WORKPLACE_TELEGRAM'] !== '0',
    seed: !argv.includes('--no-seed'),
    workDir: env['IRIS_WORK_DIR'] ?? join(homedir(), 'iris-work'),
    stallMinutes: num(env['WORKPLACE_STALL_MINUTES'], 30),
    stallReadyMinutes: num(env['WORKPLACE_STALL_READY_MIN'], 15),
    stallIdleMinutes: num(env['WORKPLACE_STALL_IDLE_MIN'], 10),
    stallReviewMinutes: num(env['WORKPLACE_STALL_REVIEW_MIN'], 30),
    stallBlockedMinutes: num(env['WORKPLACE_STALL_BLOCKED_MIN'], 15),
    dispatchSweepMinutes: num(env['WORKPLACE_DISPATCH_SWEEP_MIN'], 2),
    dispatchIdleMinutes: num(env['WORKPLACE_DISPATCH_IDLE_MIN'], 10),
    dispatchTalkGraceMinutes: num(env['WORKPLACE_DISPATCH_TALK_GRACE_MIN'], 5),
    dispatchBootDelaySeconds: num(env['WORKPLACE_DISPATCH_BOOT_DELAY_SEC'], 60),
    managerEscalateMinutes: num(env['WORKPLACE_MANAGER_ESCALATE_MIN'], 15),
    managerDigestMinutes: num(env['WORKPLACE_MANAGER_DIGEST_MIN'], 20),
    updateDedupeMinutes: num(env['WORKPLACE_UPDATE_DEDUPE_MIN'], 10),
    awsCost: env['WORKPLACE_AWS_COST'] !== '0' && !argv.includes('--no-telegram'),
    push: !argv.includes('--no-push') && env['WORKPLACE_PUSH'] !== '0',
    ownerHandles: (env['WORKPLACE_OWNER_HANDLES'] ?? 'owner,shravan').split(',').map(s => s.trim()).filter(Boolean),
    ...(env['WORKPLACE_PUSH_QUIET'] ? { pushQuiet: env['WORKPLACE_PUSH_QUIET'] } : {}),
    github: {
      org: env['WORKPLACE_GITHUB_ORG'] ?? 'shravan0001jha-iris-hq',
      repo: env['WORKPLACE_GITHUB_REPO'] ?? 'iris',
      trunk: env['WORKPLACE_GITHUB_TRUNK'] ?? 'feat/iris-character',
      tokenScript: env['WORKPLACE_GITHUB_TOKEN_SCRIPT'] ?? join(env['IRIS_OPS_DIR'] ?? join(homedir(), 'iris-ops'), 'github', 'token.py'),
      python: env['WORKPLACE_GITHUB_PYTHON'] ?? join(env['IRIS_OPS_DIR'] ?? join(homedir(), 'iris-ops'), 'github', '.venv', 'bin', 'python'),
      pushApp: env['WORKPLACE_GITHUB_PUSH_APP'] ?? 'iris-workplace',
      reviewApp: env['WORKPLACE_GITHUB_REVIEW_APP'] ?? 'iris-review',
      linkBase: env['WORKPLACE_GITHUB_LINK_BASE'] ?? `http://127.0.0.1:${num(flag('port') ?? env['WORKPLACE_PORT'], 4317)}`,
    },
    evidence: {
      dir: env['WORKPLACE_EVIDENCE_DIR'] ?? join(flag('workplace-dir') ?? env['IRIS_WORKPLACE_DIR'] ?? join(homedir(), 'iris-workplace'), 'evidence'),
      stagingUrl: (env['WORKPLACE_STAGING_URL'] ?? 'https://staging.irisforu.com').replace(/\/+$/, ''),
      stagingScript: env['WORKPLACE_STAGING_SCRIPT'] ?? join(homedir(), 'claude-dev', 'scripts', 'staging.sh'),
      runnerInRepo: 'e2e/scripts/local-run.sh',
      runnerFallback: env['WORKPLACE_EVIDENCE_RUNNER'] ?? join(homedir(), 'iris-e2e', 'scripts', 'local-run.sh'),
      androidHome: env['ANDROID_HOME'] ?? '/opt/homebrew/share/android-commandlinetools',
      javaHome: env['WORKPLACE_JAVA_HOME'] ?? '/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home',
      developerDir: env['WORKPLACE_DEVELOPER_DIR'] ?? '/Applications/Xcode.app/Contents/Developer',
      slots: 2,
      keepBuilds: 4,
      appPaths: { android: 'mobile/android', ios: 'mobile/ios' },
    },
  };
}
