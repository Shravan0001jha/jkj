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

/**
 * How much a session asks before touching your machine.
 *
 *   ask          every tool call waits for you
 *   auto         a classifier decides, and only the risky calls reach you
 *   acceptEdits  file edits run; commands still ask
 *   plan         reads and reasons, changes nothing
 *   dontAsk      nothing is asked at all
 */
export type PermissionMode = 'ask' | 'auto' | 'acceptEdits' | 'plan' | 'dontAsk';

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
  /**
   * Set when this entry is an image. The bytes are fetched separately rather
   * than inlined, so a transcript stays small enough to send on every poll.
   */
  image?: { mediaType: string; ref: string };
}

export type LogKind =
  | 'assistant'  // prose from the agent
  | 'user'       // something you typed
  | 'image'      // an image pasted into the conversation
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
  /** Turns exchanged, when the source can report it. */
  messageCount?: number;
  /** Only meaningful for a session JKJ drives. */
  permissionMode?: PermissionMode;
  /** Tools you have said to stop asking about, this session. */
  alwaysAllowed?: string[];
  /**
   * True when JKJ started this session and owns the process, so it can be
   * messaged and interrupted. Sessions started in a terminal are read-only —
   * that process owns its own input and nothing outside it can type there.
   */
  driven?: boolean;
  approval?: PendingApproval;
}

/**
 * Token counts.
 *
 * `inputTokens` is new input only. Cached context is re-sent on every turn,
 * so counting it reports tens of millions of tokens for an ordinary
 * conversation — a number that measures the cache, not the work.
 */
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

/**
 * Health of a configured MCP server. `unknown` is the honest answer until
 * something has actually connected to it.
 */
export type McpHealth = 'healthy' | 'degraded' | 'unreachable' | 'starting' | 'unknown';

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

export interface ActivityEvent {
  id: string;
  at: string;
  projectId: string;
  kind: 'started' | 'finished' | 'failed' | 'waiting' | 'info';
  message: string;
}
