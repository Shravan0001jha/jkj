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
  };
}
