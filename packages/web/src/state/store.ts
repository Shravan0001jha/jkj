import type { Agent, McpServer, Project } from '@jkj/shared';

/**
 * Client state.
 *
 * Kept as a plain object plus subscribers so we do not owe anyone a state
 * library this early. If it outgrows this, Zustand is the drop-in.
 *
 * TODO: apply ServerEvents from api/socket.ts here, and have components read
 * through useStore() instead of holding their own copies.
 */
export interface AppState {
  projects: Project[];
  agents: Agent[];
  mcp: McpServer[];
  selectedProjectId: string | null;
  openAgentId: string | null;
}

const initial: AppState = {
  projects: [],
  agents: [],
  mcp: [],
  selectedProjectId: null,
  openAgentId: null,
};

let state: AppState = initial;
const subscribers = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const fn of subscribers) fn();
}

export function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
