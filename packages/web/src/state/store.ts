import { useRef, useSyncExternalStore } from 'react';
import type {
  ActivityEvent, Agent, ApprovalDecision, Attachment, ContextResponse,
  LogEntry, McpServer, Project, ServerEvent,
} from '@jkj/shared';
import * as api from '../api/client.js';
import { sendCommand, type SocketStatus } from '../api/socket.js';

/**
 * Client state.
 *
 * A plain object plus subscribers — no state library until one earns its
 * place. Components read through `useStore(selector)`; nothing mutates
 * `state` outside the actions below.
 *
 * Data comes from the server and only from the server. Actions that would
 * change a Claude Code session are not silently dropped: JKJ is read-only for
 * now, and the ones that cannot work say so.
 */

export type TabId = 'agents' | 'context' | 'mcp' | 'activity';

export interface AppState {
  /* data */
  projects: Project[];
  agents: Agent[];
  transcripts: Record<string, LogEntry[]>;
  mcpInstalled: McpServer[];
  /** Every context layer for the selected project, as it is on disk. */
  context: ContextResponse | null;
  activity: ActivityEvent[];

  /* ui */
  selectedProjectId: string | null;
  tab: TabId;
  openAgentId: string | null;
  focusCentral: boolean;
  connection: SocketStatus;
  loading: boolean;
  error: string | null;
  /** Set when this machine has no Claude Code state to read. */
  claudeHome: string | null;
  newAgentOpen: boolean;
  toast: string | null;
}

let state: AppState = {
  projects: [],
  agents: [],
  transcripts: {},
  mcpInstalled: [],
  context: null,
  activity: [],

  selectedProjectId: null,
  tab: 'agents',
  openAgentId: null,
  focusCentral: false,
  connection: 'connecting',
  loading: true,
  error: null,
  claudeHome: null,
  newAgentOpen: false,
  toast: null,
};

const subscribers = new Set<() => void>();

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

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  }
  return false;
}

/* ---------- derived reads ---------- */

export const currentProject = (s: AppState): Project | undefined =>
  s.projects.find(p => p.id === s.selectedProjectId);

export const projectAgents = (s: AppState, projectId: string | null): Agent[] =>
  projectId ? s.agents.filter(a => a.projectId === projectId && !a.parentAgentId) : [];

export const agentById = (s: AppState, id: string | null): Agent | undefined =>
  id ? s.agents.find(a => a.id === id) : undefined;

export const transcriptOf = (s: AppState, agentId: string): LogEntry[] =>
  s.transcripts[agentId] ?? [];

/** One layer of the selected project's context, by its id. */
export const contextLayer = (s: AppState, id: string) =>
  s.context?.layers.find(l => l.id === id);

/* ---------- loading ---------- */

/** First paint: everything the shell needs before it can render anything. */
export async function loadWorkspace(): Promise<void> {
  try {
    const [health, projects, agents] = await Promise.all([
      api.getHealth(), api.getProjects(), api.getAgents(),
    ]);

    set({
      claudeHome: health.claudeHome,
      projects,
      agents,
      selectedProjectId: state.selectedProjectId ?? projects[0]?.id ?? null,
      loading: false,
      error: null,
    });

    if (state.selectedProjectId) void loadContext(state.selectedProjectId);
    void loadMcp();
    void loadActivity();
  } catch (err) {
    set({ loading: false, error: message(err) });
  }
}

export async function loadTranscript(agentId: string): Promise<void> {
  try {
    const entries = await api.getTranscript(agentId);
    set({ transcripts: { ...state.transcripts, [agentId]: entries } });
  } catch (err) {
    set({ error: message(err) });
  }
}

export async function loadContext(projectId: string): Promise<void> {
  try {
    set({ context: await api.getContext(projectId) });
  } catch (err) {
    set({ error: message(err) });
  }
}

export async function loadMcp(): Promise<void> {
  try {
    const { installed } = await api.getMcp();
    set({ mcpInstalled: installed });
  } catch (err) {
    set({ error: message(err) });
  }
}

export async function loadActivity(): Promise<void> {
  try {
    set({ activity: await api.getActivity() });
  } catch (err) {
    set({ error: message(err) });
  }
}

/** Apply one event from the socket. */
export function applyServerEvent(event: ServerEvent): void {
  switch (event.type) {
    case 'snapshot':
      set({ projects: event.projects, agents: event.agents, mcpInstalled: event.mcp, loading: false });
      if (!state.selectedProjectId && event.projects[0]) set({ selectedProjectId: event.projects[0].id });
      break;

    case 'agent.updated': {
      const known = state.agents.some(a => a.id === event.agent.id);
      set({
        agents: known
          ? state.agents.map(a => (a.id === event.agent.id ? event.agent : a))
          : [...state.agents, event.agent],
      });
      // A session JKJ drives streams its own lines, so only re-read the ones
      // being written by a CLI somewhere else.
      if (state.openAgentId === event.agent.id && !event.agent.driven) {
        void loadTranscript(event.agent.id);
      }
      break;
    }

    case 'agent.log': {
      const existing = state.transcripts[event.entry.agentId];
      if (!existing) break;   // not open, so nothing to append to
      if (existing.some(e => e.id === event.entry.id)) break;   // already have it
      set({
        transcripts: {
          ...state.transcripts,
          [event.entry.agentId]: [...existing, event.entry],
        },
      });
      break;
    }

    case 'agent.removed':
      set({ agents: state.agents.filter(a => a.id !== event.agentId) });
      break;

    case 'error':
      showToast(event.message);
      break;

    default:
      break;
  }
}

export const setConnection = (connection: SocketStatus): void => set({ connection });

/* ---------- ui actions ---------- */

export function selectProject(projectId: string): void {
  set({ selectedProjectId: projectId, openAgentId: null, focusCentral: false });
  void loadContext(projectId);
}

export function setTab(tab: TabId): void {
  set({ tab });
  // These files are edited outside JKJ all the time — by you in an editor, by
  // Claude as it learns. Re-read them whenever the tab is opened rather than
  // showing whatever was true when the page loaded.
  if (tab === 'context' && state.selectedProjectId) void loadContext(state.selectedProjectId);
}

export function openAgent(agentId: string): void {
  set({ openAgentId: agentId, tab: 'agents' });
  void loadTranscript(agentId);
}

export const closeAgent = (): void => set({ openAgentId: null });

export function openCentralContext(): void {
  set({ tab: 'context', focusCentral: true });
  if (state.selectedProjectId) void loadContext(state.selectedProjectId);
}

export const setNewAgentOpen = (open: boolean): void => set({ newAgentOpen: open });

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function showToast(message: string): void {
  set({ toast: message });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => set({ toast: null }), 4000);
}

export function toggleTheme(): void {
  const root = document.documentElement;
  const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  root.setAttribute('data-theme', next);
  try {
    localStorage.setItem('jkj:theme', next);
  } catch {
    // Not being able to remember the choice is not a reason to refuse it.
  }
}

/* ---------- context edits ---------- */

/**
 * Context edits go straight to the CLAUDE.md files Claude Code already reads,
 * so they are debounced rather than saved on every keystroke.
 */
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function debounceSave(key: string, save: () => Promise<unknown>): void {
  clearTimeout(saveTimers.get(key));
  saveTimers.set(key, setTimeout(() => {
    save().catch(err => showToast(`Could not save: ${message(err)}`));
  }, 700));
}

export function editContext(id: string, body: string): void {
  const context = state.context;
  if (!context) return;

  set({
    context: {
      ...context,
      layers: context.layers.map(layer =>
        layer.id === id ? { ...layer, body, tokens: Math.round(body.length / 3.6) } : layer),
    },
  });

  debounceSave(id, () => api.putContext(context.projectId, id, body));
}

/* ---------- driving a session ---------- */

/**
 * Only sessions JKJ started can be driven. One started in a terminal belongs
 * to that process, and nothing here can type into it.
 */
const NOT_OURS = 'That session is open in a terminal. Close it there, then continue it here.';

export async function createSession(
  task: string,
  model: string,
  permissionMode: 'default' | 'acceptEdits' | 'plan',
  attachments: Attachment[] = [],
): Promise<void> {
  const projectId = state.selectedProjectId;
  if (!projectId) return;

  try {
    const agent = await api.createAgent({
      projectId, task, model, workspace: 'branch', permissionMode, attachments,
    });
    set({
      agents: [agent, ...state.agents],
      openAgentId: agent.id,
      tab: 'agents',
      newAgentOpen: false,
    });

    // The run starts logging the moment it is created, which is before this
    // client has anywhere to put those lines. Read what it already has rather
    // than starting from an empty transcript that is missing the prompt.
    await loadTranscript(agent.id);
  } catch (err) {
    showToast(`Could not start it: ${message(err)}`);
  }
}

/**
 * One box, two behaviours. A session JKJ drives takes the message straight
 * away; a finished one is picked back up first, and the message becomes its
 * next turn. A session still open in a terminal is the only one that cannot
 * be typed into, and it says so instead of offering a box.
 */
export async function sendMessage(
  agentId: string,
  text: string,
  attachments: Attachment[] = [],
): Promise<void> {
  const agent = agentById(state, agentId);
  if (!agent) return;

  try {
    if (agent.driven) {
      // Sent over REST rather than the socket: attachments are far larger
      // than anything else the socket carries, and one path is easier to
      // trust than a fast one beside a slow one.
      await api.postMessage(agentId, text, attachments);
      return;
    }

    if (agent.status === 'running' || agent.status === 'waiting') return showToast(NOT_OURS);

    const resumed = await api.resumeAgent(agentId, text, attachments);
    set({
      agents: [resumed, ...state.agents.filter(a => a.id !== agentId)],
      openAgentId: resumed.id,
    });
    await loadTranscript(resumed.id);
  } catch (err) {
    showToast(message(err));
  }
}

export function interruptAgent(agentId: string): void {
  const agent = agentById(state, agentId);
  if (!agent?.driven) return showToast(NOT_OURS);
  sendCommand({ type: 'agent.interrupt', agentId });
}

export function resolveApproval(agentId: string, decision: ApprovalDecision): void {
  sendCommand({ type: 'agent.approve', agentId, approvalId: '', decision });
}

export async function archiveAgent(agentId: string): Promise<void> {
  const agent = agentById(state, agentId);
  if (!agent?.driven) return showToast('Only sessions JKJ started can be closed from here.');

  try {
    await api.archiveAgent(agentId);
    set({ agents: state.agents.filter(a => a.id !== agentId), openAgentId: null });
  } catch (err) {
    showToast(message(err));
  }
}

export const forkAgent = (): void =>
  showToast('Forking a session is not wired up yet.');

export const toggleMcp = (): void =>
  showToast('MCP servers are configured with the claude CLI. JKJ shows them read-only.');

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
