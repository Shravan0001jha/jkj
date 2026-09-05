import { join } from 'node:path';
import type { McpCatalogEntry, McpServer } from '@jkj/shared';
import { findClaudeHome, readConfig, readJsonFile, type McpServerConfig } from '../runtime/claude-home.js';
import { getSnapshot } from './workspace.js';

/**
 * MCP servers, read from the configuration Claude Code already uses:
 *
 *   - servers defined for every project, in the settings file
 *   - servers defined for one project, in the same file
 *   - servers a repo ships in its own .mcp.json
 *
 * Health cannot be known without connecting to each one, which JKJ does not
 * do yet — so it reports "unknown" rather than a green tick it did not earn.
 */

export async function listInstalled(): Promise<McpServer[]> {
  const home = findClaudeHome();
  const config = readConfig(home);
  const byId = new Map<string, McpServer>();

  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    byId.set(name, toServer(name, server, 'user settings'));
  }

  for (const project of (await getSnapshot()).projects) {
    const settings = config.projects?.[project.path];
    for (const [name, server] of Object.entries(settings?.mcpServers ?? {})) {
      byId.set(name, toServer(name, server, project.name));
    }

    const local = readJsonFile<{ mcpServers?: Record<string, McpServerConfig> }>(join(project.path, '.mcp.json'));
    for (const [name, server] of Object.entries(local?.mcpServers ?? {})) {
      byId.set(name, toServer(name, server, `${project.name}/.mcp.json`));
    }
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Nothing is installable until JKJ can write the settings file safely. */
export function listCatalog(): McpCatalogEntry[] {
  return [];
}

function toServer(name: string, config: McpServerConfig, origin: string): McpServer {
  const transport = config.url ? 'http' : 'stdio';
  const source = config.url
    ?? [config.command, ...(config.args ?? [])].filter(Boolean).join(' ')
    ?? 'unknown';

  return {
    id: name,
    name,
    source: source || 'unknown',
    transport,
    health: 'unknown',
    // The tool list only exists once a server is running; JKJ has not asked.
    toolCount: 0,
    note: `from ${origin}`,
  };
}
