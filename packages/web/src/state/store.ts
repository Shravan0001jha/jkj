import { useRef, useSyncExternalStore } from 'react';
import type {
  ActivityEvent, Agent, ContextDoc, LogEntry, McpServer, Project, ServerEvent,
} from '@jkj/shared';
import * as api from '../api/client.js';
import type { SocketStatus } from '../api/socket.js';

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
  central: ContextDoc;
  projectContexts: Record<string, ContextDoc>;
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

const EMPTY_DOC: ContextDoc = { scope: 'central', projectId: null, body: '', updatedAt: '' };

let state: AppState = {
  projects: [],
  agents: [],
  transcripts: {},
  mcpInstalled: [],
  central: EMPTY_DOC,
  projectContexts: {},
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

/** Blank documents are cached so the selector keeps returning one object. */
const blankDocs = new Map<string, ContextDoc>();

export function projectContext(s: AppState, projectId: string | null): ContextDoc {
  if (!projectId) return EMPTY_DOC;
  const existing = s.projectContexts[projectId];
  if (existing) return existing;

  let blank = blankDocs.get(projectId);
  if (!blank) {
    blank = { scope: 'project', projectId, body: '', updatedAt: '' };
    blankDocs.set(projectId, blank);
  }
  return blank;
}

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
    const { central, project } = await api.getContext(projectId);
    set({ central, projectContexts: { ...state.projectContexts, [projectId]: project } });
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
      // A live session keeps writing; keep the open transcript current.
      if (state.openAgentId === event.agent.id) void loadTranscript(event.agent.id);
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

export const setTab = (tab: TabId): void => set({ tab });

export function openAgent(agentId: string): void {
  set({ openAgentId: agentId, tab: 'agents' });
  void loadTranscript(agentId);
}

export const closeAgent = (): void => set({ openAgentId: null });

export const openCentralContext = (): void => set({ tab: 'context', focusCentral: true });

export const setNewAgentOpen = (open: boolean): void => set({ newAgentOpen: open });

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function showToast(message: string): void {
  set({ toast: message });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => set({ toast: null }), 4000);
}

export function toggleTheme(): void {
  const root = document.documentElement;
  const current = root.getAttribute('data-theme');
  const dark = current ? current === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.setAttribute('data-theme', dark ? 'light' : 'dark');
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

export function setCentralContext(body: string): void {
  set({ central: { ...state.central, scope: 'central', projectId: null, body } });
  debounceSave('central', () => api.putContext('central', body));
}

export function setProjectContextBody(projectId: string, body: string): void {
  set({
    projectContexts: {
      ...state.projectContexts,
      [projectId]: { scope: 'project', projectId, body, updatedAt: new Date().toISOString() },
    },
  });
  debounceSave(`project:${projectId}`, () => api.putContext('project', body, projectId));
}

/* ---------- writes JKJ cannot do yet ---------- */

/**
 * These exist so the buttons that call them keep their final shape. Each one
 * explains the gap instead of pretending, and each is where a real command
 * will go once JKJ can drive a session.
 */
const READ_ONLY = 'JKJ can read your sessions but not drive them yet.';

export const sendMessage = (): void => showToast(READ_ONLY);
export const interruptAgent = (): void => showToast(READ_ONLY);
export const restartAgent = (): void => showToast(READ_ONLY);
export const archiveAgent = (): void => showToast(READ_ONLY);
export const forkAgent = (): void => showToast(READ_ONLY);
export const resolveApproval = (): void => showToast(READ_ONLY);
export const toggleMcp = (): void =>
  showToast('MCP servers are configured with the claude CLI. JKJ shows them read-only.');
export const restartMcp = (): void =>
  showToast('Restarting a server needs JKJ to own the connection. Not yet.');

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
