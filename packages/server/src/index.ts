import type { Config } from './config.js';
import { openDatabase } from './store/db.js';
import { createHttpServer, listen } from './http/server.js';
import { attachSocket } from './ws/hub.js';
import { log } from './util/logger.js';

/**
 * Boot sequence. Everything JKJ starts, starts here, in this order.
 */
export async function start(config: Config): Promise<void> {
  openDatabase(config.dataDir);
  log.info('boot', `data directory ${config.dataDir}`);

  const server = createHttpServer(config);
  attachSocket(server, config.version);
  await listen(server, config);

  // TODO: restore agents that were running when the process last exited.
  // TODO: start the MCP health check timer.
}
