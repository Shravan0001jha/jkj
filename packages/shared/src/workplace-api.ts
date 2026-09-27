/**
 * The Workplace API: every REST route and socket event the web UI and the
 * phone app use. Paths are built here so no client ever guesses one.
 *
 * Stable from 27 Sep 2026. Additions are announced; nothing is renamed.
 * Errors are `{ error: string }` with 400, 401, 404 or 409.
 * Off-loopback requests need `Authorization: Bearer <token>` (LLD §13).
 */
import type { Agent } from './types.js';
import type { Attachment, HealthResponse } from './protocol.js';
import type {
  CharterSummary, Coverage, Employee, EmployeeCard, EmployeeSignals, HealthSignals,
  InboxItem, LintFinding, MapEntry, OrgHistoryEntry, OrgProposal, ProposalKind, Release,
  Requirement, Role, RouteResult, Shippable, SpendSummary, Unit, WorkItem, WorkKind, WorkState,
  Evidence, RoomThread, RoomMessage,
} from './workplace.js';

export const WORKPLACE_API = {
  health: '/api/health',
  office: '/api/office',
  org: '/api/org',
  charter: (id: string) => `/api/charters/${encodeURIComponent(id)}`,
  inbox: '/api/inbox',
  inboxAnswer: (id: string) => `/api/inbox/${encodeURIComponent(id)}/answer`,
  employees: '/api/employees',
  employee: (id: string) => `/api/employees/${encodeURIComponent(id)}`,
  employeeTalk: (id: string) => `/api/employees/${encodeURIComponent(id)}/talk`,
  employeeEndSession: (id: string) => `/api/employees/${encodeURIComponent(id)}/end-session`,
  employeeContext: (id: string) => `/api/employees/${encodeURIComponent(id)}/context`,
  agentLog: (id: string) => `/api/agents/${encodeURIComponent(id)}/log`,
  agentMessage: (id: string) => `/api/agents/${encodeURIComponent(id)}/message`,
  agentInterrupt: (id: string) => `/api/agents/${encodeURIComponent(id)}/interrupt`,
  agentApprove: (id: string) => `/api/agents/${encodeURIComponent(id)}/approve`,
  agentMode: (id: string) => `/api/agents/${encodeURIComponent(id)}/mode`,
  agentImage: (id: string, ref: string) =>
    `/api/agents/${encodeURIComponent(id)}/image?ref=${encodeURIComponent(ref)}`,
  work: (q?: WorkQuery) => withQuery('/api/work', q ? { ...q } : undefined),
  workItem: (id: string) => `/api/work/${encodeURIComponent(id)}`,
  workTransition: (id: string) => `/api/work/${encodeURIComponent(id)}/transition`,
  features: '/api/features',
  feature: (id: string) => `/api/features/${encodeURIComponent(id)}`,
  featureDecompose: (id: string) => `/api/features/${encodeURIComponent(id)}/decompose`,
  featurePivot: (rows: PivotRows) => `/api/features/pivot?rows=${rows}`,
  requirements: (group?: string) => withQuery('/api/requirements', group ? { group } : undefined),
  coverage: '/api/requirements/coverage',
  route: (q: { text?: string; paths?: string[]; platforms?: string[]; requirementIds?: string[] }) =>
    withQuery('/api/route', {
      text: q.text,
      paths: q.paths?.join(','),
      platforms: q.platforms?.join(','),
      requirementIds: q.requirementIds?.join(','),
    }),
  proposals: '/api/proposals',
  proposalApply: (id: string) => `/api/proposals/${encodeURIComponent(id)}/apply`,
  releases: '/api/releases',
  releaseRun: (id: string) => `/api/releases/${encodeURIComponent(id)}/run`,
  spend: (day?: string) => withQuery('/api/spend', day ? { day } : undefined),
  room: '/api/room',
  roomThread: (id: string) => `/api/room/${encodeURIComponent(id)}`,
  roomMessages: (id: string) => `/api/room/${encodeURIComponent(id)}/messages`,
  roomResolve: (id: string) => `/api/room/${encodeURIComponent(id)}/resolve`,
  signals: '/api/health/signals',
  pair: '/api/pair',
  pairExchange: '/api/pair/exchange',
  socket: '/ws',
} as const;

export type PivotRows = 'charter' | 'platform' | 'team';

export interface WorkQuery {
  kind?: WorkKind;
  state?: WorkState;
  charterId?: string;
  employeeId?: string;
  featureId?: string;
}

function withQuery(path: string, q?: Record<string, string | undefined>): string {
  if (!q) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) params.set(k, v);
  const s = params.toString();
  return s ? `${path}?${s}` : path;
}

/* ---------- responses ---------- */

export interface WorkplaceHealthResponse extends HealthResponse {
  workplace: { dataDir: string; capInr: number; day: string; telegram: boolean; published: 'not-configured' | 'connecting' | 'connected' | 'offline' | 'off' };
}

export interface OfficeResponse {
  units: { unit: Unit; employees: EmployeeCard[] }[];
  coverage: Coverage;
  needsYou: number;
  spend: SpendSummary;
  lintErrors: number;
  /** Headline counts over the employees and their work. */
  counts: OfficeCounts;
}

export interface OfficeCounts {
  working: number;
  blocked: number;
  /** Assignments in progress with no session activity past the stall threshold. */
  stalled: number;
  needsYou: number;
  total: number;
}

export interface OrgResponse {
  units: Unit[];
  roles: Role[];
  employees: Employee[];
  charters: CharterSummary[];
  map: MapEntry[];
  lint: LintFinding[];
  proposals: OrgProposal[];
  history: OrgHistoryEntry[];
}

export interface EmployeeDetail {
  employee: Employee;
  charters: CharterSummary[];
  status: string;
  handoff: string;
  sessions: Agent[];
  assignments: WorkItem[];
  spendTodayInr: number;
  signals: EmployeeSignals;
  /** Open Inbox items raised by, or addressed to, this employee: what the owner can answer here. */
  needsYou: InboxItem[];
}

export interface FeatureBoard {
  features: WorkItem[];
  byState: Record<string, number>;
}

export interface FeatureDetail {
  feature: WorkItem;
  assignments: WorkItem[];
  requirements: Requirement[];
  route: RouteResult;
}

export interface PivotCell {
  total: number;
  byState: Record<string, number>;
}

export interface Pivot {
  rows: string[];
  cols: string[];
  cells: Record<string, Record<string, PivotCell>>;
}

export interface DecomposeResponse {
  feature: WorkItem;
  assignments: WorkItem[];
  route: RouteResult;
}

export interface RoomResponse {
  threads: RoomThread[];
}
export interface RoomThreadDetail {
  thread: RoomThread;
  messages: RoomMessage[];
}
export interface CreateThreadRequest { title: string; text: string; charterIds?: string[]; mentions?: string[] }
export interface PostMessageRequest { text: string; mentions?: string[] }
export interface ResolveThreadRequest { summary: string }

export interface PairResponse { code: string; expiresAt: string }
export interface PairExchangeResponse { token: string }

/* ---------- requests ---------- */

export interface TalkRequest {
  text: string;
  attachments?: Attachment[];
  /** A probe or verification session: it never writes the employee's status or handoff. */
  probe?: boolean;
}
export interface AnswerInboxRequest { optionId: string; note?: string }
export interface CreateWorkRequest {
  kind: WorkKind;
  title: string;
  body: string;
  charterId?: string;
  employeeId?: string;
  requirementIds?: string[];
  platformIds?: string[];
}
export interface TransitionRequest { to: WorkState; note?: string; evidence?: Evidence; by?: string }
export interface CreateFeatureRequest {
  title: string;
  body: string;
  requirementIds?: string[];
  platformIds?: string[];
  paths?: string[];
  services?: string[];
}
export interface CreateProposalRequest {
  kind: ProposalKind;
  reason: string;
  params: Record<string, unknown>;
  proposedBy?: string;
}
export interface CreateReleaseRequest { shippable: Shippable; version: string }
export interface SaveCharterRequest { body: string }
export interface SaveEmployeeContextRequest { id: string; body: string }

/* ---------- socket events (added to ServerEvent) ---------- */

export type WorkplaceServerEvent =
  /** Sent once on socket connect: the whole Office, so a client can render before its first GET. */
  | { type: 'office.snapshot'; office: OfficeResponse }
  | { type: 'office.updated'; card: EmployeeCard }
  | { type: 'inbox.updated'; item: InboxItem }
  | { type: 'work.updated'; item: WorkItem }
  | { type: 'proposal.updated'; proposal: OrgProposal }
  | { type: 'release.updated'; release: Release }
  | { type: 'release.log'; id: string; line: string }
  | { type: 'spend.updated'; summary: SpendSummary }
  | { type: 'signals.updated'; signals: HealthSignals }
  | { type: 'room.thread'; thread: RoomThread }
  | { type: 'room.message'; message: RoomMessage; thread: RoomThread }
  | { type: 'alert'; level: 'info' | 'needs-you' | 'blocked' | 'cap'; title: string; body: string; inboxId?: string };

export type WorkplaceClientCommand =
  | { type: 'inbox.answer'; id: string; optionId: string; note?: string };

