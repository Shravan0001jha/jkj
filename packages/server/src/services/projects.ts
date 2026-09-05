import type { Project } from '@jkj/shared';
import { createMemoryStore } from '../store/db.js';

/**
 * Projects — a project is just a directory on disk that JKJ watches.
 *
 * Every function here is the real signature we will keep. Only the bodies
 * change when we wire this to git and the filesystem.
 */

const store = createMemoryStore<Project>([
  // Placeholder row so the UI has something to render before you add a repo.
  {
    id: 'example',
    name: 'example-project',
    path: '~/code/example-project',
    branch: 'main',
    enabledMcpServers: ['filesystem'],
  },
]);

export function listProjects(): Project[] {
  return store.all();
}

export function getProject(id: string): Project | undefined {
  return store.get(id);
}

/**
 * Register a directory as a project.
 *
 * TODO:
 *   - verify the path exists and is a git repo (`git rev-parse --show-toplevel`)
 *   - read the current branch
 *   - import an existing CLAUDE.md into the project context doc if present
 */
export function addProject(path: string): Project {
  const name = path.split('/').filter(Boolean).pop() ?? 'project';
  return store.put({
    id: name,
    name,
    path,
    branch: 'main',
    enabledMcpServers: [],
  });
}

export function removeProject(id: string): void {
  store.remove(id);
}

/** Enable or disable one MCP server for one project. */
export function setMcpEnabled(projectId: string, serverId: string, enabled: boolean): Project | undefined {
  const project = store.get(projectId);
  if (!project) return undefined;
  const set = new Set(project.enabledMcpServers);
  enabled ? set.add(serverId) : set.delete(serverId);
  return store.put({ ...project, enabledMcpServers: [...set] });
}
