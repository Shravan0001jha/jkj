/**
 * The Iris Workplace domain: the organisation as data, the requirements it
 * serves, the work it does, and what the owner must decide.
 *
 * These types are the contract between the server, the web UI and the phone
 * app. Every field a client renders is here; nothing here imports from a
 * package outside @jkj/shared. See docs/LLD-workplace.md §2 and §14.
 */
import type { Agent, PermissionMode } from './types.js';
import type { ItemLevel, ItemResolution, ItemStatus, Points } from './workplace-v2.js';

/* ---------- organisation ---------- */

/** A charter can be cut along any of these axes; axes coexist in one org. */
export type Axis = 'capability' | 'platform' | 'function' | 'project' | 'segment';

/** One thing a charter owns. `kind` decides how the ownership map matches it. */
export interface OwnedThing {
  kind: OwnedKind;
  key: string;
}

export type OwnedKind =
  | 'path'               // a directory or file, matched by longest prefix
  | 'service'            // a deployable service name
  | 'route'              // an HTTP route or event shape
  | 'feature'            // a product feature slug
  | 'platform'           // mac | intel | windows | ios | android | server | web
  | 'keyword'            // a word that, in a feature's text, points here
  | 'requirement-group'  // a group in the product definition
  | 'requirement';       // one requirement id

export interface CharterSummary {
  id: string;
  title: string;
  axis: Axis;
  version: number;
  mission: string;
  /** Employees currently holding it. Empty is a lint finding. */
  holderIds: string[];
  /** Estimated tokens the charter body adds to a session's context. */
  tokens: number;
}

export interface Charter extends CharterSummary {
  scope: string[];
  owns: OwnedThing[];
  interfaces: { publishes: string[]; consumes: string[] };
  rules: string[];
  definitionOfDone: string[];
  buildTestShip: string[];
  coordinateWith: string[];
  needsOwnerApproval: string[];
  /** The markdown body as stored, front-matter removed. What a session reads. */
  body: string;
  path: string;
}

/** 0 = chief of staff, 1 = lead (permanent), 2 = hire (contractor). No level 3. */
export type Level = 0 | 1 | 2;

export interface Role {
  id: string;
  title: string;
  level: Level;
  instructions: string;
  tools: { allowed?: string[]; disallowed?: string[] };
  permissionMode: PermissionMode;
  model: string;
  budgetClass: 'high' | 'medium' | 'low';
}

export type EmployeeState = 'idle' | 'working' | 'blocked' | 'needs-owner' | 'paused' | 'online' | 'offline';

export interface Workspace {
  /** Absolute path of the repo the employee works in. */
  repo: string;
  /** Worktree path when the employee has its own; otherwise it shares the repo. */
  worktree?: string;
  branch?: string;
}

export interface Employee {
  id: string;
  name: string;
  roleId: string;
  level: Level;
  permanent: boolean;
  charterIds: string[];
  unitId: string;
  /** Chapters the employee also sits in (matrix). */
  chapterIds: string[];
  reportsTo: string | null;
  workspace: Workspace;
  budget: { inrPerDay: number; concurrentSessions: number };
  /** The GitHub App slug that gives this employee its identity. Never a credential. */
  githubApp?: string;
  state: EmployeeState;
  /** Why the state is blocked or needs-owner, e.g. "spend cap reached (employee:mira)". */
  stateReason?: string;
  /**
   * True for an employee the Workplace never spawns a session for (the COO: "Claude — COO" is the
   * lead's own terminal session on this Mac, reached through the COO bridge, not through Talk).
   * Shown in Office and Org like any other employee; `talk`/`assign`/`spawn` refuse it.
   */
  virtual?: boolean;
}

export interface Unit {
  id: string;
  title: string;
  parentId: string | null;
  kind: 'unit' | 'chapter';
  /** Optional team cap, on top of the company cap. */
  budget?: { inrPerDay: number };
}

export interface MapEntry {
  kind: OwnedKind;
  key: string;
  primary: string;
  contributors: string[];
  consulted: string[];
}

export type LintCode =
  | 'orphan'
  | 'overlap'
  | 'dead'
  | 'unowned-requirement'
  | 'unheld-charter'
  | 'unknown-ref';

export interface LintFinding {
  code: LintCode;
  severity: 'error' | 'warn';
  /** The thing the finding is about: a path, a requirement id, a charter id. */
  subject: string;
  message: string;
}

/** Why a charter was chosen for a piece of work. */
export interface RouteHit {
  charterId: string;
  because: OwnedThing[];
}

export interface RouteResult {
  primaries: RouteHit[];
  consulted: string[];
  /** Things that resolved to nobody. Non-empty means the map has a gap. */
  unresolved: OwnedThing[];
}

/* ---------- requirements ---------- */

export type RequirementStatus = 'missing' | 'partial' | 'built' | 'verified' | 'released';

export interface Requirement {
  id: string;
  group: string;
  /** Section of the product definition, e.g. "§3 Features" or "§6 Pricing". */
  section: string;
  title: string;
  note?: string;
  segments: string[];
  status: RequirementStatus;
  evidence: string[];
  /** Resolved through the ownership map. Null is a lint finding. */
  charterId: string | null;
  featureIds: string[];
}

export interface CoverageCounts {
  total: number;
  owned: number;
  planned: number;
  built: number;
  verified: number;
  released: number;
}

export interface Coverage extends CoverageCounts {
  byGroup: Record<string, CoverageCounts>;
  byCharter: Record<string, CoverageCounts>;
}

/* ---------- work ---------- */

export type WorkKind = 'feature' | 'assignment' | 'bug' | 'question';

export type FeatureState =
  | 'stated' | 'specced' | 'decomposed' | 'in-progress' | 'built' | 'released';

export type AssignmentState =
  | 'proposed' | 'planned' | 'building' | 'review' | 'done' | 'blocked' | 'rejected';

export type WorkState = FeatureState | AssignmentState;

export interface Evidence {
  tests: { passed: number; failed: number; command?: string };
  commits: string[];
  liveVerified: string[];
  notVerified: string[];
  notes?: string;
}

export interface WorkHistoryEntry {
  at: string;
  from: WorkState | null;
  to: WorkState;
  by: string;
  note?: string;
  /**
   * Set only when `to` is `blocked` and the block is the Workplace's own planned shutdown or
   * restart (never the owner, a spend cap, or a failed start): on boot, `employees.resumeAfterShutdown`
   * restarts exactly these, instead of waiting on the Chief of Staff's once-a-day resume. Legacy: no longer written since 2 Oct (a restart no longer blocks; see LLD §7b).
   */
  cause?: 'workplace-shutdown';
}

export interface WorkItem {
  id: string;
  kind: WorkKind;
  title: string;
  body: string;
  state: WorkState;
  charterId?: string;
  employeeId?: string;
  /** For an assignment: the feature it belongs to. */
  featureId?: string;
  requirementIds: string[];
  platformIds: string[];
  /** Written by the Chief of Staff for a feature. */
  spec?: string;
  /** The assignee's plan, parsed from its first reply. */
  plan?: string;
  evidence?: Evidence;
  /** Who verified a `done`. */
  verifiedBy?: string;
  sessionId?: string;
  /**
   * Derived, never stored: set when an assignment in progress has had no session activity for
   * longer than the stall threshold (WORKPLACE_STALL_MINUTES, default 30). The Chief of Staff's
   * routine resumes it within budget or raises an Inbox note saying why it waits.
   */
  stalledSince?: string;
  createdAt: string;
  updatedAt: string;
  history: WorkHistoryEntry[];

  /* v2 (LLD §19.2): all optional and additive; the client shape is `Item` (workplace-v2.ts). */
  level?: ItemLevel;
  status?: ItemStatus;
  statusSince?: string;
  /** story → epic, task → story. */
  parentId?: string;
  /** Epics only. */
  areaId?: string;
  rank?: number;
  points?: Points;
  reviewerId?: string;
  /** Epics: who owns the outcome. */
  ownerId?: string;
  targetDate?: string;
  acceptance?: string[];
  blockedReason?: string;
  /** 'owner', 'coo' or 'external' (a wait on a teammate is a review or a handoff, LLD §19.6c). */
  waitingOn?: string;
  blockedSince?: string;
  /** Blocked on the owner: what the asker recommends (it goes into his Inbox item). */
  blockedRecommendation?: string;
  resolution?: ItemResolution;
  mergedInto?: string;
  releasedIn?: string;
  /** Handed to a teammate (LLD §19.6c); `prev` is an earlier handoff still open (it unwinds in order). */
  handoff?: { fromId: string; reason: string; at: string; prev?: WorkItem['handoff'] };
  /** The last handback (internal, not projected): whom it went to, by whom, the note. */
  handedBack?: { toId: string; byId: string; note: string; at: string };
  /**
   * Backlog parked on purpose by the owner or the COO (or with a hold note): the dispatcher never
   * starts it (LLD §19.6d). Cleared when the item leaves Backlog.
   */
  hold?: boolean;
  /** Ready and waiting for its busy assignee (the watcher's "busy" case): the dispatcher starts it when they are free. */
  queuedFor?: string;
  /** The story's pull request on GitHub (docs/LLD-github-flow.md §1); set only in shadow/on mode. */
  pr?: PrRecord;
  /** The last time the server refused to push the story's branch (a planted key, build output, a bad name). */
  prRefused?: { at: string; sha: string; reasons: string[] };
}

/* ---------- GitHub flow (docs/LLD-github-flow.md) ---------- */

export type GitHubMode = 'local' | 'shadow' | 'on';

/** An approval holds only for the commit it was given on, in the same stay in review. */
export interface PrApproval {
  by: string;
  at: string;
  sha: string;
  /** The item's statusSince when it was given: a send-back and a new review are a new episode. */
  episode: string;
  note?: string;
}

export interface PrRecord {
  number: number;
  url: string;
  branch: string;
  base: string;
  headSha: string;
  pushedAt: string;
  devApproval?: PrApproval;
  qaApproval?: PrApproval;
  evidence: 'pending' | 'stale' | 'success' | 'failure';
  evidenceNote?: string;
  tests?: { state: 'pending' | 'success' | 'failure' | 'error'; sha: string; at: string; summary: string; details?: string };
  sendBack?: { by: string; at: string; note: string; disputedAt?: string };
  /** context → "sha|state|description" last posted, so an unchanged status is not posted again. */
  posted?: Record<string, string>;
  merged?: { at: string; sha: string; by: string };
}

/* ---------- inbox ---------- */

export type InboxKind = 'approval' | 'decision' | 'question' | 'cap' | 'org-change' | 'release';

export interface InboxOption {
  id: string;
  label: string;
  danger?: boolean;
  /** v2: the option the asker recommends (marked on the button). */
  recommended?: boolean;
  /** When true the answer needs a note (e.g. a number for a cap). */
  needsNote?: boolean;
}

export interface InboxAnswer {
  optionId: string;
  note?: string;
  at: string;
  /** 'workplace': resolved by the Workplace itself (a migration, a superseded item), with a note. */
  via: 'web' | 'phone' | 'telegram' | 'workplace';
}

/**
 * One line to the owner (HLD D16): what he reads first, ≤ OWNER_LINE_MAX chars, the outcome not
 * the process. The rest, when there is more, is `details` (markdown) behind an expand control.
 */
export interface OwnerLine {
  summary: string;
  details?: string;
}
export const OWNER_LINE_MAX = 120;

export interface InboxItem {
  id: string;
  kind: InboxKind;
  title: string;
  /** The full text, as raised. Clients show `summary` and put this behind expand. */
  body: string;
  /** One line for the owner (D16), derived from the body when the raiser gave none. */
  summary: string;
  /** The rest of the body, when the body was more than one line. */
  details?: string;
  /** Structured context a client may render: action, subject, diff, links. */
  context: Record<string, unknown>;
  options: InboxOption[];
  state: 'open' | 'answered' | 'expired';
  answer?: InboxAnswer;
  raisedBy: string;
  createdAt: string;
  /** Employee ids the item concerns: the raiser, the assignee, the charter holders, the Chief of Staff. It shows on each of their pages. */
  affects: string[];
  /** One line each: what happens on the first option and on a refusal. */
  onApprove?: string;
  onDeny?: string;
  links?: { label: string; href: string }[];
  /**
   * False for routine housekeeping (a stall notice, a session that did nothing, a review request
   * for a non-owner reviewer): it never reaches the owner's Inbox or its counts, only the pages of
   * the employees it affects (always including the Chief of Staff). Absent or true means the owner
   * decides it (the §0 approvals table). Never touched by clients; the server decides it on raise.
   */
  ownerFacing?: boolean;
  /** v2: replies in the item's thread (GET /api/inbox/:id has them). Always set by the server (0 when none). */
  messageCount?: number;
  lastMessageAt?: string;
  /** v2: shown by colour and label, not wording. Always set by the server since 2 Oct (from the kind and the level, LLD §19.5); absent (an old client cache) = normal. */
  urgency?: 'normal' | 'high' | 'urgent';
}

/* ---------- org changes ---------- */

export type ProposalKind = 'hire' | 'retire' | 'split' | 'merge' | 'reassign' | 'restructure';

export interface OrgSnapshot {
  units: Unit[];
  employees: Employee[];
  charters: CharterSummary[];
  map: MapEntry[];
}

export interface OrgProposal {
  id: string;
  kind: ProposalKind;
  reason: string;
  proposedBy: string;
  state: 'pending' | 'approved' | 'rejected' | 'applied';
  params: Record<string, unknown>;
  before: OrgSnapshot;
  after: OrgSnapshot;
  /** Unified diff of the org files. */
  diff: string;
  inboxId: string;
  createdAt: string;
  appliedCommit?: string;
  /** Lint of the org after the change. Errors block approval. */
  lint: LintFinding[];
}

export interface OrgHistoryEntry {
  commit: string;
  at: string;
  message: string;
}

/* ---------- spend and health ---------- */

/**
 * Real money spent by the organisation's work (HLD D9b). Subscription usage is not money and lives
 * in `SubscriptionUsage`; rows with source 'subscription' are the pre-28-Sep ledger, kept for
 * history and excluded from every cap.
 */
export type SpendSource = 'anthropic-api' | 'aws' | 'third-party' | 'subscription';
export type SpendBasis = 'metered' | 'estimated' | 'reported';

export interface SpendEntry {
  at: string;
  employeeId: string;
  sessionId: string;
  source: SpendSource;
  basis: SpendBasis;
  /** What was paid for: "release-iris.sh 0.2.16", "llm-gateway test run", "AWS actual (unattributed)". */
  what: string;
  inr: number;
  /** The provider's own figure when it gave one (usd, tokens, units). */
  detail?: Record<string, number | string>;
  /** 'owner-talk': a turn the owner started (free under D9b, kept for the record). */
  tag?: 'owner-talk';
}

/** The subscription's own limits as the Agent SDK reports them, per window. */
export interface RateLimitWindow {
  window: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage' | 'unknown';
  status: 'allowed' | 'allowed_warning' | 'rejected';
  /** 0..1 when the SDK gives it. */
  utilization?: number;
  resetsAt?: string;
  seenAt: string;
}

export interface SubscriptionUsage {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** List price × tokens, for information only. Never against a cap. */
  equivalentInr: number;
  byEmployee: Record<string, { turns: number; equivalentInr: number }>;
  windows: RateLimitWindow[];
}

export interface SpendSummary {
  /** IST calendar day, YYYY-MM-DD. */
  day: string;
  /** Real money today, ₹. */
  companyInr: number;
  capInr: number;
  /** Real money by source and by basis, so an estimate is never mistaken for a bill. */
  bySource: Record<string, number>;
  byBasis: Record<string, number>;
  byEmployee: Record<string, number>;
  byUnit: Record<string, number>;
  /** Scopes paused at their cap: 'company', 'unit:<id>', 'employee:<id>'. Real money only. */
  paused: string[];
  /** Free: the subscription's usage today. */
  subscription: SubscriptionUsage;
  /** Kept from the earlier model: the part of the subscription usage that was owner talk, ₹ equivalent. */
  ownerTalkInr: number;
}

export interface EmployeeSignals {
  throughput7d: number;
  rework7d: number;
  falseDoneRate7d: number;
  costPerDoneInr: number;
}

export interface HealthSignals {
  employees: Record<string, EmployeeSignals>;
  charters: Record<string, { queue: number; contextLimitHits7d: number }>;
  blockingPairs: [string, string][];
  proposalTriggers: { code: string; subject: string; message: string }[];
  stalled: { sessionId: string; employeeId: string; reason: 'idle' | 'loop'; since: string }[];
}

/* ---------- releases ---------- */

export type Shippable =
  | 'desktop-mac' | 'desktop-intel' | 'windows' | 'ios' | 'android'
  | 'server-api' | 'server-agent' | 'website';

export interface Release {
  id: string;
  shippable: Shippable;
  version: string;
  state: 'proposed' | 'approved' | 'rejected' | 'running' | 'done' | 'failed';
  /** Commits or assignments merged but not yet in a release of this shippable. */
  unreleased: string[];
  inboxId: string;
  log?: string;
  createdAt: string;
}

/* ---------- views ---------- */

export interface EmployeeCard {
  employee: Employee;
  charters: CharterSummary[];
  currentWork: WorkItem | null;
  lastReport: string | null;
  session: Agent | null;
  spendTodayInr: number;
  /** Open inbox items raised by this employee. */
  needsYou: number;
}

/* ---------- the Team Room ---------- */

export interface RoomThread {
  id: string;
  title: string;
  /** Charters the topic touches. */
  charterIds: string[];
  createdBy: string;
  createdAt: string;
  state: 'open' | 'resolved';
  /** Asha's summary when resolved; written into the relevant charter or contract. */
  summary?: string;
  /** One line for the owner (D16): where this thread stands. Set by the poster or the Chief of Staff; the resolution summary when resolved. */
  headline: string;
  lastAt: string;
  messageCount: number;
  /** Employees mentioned or posting in the thread. */
  participants: string[];
  /** Inbox items escalated from this thread. */
  escalations: string[];
  /** v2: 'general' | 'area:<id>' | 'releases'. Absent reads as 'general'. */
  roomId?: string;
  /** v2: the epic this thread is about, inside its area room. */
  epicId?: string;
}

export interface RoomMessage {
  id: string;
  threadId: string;
  at: string;
  /** An employee id, 'owner' or 'workplace'. */
  by: string;
  /** True when the owner wrote it. */
  owner: boolean;
  text: string;
  mentions: string[];
  /** v2: 'update' (a named update the room posts), 'standup', 'release'; absent = an authored message. */
  kind?: 'message' | 'update' | 'standup' | 'release';
  /** v2: who a stand-up is about (it is authored by 'workplace'). */
  about?: string;
  /** v2: the whole of a long agent message (`text` stays short). Shown in place of `text` on "more". */
  details?: string;
  /** True when `text` was cut: `details` then holds the full text. */
  truncated?: boolean;
  /** v2: the item an update line is about. */
  itemId?: string;
}

/* ---------- the COO bridge ---------- */

/**
 * The owner's Talk with "Claude — COO" (the lead's own terminal session on this Mac, never an
 * Agent SDK employee). No mirroring: this transcript holds only what the owner sent to `coo` in
 * the app and what the lead sent back through `POST /api/coo/reply`; the lead's own tool calls and
 * thinking never appear here.
 */
export interface CooMessage {
  id: string;
  at: string;
  from: 'owner' | 'coo';
  text: string;
  /** Chat-style: the reply itself is the summary (short); `details` is optional extra context. */
  summary?: string;
  details?: string;
  /** Set on a 'coo' message that answers a specific owner message. */
  inReplyTo?: string;
}

export type CooItemKind = 'escalation' | 'mention' | 'stall';

/**
 * Something Asha would raise above her own authority, or an `@coo` Room mention, delivered to the
 * COO bridge instead of straight to the owner's Inbox. The COO answers it (`POST /api/coo/answer`)
 * or forwards it to the owner with a recommendation (`POST /api/coo/forward`); if the COO is
 * offline for more than 30 minutes it falls back to the owner's Inbox on its own.
 */
export interface CooItem {
  id: string;
  at: string;
  kind: CooItemKind;
  title: string;
  body: string;
  options: InboxOption[];
  raisedBy: string;
  threadId?: string;
  /** v2: a stall notice is about this item. */
  itemId?: string;
  state: 'open' | 'answered' | 'forwarded';
  answer?: { optionId: string; note?: string; at: string };
  /** Set once this item reached the owner's Inbox, by the COO forwarding it or by the 30-minute fallback. */
  forward?: { inboxId: string; recommendation?: string; at: string; auto: boolean };
}

export interface CooPresence {
  online: boolean;
  lastHeartbeat: string | null;
}
