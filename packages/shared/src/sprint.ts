/**
 * The owner's sprint board (docs/HLD-sprint-board.md, LLD §1): Feature > Epic > Story, two-week
 * sprints, dated epics, and the owner's web screens. A feature is a planning record; an epic is the
 * ordinary `level: 'epic'` item with planning metadata beside it; stories are untouched.
 */
import type { EpicProgress, Item, ItemBlocker } from './workplace-v2.js';

/** Set by the owner (or the COO for him). */
export type PlanState = 'backlog' | 'planned' | 'parked';
/** What the board shows: the plan state, or a state derived from the epic's stories and its date. */
export type EpicState = 'backlog' | 'planned' | 'in-progress' | 'at-risk' | 'blocked' | 'done' | 'parked';
export const EPIC_STATES: readonly EpicState[] = ['backlog', 'planned', 'in-progress', 'at-risk', 'blocked', 'done', 'parked'];

export interface DateChange {
  subjectId: string;
  kind: 'feature' | 'epic';
  from?: string;
  to?: string;
  by: string;
  at: string;
  reason: string;
}

export interface FeatureProgress {
  epicsDone: number;
  epicsTotal: number;
  storiesDone: number;
  storiesTotal: number;
  /** 0..100 over epics when the feature has planned epics, else over its container stories. */
  pct: number;
}

export interface Feature {
  id: string;
  title: string;
  body: string;
  /** YYYY-MM-DD (IST). */
  dueDate?: string;
  status: 'active' | 'parked' | 'done';
  rank: number;
  /** The pre-sprint epics this feature was made from (HLD D2): they keep their stories; never on the epic board. */
  containerEpicIds: string[];
  createdAt: string;
  updatedAt: string;
  progress: FeatureProgress;
}

export interface EpicBlocker {
  storyId: string;
  title: string;
  blocker: ItemBlocker;
}

export interface Carried {
  fromSprint: string;
  reason: string;
  at: string;
}

export interface PlannedEpic {
  /** The work item id (level epic). */
  id: string;
  title: string;
  featureId?: string;
  featureTitle?: string;
  /** null in the backlog or parked. */
  sprintId: string | null;
  planState: PlanState;
  state: EpicState;
  /** Past its date and not done (shown red). */
  overdue: boolean;
  /** Due today and not done (highlighted). */
  dueToday: boolean;
  dueDate?: string;
  rank: number;
  progress: EpicProgress;
  /** Open stories that are blocked or waiting, with what they wait on. */
  blockers: EpicBlocker[];
  waitingOnOwner: boolean;
  carried?: Carried[];
  ownerId?: string;
  /** Distinct assignees of its stories. */
  assignees: string[];
}

export interface Sprint {
  id: string;
  number: number;
  /** YYYY-MM-DD, a Saturday (IST). */
  start: string;
  /** YYYY-MM-DD, the Friday 13 days later (IST). */
  end: string;
  goal?: string;
  current: boolean;
}

export interface EpicRef {
  id: string;
  title: string;
  featureTitle?: string;
  dueDate?: string;
  reason?: string;
}

export interface SprintReport {
  sprintId: string;
  number: number;
  start: string;
  end: string;
  goal?: string;
  done: EpicRef[];
  slipped: EpicRef[];
  carried: EpicRef[];
  frozenAt: string;
}

export interface WaitingOnYou {
  kind: 'inbox' | 'item';
  id: string;
  title: string;
  /** The one line: the inbox summary, or why the item waits. */
  line: string;
  since: string;
}

export interface TodayView {
  /** YYYY-MM-DD (IST). */
  date: string;
  sprint: Sprint;
  dueToday: PlannedEpic[];
  overdue: PlannedEpic[];
  atRisk: PlannedEpic[];
  blocked: PlannedEpic[];
  /** In progress this sprint, due later. */
  moving: PlannedEpic[];
  doneToday: PlannedEpic[];
  waitingOnYou: WaitingOnYou[];
  /** No dated epics yet: the features still need splitting into epics. */
  empty: boolean;
}

export interface SprintView {
  sprint: Sprint;
  features: { feature?: Feature; epics: PlannedEpic[] }[];
  /** The next 14 days from today, each with the epics due that day. */
  timeline: { date: string; epics: { id: string; title: string; state: EpicState; overdue: boolean }[] }[];
  totals: { epics: number; done: number; atRisk: number; blocked: number };
}

export interface BacklogView {
  sprint: Sprint;
  next: Sprint;
  /** In the current sprint, ranked. */
  planned: PlannedEpic[];
  /** Planned into a future sprint. */
  later: PlannedEpic[];
  backlog: PlannedEpic[];
  parked: PlannedEpic[];
  /** Epics on the board's store with no planning row yet (not containers): adopt them by giving a feature. */
  unplanned: { id: string; title: string; status: string }[];
  features: Feature[];
}

export interface ReviewView {
  current: Sprint;
  last?: SprintReport;
  archive: SprintReport[];
}

export interface Team {
  id: string;
  name: string;
  leadIds: string[];
  memberIds: string[];
}

export type BoardColumn = 'todo' | 'progress' | 'review' | 'qa' | 'done';
export const BOARD_COLUMNS: readonly BoardColumn[] = ['todo', 'progress', 'review', 'qa', 'done'];

export interface TeamBoard {
  team: Team;
  sprint: Sprint;
  columns: Record<BoardColumn, Item[]>;
}

export interface EpicDetail {
  epic: PlannedEpic;
  feature?: Feature;
  /** Blocked/waiting first, then open, then done. */
  stories: Item[];
  dates: DateChange[];
}

export interface FeatureDetail$ {
  feature: Feature;
  epics: PlannedEpic[];
  /** Stories still filed under the container epics: open first, at most 200. */
  containerStories: Item[];
  containerStoriesTotal: number;
  dates: DateChange[];
}

export interface TrackedDay {
  date: string;
  sprint: Sprint;
  /** Due today, overdue, or in progress in the sprint: what the start and park reports cover. */
  tracked: PlannedEpic[];
}

export interface CreatePlanFeatureRequest {
  title: string;
  body?: string;
  dueDate?: string;
}

export interface UpdatePlanFeatureRequest {
  title?: string;
  body?: string;
  dueDate?: string;
  status?: Feature['status'];
  /** Required when an existing due date changes. */
  reason?: string;
}

export interface CreatePlannedEpicRequest {
  title: string;
  featureId: string;
  dueDate: string;
  body?: string;
  areaId?: string;
  ownerId?: string;
  /** Default 'backlog'. */
  sprint?: 'current' | 'backlog';
}

export interface UpdatePlannedEpicRequest {
  featureId?: string;
  dueDate?: string;
  planState?: PlanState;
  sprintId?: string;
  /** Required when an existing due date changes. */
  reason?: string;
  /** Replaces the reason on the last carry-over. */
  carryReason?: string;
}

export interface RankRequest {
  epicIds: string[];
}

export interface UpdateSprintRequest {
  goal: string;
}
