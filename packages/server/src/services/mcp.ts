import type { McpCatalogEntry, McpServer } from '@jkj/shared';
import { createMemoryStore } from '../store/db.js';

/**
 * MCP servers — installed once for the machine, switched on per project.
 */

const installed = createMemoryStore<McpServer>([
  {
    id: 'filesystem',
    name: 'filesystem',
    source: '@modelcontextprotocol/server-filesystem',
    transport: 'stdio',
    health: 'healthy',
    toolCount: 8,
  },
]);

/** Curated list. Lives in the repo so it can be reviewed in a PR. */
const CATALOG: McpCatalogEntry[] = [
  {
    id: 'github',
    name: 'github',
    description: 'Read and write issues, pull requests and workflow runs.',
    source: 'github-mcp-server',
    transport: 'http',
    toolCount: 42,
  },
];

export function listInstalled(): McpServer[] {
  return installed.all();
}

export function listCatalog(): McpCatalogEntry[] {
  return CATALOG.filter(c => !installed.get(c.id));
}

/**
 * Install a catalog entry.
 *
 * TODO:
 *   - run the install command (npx/uvx/binary download) with a timeout
 *   - start it once to enumerate its tools, then record toolCount
 *   - store any secrets in the OS keychain, never in the data dir
 */
export function install(catalogId: string): McpServer | undefined {
  const entry = CATALOG.find(c => c.id === catalogId);
  if (!entry) return undefined;
  return installed.put({
    id: entry.id,
    name: entry.name,
    source: entry.source,
    transport: entry.transport,
    health: 'starting',
    toolCount: entry.toolCount,
  });
}

/**
 * Restart a server without disturbing the agents using it.
 *
 * TODO: kill the child process, respawn, re-handshake, then re-register its
 * tools with every running agent that had it enabled.
 */
export function restart(serverId: string): McpServer | undefined {
  const server = installed.get(serverId);
  if (!server) return undefined;
  return installed.put({ ...server, health: 'healthy', note: undefined });
}

export function uninstall(serverId: string): void {
  installed.remove(serverId);
}

/** Probe every server and update its health. Called on a timer. */
export function checkHealth(): McpServer[] {
  // TODO: send an MCP `ping` / `tools/list` to each and time it out.
  return installed.all();
}
