/**
 * The Iris Workplace domain: the organisation as data, the requirements it
 * serves, the work it does, and what the owner must decide.
 *
 * These types are the contract between the server, the web UI and the phone
 * app. Every field a client renders is here; nothing here imports from a
 * package outside @jkj/shared. See docs/LLD-workplace.md §2 and §14.
 */
import type { Agent, PermissionMode } from './types.js';

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

export type EmployeeState = 'idle' | 'working' | 'blocked' | 'needs-owner' | 'paused';

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
  createdAt: string;
  updatedAt: string;
  history: WorkHistoryEntry[];
}

/* ---------- inbox ---------- */

export type InboxKind = 'approval' | 'decision' | 'question' | 'cap' | 'org-change' | 'release';

export interface InboxOption {
  id: string;
  label: string;
  danger?: boolean;
  /** When true the answer needs a note (e.g. a number for a cap). */
  needsNote?: boolean;
}

export interface InboxAnswer {
  optionId: string;
  note?: string;
  at: string;
  via: 'web' | 'phone' | 'telegram';
}

export interface InboxItem {
  id: string;
  kind: InboxKind;
  title: string;
  body: string;
  /** Structured context a client may render: action, subject, diff, links. */
  context: Record<string, unknown>;
  options: InboxOption[];
  state: 'open' | 'answered' | 'expired';
  answer?: InboxAnswer;
  raisedBy: string;
  createdAt: string;
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

export interface SpendEntry {
  at: string;
  employeeId: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usd: number;
  inr: number;
}

export interface SpendSummary {
  /** IST calendar day, YYYY-MM-DD. */
  day: string;
  companyInr: number;
  capInr: number;
  byEmployee: Record<string, number>;
  byUnit: Record<string, number>;
  /** Scopes paused at their cap: 'company', 'unit:<id>', 'employee:<id>'. */
  paused: string[];
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
