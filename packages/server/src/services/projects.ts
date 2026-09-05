import type { Project } from '@jkj/shared';
import { getSnapshot } from './workspace.js';

/**
 * Projects are discovered, not registered: every directory Claude Code has a
 * session for is a project. Adding one means starting a session in it.
 */

export async function listProjects(): Promise<Project[]> {
  return (await getSnapshot()).projects;
}

export async function getProject(id: string): Promise<Project | undefined> {
  return (await getSnapshot()).projects.find(p => p.id === id);
}

/**
 * Enable or disable an MCP server for one project.
 *
 * TODO: write back to the `projects[path].mcpServers` map in the Claude Code
 * settings file. Until JKJ can do that safely — the file is shared with a
 * running CLI — this is read-only.
 */
export function setMcpEnabled(): never {
  throw new Error('JKJ is read-only for now: change MCP servers with the claude CLI.');
}
