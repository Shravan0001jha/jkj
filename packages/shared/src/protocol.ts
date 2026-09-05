/**
 * Wire protocol.
 *
 * REST for anything a page load needs; the socket for everything that
 * changes while you watch. Both sides import these types, so a change here
 * breaks the build rather than production.
 */
import type {
  Agent, ActivityEvent, LogEntry, McpCatalogEntry, McpServer, Project, WorkspaceMode,
} from './types.js';

/** Sent by the server, consumed by the UI. */
export type ServerEvent =
  | { type: 'hello'; version: string; startedAt: string }
  | { type: 'snapshot'; projects: Project[]; agents: Agent[]; mcp: McpServer[] }
  | { type: 'agent.updated'; agent: Agent }
  | { type: 'agent.removed'; agentId: string }
  | { type: 'agent.log'; entry: LogEntry }
  | { type: 'mcp.updated'; server: McpServer }
  | { type: 'activity'; event: ActivityEvent }
  | { type: 'error'; message: string };

/** Sent by the UI, consumed by the server. */
export type ClientCommand =
  | { type: 'subscribe'; projectId: string }
  | { type: 'agent.message'; agentId: string; text: string }
  | { type: 'agent.interrupt'; agentId: string }
  | { type: 'agent.approve'; agentId: string; approvalId: string; decision: ApprovalDecision };

export type ApprovalDecision = 'once' | 'always' | 'deny';

/** REST request/response shapes. */
export interface CreateAgentRequest {
  projectId: string;
  task: string;
  model: string;
  workspace: WorkspaceMode;
  /** How tool calls are handled. 'default' asks you; 'acceptEdits' does not. */
  permissionMode?: 'default' | 'acceptEdits' | 'plan';
  attachments?: Attachment[];
}

/**
 * A file sent along with a message.
 *
 * Images go to the model as images. Anything textual is inlined as a fenced
 * block, because that is what the model can actually read. Binary of any
 * other kind is refused rather than silently dropped.
 */
export interface Attachment {
  name: string;
  mediaType: string;
  /** base64, without a data: prefix. */
  data: string;
}

export interface SendMessageRequest {
  text: string;
  attachments?: Attachment[];
}

export interface McpListResponse {
  installed: McpServer[];
  catalog: McpCatalogEntry[];
}

export interface HealthResponse {
  ok: true;
  name: 'jkj';
  version: string;
  uptimeSeconds: number;
  /** Where Claude Code state was found, or null if this machine has none. */
  claudeHome: string | null;
}

/** Every REST route in one place, so the client can never guess a path. */
export const API = {
  health: '/api/health',
  projects: '/api/projects',
  agents: '/api/agents',
  agent: (id: string) => `/api/agents/${id}`,
  agentLog: (id: string) => `/api/agents/${id}/log`,
  agentResume: (id: string) => `/api/agents/${id}/resume`,
  agentMessage: (id: string) => `/api/agents/${id}/message`,
  agentImage: (id: string, ref: string) =>
    `/api/agents/${id}/image?ref=${encodeURIComponent(ref)}`,
  context: (projectId: string) => `/api/context?projectId=${encodeURIComponent(projectId)}`,
  mcp: '/api/mcp',
  activity: '/api/activity',
  socket: '/ws',
} as const;
