/**
 * Workplace v2 (HLD §8, LLD §19): the plan is the centre. Areas → epics → stories → tasks, with
 * comments, an activity log, the Updates feed, threaded Inbox items, area rooms and release posts.
 *
 * These are the exact JSON shapes the iOS and Android apps build against (LLD §19.8). Optional
 * fields are absent, never null, unless the type says `| null`.
 */
import type { InboxItem, RoomThread, WorkKind } from './workplace.js';

export type ItemLevel = 'epic' | 'story' | 'task';
export type ItemStatus = 'backlog' | 'ready' | 'in-progress' | 'in-review' | 'done' | 'blocked';
export type ItemResolution = 'done' | 'wont-do' | 'duplicate' | 'cant-reproduce';
/** The Jira type (docs/HLD-jira-lifecycle.md §1): a bug is a story-level item. */
export type ItemType = 'epic' | 'story' | 'task' | 'bug';
/**
 * The true status the board shows (docs/HLD-jira-lifecycle.md §1), computed on every read from the
 * stored status, the hold, the PR's stage and merge, and any open `startsAfter`.
 */
export type TrueStatus = 'backlog' | 'on-hold' | 'ready' | 'in-progress' | 'in-review' | 'qa' | 'approved' | 'merged' | 'done' | 'blocked';
export const TRUE_STATUS_LABEL: Record<TrueStatus, string> = {
  backlog: 'Backlog', 'on-hold': 'On hold', ready: 'Ready', 'in-progress': 'In progress', 'in-review': 'In review',
  qa: 'QA', approved: 'Approved', merged: 'Merged', done: 'Done', blocked: 'Blocked',
};

/** What a Blocked item waits on, and where that blocker stands now (computed on read). */
export interface ItemBlocker {
  kind: 'person' | 'owner' | 'coo' | 'external' | 'release' | 'item';
  /** The employee id, 'owner', 'coo', 'external', 'release', or the item id. */
  id: string;
  /** "Tara", "you", "the release", or the item's title. */
  label: string;
  /** The blocker's status now: the linked item's true status ("In review"), "release 1.4 approved", "no release planned". */
  status: string;
  reason?: string;
  since?: string;
}

/** The story's pull request, as the apps show it on the item. */
export interface ItemPr {
  number: number;
  url: string;
  branch: string;
  /** dev: waiting on the developer approval; qa: on QA; approved: both hold; merged. */
  stage: 'dev' | 'qa' | 'approved' | 'merged';
  /** The workplace/tests check on the head commit. */
  tests?: 'pending' | 'success' | 'failure' | 'error';
  evidence: 'pending' | 'stale' | 'success' | 'failure';
  merged?: { at: string; by: string };
}

/* ---------- hygiene (docs/HLD-jira-lifecycle.md §4) ---------- */

/** a top-idle, b no-session, c bad-block, d bad-review, e done-unmerged, f unrouted-top, g wrong-assignee. */
export type HygieneRule = 'top-idle' | 'no-session' | 'bad-block' | 'bad-review' | 'done-unmerged' | 'unrouted-top' | 'wrong-assignee';
export const HYGIENE_RULES: readonly HygieneRule[] = ['top-idle', 'no-session', 'bad-block', 'bad-review', 'done-unmerged', 'unrouted-top', 'wrong-assignee'];

export interface HygieneViolation {
  /** `<rule>:<itemId>[:<who>]`, stable while the condition lasts. */
  key: string;
  rule: HygieneRule;
  itemId: string;
  title: string;
  assigneeId?: string;
  /** What is wrong, one line. */
  what: string;
  /** When the sweep first saw it. */
  since: string;
  minutes: number;
  /** The suggested fix, one line. */
  fix: string;
}

/** GET /api/hygiene. */
export interface HygieneReport {
  at: string;
  /** The floor is paused: the monitor is silent. */
  paused: boolean;
  /** Open items (and Done with an unmerged PR) without a violation, in percent. */
  cleanPct: number;
  open: number;
  clean: number;
  counts: Record<HygieneRule, number>;
  violations: HygieneViolation[];
}
export type Points = 1 | 2 | 3 | 5 | 8;

export const ITEM_STATUSES: readonly ItemStatus[] = ['backlog', 'ready', 'in-progress', 'in-review', 'done', 'blocked'];
export const POINTS: readonly Points[] = [1, 2, 3, 5, 8];
/** At most this many areas are active at once (owner, 2 Oct). */
export const MAX_ACTIVE_AREAS = 5;

export type StallRule = 'not-started' | 'idle' | 'unreviewed';

export interface Item {
  id: string;
  level: ItemLevel;
  title: string;
  body: string;
  status: ItemStatus;
  /** When the item entered its current status. */
  statusSince: string;
  resolution?: ItemResolution;
  /** story → its epic, task → its story. */
  parentId?: string;
  /** The epic this item rolls up to (itself for an epic). */
  epicId?: string;
  /** The area, resolved through the epic. */
  areaId?: string;
  /** An employee id, or 'owner'. */
  assigneeId?: string;
  reviewerId?: string;
  /** Epics: who owns the outcome ('owner' or an employee, usually Asha). */
  ownerId?: string;
  points?: Points;
  rank: number;
  /** YYYY-MM-DD. */
  targetDate?: string;
  acceptance: string[];
  /**
   * Blocked: who it waits on — 'owner', 'coo' or 'external' (someone outside the team; the reason
   * says who). A wait on a teammate is never Blocked (LLD §19.6c): it is a review or a `handoff`.
   */
  blocked?: { reason: string; waitingOn: string; since: string };
  /**
   * Handed to a teammate (LLD §19.6c, owner 2 Oct): `assigneeId` has it now and works on it; it
   * returns to `fromId` when they call item_handback. Show it as "with <assignee> (handed by <fromId>)".
   */
  handoff?: ItemHandoff;
  /** Derived, never stored: set while the item is past one of the stall deadlines (LLD §19.6). */
  stall?: { rule: StallRule; since: string; minutes: number };
  /** Backlog held by the owner or the COO: never started automatically (LLD §19.6d). */
  hold?: true;
  /** Ready, waiting for its busy assignee: starts the moment they are free (LLD §19.6d). */
  queuedFor?: string;
  mergedInto?: string;
  /** The release post it shipped in. */
  releasedIn?: string;
  /** The story's Notion doc (W7, doc_write): one per story. */
  docUrl?: string;
  /** The old engine's view of the same row (the /api/work adapters). */
  legacy: { kind: WorkKind; state: string; charterId?: string; featureId?: string };
  /** epic, story, task or bug (a story-level bug). */
  type?: ItemType;
  /** The true status (docs/HLD-jira-lifecycle.md §1): what the board shows. */
  trueStatus?: TrueStatus;
  /** Blocked (or Ready with an open startsAfter): what it waits on and where that stands now. */
  blocker?: ItemBlocker;
  /** An explicit dependency: "Starts after <title> (<status>)". `done` once it finished. */
  startsAfter?: { id: string; title: string; status: string; done: boolean };
  /** On hold: why. */
  holdReason?: string;
  /** Merged and closed by Asha (Merged → Done). */
  closedAt?: string;
  pr?: ItemPr;
  createdAt: string;
  updatedAt: string;
}

/** A handoff on an item (LLD §19.6c). */
export interface ItemHandoff {
  /** Who handed it over (and gets it back): an employee id or 'owner'. */
  fromId: string;
  /** What the assignee is to do before handing it back. */
  reason: string;
  at: string;
}

export interface Area {
  id: string;
  title: string;
  description?: string;
  state: 'active' | 'archived';
  rank: number;
  ownerId: string;
  /** 'area:<id>'. */
  roomId: string;
  /** The area's own channel in its room. */
  threadId: string;
  createdAt: string;
  updatedAt: string;
}

export interface EpicProgress {
  pointsDone: number;
  pointsTotal: number;
  storiesDone: number;
  storiesTotal: number;
  /** 0..100: points when any story is pointed, else stories. */
  pct: number;
}

export interface PlanFlag {
  kind: 'blocked' | 'stalled';
  itemId: string;
  title: string;
  reason: string;
  waitingOn?: string;
  since: string;
  /** The flagged item is handed over (LLD §19.6c): "with <withId> (handed by <fromId>)". */
  handoff?: { withId: string; fromId: string };
}

/** An item of an epic handed to a teammate (LLD §19.6c): the Plan shows "with <withId> (handed by <fromId>)". */
export interface PlanHandoff {
  itemId: string;
  title: string;
  /** Who has it now (its assignee). */
  withId: string;
  /** Who handed it over and gets it back. */
  fromId: string;
  reason: string;
  at: string;
}

export interface EpicCard {
  epic: Item;
  progress: EpicProgress;
  /** The next milestone: the highest-ranked story not yet done. */
  next?: { id: string; title: string };
  flags: PlanFlag[];
  /** Present when items of this epic are handed to a teammate (LLD §19.6c). Not flags: nothing is wrong. */
  handoffs?: PlanHandoff[];
  inFocus: boolean;
  /** Rework W4: the epic is finished (`planTier === 4`); iOS folds these into "Done (N)". */
  finished: boolean;
}

/** Rework W4: super focus (settings key `super-focus`). While `until` is in the future, quiet hours are off and a stall may ring at night. */
export interface SuperFocus {
  until: string | null;
}

export interface Focus {
  epicIds: string[];
  setBy: string;
  at: string;
}

export interface PlanResponse {
  areas: { area: Area; epics: EpicCard[] }[];
  /** Epics with no area yet. */
  unfiled: EpicCard[];
  /** Open items assigned to the owner: shown at the top of the Plan. */
  mine: Item[];
  focus: Focus;
  /** Stories and tasks by status. */
  counts: Record<ItemStatus, number>;
  /** `?view=board`: stories and tasks grouped by status, rank order. */
  board?: Record<ItemStatus, Item[]>;
}

export interface Comment {
  id: string;
  itemId: string;
  at: string;
  /** An employee id, 'owner', 'coo' or 'workplace'. */
  by: string;
  text: string;
  details?: string;
  mentions: string[];
}

export type ActivityKind =
  | 'created' | 'status' | 'assigned' | 'reviewer' | 'points' | 'field' | 'comment'
  | 'commit' | 'test' | 'note' | 'stall' | 'merged' | 'reopen' | 'started' | 'doc';

export interface Activity {
  id: string;
  at: string;
  itemId: string | null;
  by: string;
  kind: ActivityKind;
  from?: string;
  to?: string;
  text: string;
  link?: string;
}

export interface ItemDetail {
  item: Item;
  parent?: Item;
  epic?: Item;
  area?: Area;
  children: Item[];
  comments: Comment[];
  /** Newest last. */
  activity: Activity[];
  progress?: EpicProgress;
  /** The epic's thread in its area room, once it has one. */
  threadId?: string;
}

export type UpdateKind = 'started' | 'shipped' | 'blocked' | 'unblocked' | 'decided' | 'brief' | 'review';

export interface Update {
  id: string;
  at: string;
  kind: UpdateKind;
  /** One line, with names, never a bare count. */
  line: string;
  details?: string;
  by: string;
  itemId?: string;
  inboxId?: string;
  /** App route: item/<id>, inbox/<id>, plan. */
  href: string;
  /** Whether this one is pushed to the phone. */
  push: boolean;
}

export interface InboxMessage {
  id: string;
  inboxId: string;
  at: string;
  by: string;
  text: string;
  details?: string;
}

export interface InboxThread {
  item: InboxItem;
  messages: InboxMessage[];
}

export type RoomKind = 'general' | 'area' | 'releases';

export interface Room {
  /** 'general', 'area:<areaId>' or 'releases'. */
  id: string;
  kind: RoomKind;
  title: string;
  areaId?: string;
  headline: string;
  lastAt: string;
  threadIds: string[];
}

export interface RoomDetail {
  room: Room;
  threads: RoomThread[];
}

export interface ReleasePostItem {
  id: string;
  title: string;
  level: ItemLevel;
  kind: 'story' | 'fix';
}

export interface ReleasePost {
  id: string;
  at: string;
  title: string;
  version: string;
  shippable?: string;
  releaseId?: string;
  by: string;
  groups: { areaId: string | null; areaTitle: string; items: ReleasePostItem[] }[];
  text: string;
  threadId: string;
}

export interface StatusAnswer {
  q: string;
  line: string;
  matches: { item: Item; line: string; href: string }[];
}

/* ---------- requests ---------- */

export interface CreateItemRequest {
  level: ItemLevel;
  title: string;
  body?: string;
  parentId?: string;
  /** Epics only. */
  areaId?: string;
  assigneeId?: string;
  reviewerId?: string;
  ownerId?: string;
  points?: Points;
  /** 'backlog' or 'ready' (default). */
  status?: 'backlog' | 'ready';
  targetDate?: string;
  acceptance?: string[];
  rank?: number;
  /** 'bug' files a story-level bug. */
  type?: 'bug';
  /** An explicit dependency: it starts after this item finishes. */
  startsAfter?: string;
}

export interface UpdateItemRequest {
  title?: string;
  body?: string;
  assigneeId?: string;
  reviewerId?: string;
  ownerId?: string;
  points?: Points | null;
  rank?: number;
  areaId?: string | null;
  parentId?: string;
  targetDate?: string | null;
  acceptance?: string[];
  status?: ItemStatus;
  resolution?: ItemResolution;
  blockedReason?: string;
  /** An employee id, 'owner', 'coo' or 'external'. A teammate turns Blocked into In review or a handoff (LLD §19.6c). */
  waitingOn?: string;
  /** With status blocked on a teammate: 'review' (→ In review, them reviewing) or 'work' (→ handed to them). Guessed from the reason when absent. */
  kind?: 'review' | 'work';
  /** Why (a reopen needs one; recorded on the activity row). */
  note?: string;
  /** Blocked on the owner: what the asker recommends (goes into the Inbox item). */
  recommendation?: string;
  /** Moving to in-progress: also start the assignee's session. */
  start?: boolean;
  /**
   * Owner/COO only (LLD §19.6d): true parks the item in Backlog on hold (the dispatcher never starts
   * it); false lifts the hold. Moving into Backlog as the owner/COO, or with a hold/parked note, holds it.
   */
  hold?: boolean;
  /** An explicit dependency: it starts after this item finishes; '' clears it. */
  startsAfter?: string;
}

export interface CommentRequest { text: string }
export interface MergeRequest { intoId: string }
/** POST /api/items/:id/handback (LLD §19.6c). */
export interface HandbackRequest { note: string }
export interface InboxReplyRequest { text?: string; optionId?: string }
export interface CreateAreaRequest { title: string; description?: string; ownerId?: string }
export interface UpdateAreaRequest { title?: string; description?: string; state?: 'active' | 'archived'; rank?: number }
export interface CreateReleasePostRequest { version: string; shippable?: string; itemIds?: string[]; title?: string }
export interface FocusRequest { epicIds: string[] }
