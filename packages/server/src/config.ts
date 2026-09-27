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
    contextTokens: num(env['WORKPLACE_CONTEXT_TOKENS'], 24_000),
    digestHour: num(env['WORKPLACE_DIGEST_HOUR'], 9),
    telegram: !argv.includes('--no-telegram') && env['WORKPLACE_TELEGRAM'] !== '0',
    seed: !argv.includes('--no-seed'),
    workDir: env['IRIS_WORK_DIR'] ?? join(homedir(), 'iris-work'),
  };
}
