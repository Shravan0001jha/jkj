import { API } from '@jkj/shared';
import type {
  ActivityEvent, Agent, ContextDoc, ContextResponse, CreateAgentRequest,
  HealthResponse, LogEntry, McpListResponse, Project,
} from '@jkj/shared';

/**
 * REST client. One function per endpoint, typed off @jkj/shared, so a server
 * change that breaks the UI breaks the build instead of the page.
 */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(detail ? `${res.status} — ${detail}` : `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const getHealth = () => request<HealthResponse>(API.health);
export const getProjects = () => request<Project[]>(API.projects);
export const getAgents = () => request<Agent[]>(API.agents);
export const getTranscript = (agentId: string) => request<LogEntry[]>(API.agentLog(encodeURIComponent(agentId)));
export const getContext = (projectId: string) => request<ContextResponse>(API.context(projectId));
export const getMcp = () => request<McpListResponse>(API.mcp);
export const getActivity = () => request<ActivityEvent[]>(API.activity);

export const createAgent = (body: CreateAgentRequest) =>
  request<Agent>(API.agents, { method: 'POST', body: JSON.stringify(body) });

export const resumeAgent = (agentId: string, text: string) =>
  request<Agent>(API.agentResume(encodeURIComponent(agentId)), {
    method: 'POST',
    body: JSON.stringify({ text }),
  });

export const archiveAgent = (agentId: string) =>
  request<{ ok: true }>(API.agent(encodeURIComponent(agentId)), { method: 'DELETE' });

export const putContext = (scope: 'central' | 'project', body: string, projectId?: string) =>
  request<ContextDoc>(
    projectId ? `/api/context?projectId=${encodeURIComponent(projectId)}` : '/api/context',
    { method: 'PUT', body: JSON.stringify({ scope, body }) },
  );
