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
  CharterSummary,
  Coverage,
  Employee,
  EmployeeCard,
  EmployeeSignals,
  HealthSignals,
  InboxItem,
  LintFinding,
  MapEntry,
  OrgHistoryEntry,
  OrgProposal,
  ProposalKind,
  Release,
  Requirement,
  Role,
  RouteResult,
  Shippable,
  SpendSummary,
  Unit,
  WorkItem,
  WorkKind,
  WorkState,
  Evidence,
  RoomThread,
  RoomMessage,
  AssignmentState,
  CooMessage,
  CooItem,
  CooPresence,
} from './workplace.js';
import type { Activity, Area, Comment, Item, ReleasePost, Update, InboxMessage } from './workplace-v2.js';

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
  agentLog: (id: string, view?: 'chat') => `/api/agents/${encodeURIComponent(id)}/log${view ? `?view=${view}` : ''}`,
  agentMessage: (id: string) => `/api/agents/${encodeURIComponent(id)}/message`,
  agentInterrupt: (id: string) => `/api/agents/${encodeURIComponent(id)}/interrupt`,
  agentApprove: (id: string) => `/api/agents/${encodeURIComponent(id)}/approve`,
  agentMode: (id: string) => `/api/agents/${encodeURIComponent(id)}/mode`,
  agentImage: (id: string, ref: string) =>
    `/api/agents/${encodeURIComponent(id)}/image?ref=${encodeURIComponent(ref)}`,
  /** The default Talk: the Chief of Staff. */
  talk: '/api/talk',
  requests: '/api/requests',
  work: (q?: WorkQuery) => withQuery('/api/work', q ? { ...q } : undefined),
  workItem: (id: string) => `/api/work/${encodeURIComponent(id)}`,
  workTransition: (id: string) => `/api/work/${encodeURIComponent(id)}/transition`,
  workStart: (id: string) => `/api/work/${encodeURIComponent(id)}/start`,
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
  proposal: (id: string) => `/api/proposals/${encodeURIComponent(id)}`,
  proposalApply: (id: string) => `/api/proposals/${encodeURIComponent(id)}/apply`,
  releases: '/api/releases',
  releasesReady: '/api/releases/ready',
  releaseRun: (id: string) => `/api/releases/${encodeURIComponent(id)}/run`,
  spend: (day?: string) => withQuery('/api/spend', day ? { day } : undefined),
  room: '/api/room',
  roomThread: (id: string) => `/api/room/${encodeURIComponent(id)}`,
  roomMessages: (id: string) => `/api/room/${encodeURIComponent(id)}/messages`,
  roomResolve: (id: string) => `/api/room/${encodeURIComponent(id)}/resolve`,
  signals: '/api/health/signals',
  pair: '/api/pair',
  pairExchange: '/api/pair/exchange',
  /**
   * The COO bridge (loopback only: the relay can never reach `/api/coo/*`, same as `/api/pair`).
   * `coo.talk` mirrors `employeeTalk` but is served entirely from the bridge files, not a session.
   */
  cooLog: '/api/coo/log',
  cooMessage: '/api/coo/message',
  cooReply: '/api/coo/reply',
  cooItems: '/api/coo/items',
  cooAnswer: '/api/coo/answer',
  cooForward: '/api/coo/forward',
  cooPresence: '/api/coo/presence',
  /* ---------- v2 (LLD §19.8) ---------- */
  plan: (view?: 'board') => `/api/plan${view ? `?view=${view}` : ''}`,
  focus: '/api/focus',
  items: (q?: { level?: string; status?: string; assigneeId?: string; areaId?: string; parentId?: string }) => withQuery('/api/items', q ? { ...q } : undefined),
  item: (id: string) => `/api/items/${encodeURIComponent(id)}`,
  itemComments: (id: string) => `/api/items/${encodeURIComponent(id)}/comments`,
  itemMerge: (id: string) => `/api/items/${encodeURIComponent(id)}/merge`,
  updates: (q?: { limit?: number; before?: string }) => withQuery('/api/updates', q ? { limit: q.limit ? String(q.limit) : undefined, before: q.before } : undefined),
  inboxThread: (id: string) => `/api/inbox/${encodeURIComponent(id)}`,
  inboxReply: (id: string) => `/api/inbox/${encodeURIComponent(id)}/reply`,
  status: (q: string) => withQuery('/api/status', { q }),
  areas: '/api/areas',
  area: (id: string) => `/api/areas/${encodeURIComponent(id)}`,
  rooms: '/api/rooms',
  roomDetail: (id: string) => `/api/rooms/${encodeURIComponent(id)}`,
  releasePosts: '/api/releases/posts',
  releasePost: (id: string) => `/api/releases/posts/${encodeURIComponent(id)}`,
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
  /** The Chief of Staff's id: the default Talk target (POST /api/talk goes to her). */
  chiefOfStaff: string;
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
  /** Per feature id: where it stands, in the owner's terms. */
  status: Record<string, RequestStatus>;
}

export interface FeatureDetail {
  feature: WorkItem;
  assignments: WorkItem[];
  requirements: Requirement[];
  route: RouteResult;
  status: RequestStatus;
}

/**
 * A request's status, derived from the feature and its assignments (29 Sep, phone): one stage,
 * one line, and the assignments behind it. Never stored.
 */
export type RequestStage = 'with-asha' | 'specced' | 'routed' | 'building' | 'review' | 'blocked' | 'built' | 'released';

export interface RequestStatus {
  stage: RequestStage;
  /** One line for the owner, e.g. "Asha is writing the spec" or "2 of 3 building, 1 in review". */
  line: string;
  assignments: { id: string; title: string; employeeId?: string; charterId?: string; state: AssignmentState; stalledSince?: string }[];
  /** The Chief of Staff's session asked for the spec, when one was started. */
  askedAgentId?: string;
}

/** POST /api/requests `{ text, platformIds? }` → 201; GET /api/requests → the list, newest first. */
export interface CreateRequest { text: string; platformIds?: string[] }
export interface RequestResponse { feature: WorkItem; status: RequestStatus }

/** GET /api/proposals/:id: the proposal with its unified diff, and the Inbox item that decides it. */
export interface ProposalDetail { proposal: OrgProposal; item: InboxItem }

/** GET /api/releases/ready: per shippable, what is done and unreleased, the release in flight, the last done one. */
export interface ReleaseReadiness {
  shippable: Shippable;
  unreleased: string[];
  /** proposed, approved or running. */
  open?: Release;
  last?: Release;
}

export interface PivotItem {
  id: string;
  title: string;
  employeeId?: string;
  state: AssignmentState;
  /** From the assignment's evidence, once reported. */
  evidence?: { tests: string; commits: string[]; liveVerified: number; notVerified: number };
  /** Where to see it: the assignee's page, with the item selected. */
  href: string;
}

export interface PivotCell {
  total: number;
  byState: Record<string, number>;
  items: PivotItem[];
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
  /** An assignment under a feature: it counts in the feature's status and the pivot (29 Sep, iOS). */
  featureId?: string;
  /** false: create the assignment without starting its session. */
  start?: boolean;
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
  | { type: 'alert'; level: 'info' | 'needs-you' | 'blocked' | 'cap'; title: string; body: string; inboxId?: string }
  /**
   * The COO bridge. `coo.message` (the owner's own conversation) and `coo.presence` (online ↔
   * offline, from the lead's heartbeat) reach every authenticated owner socket, relay included —
   * see `/api/coo/*`'s owner-facing routes. `coo.item` (escalations raised *to* the COO) is
   * lead-only bookkeeping and stays local (`ws/hub.ts`), like `/api/coo/{items,answer,forward,reply}`.
   */
  | { type: 'coo.message'; message: CooMessage }
  | { type: 'coo.presence'; presence: CooPresence }
  | { type: 'coo.item'; item: CooItem }
  /** A mention-woken Room turn (services/mentions.ts), for a "Mira is replying…" indicator. */
  | { type: 'room.replying'; threadId: string; employeeId: string; state: 'started' | 'done' | 'skipped' }
  /* v2 (LLD §19.8) */
  | { type: 'item.updated'; item: Item }
  | { type: 'item.comment'; comment: Comment }
  | { type: 'activity.recorded'; activity: Activity }
  | { type: 'update.posted'; update: Update }
  | { type: 'area.updated'; area: Area }
  | { type: 'inbox.message'; message: InboxMessage }
  | { type: 'release.post'; post: ReleasePost };

export type WorkplaceClientCommand =
  | { type: 'inbox.answer'; id: string; optionId: string; note?: string };

