# HLD: Owner sprint board and web parity (7 Nov 2026)

Owner, 7 Nov 2026: "Every jira has a date and every epic has a date… do it in the web, not the app. I want the web to be
better than the app. I want a sprint view and today's view, so I can check whenever I want." Planning runs on two-week
sprints. The owner reviews and plans every other Saturday; the COO runs the days.

## 1. Goals

1. **Three levels: Feature > Epic > Story.**
   - A feature is a big outcome that takes weeks.
   - An epic is a 2–5 day deliverable. It is the unit the owner tracks day to day.
   - A story is hours of work, as today.
2. **Every feature and epic has a due date.** Each date change is logged with who, when, old value, new value and reason.
3. **Two-week sprints.**
   - Sprint 1 starts Sat 7 Nov 2026.
   - Each sprint has a one-line goal.
   - Every epic is either in a sprint or in the ranked backlog.
   - Unfinished epics carry over into the next sprint, marked with a reason.
4. **Owner screens on the web, owner-only.**
   - **Today:** the epics due today, highlighted, plus "Waiting on you".
   - **Sprint:** the sprint's epics grouped by feature, a 2-week timeline, and drill-down into each epic's stories.
   - **Backlog:** the owner can rank, plan, park, date and add epics.
   - **Review:** last sprint's done, slipped and carried epics, plus the archive of past sprints.
   - **Teams:** one sprint calendar, and a story board per team.
5. **Web parity:** every screen the iOS Workplace app has, the web has too, so the web is at least as good as the app (§6).
6. **Daily tracking hook:** the COO reads today's tracked epics for the 21:30 IST start report and for the park report.

Out of scope:
- Changing how agents file or work stories. Their MCP tools are unchanged.
- The iOS app. The owner said "don't do it in the app".

## 2. Key decisions

**D1. A feature is a planning record, not a fourth item level.**
- `level: 'epic'` is wired into about 30 server modules: dispatch, hygiene, focus, plan, metrics, room threads, agent tools and so on.
- Adding a level above it, or re-levelling the 40 open epics, would break the agents' filing (a story's parent must be an epic) and the board.
- So a **feature** lives in a new planning table and points at its epics.
- An epic remains an ordinary `level: 'epic'` item that agents already understand, with planning metadata (feature, sprint, due date, rank, plan state) in a side table keyed by the epic id.
- Story `parentId` links are untouched.

**D2. Today's big epics become features through container links.**
- A one-time, idempotent migration wraps each open epic in a feature with the same title and due date. The epic is recorded as the feature's *container epic*.
- The container still holds its existing stories, so nothing moves.
- New 2–5-day epics are filed under the feature. They are new `level: 'epic'` items, so agents keep filing stories under an epic.
- Container epics are hidden from the epic board. Their stories still show when the owner drills into the feature.

**D3. The epic state is partly stored and partly derived.**
- The owner sets the plan state: `backlog`, `planned` or `parked`.
- `in-progress`, `at-risk`, `blocked` and `done` are derived on read from the epic's stories and its due date, so the board can't drift from the real work.
- `overdue` is a flag on at-risk (shown as the red chip).

**D4. Sprints use IST calendar dates.**
- Sprint *n* covers `2026-11-07 + 14·(n−1)` to `+13` days, Saturday to Friday, in IST.
- "Due today" means the IST calendar date.
- The team's work day starts at 21:30 IST. An epic due on day D is due by that day's park (about 15:00 IST on D).
- No 21:30 cut-over is applied to dates. Calendar dates are what the owner reads.

**D5. Carry-over happens lazily on read.**
- The first read after a sprint ends freezes that sprint's report (done, slipped, carried) into the archive.
- It then moves the sprint's unfinished planned epics into the current sprint with `carried: {fromSprint, reason}`.
- The default reason is "Not done by the end of Sprint n". The owner or COO can replace it.

**D6. Teams are the leads under the Chief of Staff.**
- A lead with two or more direct reports gets a board.
- Everyone else (small teams and solo leads) shares one "Experts & prompts" board.
- An optional `teams.yaml` in the workplace directory overrides this (id, name, leadIds), for example to give Mira her own board. See LLD §5.

**D7. Access and actors.**
- The web is published at work.irisforu.com behind the relay's login. Every relayed request is the owner (`actorOf`), and loopback without a header is the owner too.
- The new write routes accept only the owner or the COO (`x-workplace-actor: coo` from loopback). Any other actor header gets 403.
- Agents have no HTTP access, so they never reach these routes.

## 3. Components

- **`packages/shared/src/sprint.ts`:** the contract types (Feature, PlannedEpic, Sprint, views, requests).
- **`packages/server/src/services/sprints.ts`:**
  - schema and the one-time migration
  - sprint calendar and rollover
  - feature and epic planning, and the date log
  - the views: today, sprint, backlog, review, teams, team board, epic detail, tracked day
- **`/api/sprint/*` routes** in `routes.ts`.
- **Web:**
  - new screens: Today (the new home), Sprint, Backlog, Review, Teams, Plan, Item detail, Talk, Dashboard, Updates, Alerts, Settings
  - updated screens: Inbox (thread replies), Releases (posts and the Mac queue)
- **Socket:** planning writes emit an `items.changed`-style event (`sprint.changed`) so open owner screens reload.

## 4. Data

- **New tables:** `plan_features`, `plan_epics`, `plan_sprints` and `plan_dates` (see LLD §2).
- **Existing tables:** read only. The one exception is creating an epic from the web, which calls `items.create`, the same path as everything else.

## 5. Risks

- **Large legacy epics.** For example, "Phone works without the Mac" holds 827 stories. As containers they are hidden from the epic board, so the owner sees only real epics. The feature drill-down caps the stories it shows (open stories first) so the page stays fast.
- **An empty board at first.** Until the COO splits the features into dated epics, the board is empty. The Today screen says so instead of showing nothing.
- **Clock.** All date maths uses an injectable `nowMs` so tests are deterministic.

## 6. Web/app parity audit (reference: iOS branch `mac/app-chat-notify`, 1 Nov 2026)

| App screen / feature | Web before | Fix |
|---|---|---|
| Plan tab: areas, epics with progress and flags, board view, focus | missing | **Plan** screen on `/api/plan` and `?view=board` |
| Item detail: activity, comments, add comment, PR, blocker, merge | missing | **Item** screen on `/api/items/:id` and comments |
| Inbox v2: summary/details, thread replies, reply | answer only | InboxCard gets details, the reply thread and a reply box (`/api/inbox/:id`, `/reply`) |
| Talk tab: every 1:1 chat thread | per-employee page only | **Talk** list on `/api/talk` linking to each employee page |
| Room tab | present | kept |
| Dashboard tab: metrics snapshot, products, trends, Workplace waits | missing | **Dashboard** screen on `/api/metrics/snapshot` |
| Updates feed | missing | **Updates** screen on `/api/updates` |
| Alerts (socket `alert` events this session) | toast only | **Alerts** list in the store, with a bell in the top bar |
| Spend sheet | present | kept |
| Releases, release posts, ready | releases only | release **posts** and **Mac queue** (with grant) added to Releases |
| Office, Features | present | kept |
| New request | Assign screen | kept (Assign covers it) |
| Settings: super-focus | missing | **Settings** screen (super-focus on/off) |
| Settings: push devices, per-chat mute | n/a | **deferred:** push notifications go to phones, and the web gets no pushes |
| @mention autocomplete in composers | missing | **deferred:** the app sends plain text that the server parses, so mentions already work |
| Themes (sci-fi) | light/dark toggle | **deferred:** cosmetic |

After these fixes the web has everything the app has except the phone-only push features. It also has more than the app: the sprint board (Today, Sprint, Backlog, Review, Teams) and owner editing.
