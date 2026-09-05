import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Everything JKJ needs to know before it starts. Read once at boot so the
 * rest of the code never touches process.env directly.
 */
export interface Config {
  port: number;
  host: string;
  /** Where projects, agents and context are persisted. */
  dataDir: string;
  /** Open the browser on boot. */
  openBrowser: boolean;
  version: string;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  return {
    port: Number(flag('port') ?? process.env.JKJ_PORT ?? 4317),
    // Bind to loopback only. Anything else needs an explicit --host.
    host: flag('host') ?? '127.0.0.1',
    dataDir: flag('data-dir') ?? process.env.JKJ_DATA_DIR ?? join(homedir(), '.jkj'),
    openBrowser: !argv.includes('--no-open'),
    version: '0.0.1',
  };
}
