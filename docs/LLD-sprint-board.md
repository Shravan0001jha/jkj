# LLD: Owner sprint board and web parity

The design is in HLD-sprint-board.md. The code is in `packages/shared/src/sprint.ts`, `packages/server/src/services/sprints.ts`,
the `/api/sprint/*` routes, and `packages/web/src/features/{sprint,plan,item,talk,dashboard,updates,alerts,settings}`.

## 1. Contract (`@jkj/shared` sprint.ts)

```ts
type PlanState = 'backlog' | 'planned' | 'parked';
type EpicState = 'backlog' | 'planned' | 'in-progress' | 'at-risk' | 'blocked' | 'done' | 'parked';
interface DateChange { subjectId; kind: 'feature' | 'epic'; from?: string; to?: string; by; at; reason }
interface Feature {
  id: 'fe_…'; title; body; dueDate?: 'YYYY-MM-DD'; status: 'active' | 'parked' | 'done';
  rank: number; containerEpicIds: string[]; createdAt; updatedAt;
  progress: { epicsDone; epicsTotal; storiesDone; storiesTotal; pct };
}
interface PlannedEpic {
  id;                      // the work item id (level epic)
  title; featureId?; featureTitle?; sprintId?: 'sp_<n>' | null;
  planState: PlanState; state: EpicState; overdue: boolean; dueToday: boolean; dueDate?;
  rank; progress: EpicProgress;
  blockers: { storyId; title; blocker: ItemBlocker }[];   // the open stories that are blocked or waiting, with their blocker
  waitingOnOwner: boolean; carried?: { fromSprint: string; reason: string; at: string }[];
  ownerId?; assignees: string[];
}
interface Sprint { id: 'sp_<n>'; number; start; end; goal?: string; current: boolean }
interface SprintReport { sprintId; number; start; end; goal?; done: EpicRef[]; slipped: EpicRef[]; carried: EpicRef[]; frozenAt }
interface TodayView { date; sprint: Sprint; dueToday: PlannedEpic[]; overdue: PlannedEpic[]; atRisk: PlannedEpic[];
  blocked: PlannedEpic[]; doneToday: PlannedEpic[]; waitingOnYou: WaitingOnYou[]; empty: boolean }
interface SprintView { sprint: Sprint; features: { feature?: Feature; epics: PlannedEpic[] }[];
  timeline: { date; epics: { id; title; state }[] }[];        // the next 14 days, by due date
  totals: { epics; done; atRisk; blocked } }
interface BacklogView { sprint: Sprint; next: Sprint; planned: PlannedEpic[]; backlog: PlannedEpic[]; parked: PlannedEpic[]; features: Feature[] }
interface ReviewView { current: Sprint; last?: SprintReport; archive: SprintReport[] }
interface Team { id; name; leadIds: string[]; memberIds: string[] }
interface TeamBoard { team: Team; sprint: Sprint; columns: Record<'todo'|'progress'|'review'|'qa'|'done', Item[]> }
interface EpicDetail { epic: PlannedEpic; feature?: Feature; stories: Item[] /* blocked first, then open, then done */; dates: DateChange[] }
interface TrackedDay { date; sprint: Sprint; tracked: PlannedEpic[] /* due today + overdue + in progress in the sprint */ }
```

Requests:
- `CreateFeatureRequest {title, body?, dueDate?}`
- `UpdateFeatureRequest {title?, body?, dueDate?, status?, reason?}`
- `CreatePlannedEpicRequest {title, featureId, dueDate, body?, areaId?, ownerId?, sprint?: 'current' | 'backlog'}`
- `UpdatePlannedEpicRequest {featureId?, dueDate?, planState?, sprintId?, reason?, carryReason?}`
- `RankRequest {epicIds}`
- `UpdateSprintRequest {goal}`

## 2. Tables (created by `sprints.ensure(wp)`; idempotent)

```sql
plan_features(id pk, rank real, status text, due_date text, json text)
plan_epics(epic_id pk, feature_id text, sprint_id text, plan_state text, due_date text, rank real, json text)
plan_sprints(id pk, number int, start text, end text, json text)          -- json: {goal?, report?}
plan_dates(seq integer pk autoincrement, subject_id text, kind text, from_date text, to_date text, by text, at text, reason text)
plan_meta(key pk, value text)                                            -- 'migrated:v1'
```

## 3. Rules

**Calendar**
- `istDate(ms)` is the YYYY-MM-DD at +05:30.
- Sprint *n* starts on `2026-11-07 + 14(n−1)`. `sprintFor(date)`. Dates before Sprint 1 belong to Sprint 1.

**Migration v1** (runs once, on the first `ensure`):
- For every epic that is open (not done) and not already a container, insert a feature with the same title and `due = targetDate`, `containerEpicIds = [epic.id]`, in the epic's plan order.
- Containers get no `plan_epics` row.

**Epic registration**
- An epic appears on the board only once it has a `plan_epics` row.
- The row is created when the epic is made through `POST /api/sprint/epics`, or when it is linked to a feature with `featureId`.
- Unlinked non-container epics show in Backlog under "Unplanned epics" so the owner can adopt them.

**Derived state.** Checked in this order, first match wins:
1. `parked` if planState = parked.
2. `done` if the item is done, or every story is done (storiesTotal > 0).
3. `blocked` if any open story has trueStatus blocked, or waiting on owner/external, or the epic itself is blocked.
4. `at-risk` (with `overdue`) if dueDate < today.
5. `at-risk` if dueDate ≤ today+1 and pct < 50, or if any open story is stalled.
6. `in-progress` if any story is in progress, in review, in QA, approved or done.
7. Otherwise `planned` if it is in a sprint, else `backlog`.

- `dueToday` = dueDate == today and the epic isn't done.

**Dates**
- A change to a feature or epic due date writes `plan_dates`.
- A **reason is required** when the subject already had a date. Setting the first date needs no reason.
- The date must be a valid YYYY-MM-DD.

**Plan moves**
- planState `planned` with no sprintId means the current sprint.
- `backlog` or `parked` clears sprintId.
- `sprintId` must be the current or a future sprint (`sp_n` with n ≥ current).

**Rank**
- `POST /api/sprint/backlog/rank` sets rank 1..k in the given order for those epic ids.
- Unknown ids give 400.

**Rollover.** On every read:
1. Freeze reports for any sprint with `end < today` that has no report yet.
2. For epics with `sprint_id` = that sprint and not done: append `carried {fromSprint, reason: 'Not done by the end of Sprint n', at}` and set `sprint_id` = current.
3. `carryReason` on an update replaces the last carried reason.

**Waiting on you**
- Open owner-facing Inbox items: id, title, summary, createdAt.
- Plus open stories and epics waiting on, or blocked on, `owner`: id, title, reason.

## 4. Routes (in `routes.ts`, all under `/api/sprint`)

| Method | Path | Notes |
|---|---|---|
| GET | `/today` | TodayView |
| GET | `/current` | SprintView, current sprint (`?sprint=sp_n` for another) |
| GET | `/backlog` | BacklogView (plus `unplanned` epics) |
| GET | `/review` | ReviewView |
| GET | `/teams` | Team[] |
| GET | `/teams/:id` | TeamBoard |
| GET | `/epics/:id` | EpicDetail |
| GET | `/features` | Feature[] (with progress) |
| GET | `/features/:id` | `{feature, epics, containerStories (open first, cap 200), dates}` |
| GET | `/tracked?day=YYYY-MM-DD` | TrackedDay (COO daily hook) |
| POST | `/features` | create (201) |
| POST | `/features/:id` | update |
| POST | `/epics` | create epic item + plan row (201) |
| POST | `/epics/:id` | update plan row (adopts an unplanned epic) |
| POST | `/backlog/rank` | rank |
| POST | `/sprints/:id` | `{goal}` |

- **Writes:** `ownerOrCoo(req)`.
  - An `x-workplace-actor` header other than owner or coo gives **403**.
  - A loopback request with no header is the owner, and a relayed request is always the owner.
  - The actor is recorded as `by`.
- **Events:** each write emits `{type: 'sprint.changed', at}`.

## 5. Teams

- `teams.yaml` in the workplace directory, if it exists: `- {id, name, leads: [employeeId…]}`. Members are the leads plus their direct reports.
- Otherwise, derived:
  - Every direct report of the Chief of Staff who has ≥ 2 direct reports becomes a team: `id = lead id`, `name = "<Lead>'s team"`.
  - All other direct reports of the Chief of Staff, with their reports, form `{id: 'small', name: 'Experts & prompts'}`.
  - Asha and the CTO are left out: they are cross-team.
- **Board.** Every story or task assigned to a member that is either open, or done inside the sprint window (by `statusSince`).
  - Columns come from trueStatus:

    | trueStatus | Column |
    |---|---|
    | backlog, ready, on-hold | todo |
    | in-progress, waiting, blocked, parked | progress |
    | in-review | review |
    | qa, approved | qa |
    | merged, awaiting-mac, done | done |

  - Cards keep `blocker` and `trueStatus`, so the web shows the blocked marker.
  - Parked stories are left out unless they were parked this sprint.

## 6. Web

**Routes:** `today` (new default home), `sprint`, `backlog`, `review`, `teams/:id`, `epic/:id`, `feature/:id`, `plan`, `item/:id`, `talk`, `dashboard`, `updates`, `alerts`, `settings`, plus the existing ones.

**Navigation**
- Primary: Today, Sprint, Inbox, Talk, Room.
- More: Backlog, Review, Teams, Plan, Dashboard, Updates, Office, Features, Org, Assign, Releases, Spend, Settings.

**Chips**

| State | Chip |
|---|---|
| done | green |
| on track (planned or in-progress, not at risk) | blue |
| at-risk | amber |
| overdue | red |
| blocked | grey, with the blocker label |
| parked | outline |

**Editing (Backlog and Epic screens)**
- **Reorder:** up/down buttons, plus drag and drop on desktop.
- **Plan / Unplan / Park.**
- **Date:** a date input that asks for a reason when the epic already had a date.
- **New epic:** title, feature and date.
- **New feature.**

**Layout and loading**
- Phone width: a single column, with the tab bar reduced to the 5 primary screens.
- Each screen reloads on `sprint.changed`, `item.updated` and `inbox.updated` events.

## 7. Tests (TDD; `packages/server/test/sprint-board.test.ts`)

1. **Calendar:** IST dates and sprint boundaries (6 Nov 23:59 IST → Sprint 1; 21 Nov → Sprint 2).
2. **Migration:**
   - Open epics become features with containers, and done epics are skipped.
   - It is idempotent.
   - Story parent links are unchanged.
3. **Epic creation:** creates a level-epic item plus its plan row; a story filed under it works.
4. **Derived state:** done, blocked (story blocked on owner), overdue, at-risk (due tomorrow, 0%), in-progress, parked, planned/backlog.
5. **Date log:** a reason is required on change, it is optional the first time, and the log has from/to/by/reason.
6. **Rank order and plan moves:** sprint validation; a past sprint is refused.
7. **Rollover:** the report freezes, unfinished epics carry over with a reason, and it is idempotent.
8. **Today view:** due today, overdue, waiting on you (owner inbox item and a story waiting on the owner), and empty state.
9. **Teams:** the derived teams from the tree fake (`withTree`), the `teams.yaml` override, and board column mapping.
10. **Routes over HTTP:**
    - the owner writes succeed (201/200)
    - `x-workplace-actor: kabir` gives 403
    - the COO header works
    - a `sprint.changed` event is emitted
    - the tracked endpoint works
