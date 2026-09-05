/**
 * Domain types. These describe what JKJ manages, not how it talks about it
 * over the wire (see protocol.ts for that).
 */

/** Lifecycle of a single agent run. */
export type AgentStatus =
  | 'idle'      // created, not started
  | 'running'   // actively working
  | 'waiting'   // blocked on a permission prompt or a question for the user
  | 'done'      // finished cleanly
  | 'error';    // stopped on a failure or a denied permission

/** How an agent gets a place on disk to work in. */
export type WorkspaceMode =
  | 'worktree'  // its own git worktree — safe to run in parallel
  | 'branch'    // shares the repo's working tree — writes must be serialised
  | 'readonly'; // may read and run commands; every edit needs approval

/** One entry in an agent transcript. */
export interface LogEntry {
  id: string;
  agentId: string;
  at: string;               // ISO timestamp
  kind: LogKind;
  /** Short label, e.g. the tool name. Empty for assistant/user prose. */
  label: string;
  /** The body: a file path, a command, a sentence. */
  text: string;
  /** Set when this entry represents a subagent run. */
  subagentId?: string;
}

export type LogKind =
  | 'assistant'  // prose from the agent
  | 'user'       // something you typed
  | 'read' | 'edit' | 'bash' | 'search' | 'task' | 'tool'
  | 'error'
  | 'system';    // JKJ itself speaking (interrupted, restarted, …)

/** A permission request the agent is blocked on. */
export interface PendingApproval {
  id: string;
  tool: string;
  input: string;
  reason: string;
  requestedAt: string;
}

export interface Agent {
  id: string;
  projectId: string;
  /** Short slug used in the UI and as the worktree name. */
  name: string;
  task: string;
  model: string;
  status: AgentStatus;
  workspace: WorkspaceMode;
  /** Absolute path the agent actually runs in. */
  cwd: string;
  parentAgentId?: string;   // set for subagents
  startedAt: string;
  endedAt?: string;
  usage: Usage;
  approval?: PendingApproval;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Project {
  id: string;
  name: string;
  /** Absolute path to the repo root. */
  path: string;
  branch: string;
  /** MCP server ids enabled for this project. */
  enabledMcpServers: string[];
}

/** Health of a configured MCP server. */
export type McpHealth = 'healthy' | 'degraded' | 'unreachable' | 'starting';

export interface McpServer {
  id: string;
  name: string;
  /** npm package, binary, or URL depending on transport. */
  source: string;
  transport: 'stdio' | 'http';
  health: McpHealth;
  toolCount: number;
  note?: string;
}

/** An entry in the installable catalog, not yet installed. */
export interface McpCatalogEntry {
  id: string;
  name: string;
  description: string;
  source: string;
  transport: 'stdio' | 'http';
  toolCount: number;
}

/**
 * Context comes in exactly two layers. Central is written once and reaches
 * every agent; project context is scoped to one repo. Resist adding a third.
 */
export type ContextScope = 'central' | 'project';

export interface ContextDoc {
  scope: ContextScope;
  /** null for the central doc. */
  projectId: string | null;
  body: string;
  updatedAt: string;
}

/** Breakdown of the prompt a new agent would receive right now. */
export interface AssembledContext {
  text: string;
  segments: { label: string; tokens: number }[];
  totalTokens: number;
}

export interface ActivityEvent {
  id: string;
  at: string;
  projectId: string;
  kind: 'started' | 'finished' | 'failed' | 'waiting' | 'info';
  message: string;
}
