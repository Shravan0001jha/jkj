import type { Config } from './config.js';
import { createHttpServer, listen } from './http/server.js';
import { attachSocket } from './ws/hub.js';
import { findClaudeHome } from './runtime/claude-home.js';
import { log } from './util/logger.js';

/**
 * Boot sequence. Everything JKJ starts, starts here, in this order.
 */
export async function start(config: Config): Promise<void> {
  const home = findClaudeHome();
  if (home.present) {
    log.info('boot', `reading Claude Code state from ${home.configDir}`);
  } else {
    log.warn('boot', `no Claude Code state found at ${home.configDir} — the UI will be empty`);
  }

  const server = createHttpServer(config);
  attachSocket(server, config.version);
  await listen(server, config);

  // TODO: probe each MCP server so health is a fact rather than "unknown".
  // TODO: drive sessions, not just read them (see runtime/claude-agent.ts).
}
