#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { start } from './index.js';
import { log } from './util/logger.js';

/**
 * `jkj` — start the Iris Workplace and open it in a browser.
 *
 * Flags:
 *   --port <n>        default 4317
 *   --host <addr>     default 127.0.0.1 (loopback only)
 *   --data-dir <p>    default ~/.jkj
 *   --no-open         do not launch a browser
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const running = await start(config);

  const url = `http://${config.host}:${config.port}`;
  log.info('workplace', `ready at ${url}`);
  // Stop, then exit; and exit anyway after 20 s, so a hung close (an open socket, a slow handoff)
  // can never leave a listener-less process alive with the lock.
  const shutdown = () => {
    setTimeout(() => { log.warn('workplace', 'stop did not finish in 20 s; exiting'); process.exit(1); }, 20_000).unref();
    void running.stop().then(() => process.exit(0), err => { log.error('workplace', String(err)); process.exit(1); });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (config.openBrowser) openBrowser(url);
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
}

main().catch(err => {
  log.error('workplace', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
