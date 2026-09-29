import { useRef, useSyncExternalStore } from 'react';
import type {
  Agent, ApprovalDecision, Attachment, ContextResponse, Coverage, EmployeeCard, EmployeeDetail,
  FeatureBoard, FeatureDetail, HealthSignals, InboxItem, LogEntry, OfficeResponse, OrgResponse,
  PermissionMode, Pivot, PivotRows, Release, ReleaseReadiness, Requirement, RoomThread, RoomThreadDetail, ServerEvent, SpendSummary,
  WorkplaceHealthResponse, WorkplaceServerEvent, CooMessage,
} from '@jkj/shared';
import * as api from '../api/client.js';
import { sendCommand, type SocketStatus } from '../api/socket.js';

/**
 * Client state.
 *
 * A plain object plus subscribers — no state library until one earns its
 * place. Components read through `useStore(selector)`; nothing mutates
 * `state` outside the actions below. Data comes from the server and only
 * from the server; the socket keeps it current.
 */

export type RouteName = 'office' | 'org' | 'inbox' | 'room' | 'features' | 'employee' | 'assign' | 'releases' | 'spend';

export interface Route {
  name: RouteName;
  id?: string;
}

export interface AppState {
  /* navigation */
  route: Route;

  /* workplace data */
  health: WorkplaceHealthResponse | null;
  office: OfficeResponse | null;
  org: OrgResponse | null;
  inbox: InboxItem[];
  features: FeatureBoard | null;
  featureDetails: Record<string, FeatureDetail>;
  pivot: Pivot | null;
  pivotRows: PivotRows;
  coverage: Coverage | null;
  requirements: Requirement[];
  employees: Record<string, EmployeeDetail>;
  employeeContext: Record<string, ContextResponse>;
  releases: Release[];
  releaseLogs: Record<string, string[]>;
  /** Per shippable: done and unreleased, the release in flight, the last one done. */
  readiness: ReleaseReadiness[];
  spend: SpendSummary | null;
  signals: HealthSignals | null;
  /* the Team Room: every thread, and the messages of the ones opened */
  room: RoomThread[];
  roomThreads: Record<string, RoomThreadDetail>;
  /** The owner's Talk with "Claude — COO" (loopback only; empty when opened through the relay). */
  cooLog: CooMessage[];

  /* sessions */
  agents: Agent[];
  transcripts: Record<string, LogEntry[]>;
  /** The session open on the employee page (a subagent run, when one is drilled into). */
  openAgentId: string | null;

  /* ui */
  connection: SocketStatus;
  loading: boolean;
  error: string | null;
  toast: string | null;
}

let state: AppState = {
  route: parseHash(location.hash),

  health: null,
  office: null,
  org: null,
  inbox: [],
  features: null,
  featureDetails: {},
  pivot: null,
  pivotRows: 'charter',
  coverage: null,
  requirements: [],
  employees: {},
  employeeContext: {},
  releases: [],
  releaseLogs: {},
  readiness: [],
  spend: null,
  signals: null,
  room: [],
  roomThreads: {},
  cooLog: [],

  agents: [],
  transcripts: {},
  openAgentId: null,

  connection: 'connecting',
  loading: true,
  error: null,
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
 * Read a slice of state. The snapshot is cached and compared one level deep,
 * because most selectors derive a new array every call.
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

/* ---------- routing ---------- */

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const name = (parts[0] ?? 'office') as RouteName;
  const known: RouteName[] = ['office', 'org', 'inbox', 'room', 'features', 'employee', 'assign', 'releases', 'spend'];
  if (!known.includes(name)) return { name: 'office' };
  return parts[1] ? { name, id: decodeURIComponent(parts[1]) } : { name };
}

export const hrefFor = (name: RouteName, id?: string): string =>
  id ? `#/${name}/${encodeURIComponent(id)}` : `#/${name}`;

export function navigate(name: RouteName, id?: string): void {
  location.hash = hrefFor(name, id);
}

/** Called once from the App; the hash is the source of truth. */
export function watchHash(): () => void {
  const apply = (): void => {
    const route = parseHash(location.hash);
    set({ route, openAgentId: null });
    void loadRoute(route);
  };
  window.addEventListener('hashchange', apply);
  apply();
  return () => window.removeEventListener('hashchange', apply);
}

/** What each screen needs, re-read every time it is opened. */
export async function loadRoute(route: Route): Promise<void> {
  try {
    switch (route.name) {
      case 'office': await loadOffice(); break;
      case 'org': await loadOrg(); break;
      case 'inbox': await loadInbox(); break;
      case 'room':
        await Promise.all([loadRoom(), state.org ? Promise.resolve() : loadOrg()]);
        if (route.id) await loadThread(route.id);
        break;
      case 'features':
        await Promise.all([loadFeatures(), loadCoverage(), loadPivot(state.pivotRows)]);
        if (route.id) await loadFeature(route.id);
        break;
      case 'employee': if (route.id) await loadEmployee(route.id); break;
      case 'assign': await Promise.all([loadOrg(), loadRequirements()]); break;
      case 'releases': await Promise.all([loadReleases(), loadReadiness()]); break;
      case 'spend': await Promise.all([loadSpend(), loadSignals()]); break;
    }
  } catch (err) {
    showToast(message(err));
  }
}

/* ---------- loading ---------- */

export async function loadWorkspace(): Promise<void> {
  try {
    const [health, office, inbox] = await Promise.all([api.getHealth(), api.getOffice(), api.getInbox()]);
    set({ health, office, inbox, loading: false, error: null });
  } catch (err) {
    set({ loading: false, error: message(err) });
  }
}

export async function loadOffice(): Promise<void> {
  set({ office: await api.getOffice() });
}

export async function loadOrg(): Promise<void> {
  set({ org: await api.getOrg() });
}

export async function loadInbox(): Promise<void> {
  set({ inbox: await api.getInbox() });
}

export async function loadFeatures(): Promise<void> {
  set({ features: await api.getFeatures() });
}

export async function loadFeature(id: string): Promise<void> {
  const detail = await api.getFeature(id);
  set({ featureDetails: { ...state.featureDetails, [id]: detail } });
}

export async function loadPivot(rows: PivotRows): Promise<void> {
  set({ pivotRows: rows, pivot: await api.getPivot(rows) });
}

export async function loadCoverage(): Promise<void> {
  set({ coverage: await api.getCoverage() });
}

export async function loadRequirements(group?: string): Promise<void> {
  set({ requirements: await api.getRequirements(group) });
}

export async function loadEmployee(id: string): Promise<void> {
  const [detail, context] = await Promise.all([api.getEmployee(id), api.getEmployeeContext(id).catch(() => null)]);
  const known = new Map(state.agents.map(a => [a.id, a]));
  for (const session of detail.sessions) known.set(session.id, session);
  set({
    employees: { ...state.employees, [id]: detail },
    ...(context ? { employeeContext: { ...state.employeeContext, [id]: context } } : {}),
    agents: [...known.values()],
  });
}

export async function loadReleases(): Promise<void> {
  set({ releases: await api.getReleases() });
}

export async function loadReadiness(): Promise<void> {
  set({ readiness: await api.getReleaseReadiness() });
}

export async function loadRoom(): Promise<void> {
  set({ room: (await api.getRoom()).threads });
}

export async function loadThread(id: string): Promise<void> {
  const detail = await api.getThread(id);
  set({ roomThreads: { ...state.roomThreads, [id]: detail } });
}

/** The COO bridge. Silently empty off loopback (through the relay) rather than a red error banner. */
export async function loadCooLog(): Promise<void> {
  try { set({ cooLog: await api.getCooLog() }); } catch { /* loopback only; the relay 400s this on purpose */ }
}

export async function sendToCoo(text: string): Promise<void> {
  try {
    const sent = await api.sendCooMessage(text);
    if (!state.cooLog.some(m => m.id === sent.id)) set({ cooLog: [...state.cooLog, sent] });
  } catch (err) {
    showToast(message(err));
  }
}

export async function loadSpend(): Promise<void> {
  set({ spend: await api.getSpend() });
}

export async function loadSignals(): Promise<void> {
  set({ signals: await api.getSignals() });
}

export async function loadTranscript(agentId: string): Promise<void> {
  try {
    const entries = await api.getTranscript(agentId);
    set({ transcripts: { ...state.transcripts, [agentId]: entries } });
  } catch (err) {
    set({ error: message(err) });
  }
}

/* ---------- socket ---------- */

export function applyServerEvent(event: ServerEvent | WorkplaceServerEvent): void {
  switch (event.type) {
    case 'snapshot':
      set({ agents: mergeAgents(state.agents, event.agents), loading: false });
      break;

    case 'agent.updated': {
      const known = state.agents.some(a => a.id === event.agent.id);
      set({
        agents: known
          ? state.agents.map(a => (a.id === event.agent.id ? event.agent : a))
          : [...state.agents, event.agent],
      });
      // The employee page shows the session, so keep the detail in step.
      if (event.agent.employeeId && state.employees[event.agent.employeeId]) {
        const detail = state.employees[event.agent.employeeId]!;
        const sessions = detail.sessions.some(s => s.id === event.agent.id)
          ? detail.sessions.map(s => (s.id === event.agent.id ? event.agent : s))
          : [event.agent, ...detail.sessions];
        set({ employees: { ...state.employees, [event.agent.employeeId]: { ...detail, sessions } } });
      }
      break;
    }

    case 'agent.log': {
      const existing = state.transcripts[event.entry.agentId];
      if (!existing) break;
      if (existing.some(e => e.id === event.entry.id)) break;
      set({ transcripts: { ...state.transcripts, [event.entry.agentId]: [...existing, event.entry] } });
      break;
    }

    case 'agent.removed':
      set({ agents: state.agents.filter(a => a.id !== event.agentId) });
      break;

    case 'office.updated':
      set({ office: patchCard(state.office, event.card) });
      if (state.employees[event.card.employee.id]) {
        const detail = state.employees[event.card.employee.id]!;
        set({ employees: { ...state.employees, [event.card.employee.id]: { ...detail, employee: event.card.employee, spendTodayInr: event.card.spendTodayInr } } });
      }
      break;

    case 'inbox.updated': {
      const known = state.inbox.some(i => i.id === event.item.id);
      const inbox = known ? state.inbox.map(i => (i.id === event.item.id ? event.item : i)) : [event.item, ...state.inbox];
      const openCount = inbox.filter(i => i.state === 'open').length;
      // The same item sits on every concerned employee's page; an answer anywhere clears it there too.
      const employees = { ...state.employees };
      for (const [id, detail] of Object.entries(employees)) {
        const rest = detail.needsYou.filter(i => i.id !== event.item.id);
        const mine = event.item.state === 'open' && event.item.affects.includes(id);
        employees[id] = { ...detail, needsYou: mine ? [event.item, ...rest] : rest };
      }
      set({
        inbox, employees,
        ...(state.office ? { office: { ...state.office, needsYou: openCount, counts: { ...state.office.counts, needsYou: openCount } } } : {}),
      });
      break;
    }

    case 'room.thread': {
      const known = state.room.some(t => t.id === event.thread.id);
      const room = known ? state.room.map(t => (t.id === event.thread.id ? event.thread : t)) : [event.thread, ...state.room];
      const detail = state.roomThreads[event.thread.id];
      set({ room, ...(detail ? { roomThreads: { ...state.roomThreads, [event.thread.id]: { ...detail, thread: event.thread } } } : {}) });
      break;
    }

    case 'room.message': {
      const known = state.room.some(t => t.id === event.thread.id);
      const room = known ? state.room.map(t => (t.id === event.thread.id ? event.thread : t)) : [event.thread, ...state.room];
      const detail = state.roomThreads[event.thread.id];
      const messages = detail && !detail.messages.some(m => m.id === event.message.id) ? [...detail.messages, event.message] : detail?.messages;
      set({ room, ...(detail ? { roomThreads: { ...state.roomThreads, [event.thread.id]: { thread: event.thread, messages: messages ?? [] } } } : {}) });
      break;
    }

    case 'coo.message': {
      if (!state.cooLog.some(m => m.id === event.message.id)) set({ cooLog: [...state.cooLog, event.message] });
      break;
    }

    case 'work.updated':
      if (event.item.kind === 'feature' && state.features) {
        const known = state.features.features.some(f => f.id === event.item.id);
        const features = known ? state.features.features.map(f => (f.id === event.item.id ? event.item : f)) : [event.item, ...state.features.features];
        set({ features: { ...state.features, features, byState: countBy(features.map(f => f.state)) } });
      }
      // The status lines are derived on the server; re-read the board (and the open feature) rather than guess.
      if (state.route.name === 'features') {
        void loadFeatures();
        if (event.item.featureId && state.featureDetails[event.item.featureId]) void loadFeature(event.item.featureId);
      }
      if (event.item.featureId && state.featureDetails[event.item.featureId]) {
        const detail = state.featureDetails[event.item.featureId]!;
        const known = detail.assignments.some(a => a.id === event.item.id);
        const assignments = known ? detail.assignments.map(a => (a.id === event.item.id ? event.item : a)) : [...detail.assignments, event.item];
        set({ featureDetails: { ...state.featureDetails, [event.item.featureId]: { ...detail, assignments } } });
      }
      if (event.item.employeeId && state.employees[event.item.employeeId]) {
        const detail = state.employees[event.item.employeeId]!;
        const known = detail.assignments.some(a => a.id === event.item.id);
        const assignments = known ? detail.assignments.map(a => (a.id === event.item.id ? event.item : a)) : [event.item, ...detail.assignments];
        set({ employees: { ...state.employees, [event.item.employeeId]: { ...detail, assignments } } });
      }
      break;

    case 'proposal.updated':
      if (state.org) {
        const known = state.org.proposals.some(p => p.id === event.proposal.id);
        const proposals = known ? state.org.proposals.map(p => (p.id === event.proposal.id ? event.proposal : p)) : [event.proposal, ...state.org.proposals];
        set({ org: { ...state.org, proposals } });
        // An applied proposal changes the org; re-read it rather than guess.
        if (event.proposal.state === 'applied' && state.route.name === 'org') void loadOrg();
      }
      break;

    case 'release.updated': {
      const known = state.releases.some(r => r.id === event.release.id);
      set({ releases: known ? state.releases.map(r => (r.id === event.release.id ? event.release : r)) : [event.release, ...state.releases] });
      if (state.route.name === 'releases') void loadReadiness().catch(() => undefined);
      break;
    }

    case 'release.log':
      set({ releaseLogs: { ...state.releaseLogs, [event.id]: [...(state.releaseLogs[event.id] ?? []), event.line] } });
      break;

    case 'spend.updated':
      set({ spend: event.summary, ...(state.office ? { office: { ...state.office, spend: event.summary } } : {}) });
      break;

    case 'signals.updated':
      set({ signals: event.signals });
      break;

    case 'alert':
      showToast(event.level === 'info' ? event.title : `${event.title} — ${event.body}`);
      break;

    case 'error':
      showToast(event.message);
      break;

    default:
      break;
  }
}

function mergeAgents(current: Agent[], incoming: Agent[]): Agent[] {
  const byId = new Map(current.map(a => [a.id, a]));
  for (const a of incoming) byId.set(a.id, a);
  return [...byId.values()];
}

function patchCard(office: OfficeResponse | null, card: EmployeeCard): OfficeResponse | null {
  if (!office) return office;
  let found = false;
  const units = office.units.map(u => ({
    ...u,
    employees: u.employees.map(e => {
      if (e.employee.id !== card.employee.id) return e;
      found = true;
      return card;
    }),
  }));
  if (!found) {
    // A new hire: put it in its unit, or the first one.
    const target = units.find(u => u.unit.id === card.employee.unitId) ?? units[0];
    if (target) target.employees = [...target.employees, card];
  }
  return { ...office, units };
}

const countBy = (keys: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = (out[k] ?? 0) + 1;
  return out;
};

export const setConnection = (connection: SocketStatus): void => set({ connection });

/* ---------- derived reads ---------- */

export const agentById = (s: AppState, id: string | null): Agent | undefined =>
  id ? s.agents.find(a => a.id === id) : undefined;

export const transcriptOf = (s: AppState, agentId: string): LogEntry[] =>
  s.transcripts[agentId] ?? [];

export const needsYouCount = (s: AppState): number =>
  s.office?.needsYou ?? s.inbox.filter(i => i.state === 'open').length;

/* ---------- actions ---------- */

export async function answerInbox(id: string, optionId: string, note?: string): Promise<void> {
  try {
    const item = await api.answerInbox(id, optionId, note);
    set({ inbox: state.inbox.map(i => (i.id === id ? item : i)) });
    showToast(`Answered: ${item.title}`);
  } catch (err) {
    showToast(message(err));
  }
}

/* ---------- the Team Room ---------- */

export async function openThread(title: string, text: string, charterIds: string[] = []): Promise<string | null> {
  try {
    const detail = await api.createThread({ title, text, charterIds });
    set({ roomThreads: { ...state.roomThreads, [detail.thread.id]: detail }, room: [detail.thread, ...state.room.filter(t => t.id !== detail.thread.id)] });
    return detail.thread.id;
  } catch (err) {
    showToast(message(err));
    return null;
  }
}

export async function postToThread(id: string, text: string): Promise<void> {
  try {
    const m = await api.postRoomMessage(id, { text });
    const detail = state.roomThreads[id];
    if (detail && !detail.messages.some(x => x.id === m.id)) set({ roomThreads: { ...state.roomThreads, [id]: { ...detail, messages: [...detail.messages, m] } } });
  } catch (err) {
    showToast(message(err));
  }
}

export async function resolveThread(id: string, summary: string): Promise<void> {
  try {
    const thread = await api.resolveThread(id, { summary });
    const detail = state.roomThreads[id];
    set({ room: state.room.map(t => (t.id === id ? thread : t)), ...(detail ? { roomThreads: { ...state.roomThreads, [id]: { ...detail, thread } } } : {}) });
    showToast('Thread resolved.');
  } catch (err) {
    showToast(message(err));
  }
}

export async function saveCharter(id: string, body: string): Promise<void> {
  try {
    await api.putCharter(id, body);
    showToast('Charter saved.');
    await loadOrg();
  } catch (err) {
    showToast(message(err));
  }
}

/** Talk to an employee: continues its open session, or starts one from the files. */
export async function talkTo(employeeId: string, text: string, attachments: Attachment[] = []): Promise<void> {
  try {
    const agent = await api.talkTo(employeeId, text, attachments);
    set({ agents: mergeAgents(state.agents, [agent]), openAgentId: agent.id });
    await loadTranscript(agent.id);
    await loadEmployee(employeeId);
  } catch (err) {
    showToast(message(err));
  }
}

/** The default Talk: the Chief of Staff. Opens her page with the session. */
export async function talkToChiefOfStaff(text: string): Promise<void> {
  try {
    const agent = await api.talkToChiefOfStaff(text);
    set({ agents: mergeAgents(state.agents, [agent]), openAgentId: agent.id });
    if (agent.employeeId) navigate('employee', agent.employeeId);
  } catch (err) {
    showToast(message(err));
  }
}

/** A request in the owner's words: Asha turns it into a feature with a spec. */
export async function sendRequest(text: string, platformIds: string[] = []): Promise<string | null> {
  try {
    const made = await api.createRequest({ text, platformIds });
    await loadFeatures();
    showToast(made.status.line);
    return made.feature.id;
  } catch (err) {
    showToast(message(err));
    return null;
  }
}

export async function endEmployeeSession(employeeId: string): Promise<void> {
  try {
    showToast('Asking for the handoff…');
    await api.endSession(employeeId);
    set({ openAgentId: null });
    await loadEmployee(employeeId);
    showToast('Session ended. The handoff is in the files.');
  } catch (err) {
    showToast(message(err));
  }
}

export const openAgent = (agentId: string): void => {
  set({ openAgentId: agentId });
  void loadTranscript(agentId);
};

export const closeAgent = (): void => set({ openAgentId: null });

/** A message to a session the Workplace drives. */
export async function sendMessage(agentId: string, text: string, attachments: Attachment[] = []): Promise<void> {
  const agent = agentById(state, agentId);
  if (!agent) return;
  try {
    if (agent.driven) {
      await api.postMessage(agentId, text, attachments);
      return;
    }
    if (agent.employeeId) {
      await talkTo(agent.employeeId, text, attachments);
      return;
    }
    showToast('That session has ended. Talk to the employee to start a new one.');
  } catch (err) {
    showToast(message(err));
  }
}

export function interruptAgent(agentId: string): void {
  if (!sendCommand({ type: 'agent.interrupt', agentId })) showToast('Not connected to the server.');
}

export function resolveApproval(agentId: string, decision: ApprovalDecision): void {
  sendCommand({ type: 'agent.approve', agentId, approvalId: '', decision });
}

export function setPermissionMode(agentId: string, mode: PermissionMode): void {
  if (!sendCommand({ type: 'agent.mode', agentId, mode })) showToast('Not connected to the server.');
}

/** Context edits go straight to the files; debounced rather than saved per keystroke. */
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function editEmployeeContext(employeeId: string, id: string, body: string): void {
  const context = state.employeeContext[employeeId];
  if (!context) return;
  set({
    employeeContext: {
      ...state.employeeContext,
      [employeeId]: {
        ...context,
        layers: context.layers.map(layer =>
          layer.id === id ? { ...layer, body, tokens: Math.round(body.length / 3.6) } : layer),
      },
    },
  });
  const key = `${employeeId}:${id}`;
  clearTimeout(saveTimers.get(key));
  saveTimers.set(key, setTimeout(() => {
    api.putEmployeeContext(employeeId, id, body).catch(err => showToast(`Could not save: ${message(err)}`));
  }, 700));
}

export async function decompose(featureId: string): Promise<void> {
  try {
    await api.decomposeFeature(featureId);
    await Promise.all([loadFeature(featureId), loadFeatures()]);
    showToast('Decomposed through the ownership map.');
  } catch (err) {
    showToast(message(err));
  }
}

export async function startRelease(id: string): Promise<void> {
  try {
    set({ releaseLogs: { ...state.releaseLogs, [id]: [] } });
    await api.runRelease(id);
    await loadReleases();
  } catch (err) {
    showToast(message(err));
    await loadReleases();
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function showToast(text: string): void {
  set({ toast: text });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => set({ toast: null }), 4500);
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

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
