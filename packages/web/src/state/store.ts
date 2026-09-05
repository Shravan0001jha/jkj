import { useRef, useSyncExternalStore } from 'react';
import type {
  ActivityEvent, Agent, ApprovalDecision, ContextDoc, LogEntry,
  McpCatalogEntry, McpServer, Project, WorkspaceMode,
} from '@jkj/shared';
import { uid, slugify } from '../lib/format.js';

/**
 * Client state.
 *
 * A plain object plus subscribers — no state library until one earns its
 * place. Components read through `useStore(selector)`; nothing mutates
 * `state` outside the actions below.
 *
 * Actions are the seam. Today they change local state directly. When the
 * server is wired up, each one sends a command and lets the resulting
 * ServerEvent apply the change (see api/socket.ts). Component code does not
 * move when that happens.
 */

export type TabId = 'agents' | 'context' | 'mcp' | 'activity';

export interface AppState {
  /* data */
  projects: Project[];
  agents: Agent[];                              // subagents included, via parentAgentId
  transcripts: Record<string, LogEntry[]>;      // agentId -> entries
  mcpInstalled: McpServer[];
  mcpCatalog: McpCatalogEntry[];
  central: ContextDoc;
  projectContexts: Record<string, ContextDoc>;
  activity: ActivityEvent[];

  /* ui */
  selectedProjectId: string;
  tab: TabId;
  openAgentId: string | null;                   // null = the agent grid
  focusCentral: boolean;
  streamPaused: boolean;
  busyMcpId: string | null;                     // restarting or installing
  newAgentOpen: boolean;
  toast: string | null;
}

let state: AppState;
const subscribers = new Set<() => void>();

export function initStore(initial: AppState): void {
  state = initial;
}

export const getState = (): AppState => state;

function set(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const fn of subscribers) fn();
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => void subscribers.delete(fn);
}

/**
 * Read a slice of state.
 *
 * The snapshot is cached and compared one level deep, because most selectors
 * derive a new array every call (`agents.filter(...)`). Without the cache
 * useSyncExternalStore would see a new value on every render and spin.
 */
export function useStore<T>(selector: (s: AppState) => T): T {
  const cache = useRef<{ value: T } | null>(null);

  const snapshot = (): T => {
    const next = selector(state);
    if (cache.current && shallowEqual(cache.current.value, next)) return cache.current.value;
    cache.current = { value: next };
    return next;
  };

  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Equal if the same reference, or the same entries one level down. */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  }
  return false;
}

/* ---------- derived reads ---------- */

export const currentProject = (s: AppState): Project =>
  s.projects.find(p => p.id === s.selectedProjectId) ?? s.projects[0]!;

/** Top-level agents in a project. Subagents are reached through their parent. */
export const projectAgents = (s: AppState, projectId: string): Agent[] =>
  s.agents.filter(a => a.projectId === projectId && !a.parentAgentId);

export const agentById = (s: AppState, id: string | null): Agent | undefined =>
  id ? s.agents.find(a => a.id === id) : undefined;

export const transcriptOf = (s: AppState, agentId: string): LogEntry[] =>
  s.transcripts[agentId] ?? [];

/**
 * A project always has a context document, even before anything is written
 * into it. The blank ones are cached so the selector keeps returning the same
 * object — a fresh one each call would defeat the snapshot cache above.
 */
const blankDocs = new Map<string, ContextDoc>();

export function projectContext(s: AppState, projectId: string): ContextDoc {
  const existing = s.projectContexts[projectId];
  if (existing) return existing;

  let blank = blankDocs.get(projectId);
  if (!blank) {
    blank = { scope: 'project', projectId, body: '', updatedAt: new Date(0).toISOString() };
    blankDocs.set(projectId, blank);
  }
  return blank;
}

/* ---------- ui actions ---------- */

export const selectProject = (projectId: string): void =>
  set({ selectedProjectId: projectId, openAgentId: null, focusCentral: false });

export const setTab = (tab: TabId): void => set({ tab });

export const openAgent = (agentId: string): void =>
  set({ openAgentId: agentId, tab: 'agents' });

export const closeAgent = (): void => set({ openAgentId: null });

export const openCentralContext = (): void => set({ tab: 'context', focusCentral: true });

export const togglePause = (): void => set({ streamPaused: !state.streamPaused });

export const setNewAgentOpen = (open: boolean): void => set({ newAgentOpen: open });

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function showToast(message: string): void {
  set({ toast: message });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => set({ toast: null }), 2800);
}

export function toggleTheme(): void {
  const root = document.documentElement;
  const current = root.getAttribute('data-theme');
  const dark = current ? current === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.setAttribute('data-theme', dark ? 'light' : 'dark');
}

/* ---------- data actions ---------- */

export function appendLog(entry: LogEntry): void {
  set({
    transcripts: {
      ...state.transcripts,
      [entry.agentId]: [...(state.transcripts[entry.agentId] ?? []), entry],
    },
  });
}

export function patchAgent(id: string, patch: Partial<Agent>): void {
  set({ agents: state.agents.map(a => (a.id === id ? { ...a, ...patch } : a)) });
}

export function addAgent(agent: Agent): void {
  set({ agents: [...state.agents, agent], transcripts: { ...state.transcripts, [agent.id]: [] } });
}

export function addActivity(
  projectId: string,
  kind: ActivityEvent['kind'],
  message: string,
): void {
  const event: ActivityEvent = { id: uid('ev'), at: new Date().toISOString(), projectId, kind, message };
  set({ activity: [event, ...state.activity].slice(0, 80) });
}

export function makeEntry(
  agentId: string,
  kind: LogEntry['kind'],
  label: string,
  text: string,
  subagentId?: string,
): LogEntry {
  return { id: uid('ln'), agentId, at: new Date().toISOString(), kind, label, text, subagentId };
}

/* ---------- agent commands ---------- */
/* Each of these becomes a socket command; the local mutation is the stand-in. */

export function sendMessage(agentId: string, text: string): void {
  // TODO: socket.send({ type: 'agent.message', agentId, text })
  appendLog(makeEntry(agentId, 'user', '', text));
  patchAgent(agentId, { status: 'running' });
  appendLog(makeEntry(agentId, 'assistant', '', 'Understood — adjusting course.'));
  addActivity(state.selectedProjectId, 'info', `You steered **${agentById(state, agentId)?.name}**`);
}

export function interruptAgent(agentId: string): void {
  // TODO: socket.send({ type: 'agent.interrupt', agentId })
  patchAgent(agentId, { status: 'idle' });
  appendLog(makeEntry(agentId, 'system', 'Stopped', 'Interrupted. The worktree was left untouched.'));
  addActivity(state.selectedProjectId, 'waiting', `**${agentById(state, agentId)?.name}** interrupted`);
}

export function restartAgent(agentId: string): void {
  patchAgent(agentId, { status: 'running' });
  appendLog(makeEntry(agentId, 'assistant', '', 'Picking up where I left off.'));
  addActivity(state.selectedProjectId, 'started', `**${agentById(state, agentId)?.name}** restarted`);
}

export function archiveAgent(agentId: string): void {
  const name = agentById(state, agentId)?.name;
  const rest = { ...state.transcripts };
  delete rest[agentId];
  set({
    agents: state.agents.filter(a => a.id !== agentId && a.parentAgentId !== agentId),
    transcripts: rest,
    openAgentId: state.openAgentId === agentId ? null : state.openAgentId,
  });
  addActivity(state.selectedProjectId, 'info', `**${name}** archived`);
}

export function forkAgent(agentId: string): void {
  const source = agentById(state, agentId);
  if (!source) return;
  const fork: Agent = {
    ...source,
    id: uid('ag'),
    name: `${source.name}-fork`,
    cwd: `${source.cwd}-fork`,
    status: 'running',
    startedAt: new Date().toISOString(),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    approval: undefined,
  };
  set({
    agents: [...state.agents, fork],
    // A fork inherits the conversation up to this point, then diverges.
    transcripts: { ...state.transcripts, [fork.id]: transcriptOf(state, agentId).slice(0, 3) },
    openAgentId: fork.id,
  });
  addActivity(state.selectedProjectId, 'started', `**${source.name}** forked into **${fork.name}**`);
}

export function resolveApproval(agentId: string, decision: ApprovalDecision): void {
  // TODO: socket.send({ type: 'agent.approve', agentId, approvalId, decision })
  const agent = agentById(state, agentId);
  if (!agent?.approval) return;

  if (decision === 'deny') {
    patchAgent(agentId, { status: 'error', approval: undefined });
    appendLog(makeEntry(agentId, 'error', 'Denied',
      'You denied this command. The agent stopped; the worktree is untouched.'));
    addActivity(agent.projectId, 'failed', `**${agent.name}** stopped — command denied`);
  } else {
    patchAgent(agentId, { status: 'running', approval: undefined });
    appendLog(makeEntry(agentId, 'bash', agent.approval.tool, agent.approval.input));
    if (decision === 'always') showToast(`${agent.approval.tool} is now auto-approved for this project.`);
    addActivity(agent.projectId, 'started', `**${agent.name}** resumed — you approved the request`);
  }
}

export function createAgent(task: string, model: string, workspace: WorkspaceMode): string {
  // TODO: POST /api/agents and let the socket deliver the created agent.
  const project = currentProject(state);
  const name = slugify(task);
  const agent: Agent = {
    id: uid('ag'),
    projectId: project.id,
    name,
    task,
    model,
    status: 'running',
    workspace,
    cwd: workspace === 'worktree' ? `.jkj/worktrees/${name}` : project.path,
    startedAt: new Date().toISOString(),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
  addAgent(agent);
  set({ openAgentId: agent.id, tab: 'agents', newAgentOpen: false });
  addActivity(project.id, 'started', `Started **${name}** on \`${agent.cwd}\``);
  return agent.id;
}

/* ---------- context ---------- */

export function setCentralContext(body: string): void {
  // TODO: PUT /api/context (scope=central)
  set({ central: { ...state.central, body, updatedAt: new Date().toISOString() } });
}

export function setProjectContextBody(projectId: string, body: string): void {
  set({
    projectContexts: {
      ...state.projectContexts,
      [projectId]: { scope: 'project', projectId, body, updatedAt: new Date().toISOString() },
    },
  });
}

/* ---------- mcp ---------- */

export function toggleMcp(projectId: string, serverId: string): void {
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return;
  const enabled = project.enabledMcpServers.includes(serverId);
  const next = enabled
    ? project.enabledMcpServers.filter(id => id !== serverId)
    : [...project.enabledMcpServers, serverId];
  set({ projects: state.projects.map(p => (p.id === projectId ? { ...p, enabledMcpServers: next } : p)) });
  addActivity(projectId, 'info', `MCP **${serverId}** ${enabled ? 'disabled' : 'enabled'} for this project`);
}

export function restartMcp(serverId: string): void {
  // TODO: POST /api/mcp/:id/restart and wait for the mcp.updated event.
  set({ busyMcpId: serverId });
  setTimeout(() => {
    set({
      busyMcpId: null,
      mcpInstalled: state.mcpInstalled.map(m =>
        m.id === serverId ? { ...m, health: 'healthy', note: undefined } : m),
    });
    const server = state.mcpInstalled.find(m => m.id === serverId);
    addActivity(state.selectedProjectId, 'info',
      `MCP **${serverId}** restarted — ${server?.toolCount ?? 0} tools re-registered`);
  }, 1400);
}

export function installMcp(catalogId: string): void {
  // TODO: POST /api/mcp with the catalog id; the server does the install.
  const entry = state.mcpCatalog.find(c => c.id === catalogId);
  if (!entry) return;
  set({ busyMcpId: catalogId });
  setTimeout(() => {
    const server: McpServer = {
      id: entry.id, name: entry.name, source: entry.source,
      transport: entry.transport, health: 'healthy', toolCount: entry.toolCount,
    };
    set({
      busyMcpId: null,
      mcpCatalog: state.mcpCatalog.filter(c => c.id !== catalogId),
      mcpInstalled: [...state.mcpInstalled, server],
      projects: state.projects.map(p =>
        p.id === state.selectedProjectId
          ? { ...p, enabledMcpServers: [...p.enabledMcpServers, server.id] }
          : p),
    });
    addActivity(state.selectedProjectId, 'info', `Installed **${entry.name}** and enabled it here`);
  }, 1600);
}
