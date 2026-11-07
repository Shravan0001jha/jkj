import { WORKPLACE_API as W, csrfTokenFrom } from '@jkj/shared';
import type {
  Agent, Attachment, ContextLayer, ContextResponse, LogEntry,
  OfficeResponse, OrgResponse, Charter, InboxItem, Employee, EmployeeDetail, WorkItem, FeatureBoard,
  FeatureDetail, Pivot, PivotRows, Requirement, Coverage, RouteResult, OrgProposal, Release,
  SpendSummary, HealthSignals, WorkplaceHealthResponse, DecomposeResponse, WorkQuery,
  CreateWorkRequest, CreateFeatureRequest, CreateProposalRequest, CreateReleaseRequest,
  TransitionRequest, RoomResponse, RoomThreadDetail, RoomThread, RoomMessage, CreateThreadRequest, PostMessageRequest,
  ResolveThreadRequest, RequestResponse, CreateRequest, ReleaseReadiness, ProposalDetail, CooMessage, CooPresence,
  BacklogView, CreatePlanFeatureRequest, CreatePlannedEpicRequest, EpicDetail, Feature as PlanFeature, FeatureDetail$, PlannedEpic,
  ReviewView, Sprint, SprintView, Team, TeamBoard, TodayView, UpdatePlanFeatureRequest, UpdatePlannedEpicRequest,
  PlanResponse, ItemDetail, UpdateItemRequest, Comment, TalkThread, Update, InboxThread, ReleasePost, SuperFocus, HygieneReport,
} from '@jkj/shared';

/**
 * REST client. One function per endpoint, typed off @jkj/shared, so a server
 * change that breaks the UI breaks the build instead of the page.
 */

/**
 * Behind the published relay (https://work.irisforu.com) every mutating request must carry the
 * CSRF token the relay set in the readable `wp_csrf` cookie. On the Mac (loopback) there is no
 * cookie and the header is simply absent.
 */
function csrfHeader(): Record<string, string> {
  const token = csrfTokenFrom(document.cookie);
  return token ? { 'x-csrf-token': token } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(method !== 'GET' ? csrfHeader() : {}), ...init?.headers },
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json() as { error?: string };
      detail = body.error ?? '';
    } catch {
      detail = '';
    }
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });

/* ---------- workplace ---------- */

export const getHealth = () => request<WorkplaceHealthResponse>(W.health);
export const getOffice = () => request<OfficeResponse>(W.office);
export const getOrg = () => request<OrgResponse>(W.org);
export const getCharter = (id: string) => request<Charter>(W.charter(id));
export const putCharter = (id: string, body: string) => put<Charter>(W.charter(id), { body });

export const getInbox = () => request<InboxItem[]>(W.inbox);
export const answerInbox = (id: string, optionId: string, note?: string) =>
  post<InboxItem>(W.inboxAnswer(id), { optionId, ...(note ? { note } : {}) });

export const getEmployees = () => request<Employee[]>(W.employees);
export const getEmployee = (id: string) => request<EmployeeDetail>(W.employee(id));
export const talkTo = (id: string, text: string, attachments: Attachment[] = []) =>
  post<Agent>(W.employeeTalk(id), { text, attachments });
/** The default Talk: the Chief of Staff (D16 / phone). */
export const talkToChiefOfStaff = (text: string, attachments: Attachment[] = []) =>
  post<Agent>(W.talk, { text, attachments });
export const endSession = (id: string) => post<{ ok: true }>(W.employeeEndSession(id));
export const getEmployeeContext = (id: string) => request<ContextResponse>(W.employeeContext(id));
export const putEmployeeContext = (employeeId: string, id: string, body: string) =>
  put<ContextLayer>(W.employeeContext(employeeId), { id, body });

/**
 * The COO bridge: loopback only (the web app running on the Mac itself is loopback; opened through
 * the published relay these calls 401/400 the same way /api/pair does, on purpose).
 */
export const getCooLog = () => request<CooMessage[]>(W.cooLog);
export const sendCooMessage = (text: string) => post<CooMessage>(W.cooMessage, { text });
export const getCooPresence = () => request<CooPresence>(W.cooPresence);

export const getWork = (q?: WorkQuery) => request<WorkItem[]>(W.work(q));
export const createWork = (body: CreateWorkRequest) => post<WorkItem>(W.work(), body);
export const transitionWork = (id: string, body: TransitionRequest) => post<WorkItem>(W.workTransition(id), body);

export const getRequests = () => request<RequestResponse[]>(W.requests);
export const createRequest = (body: CreateRequest) => post<RequestResponse>(W.requests, body);
export const getFeatures = () => request<FeatureBoard>(W.features);
export const createFeature = (body: CreateFeatureRequest) => post<WorkItem>(W.features, body);
export const getFeature = (id: string) => request<FeatureDetail>(W.feature(id));
export const decomposeFeature = (id: string) => post<DecomposeResponse>(W.featureDecompose(id));
export const getPivot = (rows: PivotRows) => request<Pivot>(W.featurePivot(rows));

export const getRequirements = (group?: string) => request<Requirement[]>(W.requirements(group));
export const getCoverage = () => request<Coverage>(W.coverage);
export const previewRoute = (q: { text?: string; paths?: string[]; platforms?: string[]; requirementIds?: string[] }) =>
  request<RouteResult>(W.route(q));

export const getProposals = () => request<OrgProposal[]>(W.proposals);
export const createProposal = (body: CreateProposalRequest) => post<OrgProposal>(W.proposals, body);
export const getProposal = (id: string) => request<ProposalDetail>(W.proposal(id));

export const getReleases = () => request<Release[]>(W.releases);
export const getReleaseReadiness = () => request<ReleaseReadiness[]>(W.releasesReady);
export const createRelease = (body: CreateReleaseRequest) => post<Release>(W.releases, body);
export const runRelease = (id: string) => post<Release>(W.releaseRun(id));

/* ---------- the Team Room ---------- */

export const getRoom = () => request<RoomResponse>(W.room);
export const getThread = (id: string) => request<RoomThreadDetail>(W.roomThread(id));
export const createThread = (body: CreateThreadRequest) => post<RoomThreadDetail>(W.room, body);
export const postRoomMessage = (id: string, body: PostMessageRequest) => post<RoomMessage>(W.roomMessages(id), body);
export const resolveThread = (id: string, body: ResolveThreadRequest) => post<RoomThread>(W.roomResolve(id), body);

export const getSpend = (day?: string) => request<SpendSummary>(W.spend(day));
export const getSignals = () => request<HealthSignals>(W.signals);

/* ---------- sessions (kept from JKJ) ---------- */

export const getTranscript = (agentId: string) => request<LogEntry[]>(W.agentLog(agentId));
export const postMessage = (agentId: string, text: string, attachments: Attachment[] = []) =>
  post<{ ok: true }>(W.agentMessage(agentId), { text, attachments });

/* ---------- the owner's sprint board (docs/LLD-sprint-board.md §4) ---------- */

export const sprintApi = {
  today: () => request<TodayView>('/api/sprint/today'),
  current: (sprintId?: string) => request<SprintView>(`/api/sprint/current${sprintId ? `?sprint=${encodeURIComponent(sprintId)}` : ''}`),
  backlog: () => request<BacklogView>('/api/sprint/backlog'),
  review: () => request<ReviewView>('/api/sprint/review'),
  teams: () => request<Team[]>('/api/sprint/teams'),
  team: (id: string) => request<TeamBoard>(`/api/sprint/teams/${encodeURIComponent(id)}`),
  epic: (id: string) => request<EpicDetail>(`/api/sprint/epics/${encodeURIComponent(id)}`),
  features: () => request<PlanFeature[]>('/api/sprint/features'),
  feature: (id: string) => request<FeatureDetail$>(`/api/sprint/features/${encodeURIComponent(id)}`),
  createFeature: (body: CreatePlanFeatureRequest) => post<PlanFeature>('/api/sprint/features', body),
  updateFeature: (id: string, body: UpdatePlanFeatureRequest) => post<PlanFeature>(`/api/sprint/features/${encodeURIComponent(id)}`, body),
  createEpic: (body: CreatePlannedEpicRequest) => post<PlannedEpic>('/api/sprint/epics', body),
  updateEpic: (id: string, body: UpdatePlannedEpicRequest) => post<PlannedEpic>(`/api/sprint/epics/${encodeURIComponent(id)}`, body),
  rank: (epicIds: string[]) => post<PlannedEpic[]>('/api/sprint/backlog/rank', { epicIds }),
  setGoal: (sprintId: string, goal: string) => post<Sprint>(`/api/sprint/sprints/${encodeURIComponent(sprintId)}`, { goal }),
};

/* ---------- web/app parity (docs/HLD-sprint-board.md §6) ---------- */

export const v2Api = {
  plan: (board = false) => request<PlanResponse>(`/api/plan${board ? '?view=board' : ''}`),
  item: (id: string) => request<ItemDetail>(`/api/items/${encodeURIComponent(id)}`),
  updateItem: (id: string, body: UpdateItemRequest) => post<ItemDetail>(`/api/items/${encodeURIComponent(id)}`, body),
  comment: (id: string, text: string) => post<Comment>(`/api/items/${encodeURIComponent(id)}/comments`, { text }),
  talkThreads: () => request<TalkThread[]>('/api/talk/threads'),
  updates: (before?: string) => request<Update[]>(`/api/updates?limit=60${before ? `&before=${encodeURIComponent(before)}` : ''}`),
  snapshot: () => request<Record<string, unknown>>('/api/metrics/snapshot'),
  inboxThread: (id: string) => request<InboxThread>(`/api/inbox/${encodeURIComponent(id)}`),
  inboxReply: (id: string, text: string) => post<InboxThread>(`/api/inbox/${encodeURIComponent(id)}/reply`, { text }),
  macQueue: () => request<{ active: MacQueueRequest | null; queue: MacQueueRequest[] }>('/api/mac-queue'),
  macGrant: (id: string) => post<unknown>(`/api/mac-queue/${encodeURIComponent(id)}/grant`),
  releasePosts: () => request<ReleasePost[]>('/api/releases/posts'),
  superFocus: () => request<SuperFocus>('/api/settings/super-focus'),
  setSuperFocus: (hours: number) => post<SuperFocus>('/api/settings/super-focus', { hours }),
  hygiene: () => request<HygieneReport>('/api/hygiene'),
};

/** The Mac test-slot queue (server mac-queue.ts MacRequest), as the web reads it. */
export interface MacQueueRequest {
  id: string;
  emp: string;
  itemId: string;
  minutes: number;
  why: string;
  at: string;
  state: string;
  grantedAt?: string;
  until?: string;
}
