import { API } from '@jkj/shared';
import type {
  Agent, ContextResponse, CreateAgentRequest, HealthResponse,
  LogEntry, McpListResponse, Project,
} from '@jkj/shared';

/**
 * REST client. One function per endpoint, all typed off @jkj/shared, so a
 * server change that breaks the UI breaks the build instead of the page.
 */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return (await res.json()) as T;
}

export const getHealth = () => request<HealthResponse>(API.health);
export const getProjects = () => request<Project[]>(API.projects);
export const getAgents = (projectId?: string) =>
  request<Agent[]>(projectId ? `${API.agents}?projectId=${encodeURIComponent(projectId)}` : API.agents);
export const getTranscript = (agentId: string) => request<LogEntry[]>(API.agentLog(agentId));
export const getContext = (projectId: string) => request<ContextResponse>(API.context(projectId));
export const getMcp = () => request<McpListResponse>(API.mcp);

export const createAgent = (body: CreateAgentRequest) =>
  request<Agent>(API.agents, { method: 'POST', body: JSON.stringify(body) });
