import { WORKPLACE_API as W } from '@jkj/shared';
import type {
  Agent, Attachment, ContextLayer, ContextResponse, LogEntry,
  OfficeResponse, OrgResponse, Charter, InboxItem, Employee, EmployeeDetail, WorkItem, FeatureBoard,
  FeatureDetail, Pivot, PivotRows, Requirement, Coverage, RouteResult, OrgProposal, Release,
  SpendSummary, HealthSignals, WorkplaceHealthResponse, DecomposeResponse, WorkQuery,
  CreateWorkRequest, CreateFeatureRequest, CreateProposalRequest, CreateReleaseRequest,
  TransitionRequest, RoomResponse, RoomThreadDetail, RoomThread, RoomMessage, CreateThreadRequest, PostMessageRequest,
  ResolveThreadRequest,
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
  const m = /(?:^|;\s*)wp_csrf=([^;]+)/.exec(document.cookie);
  return m ? { 'x-csrf-token': decodeURIComponent(m[1]!) } : {};
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
export const endSession = (id: string) => post<{ ok: true }>(W.employeeEndSession(id));
export const getEmployeeContext = (id: string) => request<ContextResponse>(W.employeeContext(id));
export const putEmployeeContext = (employeeId: string, id: string, body: string) =>
  put<ContextLayer>(W.employeeContext(employeeId), { id, body });

export const getWork = (q?: WorkQuery) => request<WorkItem[]>(W.work(q));
export const createWork = (body: CreateWorkRequest) => post<WorkItem>(W.work(), body);
export const transitionWork = (id: string, body: TransitionRequest) => post<WorkItem>(W.workTransition(id), body);

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

export const getReleases = () => request<Release[]>(W.releases);
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
