# LLD — The Iris Workplace

Companion to `HLD-workplace.md`. Section numbers referenced from the HLD are these.

## 1. Data directory layout (`IRIS_WORKPLACE_DIR`, default `~/iris-workplace`)

```
handbook.md                  company handbook (layer 1); seeded from the brief §5
org.yaml                     units, roles refs, employees, teams, reporting lines
roles.yaml                   role templates
map.yaml                     ownership map
requirements.yaml            imported requirements (id, group, section, segments, status, evidence)
charters/<id>.md             front-matter (id, title, axis, version, holders, tokens budget) + body
units/<id>.md                unit doc (layer 2)
employees/<id>/status.md     three lines: doing / done / blocked
employees/<id>/handoff.md    what the next session needs
proposals/<id>.json          org-change proposals (pending, approved, rejected) with before/after
workplace.db                 SQLite: work items, inbox, events, sessions, spend, releases
.git                         every approved org change is a commit
```

The seed lives in `packages/server/seed/` with the same layout (minus `.db`, `.git`) and is copied
when the data directory is empty. `IRIS_WORKPLACE_DIR` pointing at a temp directory is how tests
run against a fresh, real organisation.

## 2. Domain types (all in `@jkj/shared`, `src/workplace.ts`)

```ts
type Axis = 'capability' | 'platform' | 'function' | 'project' | 'segment';
interface Charter { id; title; axis; version; mission; scope: string[]; owns: OwnedThing[];
  interfaces: { publishes: string[]; consumes: string[] }; rules: string[]; definitionOfDone: string[];
  buildTestShip: string[]; coordinateWith: string[]; needsOwnerApproval: string[]; tokens: number; body: string }
interface Role { id; title; level: 1 | 2 | 0 /* 0 = chief of staff, 1 lead, 2 hire */; instructions;
  tools: { allowed?: string[]; disallowed?: string[] }; permissionMode; model; budgetClass: 'high'|'medium'|'low' }
interface Employee { id; name; roleId; charterIds: string[]; unitId; chapterIds: string[]; reportsTo: string | null;
  level: 0|1|2; permanent: boolean; workspace: { repo: string; worktree?: string; branch?: string };
  budget: { inrPerDay: number; concurrentSessions: number }; githubApp?: string /* slug only */; state: EmployeeState }
type EmployeeState = 'idle' | 'working' | 'blocked' | 'needs-owner' | 'paused';
interface Unit { id; title; parentId: string | null; kind: 'unit' | 'chapter'; budget?: { inrPerDay: number } }
interface MapEntry { kind: 'path'|'service'|'route'|'feature'|'platform'|'keyword'|'requirement-group'|'requirement';
  key: string; primary: string; contributors: string[]; consulted: string[] }
interface LintFinding { code: 'orphan'|'overlap'|'dead'|'unowned-requirement'|'unheld-charter'|'unknown-ref';
  severity: 'error'|'warn'; subject: string; message: string }
interface Requirement { id; group; section; title; note?; segments: string[];
  status: 'missing'|'partial'|'built'|'verified'|'released'; evidence: string[]; charterId: string | null; featureIds: string[] }
interface Coverage { total; owned; planned; built; verified; released; byGroup: Record<string, Coverage-without-byGroup> }
interface WorkItem { id; kind: 'feature'|'assignment'|'bug'|'question'; title; body; state; charterId?; employeeId?;
  featureId?; requirementIds: string[]; platformIds: string[]; plan?: string; evidence?: Evidence; sessionId?;
  createdAt; updatedAt; history: { at; from; to; by; note? }[] }
interface Evidence { tests: { passed: number; failed: number; command?: string }; commits: string[];
  liveVerified: string[]; notVerified: string[]; notes?: string }
interface InboxItem { id; kind: 'approval'|'decision'|'question'|'cap'|'org-change'|'release';
  title; body; context: Record<string, unknown>; options: { id; label; danger?: boolean }[];
  state: 'open'|'answered'|'expired'; answer?: { optionId; note?; at; via: 'web'|'phone'|'telegram' };
  raisedBy: string; createdAt }
interface OrgProposal { id; kind: 'hire'|'retire'|'split'|'merge'|'reassign'|'restructure'; reason; proposedBy;
  state: 'pending'|'approved'|'rejected'|'applied'; before: OrgSnapshot; after: OrgSnapshot; diff: string; inboxId; createdAt; appliedCommit? }
interface SpendEntry { at; employeeId; sessionId; model; inputTokens; outputTokens; cacheRead; cacheWrite; usd; inr }
interface SpendSummary { day; companyInr; capInr; byEmployee: Record<string, number>; byTeam: Record<string, number>; paused: string[] }
interface Release { id; shippable: 'desktop-mac'|'desktop-intel'|'windows'|'ios'|'android'|'server-api'|'server-agent'|'website';
  version; state: 'proposed'|'approved'|'rejected'|'running'|'done'|'failed'; unreleased: string[]; inboxId; log? }
```

`Agent` (existing) gains `employeeId?`, `assignmentId?`, `contextTokens?`.

## 3. Context assembly (`services/context-layers.ts`)

`assembleContext(employeeId, assignment?) → { layers: ContextLayer[], append: string, tokens }`.
Layers in order: handbook → unit doc (walk `unitId` then its parent chain, outermost first) →
each charter body (in `charterIds` order) → `status.md` + `handoff.md` → assignment block. Each
layer is rendered as `## <label>\n<body>`; the append is joined by blank lines and capped at
`WORKPLACE_CONTEXT_TOKENS` (default 24 000, estimate = chars/3.6); over the cap, the assembler drops
charter *body* detail after the "Rules" section first and reports `truncated: true`. The existing
`ContextResponse` is extended so the employee page shows Workplace layers above the repo's
`CLAUDE.md` chain, all editable (charters and handbook write back to the data dir).

## 4. Routing and lint (`services/ownership.ts`)

```
resolve(thing: {kind, key}) → { primary, contributors, consulted } | null
  path:     longest entry.key that is a prefix of key (entries normalised, trailing slash)
  requirement: exact id, else requirement-group of that requirement's group
  keyword:  not resolved directly; used by route(text)
  others:   exact key
route(feature: {title, body, paths[], services[], platforms[], requirementIds[]}) → RouteResult
  hits = union of resolve() over every explicit thing
       + keyword entries whose key appears as a whole word in title/body (case-insensitive)
  primaries = distinct primaries of hits; consulted = union of consulted minus primaries
  → [{ charterId, because: [things] }], sorted by number of things, then id
lint(org, map, requirements, fs) → LintFinding[]
  orphan: repo top-level dirs (from org.repos[].root, one level) with no path entry covering them
  overlap: same (kind,key) twice with different primary
  dead: path entry whose key does not exist on disk (checked relative to each repo root)
  unowned-requirement: resolve({requirement,id}) === null
  unheld-charter: charter with no employee.charterIds containing it
  unknown-ref: entry.primary/contributors/consulted not a charter id
```

## 5. Requirements import (`services/requirements.ts`)

Input: the 110 checklist items (transcribed in `seed/requirements.checklist.ts` with group, name,
status, note — from "Iris Against Its Definition", 27 Sep) plus the non-checklist candidates from
the product-definition extract (`seed/product-definition-extract.md` §F). Ids: `REQ-<GROUPSLUG>-<nn>`,
stable by (group, title). Statuses map: Built→`built`, Partial→`partial`, Missing→`missing`; "Live-
tested" items → `verified`; nothing is `released` (branch is ahead of 0.2.15 and the checklist says
so). Re-import: same ids are matched by (group,title); status is only raised by import, never
lowered without `--reset`; new items are added; missing ones are flagged, not deleted.
`coverage()` counts owned (charterId set), planned (featureIds non-empty), built (`built|verified|
released`), verified, released.

## 6. Work (`services/work.ts`), features (`services/features.ts`)

State machine for assignments is a table; illegal transitions throw `BadRequest`. `review` requires
`evidence.tests` and non-empty `commits` *or* `notes` (non-code work). `done` is set by the
reviewer (lead for a hire; QA for a lead's own work; owner for anything with `needsOwnerApproval`)
and records `verifiedBy`. A `done` claim from the assignee's session (`report_done` tool) moves to
`review`, never to `done` — that is the false-done guard, and the false-done rate counts reviews
that were sent back.

Feature flow: `POST /api/features` (stated) → Chief of Staff session writes spec (tool
`write_spec`) → `decompose(featureId)` = `route()` → one assignment per charter, assigned to a
holder of that charter (least-loaded, then first) → each assignment spawns a session whose
assignment block says "Reply with `## Plan` first". A session's first assistant text containing
`## Plan` is stored as `plan` and moves `proposed → planned`.

Pivots: `GET /api/features/pivot?rows=charter|platform|team&cols=feature` computes counts of
assignments by state per cell, from `work` joined with `org`.

## 7. Sessions (`services/employees.ts` over `runs.ts`)

`spawn(employeeId, { assignmentId?, prompt })`: assembles context (§3), builds env
(`{...process.env, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY: undefined}` — the SDK's `env` option
replaces the child env, so the key is removed, not blanked), `cwd` = workspace path, `model`,
`permissionMode`, `allowedTools`/`disallowedTools`, `maxBudgetUsd` = remaining employee budget in
USD, and the Workplace MCP tools (`report_status`, `report_done`, `ask_owner`, `propose_org_change`,
`request_review`, `write_handoff`) served in-process via the SDK's `createSdkMcpServer`. They are in
`allowedTools` so they never prompt; the SDK lists them as deferred, so a session reaches them through
`ToolSearch` (verified live). Their schemas must be MCP-serialisable: a `z.record()` parameter made the
MCP SDK fail to list *any* tool of the server (found 27 Sep, pinned by `workplace-tools.test.ts`), so
`propose_org_change` takes `paramsJson` as a string. The result message's
`modelUsage` is diffed against the last seen totals to write `SpendEntry` rows. `talk(employeeId,
text)` = send to the open session or spawn. `endSession` asks for the handoff (a final prompt),
waits up to 90 s, then closes.

### 7a. Isolation (`services/worktrees.ts`, `services/guards.ts`)

Before a session starts, `ensureWorktree` cuts (or reuses) `~/iris-work/<employee>/<repo-name>` on
`emp/<employee>/<work-item-id>` from the base branch tip and links `.venv`, `.venv-x64` and the
`node_modules` directories from the main checkout; `spawn` refuses a cwd inside any org repo root. A
PreToolUse hook runs `guardTool`: edits must be inside the worktree and inside a path the employee's
charters own in the map (scratch under the OS temp dir is free); commands matching push/merge/rebase/
reset --hard/filter-repo/worktree/remote, a switch to a base branch, the release/deploy/testflight/
ssh-window scripts, ssh/scp/aws/gh/sudo/devicectl, `rm -rf`, or naming a main checkout are denied; the
same commands are also `disallowedTools`. `report_done` refuses evidence when `git diff base...HEAD`
plus uncommitted files include anything the employee does not own, and records only real commits on the
branch. Merging into the base branch is the lead's (a different identity), until real PRs exist.

**An open session taking a new assignment (live 2 Oct).** `assign` (`POST /api/work/:id/start`, `POST
/api/items/:id {start:true}`) with the employee's session already open used to only message it, so Dev
built a new story on `emp/dev/general`, cut before that day's merge. Now: between turns, the worktree is
moved with `ensureWorktree(item)` (uncommitted work auto-saved as a WIP commit on the old branch) and only
then is the assignment sent; mid-turn (running, or an approval pending) the switch and the message are
queued (in memory, per agent) and run when that turn ends (run event `waiting`, no approval), one per turn
end; a session closing with assignments queued starts each in a session of its own (not on a shutdown).
The session's `assignmentId`, `worktree` and row (`assignment_id`, `json.branch`, `json.cwd`) follow the
move. A switch that fails blocks the assignment with the reason, as at spawn. An item branch that does
not exist, or exists with no commits of its own (an ancestor of the base), is (re)cut at the base tip
(`checkout -B` / `worktree add -B`); one with its own commits is checked out as it is.

### 7b. Sessions across a restart, and interrupts

Every session row records its SDK session id, its status and any pending tool approval as they change.
On boot, rows still open are closed as `lost-on-restart`; and one Inbox question per lost session names
the pending tool and the resumable SDK id, so a decision is never dropped silently (iOS device test, 27
Sep). **A restart is not a transition of the work (QA, 2 Oct):** a `building` assignment whose session
the Workplace ended (an orderly shutdown, or a crash found on boot) keeps its status; the interruption is
an activity `note` ("Session run_x was shut down by the Workplace; it resumes on the next boot…") and a
settings marker `resume:<itemId>`. `resumeAfterShutdown` (boot, two at a time) starts each marked item
again and clears its marker; a capped employee's item is skipped and keeps its marker for the next boot;
an item that moved on in the meantime (no longer `building`) just loses its marker. Rows blocked by a
shutdown under the old rule (history `cause: workplace-shutdown`) are still resumed once. Before this,
every restart moved each building story to Blocked and the boot moved it straight back: a Blocked and an
Unblocked line per story, a second apart, in the feed and the epic's thread. An interrupt leaves a session `idle`
with no approval attached; a message wakes it.

**Talk and review sessions across a restart (QA, 2 Oct).** A session with no assignment (owner talk,
an autonomous talk, a review session) that the Workplace cut off **mid-turn** — its run `running` or
parked on a tool approval at an orderly shutdown (`close(…, 'shutdown')`), or its row still open with
status `running` / a pending approval when the boot finds a crash (`recoverAfterRestart`) — gets a
settings marker `resume-talk:<sessionId>` = `{ employeeId, sdkSessionId }`. `resumeAfterShutdown`, after
the assignments, spawns each one with `resume: sdkSessionId` (the same SDK conversation) and the prompt
"The Workplace restarted while you were mid-turn; continue where you left off." (from `workplace`),
then clears the marker; a capped employee, or one that already has a session open, keeps its marker
for a later boot (one session per employee: an open session is never displaced). A talk whose turn
had finished (`waiting`, no approval), one that ended normally (`ended`, `stale`, …) and probes are
never marked. The SDK session id is written to the row the moment the SDK names it (`onSessionId`),
so a crash before the next run event can still resume. `ResumeAfterShutdown` gains `resumedTalks`.

## 8. Approvals and gates (`services/approvals.ts`)

`POLICY: Record<Action, Approver>` from the brief §0. `gate(action, ctx)` returns `{ allowed: true }`
only when the action's approver is `nobody`, or an `InboxItem` of kind `approval` with
`context.action === action && context.subject === ctx.subject` is `answered` with option `approve`.
`releases.ts` and `deploys.ts` call `gate` before `spawnScript`; the script runs with
`stdio: pipe`, the log is stored on the `Release` row and streamed on the socket. Scripts are the
real ones; tests inject a fake spawner.

## 9. Budget (`services/spend.ts`)

IST day boundaries (`Asia/Kolkata`). `record(entry)`; `summary(day)`; `check(scope)` → `ok |
at-cap`. On `at-cap`: `employees.pause(scope)` (interrupts running sessions of that scope with a
system line, sets `state: paused`), files an Inbox item of kind `cap` with options `raise-today`
(asks for a number) / `keep`. Company cap `WORKPLACE_CAP_INR` default 1000; per-day override stored
in the db by the answered inbox item.

### 9b. Real money (`services/spend.ts`, `services/usage.ts`, `services/aws-cost.ts`) — HLD D9b

Two ledgers. **`usage`** (subscription, free): one row per session result (`employeeId, sessionId,
model, turns, inputTokens, outputTokens, cacheRead, cacheWrite, equivalentInr`), plus the latest
`rate_limit_event` per window (`five_hour`, `seven_day*`: status, utilization, resetsAt) kept in
`settings`. **`spend`** (real money): `source: 'anthropic-api' | 'aws' | 'third-party'`, `basis:
'metered' | 'estimated' | 'reported'`, `employeeId`, `sessionId?`, `what`, `inr`, `day`. Rows written
before 28 Sep carry `source: 'subscription'` and are excluded from every cap; the migration relabels
them. `SpendSummary.companyInr` is real money only; `subscription` holds the free figures.

| Source | How it is measured | Basis |
|---|---|---|
| Anthropic API via Iris's llm-gateway / iris-api during an employee's tests | the gateway's per-request usage (tokens × list price) read from its response or its `/usage` endpoint by the session and recorded with `record_spend` | metered |
| A paid third-party API an employee runs (Deepgram, ElevenLabs, OpenAI, web search) | `record_spend` from the session, with the provider's reported units where it gives them | metered / reported |
| A release (`release-iris.sh`) | S3 PUT + ~200 MB transfer + one CloudFront invalidation: ₹2 estimate; `release-iris-x64` the same | estimated |
| A deploy (`deploy-api.sh`, `deploy-agent.sh`, `deploy-web.sh`) | data transfer + invalidation: ₹1 estimate | estimated |
| AWS, actual | Cost Explorer `GetCostAndUsage` for the previous IST day, once a day at 09:05 (`WORKPLACE_AWS_COST`, default on; each call costs ~₹1 and is itself recorded) → one `metered` row "AWS actual (unattributed)" replacing that day's estimates in the day's total | metered |

`record_spend({ source, inr | usd, what, units? })` is a Workplace MCP tool; the row is `reported`
unless the session passes provider units, then `metered`. Caps (`check`) sum only real sources; a
pause stops `spawn` for **autonomous** work and the guard denies commands that would spend (release,
deploy, the paid-provider CLIs) for the paused scope; reads, plans and owner talk are never paused.

## 10. Stall and loop detection (`services/health.ts`)

Every 30 s over running sessions: `idleMs > 600 000` → stalled; last 5 tool entries identical
(label + text hash) → looping. Action: interrupt, `state: blocked`, Inbox `question`. Signals
computed on request: throughput, rework, false-done rate, cost per completed item (7-day window).
Org signals: queue length per charter > 5, context-limit hits ≥ 3 in 7 days, mutual blocking pairs,
orphans → listed as "proposal triggers" on the Org screen.

### 10b. Stalled work and the Chief of Staff's routine (`services/stall.ts`, `services/cos.ts`)

An assignment in `proposed | planned | building` with no session activity (its own updates, its last
session, its live transcript) for more than `WORKPLACE_STALL_MINUTES` (30) is **stalled**: derived at
read time (`WorkItem.stalledSince`), counted on the Office (`counts.stalled`), shown on the card.
Every five minutes `cos.tick` resumes the oldest stalled item that can be resumed (assignee not
paused, ≥ ₹50 real headroom, not already resumed today; one per tick) or raises one Inbox note per
item per day saying why it waits: a cap, an open question to the owner, a pending org change touching
its charter, or "resumed once already". "Resume it now" on the note starts it regardless. Items
that could be resumed but lost this tick's one slot are **queued** (`TickResult.queued`), not noted:
the next tick takes them, so a restart with ten stalled items costs the owner no pings.

### 10c. Approvals in three places (`employees.needsYouItems`, `inbox.affects`) — HLD D7b

`InboxItem` gains `affects: string[]` (employee ids the item concerns), `onApprove`, `onDeny` (one
line each) and `links`. `affects` is computed at raise time: the raiser, the assignee of
`context.assignmentId`, the holders of `context.charterId` and of a proposal's charters, the scope of
a cap; the Chief of Staff always. `EmployeeDetail.needsYou` lists open **owner-facing** items whose
`affects` includes the employee, and `EmployeeCard.needsYou` counts them: the same set the Inbox shows,
never housekeeping (`ownerFacing: false`; QA 2 Oct, Asha's 21 were 20 housekeeping). A denial (`reject`/`deny`/`no`) is delivered to the raiser: `runs.sendMessage` into its
open session, else appended to its `handoff.md` as "## Denied: <title> — <note>".

### 10d. The Team Room (`services/room.ts`) — HLD D3b

Tables `threads (id, title, charter_ids, created_by, created_at, state, summary, json)` and
`messages (id, thread_id, at, by, text, mentions, json)`. `by` is an employee id, `owner` or
`workplace`; the owner's messages carry `owner: true`. Routes: `GET /api/room` (threads, newest
activity first, with the last message and unread-for-owner count), `GET /api/room/:id`, `POST
/api/room { title, text, charterIds?, mentions? }`, `POST /api/room/:id/messages { text }` (the owner),
`POST /api/room/:id/resolve { summary }`. Socket: `room.thread`, `room.message`. Session tools:
`room_post({ threadId | title, text, mentions })`, `room_read({ threadId })`; Chief of Staff only:
`room_resolve({ threadId, summary, followUps: [{ employeeId, title, body }] })` (follow-ups become
assignments to those employees) and `escalate({ threadId, title, body, options })` (an Inbox item with
`context.threadId`). Context: each employee's assembled context gets a "Team Room" layer with its
open threads (title, last three messages). Moderation: `cos.tick` also hands Asha any thread with
messages newer than her last look (a session turn, free under D9b): she is asked to reply, assign or
resolve, and to escalate only above her authority.

## 11. Telegram (`services/telegram.ts`)

`notify(text)` = spawn `~/iris-ops/notify.sh`. `tailInbox()` reads `~/iris-ops/state/inbox.jsonl`
from `~/iris-ops/state/workplace-cursor` every 5 s; parses `approve <id>`, `reject <id>`,
`talk <employeeId> <text>`, `status`; applies via the same services the web uses, `via: 'telegram'`.
Pings: new Inbox item (one line + id), assignment blocked, cap reached, milestone. Daily digest
09:00 IST.

## 12. GitHub (`services/github-apps.ts`) — what the lead creates

Workplace side: `apps/<slug>.json` `{ appId, installationId, keyPath, org, repos[] }`; `mintToken(slug)`
(JWT RS256, `iat-60`, `exp+540`; `POST /app/installations/{id}/access_tokens`); `openPr`, `requestReview`,
`checks`, `merge` over `fetch` (injected). Nothing here creates Apps.

**For the lead to create in `shravan0001jha-iris-hq`** (names follow the seed charters; add one App
per new lead at hire):

| GitHub App (slug) | Bot identity | Installed on | Permissions |
|---|---|---|---|
| `iris-chief-of-staff` | `iris-chief-of-staff[bot]` | `iris-contracts`, every repo (read) | contents RW, pull requests RW, checks R, metadata R |
| `iris-conversation-lead` | `iris-conversation-lead[bot]` | `iris-agent` | contents RW, pull requests RW, checks R |
| `iris-experts-lead` | `iris-experts-lead[bot]` | `iris-agent` | same |
| `iris-memory-lead` | `iris-memory-lead[bot]` | `iris-server`, `iris-agent` (memory client paths) | same |
| `iris-desktop-lead` | `iris-desktop-lead[bot]` | `iris-desktop` | same |
| `iris-mobile-lead` | `iris-mobile-lead[bot]` | `iris-mobile` | same |
| `iris-qa` | `iris-qa[bot]` | every repo | pull requests RW (review/approve), checks R, contents R |

Repos (the proposed split; final boundaries come from the leads' split plan, owner-approved):
`iris-contracts` (API schema, event shapes; CODEOWNERS = all leads + CoS), `iris-agent`
(`services/agent-svc`, experts, character spec consumers), `iris-desktop` (`desktop/`, release
scripts for Mac/Intel/Windows), `iris-server` (`services/iris-api`, `services/cloud-agent`, deploy
scripts), `iris-mobile` (`mobile/ios`, `mobile/android`), `iris-web` (`web/`), `iris-workplace-data`
(optional mirror of the data dir). Org ruleset on `main` for all: PR required, required status
check `ci`, 1 approval from a different identity, CODEOWNERS enforced, no force-push, no deletion.
Private keys go to `~/iris-ops/workplace/apps/<slug>.pem` mode 600.

## 13. Phone reach (`http/auth.ts`)

Token file `~/iris-ops/workplace/api-token` (32 random bytes, hex, mode 600), created at boot if
missing. Middleware: request from loopback → allowed; otherwise `Authorization: Bearer` must equal
the token (constant-time compare) or 401. WebSocket upgrade checks the same header or `?token=`.
`POST /api/pair` (loopback only) → `{ code, expiresAt }`; `POST /api/pair/exchange { code }` (any
origin) → `{ token }` once. Loopback is **always** bound; `--host <ip>` adds one more listener on that exact address (never
`0.0.0.0`), so the page on the Mac and the loopback-only pairing route keep working while the phone
reaches the second listener with the token. `POST /api/pair/exchange` is the one route that needs no
token (it carries the one-time code). Verified 27 Sep from the LAN interface: no token → 401, wrong
token → 401, token → 200, `POST /api/pair` from the LAN → 400, exchange from the LAN → the token,
second use of the code → 401, socket upgrade without token → 401, with `?token=` → open and
`office.snapshot` received.

## 14. Workplace API contract (the phone app builds against this; stable from here)

All JSON. Errors `{ error: string }` with 400/401/404/409. Times are ISO-8601. Ids are opaque
strings. The contract is `packages/shared/src/workplace-api.ts` (`WORKPLACE_API` paths + types).

### REST

| Method & path | Body → Response | Screen |
|---|---|---|
| GET `/api/health` | → `HealthResponse` (adds `workplace: { dataDir, cap, day }`) | boot |
| GET `/api/office` | → `OfficeResponse { units: [{ unit, employees: EmployeeCard[] }], coverage, needsYou: number, spend: SpendSummary }` | Office |
| GET `/api/org` | → `OrgResponse { units, roles, employees, charters (summary), map, lint, proposals, history: OrgHistoryEntry[] }` | Org |
| GET `/api/charters/:id` | → `Charter` | Org |
| PUT `/api/charters/:id` | `{ body }` → `Charter` (bumps version, commits) | Org |
| GET `/api/inbox` | → `InboxItem[]` (open first) | Inbox |
| POST `/api/inbox/:id/answer` | `{ optionId, note? }` → `InboxItem` | Inbox |
| GET `/api/employees` | → `Employee[]` | all |
| GET `/api/employees/:id` | → `EmployeeDetail { employee, charters, status, handoff, sessions: Agent[], assignments: WorkItem[], spendToday }` | Employee |
| POST `/api/employees/:id/talk` | `{ text, attachments? }` → `Agent` (the session, new or continued) | Talk |
| POST `/api/employees/:id/end-session` | → `{ ok }` (asks for handoff, closes) | Employee |
| GET `/api/employees/:id/context` | → `ContextResponse` (Workplace layers + repo chain) | Employee |
| PUT `/api/employees/:id/context` | `{ id, body }` → `ContextLayer` | Employee |
| GET `/api/agents/:id/log` (existing) | → `LogEntry[]` | Employee |
| POST `/api/agents/:id/message` (existing), `/interrupt`, `/approve`, `/mode` (also over WS) | | Employee |
| GET `/api/work?kind=&state=&charterId=&employeeId=&featureId=` | → `WorkItem[]` | Assign |
| POST `/api/work` | `{ kind, title, body, charterId? \| employeeId?, requirementIds?, platformIds? }` → `WorkItem` (assignment routed if no target) | Assign |
| POST `/api/work/:id/transition` | `{ to, note?, evidence? }` → `WorkItem` | Assign/Employee |
| GET `/api/features` | → `FeatureBoard { features: WorkItem[], byState }` | Features |
| POST `/api/features` | `{ title, body, requirementIds?, platformIds?, paths?, services? }` → `WorkItem` | Assign |
| POST `/api/features/:id/decompose` | → `{ feature, assignments: WorkItem[], route: RouteResult }` | Features |
| GET `/api/features/:id` | → `FeatureDetail { feature, assignments, requirements, route }` | Features |
| GET `/api/features/pivot?rows=charter\|platform\|team` | → `Pivot { rows: string[], cols: string[], cells: Record<row, Record<col, PivotCell>> }` | Features |
| GET `/api/requirements?group=` | → `Requirement[]`; GET `/api/requirements/coverage` → `Coverage` | Features/Office |
| GET `/api/route?text=&paths=&platforms=` | → `RouteResult` (dry run) | Assign |
| GET `/api/proposals`; POST `/api/proposals` `{ kind, reason, params }` → `OrgProposal` (pending, files an Inbox item); POST `/api/proposals/:id/apply` (needs approved) | Org |
| GET `/api/releases`; POST `/api/releases` `{ shippable, version }` → `Release` (proposed, Inbox item); POST `/api/releases/:id/run` (needs approved) → `Release` | Releases |
| GET `/api/spend?day=` → `SpendSummary`; GET `/api/health/signals` → `HealthSignals` | Spend |
| POST `/api/pair` (loopback) → `{ code, expiresAt }`; POST `/api/pair/exchange` `{ code }` → `{ token }` | phone setup |
| POST `/api/talk` `{ text, attachments? }` → `Agent` (the Chief of Staff's session; `OfficeResponse.chiefOfStaff` names her) | Office / phone |
| POST `/api/requests` `{ text, platformIds? }` → 201 `RequestResponse { feature, status }` (a stated feature titled by its first line; Asha asked for the spec); GET `/api/requests` → `RequestResponse[]` newest first | Features / phone |
| GET `/api/features` adds `status: Record<featureId, RequestStatus>`; GET `/api/features/:id` adds `status` | Features |
| GET `/api/features/pivot` cells add `items: PivotItem[]` (id, title, employeeId, state, evidence summary, href) | Features |
| GET `/api/proposals/:id` → `ProposalDetail { proposal (with diff, lint), item }`; approving the item applies it, so `/apply` after that is 409 | Org / phone |
| GET `/api/releases/ready` → `ReleaseReadiness[]` per shippable `{ unreleased, open?, last? }`; POST `/api/releases/:id/run` → 202 `running` | Releases / phone |
| POST `/api/work/:id/start` → 201 `Agent` (the session that took the assignment) | Assign |
| POST `/api/work` accepts `featureId?` (the assignment attaches to that feature: its status and the pivot count it; 400 if it is not a feature) and `start?: false` | Assign / phone |

`RequestStatus { stage: with-asha | specced | routed | building | review | blocked | built | released; line; assignments[]; askedAgentId? }`
is derived (`services/requests.ts`): `stated` → with-asha (whether Asha's session was started is in the
settings table as `spec-asked:<id>`); `specced` or no assignments → specced; otherwise counts by state,
where a started session without a plan yet counts as building; any blocked → blocked; review only →
review; `built`/`released` from the feature.

### One line to the owner (D16) — contract additions of 28 Sep

| Type | Field | Meaning |
|---|---|---|
| `OwnerLine` (new) | `summary: string`, `details?: string` | `OWNER_LINE_MAX = 120`. The summary is what the owner reads; details sit behind an expand control. |
| `InboxItem` | `summary: string` (required), `details?: string` | Derived from `body` when the raiser gave none; `body` stays as the full text. Old rows get a summary on read. |
| `RoomThread` | `headline: string` (required) | The thread's one-line status for the owner. Set at creation (title, or the poster's `headline`), by any post carrying `headline`, and by the resolution summary. Old rows read as their title. `summary` is still the resolution summary. |
| `LogEntry` (transcript) | `summary?: string`, `details?: string` | On `kind: 'assistant'` entries only: the reply's one line and, when the reply was longer, the whole text. |
| `ServerEvent 'alert'` | `body` | Now the item's `summary` (was the first 200 chars of the body). |
| `room_post` tool | `headline?` | Employees set the owner's line for a thread. |
| `RaiseOptions` (server) | `summary?`, `details?` | `ask_owner`, `request_review` and the rest pass the body; the guard derives the line. |

Telegram: a ping is `Iris Workplace · <summary> — reply: approve <id> / reject <id>` (one line); the
digest is `Iris Workplace · needs you N · done yesterday N · blocked N · real money ₹X of ₹Y` plus at
most three `· <summary>` lines.

### WebSocket `/ws` (`ServerEvent` additions)

`office.snapshot { office: OfficeResponse }` (once, on connect), `office.updated { card: EmployeeCard }`, `inbox.updated { item }`, `work.updated { item }`,
`proposal.updated { proposal }`, `release.log { id, line }`, `spend.updated { summary }`,
`alert { level: 'info'|'needs-you'|'blocked'|'cap'; title; body; inboxId? }`. The existing
`agent.updated` / `agent.log` stay. `ClientCommand` additions: `inbox.answer { id, optionId, note? }`.
Alerts are the phone's push-style feed; the phone shows them as notifications while open.

## 14b. One line to the owner (`services/one-line.ts`) — HLD D16

`oneLine(text)`: strip code blocks; take the first non-empty line without its markdown furniture
(heading marks, bullets, numbering, emphasis, inline code); take its first sentence when that is at
least 16 characters; trim to 120 at a word with an ellipsis. `details` is the whole original text
whenever the original had more than one line or the summary is shorter than the line. `withOwnerLine`
applies it to assistant transcript entries in `runs.append`. `inbox.raise` stores `summary`/`details`
on the item (the raiser's own `summary` wins) and the `alert` event carries the summary; `list`/`get`
backfill old rows. `room.createThread/post/resolve` maintain `headline`. `telegram.ping` and
`telegram.digest` render the one-liners. The handbook (layer 1 of every context) carries the rule.

## 14c. One Workplace per organisation (`services/lock.ts`) — HLD D17

`acquire(dir, pid, alive)`: `workplace.lock` next to the database holds `pid\nISO`. A different live
pid throws `AlreadyRunning` (the CLI exits 1 with the pid and time); a dead or garbage holder is
taken over; the same pid re-acquiring gets a no-op handle so a nested boot cannot release the
first. `start()` acquires before `createWorkplace` and releases on any boot failure and in `stop()`.
`http/server.listen` rejects on the listener's `error` (EADDRINUSE names the address). `cli.ts`
arms a 20 s deadline on SIGINT/SIGTERM and exits 1 if `stop()` has not finished.

## 15. Web screens (`packages/web`)

Router by hash (`#/office`, `#/org`, `#/inbox`, `#/features`, `#/employee/:id`, `#/assign`,
`#/releases`, `#/spend`). Shell: top bar (needs-you count, spend today / cap, connection), bottom
tab bar under 720px, left rail above. Employee page embeds the existing `AgentChat` (transcript,
composer, approvals, permission mode) plus a Context panel using `ContextView`.

## 16. Config

`IRIS_WORKPLACE_DIR`, `IRIS_OPS_DIR` (default `~/iris-ops`), `WORKPLACE_CAP_INR` (1000),
`WORKPLACE_USD_INR` (88), `WORKPLACE_CONTEXT_TOKENS` (24000), `WORKPLACE_DIGEST_HOUR` (9),
`--port` (4317), `--host` (127.0.0.1), `--no-open`, `--no-telegram` (tests), `--no-seed`.

## 17. Publishing: the relay and the login (HLD D11b)

**Relay service** `services/workplace-relay/` in the deploy worktree (`~/claude-dev-deploy`): Python
3.12, FastAPI + `websockets`, its own SQLite (`/opt/workplace-relay/relay.db`), systemd unit
`workplace-relay` on `127.0.0.1:9200`, Caddy site `work.irisforu.com { reverse_proxy 127.0.0.1:9200 }`
(Caddy issues the certificate). Deploy script `scripts/deploy-workplace-relay.sh` follows
`deploy-agent.sh`: tests locally, `ssh-window.sh open`, scp, venv, unit, Caddy reload, health check,
`ssh-window.sh close`. It never touches `/opt/iris-api`.

**Tunnel protocol** (one WSS `/tunnel` from the Mac, `Authorization: Bearer <tunnel secret>`; the
secret is in `~/iris-ops/workplace/relay.env` on the Mac and `/opt/workplace-relay/.env` on the box,
mode 600, generated once):

| Frame | Direction | Fields |
|---|---|---|
| `http` | relay → Mac | `id, method, path, headers, body` (base64); Mac answers `response { id, status, headers, body }` |
| `ws-open` / `ws-frame` / `ws-close` | both | `id, path` / `id, data` / `id` — one relay client socket ↔ one local socket to `127.0.0.1:<port>/ws` |
| `telegram` | relay → Mac | `text` — the Mac runs `notify.sh` (codes, new-device pings) |
| `off` | Mac → relay | drops every session and refuses until `on` |
| `ping`/`pong` | both | liveness: the relay pings every 15 s and closes a Mac that has not answered for 45 s; the Mac reconnects when it has had no pong for 45 s |
| `on` / `enrol-on` | Mac → relay | `on` is sent on every connect (the relay stays off across restarts until the Mac says so); `enrol-on` re-enables passkey enrolment after it disabled itself |

The Mac side is `services/tunnel.ts`: reconnect with backoff (1 s → 30 s), forwards to its own
loopback port (trusted, D11), reports `published: connected | offline` on `/api/health` and the Office.

**Login** (`/login`, `/login/*` on the relay; single allowed email from config):
- Passkey: `webauthn` (py_webauthn), RP id `work.irisforu.com`, user handle = the email; enrolment
  at `/login/enrol` needs a Telegram code first (6 digits, 10 min, 5 attempts).
- Fallback: `/login/code` sends an email code (SES, as iris-api's email sign-in does) **and** a
  Telegram code; both must match.
- Session: 32-byte random id, server-side row `{ id, created, last_seen, device, ua, ip }`; cookie
  `wp_session` httpOnly/Secure/SameSite=Strict; idle 12 h, max 7 d; the id rotates every hour of use.
  Bearer form for the app: the same id in `Authorization: Bearer`. CSRF: cookie sessions must send
  `X-CSRF-Token` equal to the `wp_csrf` cookie on every non-GET; bearer sessions are exempt.
- Rate limits: 5 failed factors per IP or per email in 15 min → 15 min lockout; audit table
  `{ at, session, ip, kind, path, ok }` for every login step and every non-GET.
- `/logout`, `/logout-all`; `POST /off` (from the tunnel) and `/on`; a new device (new session
  without a `wp_device` cookie) → Telegram ping through the tunnel.
- iOS: `ASWebAuthenticationSession` opens `/login?app=1`; on success the relay redirects to
  `irisworkplace://auth#token=<session id>`; the app stores it in the Keychain and sends it as a
  bearer. Contract change announced to "main".

**Hardening from the reviews (27 Sep), all pinned by tests in `test_relay_security.py`:** the relay
reads only the real client address (uvicorn's proxy headers from Caddy; never `X-Forwarded-For`);
code requests are limited globally (3/hour, 10/day) with an owner alert; five wrong enrolment codes in a
day disable enrolment until `enrol on` from the Mac or Telegram; once a passkey exists, another needs a
signed-in session plus the code; failures ping the owner (throttled); the tunnel secret is compared in
constant time and a second live tunnel is refused, audited and reported; session tokens are 256-bit and
stored as SHA-256; bearer sessions never rotate, cookie sessions rotate hourly only on the proxy path
with a 60 s grace for the old token; `logout-all` closes live sockets; a cookie socket must come from
our origin; `/api/pair*` is refused through the relay and forwarded requests carry `x-via-tunnel`, which
the Mac's pairing route refuses; the unit runs as its own user with `--no-access-log` (the app's socket
token is in the query string), NoNewPrivileges, ProtectSystem=strict, ProtectHome; Caddy caps bodies at
32 MB and sets HSTS/nosniff/no-referrer; the Mac validates relay-supplied paths and caps responses at
12 MB; health shows counts only on loopback; cookies are `__Host-`; the WebAuthn handle is opaque.
Known trade-off: a stranger can exhaust the shared code budget or lock the owner's email fallback for
15 minutes; passkey login is unaffected.

**Verification (live, from outside the LAN):** no session → login page; wrong or absent factor →
refused; passkey → in; WebSocket without a session → rejected; tunnel down → "Mac offline";
new-device Telegram ping arrives.

## 18. The COO in the app, a chat view of Talk, and the Room as a real group chat (owner, 29 Sep)

Order followed: this RCA/design note → failing tests → code (`coo.test.ts`, `coo-routes.test.ts`,
`mentions.test.ts`, `chat-view.test.ts`, plus edits to `room.test.ts`'s escalate coverage and the
employee-count assertions in `api.test.ts`/`org.test.ts`/`phone-e2e.test.ts`/`fix-batch.test.ts`).

### 18a. RCA: why `@mentions` went unanswered

`room.ts`'s `mentionsIn`/`post` have always computed and stored `RoomMessage.mentions`. The only
code that ever read that field was `push.ts`'s `intentFor`, and only for an `@owner`/`@shravan`
mention (`ownerMentionPattern`) — a phone push, not a turn. Nothing subscribed to `room.message` to
start or resume the mentioned *employee's* session. The Team Room context layer
(`room.contextFor`) does surface a thread to an employee, but only the next time something spawns
it for other reasons (a new assignment, the owner talking to it) — there was no path that made a
mention itself the reason for a turn. Fix: `services/mentions.ts` subscribes once at boot
(`wireMentionReplies`, wired in `index.ts` next to `room.seedThreads`) to the same `room.message`
event `room.post`/`createThread` already emit — covering the REST route, the `room_post` tool and
the seed uniformly, with no new dependency from `room.ts` onto `employees.ts` (that would cycle:
`employees.ts` already depends on `room.ts` for the context layer).

### 18b. The COO: a virtual employee, not a session

**Decision.** `coo` is a real row in `org.yaml` (`Employee.virtual: true`, new field), shown in
Office/Org/the ownership tree like anyone else (Asha's `reportsTo` becomes `coo`), but
`employees.spawn`/`talk` refuse it outright (`BadRequest`, pointed at the bridge). Its
`EmployeeState` gains two values, `online`/`offline`, and `stateWithReason` special-cases a virtual
employee to read `coo.presence` (the lead's `coo/heartbeat` mtime, online under 3 minutes) instead of
session state — offline shows "messages wait; Asha handles routine" per the owner's spec.

**Why not spawn it as a session:** the COO *is* the lead's own terminal session on this Mac; spawning
a second Claude Code session under that name would be a second, competing "COO" with no shared
memory, defeating the point. **Why still an `Employee` row:** so it sorts into Office/Org for free —
card, org tree, `needsYou` — without a parallel UI.

**No mirroring (owner clarification, 29 Sep, replacing an earlier draft that reused the session/
transcript machinery).** The COO's Talk transcript is not a driven session's log: it is exactly
`{ what the owner sent to coo } + { what the lead sent back through POST /api/coo/reply }`, nothing
else — no tool calls, no thinking, ever. This is why it is its own small store (`coo_messages`,
`coo_items` — SQLite, HLD D2: operational data) behind its own routes, not a `runs.ts` session
reused with a filter; a filter can leak (a rendering bug shows the raw log) where a separate store
cannot.

**The bridge, concretely.** `<workplaceDir>/coo/`: `inbox.jsonl` (write-only from the server; the
lead tails it — owner messages, escalations and `@coo` mentions, one JSON object per line, tagged by
`kind`) and `heartbeat` (write-only from the lead, touched every 60 s; read-only here, `mtime` only).
The transcript and escalation items themselves live in SQLite because only the Workplace ever reads
or writes them — the file is purely the outbound artifact the lead's own process needs.

**Escalation routing.** `coo.routeEscalation` is what `room.escalate` (Asha's Team Room escalations)
and `mentions.ts` (`@coo`) both call: it always writes a `coo_items` row and an `inbox.jsonl` entry
first; if the COO has been offline for more than 30 minutes (`OFFLINE_FALLBACK_MS`, separate from
the 3-minute online threshold the card uses) it *also* raises the item straight to the owner's Inbox
on its own, so an urgent decision never silently waits on an absent COO. `POST /api/coo/answer`
settles an item within the COO's own authority (no owner Inbox item ever created); answering an
`@coo` **mention** with a note also posts that note where the mention was made — the Room thread, or
the item's comments for an `item:<id>` mention — **as `coo`, never as the owner** (2 Oct).
`POST /api/coo/thread-reply { threadId | itemId, text }` (lead-only, loopback, 201 with the
`RoomMessage` or `Comment`) lets the lead post as `coo` into any Room thread or on any item: the
owner's own routes (`POST /api/room/:id/messages`, `POST /api/items/:id/comments`) always write as
`owner`, and `POST /api/coo/reply` only reaches the COO chat. `POST /api/coo/forward { itemId, recommendation }` raises it to the owner's Inbox with the
recommendation folded into the body. The §0/D8 owner-only gates (release, deploy, org changes, a
cap) are untouched — those are already separate, dedicated Inbox items from `releases.ts`/
`proposals.ts`/`spend.ts`, never routed through `room.escalate`, so this change never touches them.

**Loopback only for the lead's own writes — not for the owner (correction, 29 Sep).** The first cut
of this guarded the whole `/api/coo/*` surface with the `/api/pair`/`/api/relay/off` check
(`isLoopback(remoteAddress) && !headers['x-via-tunnel']`), reading "the API needs no auth beyond
loopback" as covering the entire surface. That is wrong for the owner's own side of the bridge: the
owner reaches the Workplace **only** through the tunnel from his phone (D11b — there is no LAN
listener once publishing is on), so a loopback-only `POST /api/coo/message` would make the app
useless for the one person it is for. The split that actually matches the threat model:

- **Owner-facing** — `GET /api/coo/log`, `POST /api/coo/message`, `GET /api/coo/presence` — need
  nothing beyond the ordinary bearer/cookie session every other `/api/*` route already requires off
  loopback; there is no extra guard, because there is nothing extra to guard against here.
- **Lead-only** — `POST /api/coo/reply`, `GET /api/coo/items`, `POST /api/coo/answer`,
  `POST /api/coo/forward`, `POST /api/coo/thread-reply` — only the lead's own process on this Mac ever writes *as* the COO, so
  these keep the loopback-and-not-tunnelled guard: a stolen or leaked owner bearer token must not be
  enough to forge a COO reply.

The socket hub needed the same split, and had a real leak before it: `wp.on(event =>
broadcast(event))` fanned every event to every connected client with no filter at all, so a `coo.item`
(lead-only bookkeeping) would have reached a paired phone the moment the REST guard was added but the
hub was not. Fixed in `ws/hub.ts`: a socket's loopback-ness is captured once at the upgrade (the same
check), `coo.message` goes to every authorised socket (it is the owner's own conversation, and he is
never loopback), and only `coo.item` is held back to loopback sockets. Tested both ways in
`coo-routes.test.ts`, over HTTP and over a real socket connection with `x-via-tunnel` set.

### 18c. Chat view of Talk (`toChatView`, `@jkj/shared/chat-view.ts`)

A pure function, not a stored second copy of the transcript: `'assistant'`/`'user'`/`'image'` pass
through unchanged (an assistant entry already carries D16's `summary`/`details`); a run of **two or
more** consecutive `'read'|'edit'|'bash'|'search'|'task'|'tool'` entries collapses into one
`kind: 'activity'` entry (`"worked · 6 steps · 1m 12s"`, the original entries kept on `.activity.entries`
for the expand control); a lone tool call is left as it is (a one-step "activity" reads worse than
just showing it); `'system'`/`'error'` entries (an approval decided, a rate limit, a session note)
are left in place, uncollapsed — neither a chat message nor tool activity, and nothing the owner
might need to see (an approval that was granted, a session that closed) should vanish into a
"worked" line. The live approval prompt is not a transcript entry (`Agent.approval`) and this
transform never touches it — "approval requests still shown inline" falls out for free.

**Why one function, not two implementations.** The server serves it at `GET /api/agents/:id/log?view=chat`
(default/`view=full`/no query still returns everything — LLD §14 stays stable). The web needs the
*same* collapsing to stay correct while a session is still streaming: a raw tool-call entry lands
over `/ws` (`agent.log`) one at a time, so a client-side-only "ask the server once, then diff" scheme
would visibly un-collapse as new entries arrived. `Transcript.tsx` instead calls `toChatView` itself,
live, over whatever is already in the store; `AgentChat.tsx` adds a "Chat / Full log" toggle. Because
it is one pure function in `@jkj/shared` (a "tiny pure helper", per that package's own rule) rather
than a duplicated transform, the server and the client can never disagree about what counts as a
message.

### 18d. The Room: a General channel, and mentions that wake a turn

**General channel.** `room.ensureGeneral` (idempotent, fixed id `th_general`, called once at boot
next to `seedThreads`) is an ordinary `RoomThread` — no new type, no special-cased route — so every
existing Room screen, the `room_post` tool and `mentionsIn` already work on it unchanged.

**Mention-reply turns (the RCA fix, §18a).** A mention starts (or, if a session is already open,
merges into) a turn for that employee with the thread as its prompt, via `employees.talk(...,
{ autonomous: true, probe: true })`: `autonomous` keeps it off the owner-talk path (so a real-money
cap still pauses it, caught and logged rather than thrown); `probe` means it never overwrites the
employee's real `status.md`/`handoff.md` — a Room reply is not an assignment. `@coo` is routed to
`coo.notifyMention` (§18b) instead of a spawn, since the COO is never spawned. Bounded, per the
owner's brief: `MENTION_COOLDOWN_MS` (10 minutes) is a per-`(employee, thread)` rate limit, so a
burst of replies in one thread wakes each mentioned employee at most once per window — "one reply
turn per mention" without a duplicate-message index, because a single `RoomMessage`'s `mentions` is
already a `Set` (an employee cannot be mentioned twice in one message).

**`room.replying` (iOS agent's finding, 29 Sep): "Mira is replying…".** `{ threadId, employeeId,
state: 'started' | 'done' | 'skipped' }`, emitted by `mentions.ts`'s `wake`. `skipped` is the
cooldown or a cap turning the wake away before anything begins — there is no `started` to pair it
with. Otherwise `started` fires the moment the turn is handed to `employees.talk`, and `done` on the
next `onRunEvent` for that agent id whose status has left `'running'` — the SDK's own turn boundary,
whether the employee replied, did nothing, or errored; the event does not distinguish those, only
"still going" from "not". No new subscription machinery: `runs.onRunEvent` already exists for the
stall detector and the socket hub.

### 18f. Two corrections from live testing against the app (29 Sep)

**The COO bridge's owner-facing routes are not loopback-only.** The first cut guarded the whole
`/api/coo/*` surface with the `/api/pair`-style check. Wrong for the owner's own side: he reaches
the Workplace only through the tunnel (D11b), so `GET /api/coo/log`, `POST /api/coo/message` and
`GET /api/coo/presence` need only the ordinary bearer/cookie session every other `/api/*` route
already requires off loopback — ie. no extra guard at all. `POST /api/coo/reply`, `GET
/api/coo/items`, `POST /api/coo/answer` and `POST /api/coo/forward` stay loopback-and-not-tunnelled:
only the lead's own process may write as the COO. The socket hub gets the matching split: `coo.item`
(lead-only bookkeeping) is held to loopback sockets; `coo.message` — and now `coo.presence` — reach
every authenticated socket, relay included, because both are the owner's own view of the bridge.

**`coo.presence` (iOS agent's finding, 29 Sep): online/offline as an event, not only a poll.** The
server never observes a heartbeat write directly — the lead's own process touches the file; nothing
here watches it — so presence is polled on the existing 30 s timer (next to the stall check) and
`coo.pollPresence` emits `{ type: 'coo.presence', presence }` only when online ↔ offline actually
flips (state kept in `settings`, not a module variable, so a test's poll never leaks into another
test's). The first poll of a boot only seeds that state; nothing has "flipped" yet, so it emits
nothing.

### 18e. What changed in the existing contract, for the record

`Employee.virtual?`, `EmployeeState` gains `online`/`offline`, `LogEntry.kind` gains `'activity'`
with a new `LogEntry.activity` field, new types `CooMessage`/`CooItem`/`CooPresence`, new
`WorkplaceServerEvent` cases `coo.message`/`coo.presence` (every authenticated socket, relay
included), `coo.item` (loopback-delivered only, §18f) and `room.replying` (§18d), new REST
`/api/coo/{log,message,presence}` (ordinary auth, relay/tunnel allowed) and
`/api/coo/{reply,items,answer,forward}` (loopback-and-not-tunnelled), `GET /api/agents/:id/log`
gains `?view=chat`. Nothing existing was removed or renamed. `packages/server/seed/org.yaml`/`roles.yaml`
gain the `coo` employee/role and change Asha's `reportsTo`; `proposals.ts`'s hire-with-no-`reportsTo`
default now explicitly prefers the chief-of-staff charter holder over "whoever is level 0" (the COO
is level 0 too, but virtual, and must never become a new hire's default lead);
`spend.ts`'s cap check skips virtual employees (a ₹0/day budget on an employee that never spends
would otherwise show as permanently "at cap" and pollute every paused-scope list).


## 19. v2: areas, epics, stories, tasks (HLD §8, D18–D26)

Order followed: HLD §8 → this section → failing tests (`v2-*.test.ts`) → code. Contract types:
`packages/shared/src/workplace-v2.ts` (exported from `@jkj/shared`). Services: `items.ts` (the v2
model and state machine over `work`), `activity.ts` → `trail.ts` (activity, comments, updates),
`areas.ts`, `watch.ts` (event-driven stalls), `rhythm.ts` (brief, stand-up, weekly review),
`status.ts` (on-demand answers), `migrate-v2.ts`; additions to `inbox.ts`, `room.ts`, `releases.ts`,
`runs.ts`, `employees.ts`, `push.ts`, `chat-view.ts`.

### 19.1 Schema (`workplace.db`, additive)

```sql
-- work: the one item store (features = epics, assignments = stories/tasks). New columns, added by
-- `alter table … add column` on open; the JSON blob stays the source of truth.
alter table work add column level text;        -- epic | story | task
alter table work add column status text;       -- v2 state (19.3)
alter table work add column parent_id text;    -- story → epic, task → story
alter table work add column area_id text;      -- epics only; stories/tasks inherit through the parent
alter table work add column rank real;         -- order among siblings (epics: within the area)
alter table work add column reviewer_id text;
create index work_parent on work(parent_id); create index work_status on work(status);

create table areas (id text primary key, title text not null, state text not null,  -- active | archived
  rank real not null, created_at text not null, json text not null);
create table comments (id text primary key, item_id text not null, at text not null, by text not null,
  json text not null);                              -- index (item_id, at)
create table activity (seq integer primary key autoincrement, id text not null, at text not null,
  item_id text, by text not null, kind text not null, json text not null);  -- index (item_id, seq)
create table updates (seq integer primary key autoincrement, id text not null, at text not null,
  kind text not null, item_id text, json text not null);                    -- the Updates feed
create table inbox_messages (id text primary key, inbox_id text not null, at text not null,
  by text not null, json text not null);
create table release_posts (id text primary key, at text not null, version text not null, json text not null);
-- threads gain `room_id` (general | area:<id> | releases) in their JSON and a column.
```

Limits: **≤ 5 active areas** (creating or re-activating a sixth is 409). Points ∈ {1,2,3,5,8}.
Area rooms: thread `th_area_<areaId>` (the area's own channel) is made with the area; an epic's
thread `th_epic_<epicId>` is made when the epic first has an area. Releases room: `th_releases`.
Legacy threads (and `th_general`) are in `general`.

### 19.2 Item fields (on `WorkItem`, all optional, additive)

`level`, `status`, `statusSince`, `parentId`, `areaId` (epics), `rank`, `points`, `reviewerId`,
`ownerId` (epic owner: `owner` or an employee), `targetDate` (YYYY-MM-DD), `acceptance: string[]`,
`blockedReason`, `waitingOn`, `blockedSince`, `resolution` (`done | wont-do | duplicate`),
`mergedInto`, `releasedIn`. `employeeId` is the assignee and may now be `owner` (v2 create/update
only; such an item never gets a session). Stories also keep `featureId` = their epic, so the old
feature roll-up, pivot and request status keep counting them; tasks keep `featureId` = the epic too.

The client shape is a projection, `Item` (19.8): `toItem(workItem)`.

### 19.3 State machine (`items.ts`)

| From \ to | backlog | ready | in-progress | in-review | done | blocked |
|---|---|---|---|---|---|---|
| backlog | – | ✓ | ✓ | | owner only (wont-do) | |
| ready | ✓ | – | ✓ | | owner only (wont-do) | ✓ |
| in-progress | ✓ | ✓ | – | ✓ reviewer | owner/epic only | ✓ |
| in-review | | | ✓ (sent back) | – | ✓ reviewer/owner | ✓ |
| blocked | ✓ | ✓ | ✓ | ✓ reviewer | | – |
| done | | | ✓ reopen (note) | | – | |

- **Into in-review**: `reviewerId` set (in the request or already) and ≠ assignee, else 400.
- **Into blocked**: `blockedReason` (non-empty) and `waitingOn` (an employee id, `owner` or `coo`),
  else 400. `waitingOn: owner` raises one owner-facing Inbox question (dedupe `blocked:<id>`) with
  the recommendation if given; leaving blocked expires it. Leaving blocked clears the three fields.
- **Into done**: `by` is the reviewer or `owner`; never the assignee unless the assignee is `owner`.
  Epics: `owner` or the epic owner. From backlog/ready only by `owner`, with `resolution: wont-do`.
- **done → in-progress** (reopen) needs a note; recorded as activity `reopen`.
- An epic moves Ready/Backlog → In progress when any of its stories does (either engine); it is
  closed by the owner or its owner, never by a roll-up of v2 stories.
- An agent's own report (`report_done`) still goes through the old engine (evidence required) into
  `review`; the server fills `reviewerId` with the default reviewer: a task's story assignee (if not
  the assignee), else the `qa-release` holder (if not the assignee), else the Chief of Staff.

**Mapping old → v2** (applied whenever the old engine changes `state`):

| old (assignment) | v2 | old (feature) | v2 |
|---|---|---|---|
| proposed | ready (backlog stays backlog) | stated, specced | ready |
| planned, building | in-progress | decomposed, in-progress | in-progress |
| review | in-review | built, released | done |
| done | done | | |
| blocked | blocked (reason = the history note, waiting on `coo`) | | |
| rejected | done, resolution wont-do | | |

**Mapping v2 → old** (applied by v2 writes, written directly, bypassing the old table): backlog,
ready → `proposed`; in-progress → keeps `planned`/`building`, else `building` when a plan exists,
else `proposed` (the next session is asked for its plan first); in-review → `review`; done →
`done` (`rejected` for wont-do/duplicate); blocked → `blocked`. Epics: in-progress → `in-progress`
(from `decomposed`), done → `built`; otherwise the feature state is left alone.

### 19.4 Activity, comments, updates (`trail.ts`)

- `record(wp, { itemId, by, kind, from?, to?, text, link? })` → `Activity`; emitted as
  `activity.recorded`. Written by every item write (created, status, assigned, reviewer, points,
  field, merged, reopen), every comment, `report_done` (commits, tests), and every system note
  (stall, auto-start, moved to backlog, COO action). **System and COO notes go here, never to Talk.**
- `comment(wp, itemId, { by, text })` → `Comment`; mentions as in the Room; agent comments are
  shortened (19.9); emitted `item.comment`; a mentioned employee gets a reply turn (mentions.ts).
- `postUpdate(wp, …)` → `Update`; emitted `update.posted`. Generated by the item writes:
  - **started**: a story enters in-progress → `Started: <title> — <assignee>, <n> pts` (push)
  - **shipped**: a story or epic enters done (resolution done) → `Shipped: <title> — <assignee>` (feed only)
  - **blocked**: a story or task enters blocked → `Blocked: <title> — waiting on <who>: <reason>` (push);
    the reason in the line is its first sentence cut at a word to ~100 chars (`oneLine(reason, 100)`), the
    whole reason is the update's `details` and stays on the item (iOS QA, 2 Oct)
  - **unblocked**: leaves blocked → `Unblocked: <title> — <assignee>`
  - **decided**: an owner Inbox item answered → `Decided: <title> — <option label>`
  - **brief**, **review**: 19.7. Never a count without names.
- The same four item events post a **named chat line** in the epic's thread of its area room
  (author `workplace`, `kind: 'update'`): "Story 'X' started — Dev", "Story 'X' is done", "Story 'X'
  is blocked: waiting on Rohan", "Story 'X' is unblocked", "Epic 'X' is done".
- **No flapping (QA, 2 Oct).** Every transition is an activity row, but the feed line and its room
  line are posted only when they are news: (1) an identical line (same item, kind and text, run ids
  ignored) posted within `WORKPLACE_UPDATE_DEDUPE_MIN` (10) minutes is not posted again, in either
  place; (2) **unblocked** is posted only when the item's newest Blocked/Unblocked line is a
  **blocked** one (no "Unblocked" for a block nobody was told about). With (1), an item flapping
  Blocked ↔ In progress for the same reason produces one Blocked and one Unblocked line. The Plan's
  flags remain the live truth; the feed is the digest of changes.
- **Standing channels are never resolved (QA, 2 Oct).** An epic's thread (`th_epic_<id>`, or any
  thread with `epicId`), an area's channel (`th_area_<id>`), General and Releases keep receiving
  update lines for as long as the work exists, so `room.resolve` refuses them (400 on `POST
  /api/room/:id/resolve`, "Not resolved: …" from `room_resolve`); only topic threads resolve. The
  boot migration reopens any standing channel resolved before the rule (`room.reopenChannels`, every
  boot, idempotent; the summary is dropped, the headline kept). The Workplace's own lines (`by:
  workplace` with `kind` update/standup/release) never hand a thread to the moderator
  (`room.needsModeration` looks only at messages from people), so Asha is not woken to "moderate"
  them. Chosen over "automated lines reopen a resolved thread" because that would let a thread flip
  resolved ↔ open with every line, and the owner's composer would come and go with it.

### 19.5 Inbox threads

`inbox_messages` rows; `InboxItem` gains `messageCount`, `lastMessageAt`, `urgency`
(`normal | high | urgent`, default normal), and `InboxOption.recommended`. **Always populated (QA,
2 Oct)** on `GET /api/inbox`, `GET /api/inbox/:id` and every socket `inbox.updated`: `messageCount`
counted from `inbox_messages` (0 when none), `lastMessageAt` when there is a reply, `urgency` = the
raiser's if given, else `urgencyOf(kind, level)`: `cap` → urgent; `approval`, `release` → high; a
question/decision about a **blocked** item (`context.itemId`/`assignmentId`) → urgent for an epic, high
for a story, normal for a task; otherwise normal (items raised before this get it on read).
`raise({ recommendation })`: an option id or label marks that option `recommended: true` (only that
one); any other text is kept as `context.recommendation` and appended to the body as "Recommendation:
…". The COO path carries it too (`routeEscalation({ recommendation })` marks the `coo_items` option and
the owner item it falls back or is forwarded to). Agents' raising tools **require** it: `ask_owner`
and `escalate` take `recommendation` and refuse without one; `item_update` to blocked and
`flag_stall` with `waitingOn: owner` refuse without one (it becomes the "Blocked on you" item's
recommendation). `reply(wp, id, { by,
text?, optionId? })`: an `optionId` answers the item (the text is the note) and appends the text
as a message; text alone appends a message and leaves the item open. A message by `owner` is
delivered to the asker (`inbox.onReply` listener wired at boot): the raiser's session gets
`The owner replied on "<title>" (<id>): "<text>" — answer in the thread with inbox_reply, briefly.`
(from `workplace`, autonomous; at a cap it is logged as activity instead), the COO bridge for COO
items (`coo/inbox.jsonl` kind `inbox-reply`), and the Chief of Staff when the raiser is
`workplace`. An employee's reply (`inbox_reply` tool) appends by that employee.

### 19.6 Event-driven stall detector (`watch.ts`)

```
evaluate(wp, item, nowMs) → { rule: 'not-started'|'idle'|'unreviewed', since, dueAt } | { dueAt } | null
  not-started: status ready, level story|task, assignee an agent, no open session on it: since = statusSince; due +15 min
  idle:        status in-progress: since = last activity (item.updatedAt, its newest activity row, its open session's
               last event); due +10 min; a running turn (status 'running') is never idle
  unreviewed:  status in-review: since = max(statusSince, last activity); due +30 min
arm(itemId, dueAt)  setTimeout per item, replaced on every re-arm; disarmed when the item leaves those states
triggers that re-arm: work.updated, activity.recorded, item.comment, runs.onRunEvent of a session whose assignmentId is the item
on fire: evaluate again (the timer is only a hint) → act once per episode (settings key stall:<id> = since)
```

Actions (who is told: Asha first, 19.6e; "`coo.notifyStall`" below now means `manager.alert`): **not-started** → in focus and the assignee is an agent with no open session and within
budget → `employees.assign` + activity "Started by Asha: Ready for 15 min"; assignee busy → stays
Ready, `queuedFor` the assignee, for the dispatcher (19.6d); else → status backlog with the reason
("not in focus", "paused by the cap"), unheld. **idle** → `coo.notifyStall`
(a `coo_items` row kind `stall` + an `inbox.jsonl` line; **no owner fallback**), activity "No
activity for 10 min", the open session (if any) gets "No activity on <title> for 10 minutes: if you
are stuck call flag_stall with why; otherwise carry on." (from `workplace`); with no open session and
the COO offline, Asha's fallback resumes it (`employees.assign`, once per item per hour, only when
`cos.whyWaiting` is null). **unreviewed** → `coo.notifyStall` naming the reviewer. `flag_stall`
(tool) → activity + `coo.notifyStall` at once, and Blocked when it names `waitingOn`.

Thresholds: `WORKPLACE_STALL_READY_MIN` (15), `WORKPLACE_STALL_IDLE_MIN` (10),
`WORKPLACE_STALL_REVIEW_MIN` (30). Boot arms every open item. `cos.tick`'s stall loop is no longer
scheduled (`tick(wp, now, { stalls: false })` from `index.ts`; the function and its tests stay);
`stall.stalledSince` ignores Backlog items, so nothing old can restart a parked item either.
`Item.stall` is `evaluate`'s rule when past due (derived, never stored). On the Plan, a stalled
`PlanFlag` (QA, 2 Oct) carries `waitingOn` = who acts: the Chief of Staff (Asha, who hears of every stall first since
19.6e; `coo` only when there is none), or the
assignee once it flagged its own stall in this episode without naming anyone (a `stall` activity by
the assignee at or after the stall's `since`); and its `reason` is human time (`humanDuration`: "45
min", "3 hours", "4 days"): "Ready 1 hour, not started", "In progress 3 hours, no activity", "In
review 4 days, untouched". `status_of` uses the same wording.

### 19.6a Waking the reviewer (`review-wake.ts`, QA 2 Oct)

An item entering In review used to wake nobody; the reviewer heard of it only through the 30-minute
`unreviewed` stall to the COO. Now `startReviewWake` (boot, beside `startWatch`) listens to
`work.updated`: an item in `in-review` whose `reviewerId` is an agent (not the owner, not the assignee)
gets one record `review-wake:<itemId>` = `{ reviewerId, episode: <reviewerId>:<statusSince>, state:
queued|sent|started, queuedAt, agentId? }` and `drain(reviewer)` runs at once:
- the reviewer's open session **between turns** gets the review request as a message (from `workplace`);
- **no open session**, within budget and the concurrency cap → a short review session
  (`employees.talk(…, { autonomous: true })`) with the request as its prompt;
- **busy** (a turn running, an approval pending, capped, or the spawn refused) → stays `queued`.
The prompt names the item, its assignee, `status_of <id>`, the branch `emp/<assignee>/<id>`, and asks
for `item_update` done or in-progress with a note. The queue drains **one review at a time** when a
reviewer's turn ends (run event: `waiting`, no approval) or a session closes
(`employees.onSessionClosed`; never on `shutdown`), and at boot; order: P0 (item or epic title) or a
focus epic first, then oldest. **Dedupe:** the episode key means any number of events about the same
time in review wake the reviewer once, and a review session ending never starts a second one; leaving
In review drops the record, re-entering (or a new reviewer) is a new episode. The 30-minute
`unreviewed` stall stays as the fallback.

### 19.6b Blocks and dependencies (`blocks.ts`, owner 2 Oct)

Live: Nikhil's QA story for the P0 sat Blocked on Dev's story ~40 min, nobody told; Dev's story
reaching In review woke nobody. `startBlockWatch` (boot) listens to `work.updated`:
- **(a) Into Blocked, `waitingOn` ≠ owner** (the owner already gets the Inbox question): the COO gets a
  bridge item at once (`coo.notifyStall`, title `Blocked: <title>`, unless `flag_stall` filed one for
  this block in the same moment); the one waited on, if an agent, is told (`tell`: a message into its
  open session, else a short autonomous session within budget/cap) to unblock or say why via
  `item_comment`; while the COO is offline Asha is told too. An activity note names who heard. Once per
  block episode: `block-notify:<id>` = `{ since: blockedSince, renotified }`.
- **(b) Still the same block `WORKPLACE_STALL_BLOCKED_MIN` (15) later**: `Still blocked: <title>` to the
  COO (Asha too while offline), once (`renotified`); a timer per block, re-armed at boot; `check(wp,
  id, now)` is the deterministic core. Blocks that exist when the watch starts are recorded without
  (a) (no deploy-time flood) and still get (b).
- **(c) An item reaching In review or Done (resolution done)**: every Blocked item whose reason names
  its id, or its title (` — <Charter>` suffix ignored, ≥ 12 chars), or that waits on its assignee
  within the same epic, has its assignee told: "<X> is now In review … if this is what you were waiting
  for, unblock it (item_update … in-progress)". Never auto-unblocked. Once per arrival
  (`dep-wake:<id>` = `<status>:<statusSince>`).
- **(d)** the reviewer wake is 19.6a.

### 19.6c Waits on a teammate are handoffs, not blocks (`waits.ts`, `items.ts`, `handoff.ts`, owner 2 Oct)

Owner: "any story which has an agent working on it should not be marked blocked; they can be rather
assigned to the person working on it", and "any blocked or stalled issue is always addressed unless
it's blocked on me". A Blocked item waiting on a teammate parks two agents: the one who blocked it
stops, and the one waited on gets a message at best. So a move into Blocked is **classified** before
it is applied, wherever it comes from (`POST /api/items/:id`, `item_update`, `flag_stall`; all go
through `items.update`):

| `waitingOn` | reason / `kind` | becomes |
|---|---|---|
| an agent employee (not virtual, not the assignee) | `kind: 'review'`, or the reason says review / sign-off / approve | **In review**, `reviewerId` = that employee |
| an agent employee (not virtual, not the assignee) | anything else (`kind: 'work'` forces this) | **handoff** (below) |
| `owner` | — | **Blocked** + the owner's Inbox question (19.3, unchanged) |
| `coo`, `external`, or the assignee itself | — | **Blocked** + the COO (19.6b, unchanged: at once, again after 15 min) |

`classify(wp, { assigneeId, waitingOn, reason, kind })` in `waits.ts` is pure. The review keyword
heuristic is deliberately narrow (word-bounded `review*`, `sign-off`/`sign off`/`signoff`,
`approve*`/`approval`); `kind` wins over it either way. `external` is a new reserved `waitingOn` value
(someone outside the team; the reason says who), shown as "someone outside the team".

**Review wait.** The move is rewritten to `status: in-review, reviewerId: X` (allowed from ready,
in-progress, in-review and blocked: the conversion is the server's rule, so the transition table is
not consulted; the 19.3 in-review checks still hold). The reason is the activity note. 19.6a then wakes
X (a new reviewer is a new review episode, so an item already In review with someone else wakes X too).

**Work wait = handoff.** The move is rewritten to: assignee = X (charter follows, as for any
reassign), status In progress (unchanged if already), and `handoff = { fromId: <previous assignee>,
reason, at, prev? }` on the item (`prev` keeps an earlier handoff, so X → Z → X → Y unwinds; X
"blocking" on the person who handed it to them is a handback). Activity (`note`):
"Handed to X: <reason>; returns to Y". `startHandoffWatch` (boot) sees the new handoff on
`work.updated` and wakes X once per handoff (`handoff-wake:<id>` = `handoff.at`): X's open session gets
a message; with none, a session is started **on that item** (`employees.spawn` with the assignment,
within budget and the concurrency cap); if neither is possible the activity says so and the stall
watcher (19.6, idle) is the fallback. The prompt says what Y needs and to call `item_handback` with a
note when done. At boot the watch wakes any handoff it has no record for (a restart, the migration).

**Handback.** Agent tool `item_handback { itemId?, note }` / `POST /api/items/:id/handback { note }`
(→ `ItemDetail`): by the current assignee, the owner, the COO or the Chief of Staff; needs a handoff
on the item. Assignee = `handoff.fromId`, `handoff` = `handoff.prev` (or removed), status In progress
(unless Done), `handedBack = { toId, byId, note, at }` (internal, not projected). Activity: "Handed back
to Y by X: <note>". The watch wakes Y once per handback (`handback-wake:<id>` = `handedBack.at`) the
same way (message, or a session on the item). A handback to the owner wakes nobody (it is his item).

**Not news to the COO.** `flag_stall` with an agent `waitingOn` no longer files the "Flagged" bridge
item (the wait is now someone's work, not a stall); with `owner`, `coo` or `external` it does as before.

**Contract (additive; `workplace-v2.ts`).** `Item.handoff?: { fromId, reason, at }` (the assignee is
who has it now): the apps show "with <assignee> (handed by <fromId>)". `PlanFlag.handoff?: { withId,
fromId }` when a flagged (stalled) item is handed. `EpicCard.handoffs?: PlanHandoff[]` with
`PlanHandoff = { itemId, title, withId, fromId, reason, at }`, present when the epic has handed items,
so the Plan shows them without a new flag kind (decoders with closed enums are not broken).
`UpdateItemRequest.kind?: 'review' | 'work'`; `waitingOn` may be `external`. `status_of` lines read
"Story 'X' — In progress · Dev (handed by Nikhil)".

**Migration (`handoff.migrateBlockedWaits`, every boot, after the watches start).** Every Blocked item
whose `waitingOn` is an agent other than its assignee is re-applied through the same classification
(`by: workplace`): review waits → In review, the rest → handoffs; their wakes follow from the watches.
Idempotent: a converted item is no longer Blocked, and owner/COO/external blocks are left alone.

### 19.6d The dispatcher (`dispatch.ts`, outage 2 Oct)

**What happened.** Nothing moved for two hours. At 10:07 the watcher (19.6, not-started) moved Dev's
story "Dance tempo…" Ready → Backlog because Dev was busy in another session. Backlog never
auto-starts (D19), so when Dev finished at 10:37 nothing gave him his next story; every employee sat
in "waiting", and nothing alerts on "idle while focus work is queued for them". Two more gaps: four
items In review for days never woke their reviewer (they entered review before 19.6a existed, and
19.6a only reacts to a change), and a finished talk session just sits idle between turns.

**Root cause.** Work was *pushed* only on item events (19.6 deadlines, 19.6a, 19.6c). Nothing *pulled*
work when a person became free, and "parked because the assignee is busy" was written as the same
Backlog as "parked by the COO/owner", so the one could not be restarted without the other.

**`hold` (new field, additive).** `WorkItem.hold?: true`, projected as `Item.hold?: true`. It marks
Backlog that a person parked on purpose; the dispatcher never starts a held item.
- **Set** by `POST /api/items/:id` with `hold: true` (`UpdateItemRequest.hold`), only when the actor is
  the owner or the COO (anyone else: 400). `hold: true` with no `status` moves a Ready/In-progress item
  to Backlog (the 19.3 table applies); with a status other than backlog it is a 400. **Inferred** on a
  move into Backlog when `by` is the owner or the COO, or the note says hold/held/parked
  (`/\b(on hold|hold|held|park|parked|parking)\b/i`, any author); `hold: false` in the same request
  wins over the inference. Creating an item straight into Backlog follows the same rule.
- **Cleared** whenever the item leaves Backlog, or by `hold: false` (owner/COO).
- **Migration** (`dispatch.migrateHolds`, at boot, once: settings `hold-migration`): every Backlog item
  with no `hold` whose newest move into Backlog (history entry to `proposed`, or `status` activity to
  `backlog`) was by the owner/COO or whose note matches the pattern gets `hold: true`. On the live data
  this holds the COO's 2 Oct "parked: P0 focus" items and Nikhil's QA story, and leaves watcher parkings
  unheld.

**`queuedFor` (new field, additive).** The watcher's busy-parking changes (19.6, not-started): when the
assignee is busy, the item **stays Ready** with `queuedFor = <assignee>`, activity "Queued for Dev: busy
on X; starts when Dev is free", and the COO item is titled `Queued: <title>` (was `Parked:`, Backlog).
`watch.evaluate` returns null for a Ready item queued for its own assignee (the dispatcher owns it; no
"not started" flag on the Plan). `queuedFor` is dropped on any status change or reassign; projected as
`Item.queuedFor` while Ready. The "not in focus" and spend-cap branches still move to Backlog, unheld.

**`dispatch(wp, employeeId, nowMs)` → `{ action: 'review'|'story'|'none'|'skipped', itemId?, reason? }`.**
For an agent (not virtual), in order:
1. **Busy?** (`busyReason`) — a turn running, a tool approval pending, an assignment queued for the
   end of the turn (`employees.hasPendingSwitch`), an owner-talk session active in the last
   `WORKPLACE_DISPATCH_TALK_GRACE_MIN` (5) minutes, or one of their own stories/tasks In progress
   ("has 'X' In progress"). Busy → `skipped` with that reason; nothing is pushed into a turn.
2. **Reviews first.** `reviewWake.queued(employee)` non-empty → `reviewWake.drain` (19.6a: a message
   into the open session between turns, else a short review session). Started → `review`; else
   `skipped` "the review could not start (cap or budget)". A story never jumps a queued review.
3. **Next story** (`queue(wp, employee)`): their stories and tasks in `ready` or `backlog`, not merged,
   not `hold`, **in a focus epic** (Backlog outside focus is never auto-started), ordered by the epic's
   index in the focus list, then `rank`, then `createdAt`.
4. **Caps.** `spend.canSpend` (real-money pause) → else `skipped` "paused by the <scope> spend cap";
   with no open session, `sessionsOf(employee) < budget.concurrentSessions` → else `skipped`
   "concurrency cap (N)". An open session between turns needs no new slot.
5. **Start** with `employees.assign` (an open session between turns is switched to the item's branch
   via `moveSession`/`ensureWorktree`, then sent the assignment; else a fresh session on that branch;
   `markStarted` moves it In progress). Activity (`note`, by `workplace`): "Started: Dev was free; next
   in focus". A failure is `skipped` "could not start: <error>" (a `WorktreeSwitchError` blocks it, as
   at spawn).

**Triggers (`startDispatch`, at boot after the watches).** Deferred with `setImmediate` and coalesced
per employee, so 19.6a/19.6c listeners (registered earlier) act first:
- a run event with status `waiting` and no approval (a turn ended) → that employee;
- `employees.onSessionClosed` (not `shutdown`) → that employee;
- `work.updated` where the item **was** In progress (last seen status, tracked in memory, seeded from
  the store at start) and is no longer, or changed assignee → the previous assignee;
- a **sweep** every `WORKPLACE_DISPATCH_SWEEP_MIN` (2): stale reviews, then `dispatch` for every agent,
  then idle alerts. The first sweep runs `WORKPLACE_DISPATCH_BOOT_DELAY_SEC` (60) after start, so the
  boot's staggered resumes (`resumeAfterShutdown`) land first and are never raced; the event triggers are live at once.

**Stale reviews (`wakeStaleReviews`, boot and each sweep).** Every item In review whose reviewer is an
agent other than the assignee and which has **no open review**:
- no `review-wake:<id>` record → `reviewWake.onItem` (queued for that episode, drained if free);
- a record `sent`/`started` whose session is no longer live (it ended with no verdict) → requeued
  (`reviewWake.requeue`) **once per episode** (settings `stale-review:<id>` = the episode);
- a `queued` record, or a live session holding it → nothing. Activity: "Review requested again from X:
  it was In review with no open review". Dedupe means a sweep every 2 minutes never wakes twice.

**Idle alert.** After each sweep, per agent: `queued` = queued reviews + `queue()` stories. *Idle* =
no turn running, no approval pending. Queued > 0 and idle → an episode `dispatch-idle:<id>` = `{ since,
alerted }` (since = first sweep that saw it). Past `WORKPLACE_DISPATCH_IDLE_MIN` (10) and not yet
alerted → `manager.alert` (19.6e: Asha first; a spend/concurrency-cap reason is a `spend` decision and goes
to the COO; `itemId` = the first queued item): title "Dev idle with 2
queued items", body "Dev idle with 2 queued items: <reason>" where the reason is the last `skipped`
reason (e.g. "paused by the employee:dev spend cap", "concurrency cap (0)", "has 'X' In progress");
once per episode. Busy or nothing queued ends the episode (the record is dropped); the next one alerts
again.

**Config.** `WORKPLACE_DISPATCH_SWEEP_MIN` (2), `WORKPLACE_DISPATCH_IDLE_MIN` (10),
`WORKPLACE_DISPATCH_TALK_GRACE_MIN` (5), `WORKPLACE_DISPATCH_BOOT_DELAY_SEC` (60).

**Tests (`v2-dispatch.test.ts`).** Busy-parked (Ready, queued) and legacy watcher-Backlog items start
when the assignee frees up; held Backlog (COO/owner move, hold note, `hold: true`) and Backlog outside
focus are never started, and only the owner/COO may set `hold`; a queued review goes before a story;
stale In review items are woken once (and requeued once after a dead review session); the idle alert
fires once per episode; spend and concurrency caps are respected; the boot hold migration; wired at
boot (a booted server wakes the seeded stale reviews on its first sweep).

### 19.6e Asha first: operational alerts go to the manager (`manager.ts`, owner 2 Oct)

**Owner decision.** Asha (Chief of Staff, `chiefOfStaffId`) manages every agent and owns stall
handling. Operational alerts used to be COO bridge items (`coo.notifyStall`); now they go to **Asha
first**, and the COO hears only when Asha does not act, when the call is above her authority, or when
Asha herself is stuck.

**`alert(wp, spec, nowMs)`** with `spec = { key, itemId, title, body, text?, by?, subjectId?, decision?,
notice? }` → `'asha' | 'queued' | 'coo' | 'duplicate'`. One record per `key` (settings
`mgr-alert:<key>` = the spec + `{ at, state: queued|delivered|coo, deliveredAt?, statusAt, assigneeAt,
escalated?, resolved? }`); keys carry the episode (e.g. `idle:<itemId>:<since>`), so an alert is sent
once per episode. Routing:
- **Straight to the COO** (a bridge item, `coo.notifyStall`, the body says why) when
  (b) `decision` is set: `spend | hiring | scope | release` (a spend or concurrency cap, a parking
  because of the spend cap); or (c) the alert is about Asha (`subjectId` is Asha) or Asha is stuck
  (`ashaStuck`: no Chief of Staff agent; paused by a spend cap; no open session and at her concurrency
  cap; a tool approval pending more than `WORKPLACE_MANAGER_ESCALATE_MIN`). A `notice` that would go to
  the COO this way is dropped (it asks nothing of anyone), unless it carries a `decision`.
- **Otherwise to Asha**: queued, then `deliver`: her open session **between turns** gets one message
  with every queued alert (oldest first); no open session (within budget and cap) → a short autonomous
  session with it; mid-turn, an approval pending, or an assignment queued for her turn's end → it waits
  and is delivered when her turn ends (run event `waiting`), her session closes (not `shutdown`), or the
  next tick. Each delivered alert gets an activity note "Told Asha: <title>". The message tells her she
  owns stall handling: restart, reassign, unblock, chase, or escalate with a recommendation, and say what
  she did with `item_comment` on the item.

**Escalation (a).** Each tick, an alert (not a notice) older than `WORKPLACE_MANAGER_ESCALATE_MIN` (15)
that Asha has not acted on → one COO bridge item: `<title>`, body `<body> Asha has not acted on it in 15
min.`; activity "Escalated to the COO: Asha had not acted in 15 min". **Acted** = since the alert: the
item's status (or `statusSince`) or assignee changed; or Asha did anything on it (a non-`stall` activity
row by her); or real work landed on it (a `commit`, `test`, `status`, `assigned`, `reopen` or `merged` row by
anyone; a points or field tweak is not acting on a stall); or anyone but `workplace` commented on it; or the
alert was `resolve`d by its source (the dispatcher ends an idle episode). Undelivered alerts (Asha never
free) count as not acted. Once per alert.

**Manager digest.** Each tick, at most every `WORKPLACE_MANAGER_DIGEST_MIN` (20) and only while work is
active (any item In progress / In review / Blocked, or any focus work queued), Asha gets one compact
digest through the same queue (a `notice`, key `digest:<at>`): idle employees with queued focus work
(and why), stale reviews (In review past `WORKPLACE_STALL_REVIEW_MIN`, with the reviewer), and Blocked
items (who they wait on, the reason's first sentence). Nothing to report → no digest. Asha stuck → no
digest (her alerts are already going to the COO).

**What now goes through `alert`:**
| Source | Key | Routing |
|---|---|---|
| watch idle (19.6) | `idle:<id>:<since>` | Asha (`subjectId` the assignee); the agent nudge and the COO-offline auto-resume are unchanged |
| watch unreviewed | `unreviewed:<id>:<since>` | Asha (`subjectId` the reviewer) |
| watch not-started: started / queued / parked "not in focus" | `started:` / `queued:` / `parked:<id>:<since>` | Asha, `notice` |
| watch not-started: parked "spend cap" | `parked:<id>:<since>` | the COO (`decision: spend`) |
| watch not-started: could not start | `parked:<id>:<since>` | Asha |
| `flag_stall` (not a teammate wait) | `flag:<id>:<at>` | Asha (`subjectId` the flagger); waiting on `coo` → the COO directly |
| blocks (a) waiting on `external` or self | `blocked:<id>:<since>` | Asha; waiting on `coo` → the COO directly (it is the COO who is waited on) |
| blocks (b) still blocked 15 min | `still-blocked:<id>:<since>` | Asha (`coo` waits: the COO again) |
| dispatcher idle with queued work (19.6d) | `idle-emp:<emp>:<since>` | Asha; a spend/concurrency-cap reason → the COO (`decision: spend`) |

**COO-offline fallback, kept consistent.** Asha is now always told first, so the old "Asha too while the
COO is offline" in 19.6b is gone (she already heard). The watcher's idle fallback (no open session, the
COO offline → Asha's automatic resume, once an hour, when `cos.whyWaiting` is null) is unchanged: it is
Asha acting in the moment, and the escalation still files the COO item for when the COO is back.
Bridge items to an offline COO are still filed (read on return); there is still no owner fallback.

**Notes and the Plan.** "Told Asha: …" and "Escalated to the COO: …" are activity of kind `stall` (system
notes about a stall: they never reset the idle clock nor count as someone acting). A stalled `PlanFlag`'s
`waitingOn` is now Asha (19.6), the assignee once it flagged its own stall.

**Wiring.** `startManager` (boot, after the dispatcher): Asha's run events and session closes →
`deliver`; a tick every minute → `deliver`, `escalate`, `digest`, prune records older than 2 days.

**Config.** `WORKPLACE_MANAGER_ESCALATE_MIN` (15), `WORKPLACE_MANAGER_DIGEST_MIN` (20).

**Tests (`v2-manager.test.ts`; `v2-watch`, `v2-blocked-notify`, `v2-handoffs`, `v2-dispatch` updated).**
Alerts reach Asha (message between turns, a session when she has none, queued while mid-turn and
delivered at her turn's end); escalation to the COO after 15 minutes unacted, once, and not when she
acted; decisions, alerts about Asha, and a capped Asha go to the COO at once; the digest every 20 minutes
only while work is active.

### 19.7 Asha's rhythm (`rhythm.ts`)

A one-minute timer calls `maybeRun(wp, now)`; each run is idempotent per IST day (settings
`rhythm:<kind>:<day>`). Builders are pure and tested.

- **09:30 brief** → `Update{kind:'brief', by:'asha', push:true}`: line `Brief: <n> done yesterday ·
  focus <epic titles> · <n> blocked · <n> decisions wait on you`; details list them by name.
- **10:00 stand-up** → one General-room message per lead with open or recently done items
  (`by:'workplace', kind:'standup', about:<lead>`): `Done: …` / `Next: …` / `Blocked: …` (≤ 3 lines, names).
- **Sunday 18:00 review** → `Update{kind:'review', push:true}`: points shipped in 7 days, items
  reopened after a false done (done→in-progress and review→building sends-back), stall episodes,
  real spend (₹, 7 days), pending hire proposals.

### 19.8 API (all JSON; errors `{error}` 400/401/404/409; owner-facing, ordinary auth)

| Method & path | Body → response |
|---|---|
| GET `/api/plan[?view=board]` | → `PlanResponse` |
| GET `/api/focus` / POST `/api/focus` | `{ epicIds }` → `Focus` |
| GET `/api/items?level=&status=&assigneeId=&areaId=&parentId=` | → `Item[]` (rank order) |
| POST `/api/items` | `CreateItemRequest` → 201 `ItemDetail` |
| GET `/api/items/:id` | → `ItemDetail` |
| POST `/api/items/:id` | `UpdateItemRequest` → `ItemDetail` (any subset; status rules 19.3) |
| POST `/api/items/:id/comments` | `{ text }` → 201 `Comment` |
| POST `/api/items/:id/merge` | `{ intoId }` → `ItemDetail` (the survivor) |
| POST `/api/items/:id/handback` | `{ note }` → `ItemDetail` (19.6c: back to who handed it) |
| GET `/api/updates?limit=&before=` | → `Update[]` newest first (limit ≤ 200, default 50; `before` = an update id) |
| GET `/api/inbox?state=&limit=&before=` | → `InboxItem[]`; no params = every owner-facing item as before; `state` open/answered/expired; `before` an item id (the page starts after it); `limit` ≤ 200 (iOS QA 2 Oct) |
| GET `/api/inbox/:id` | → `InboxThread` |
| POST `/api/inbox/:id/reply` | `{ text?, optionId? }` → `InboxThread` |
| GET `/api/status?q=` | → `StatusAnswer` (resolution order below) |
| GET `/api/areas` / POST `/api/areas` / POST `/api/areas/:id` | `{ title, description?, ownerId? }` / `{ title?, description?, state?, rank? }` → `Area[]` / 201 `Area` / `Area` |
| GET `/api/rooms` / GET `/api/rooms/:id` | → `Room[]` / `RoomDetail` |
| GET `/api/releases/posts` / POST `/api/releases/posts` / GET `/api/releases/posts/:id` | `{ version, shippable?, itemIds?, title? }` → `ReleasePost[]` / 201 `ReleasePost` / `ReleasePost` |

**Status resolution (`status.answer`, QA 2 Oct).** In order: (1) item ids — the whole query or every
id written inside it (`/[a-z]{2,4}_[a-z0-9]{6,}/`: `as_…`, `ft_…`, any v2 id), a merged id answering
with its survivor; (2) an exact title (stop words ignored), with or without the ` — <Charter>` suffix
`work.decompose` gives per-charter pieces (`baseTitle`), so "Daily greeting" lists every charter's
piece and the full title finds that one — ahead of (3) a person and (4) an area named in the query
(an area called "Memory" no longer swallows "Greeting context contract — Memory"); (5) the word-score
title match. The `status_of` tool prints each match with its id (`… [as_…]`) so the agent can act on it.

Owner actions are attributed `by: 'owner'`. Old routes unchanged (adapters).

**Actor (QA, 2 Oct).** The COO drives this same API from the Mac; its writes must read as the COO's.
`actorOf(req)` (`routes.ts`): an `x-workplace-actor: coo` header on a **local** request (loopback and no
`x-via-tunnel` — the same test as `requireLocal`) attributes the write to `coo`; `owner` (or no header)
is the owner; any other value from loopback is 400. A relayed request is always `owner`: the header is
ignored behind `x-via-tunnel`, and the tunnel strips it before forwarding (`MAC_ONLY` headers in
`tunnel.ts`, defence in depth). Used by focus (`setBy`), item create/update/merge/comments, areas
(create/update now record a `note` activity by the actor), Room posts/threads/resolve, release posts,
`POST /api/work` and the feature spec transition. The old routes that take a `by`/`proposedBy` in the
body (`/api/work/:id/transition`, `/api/releases`, `/api/proposals`) honour it only on a local request;
through the tunnel it is ignored and the actor (`owner`) is used. The COO adds the header to every
API call it makes: `curl -H 'x-workplace-actor: coo' http://127.0.0.1:4317/api/…`.

**JSON shapes for the app teams** (exact; optional fields absent, never null unless stated):

```ts
type ItemLevel = 'epic' | 'story' | 'task';
type ItemStatus = 'backlog' | 'ready' | 'in-progress' | 'in-review' | 'done' | 'blocked';
type Points = 1 | 2 | 3 | 5 | 8;
interface Item {
  id: string; level: ItemLevel; title: string; body: string;
  status: ItemStatus; statusSince: string; resolution?: 'done' | 'wont-do' | 'duplicate';
  parentId?: string; epicId?: string; areaId?: string;          // areaId resolved through the epic
  assigneeId?: string;   // employee id or 'owner'
  reviewerId?: string; ownerId?: string; points?: Points; rank: number; targetDate?: string;
  acceptance: string[];
  blocked?: { reason: string; waitingOn: string; since: string };
  stall?: { rule: 'not-started' | 'idle' | 'unreviewed'; since: string; minutes: number };
  mergedInto?: string; releasedIn?: string;
  legacy: { kind: 'feature' | 'assignment' | 'bug' | 'question'; state: string; charterId?: string; featureId?: string };
  createdAt: string; updatedAt: string;
}
interface Area { id: string; title: string; description?: string; state: 'active' | 'archived'; rank: number;
  ownerId: string; roomId: string; threadId: string; createdAt: string; updatedAt: string }
interface EpicProgress { pointsDone: number; pointsTotal: number; storiesDone: number; storiesTotal: number; pct: number }
interface PlanFlag { kind: 'blocked' | 'stalled'; itemId: string; title: string; reason: string; waitingOn?: string; since: string }
interface EpicCard { epic: Item; progress: EpicProgress; next?: { id: string; title: string }; flags: PlanFlag[]; inFocus: boolean }
interface Focus { epicIds: string[]; setBy: string; at: string }
interface PlanResponse { areas: { area: Area; epics: EpicCard[] }[]; unfiled: EpicCard[]; mine: Item[]; focus: Focus;
  counts: Record<ItemStatus, number>; board?: Record<ItemStatus, Item[]> }
interface Comment { id: string; itemId: string; at: string; by: string; text: string; details?: string; mentions: string[] }
interface Activity { id: string; at: string; itemId: string | null; by: string; kind: ActivityKind; from?: string; to?: string; text: string; link?: string }
type ActivityKind = 'created' | 'status' | 'assigned' | 'reviewer' | 'points' | 'field' | 'comment' | 'commit' | 'test' | 'note' | 'stall' | 'merged' | 'reopen' | 'started';
interface ItemDetail { item: Item; parent?: Item; epic?: Item; area?: Area; children: Item[]; comments: Comment[]; activity: Activity[]; progress?: EpicProgress; threadId?: string }
type UpdateKind = 'started' | 'shipped' | 'blocked' | 'unblocked' | 'decided' | 'brief' | 'review';
interface Update { id: string; at: string; kind: UpdateKind; line: string; details?: string; by: string; itemId?: string; inboxId?: string; href: string; push: boolean }
interface InboxMessage { id: string; inboxId: string; at: string; by: string; text: string; details?: string }
interface InboxThread { item: InboxItem; messages: InboxMessage[] }   // InboxItem + messageCount, lastMessageAt?, urgency?; options[].recommended?
interface Room { id: string; kind: 'general' | 'area' | 'releases'; title: string; areaId?: string; headline: string; lastAt: string; threadIds: string[] }
interface RoomDetail { room: Room; threads: RoomThread[] }               // RoomThread + roomId?, epicId?
// RoomMessage gains kind?: 'message' | 'update' | 'standup' | 'release', about?: string, details?: string
interface ReleasePost { id: string; at: string; title: string; version: string; shippable?: string; releaseId?: string; by: string;
  groups: { areaId: string | null; areaTitle: string; items: { id: string; title: string; level: ItemLevel; kind: 'story' | 'fix' }[] }[];
  text: string; threadId: string }
interface StatusAnswer { q: string; line: string; matches: { item: Item; line: string; href: string }[] }
// LogEntry gains from?: 'owner' | 'workplace' on 'user' entries.
```

`href`s are app routes: `item/<id>`, `inbox/<id>`, `room/<threadId>`, `releases/<postId>`, `plan`.
`POST /api/items/:id` with `start: true` and a move to in-progress also starts the assignee's session
(the route calls `employees.assign`; any `employees.assign` on a Ready/Backlog item marks it in progress).
Socket events (added to `WorkplaceServerEvent`): `item.updated { item: Item }`, `item.comment {
comment }`, `activity.recorded { activity }`, `update.posted { update }`, `area.updated { area }`,
`inbox.message { message }`, `release.post { post }`. Push intents: `update.posted` with
`push: true` → category `WP_UPDATE`, thread `updates`, `collapseId: update:<itemId|kind>`, `data
{ link: href, itemId?, inboxId? }`; level `blocked` for a block (sent even in quiet hours), else
`update` (held in quiet hours, like needs-you). `coo.item` (now also kind `stall`) stays loopback-only.

**Ids in owner-facing text (iOS QA, 2 Oct).** `humanizeIds` (`id-names.ts`) replaces each id it can
resolve — item `as_/ft_`, thread `th_…` (incl. `th_epic_<id>`, `th_area_<id>`), Inbox `in_…`, area `ar_…`
— with its title in quotes, at **read time** in the owner's views only: Inbox `title`/`summary`/`details`
(`inbox.ownerView`: `ownerList`, `GET /api/inbox[/:id]`, reply responses, socket `inbox.updated`), an
employee card's `lastReport`, and Room thread headlines (`listThreads`, `GET /api/room/:id`,
`/api/rooms/:id`). Stored text keeps its ids (agents and the COO act on them); unknown ids are left as
written.

### 19.9 Chat hygiene

- `runs.append` stores `from` on `user` entries; `runs.sendMessage(id, text, attachments, { from })`
  and `createRunDirect({ promptFrom })`. `employees.talk(…, { autonomous })`, `assign`, `endSession`,
  `deliverDenial`, the lift-pause resume and every watcher/relay prompt pass `workplace`; only the
  owner's own Talk passes `owner`. `toChatView` folds `from: 'workplace'` user entries and `system`
  entries into the collapsed `activity` line with the tool runs (still expandable, nothing lost).
- `short(text)` (`one-line.ts`): ≤ 4 lines and ≤ 400 chars stay as they are; longer → `text` = the
  first lines up to that limit, cut at a word, plus "…", `details` = the whole text. Applied to agent
  Room posts, agent comments and agent Inbox replies. The owner's words are never shortened.
- `work.create`'s default author is `workplace` (it was `owner`); only owner routes pass `owner`.

### 19.10 Relay (work.irisforu.com) — follow-up list, nothing changed or deployed here

The relay (`services/workplace-relay/app.py` in `~/claude-dev-deploy`) is a **catch-all proxy**:
`@app.api_route("/{path:path}")` forwards every authenticated request (session cookie + CSRF, or
app bearer) and refuses only `api/pair*`; it adds `x-via-tunnel: 1`. So every v2 route reaches the
Mac with no relay change:

`GET /api/plan`, `GET|POST /api/focus`, `GET|POST /api/items`, `GET|POST /api/items/:id`,
`POST /api/items/:id/comments`, `POST /api/items/:id/merge`, `GET /api/updates`,
`GET /api/inbox/:id`, `POST /api/inbox/:id/reply`, `GET /api/status`, `GET|POST /api/areas`,
`POST /api/areas/:id`, `GET /api/rooms`, `GET /api/rooms/:id`, `GET|POST /api/releases/posts`,
`GET /api/releases/posts/:id`; socket events ride the existing `/ws` stream.

The COO's lead-only routes (`POST /api/coo/reply`, `GET /api/coo/items`, `POST /api/coo/answer`,
`POST /api/coo/forward`, `POST /api/coo/thread-reply`, `POST /api/coo/live-window`) stay blocked **on the Mac** (`requireLocal`
refuses any request with `x-via-tunnel`), and `coo.item` stays loopback-only on the socket — pinned
again by `v2-api.test.ts`. Follow-ups for the relay owner (not required for v2 to work):
1. Optional hardening: turn the catch-all into an allowlist of the owner-facing prefixes above plus
   today's, and refuse `/api/coo/(reply|items|answer|forward|live-window)` at the relay too
   (defence in depth; today only the Mac refuses them).
2. Add `WP_UPDATE` to the APNs/FCM category list the relay's push forwarder accepts (it forwards
   `category` verbatim today; confirm the apps register it).
3. No body-size or timeout change: every v2 call is small and synchronous.

### 19.11 Migration (`migrate-v2.ts`, at boot, once; key `v2-migration` in settings)

1. Columns and tables (19.1) — `store.ts`, every open.
2. For every `work` row without `level`: feature → epic; assignment/bug/question → story with
   `parentId = featureId` (if any); status from 19.3's old→v2 map, **except** a `blocked` item whose
   last history entry is by `coo` with a note matching /park/i → **backlog** (the 13 items Phase 1
   parked); other blocked items get `blockedReason` = the last history note (or "No reason recorded
   before v2"), `waitingOn: coo`; `review` with no reviewer → `reviewerId` = the `qa-release` holder
   (Nikhil), or the Chief of Staff if Nikhil is the assignee; `rank` = creation order (epics within
   their area, stories within their epic); `statusSince` = `updatedAt`.
3. Every item's `history` → activity rows (`kind: status`, original `at`/`by`/note), once.
4. Threads without `roomId` → `general`; the Releases thread is created.
5. Returns and logs `{ items, epics, stories, byStatusBefore, byStatusAfter, parked, reviewersSet }`;
   nothing is deleted. Idempotent: a second boot does nothing.
6. Every boot, idempotent (QA, 2 Oct): `normaliseAuthors` rewrites any author that is a charter id
   (`chief-of-staff`, from `work.decompose`'s old default author) to the employee holding it, in
   `activity`, `comments`, `messages`, `inbox_messages`, `updates` and each item's `history`
   (verified on a scratch copy of the live db: 9 activity rows and 9 histories, then 0 on a second
   run); `room.reopenChannels` reopens standing channels resolved before 19.4's rule. New writes are
   normalised at the source (`authorId` in `work.create/transition/put`, `items.update`,
   `trail.record/comment`, `room.post`), and `decompose` defaults to the Chief of Staff's employee id.

Data clean-up done after deploy through the API (COO, owner rules once): areas (`POST /api/areas`,
first pass Voice & audio, Character & greeting, Memory, Mac & mobile apps), epics into areas
(`POST /api/items/:id {areaId}`), duplicates merged (`POST /api/items/:id/merge`), the 8 never-started
items started / backlogged / closed (wont-do), points estimated.

### 19.12 Agent tools (added to the Workplace MCP server)

`item_create { level: story|task, parentId, title, body?, assigneeId?, points?, acceptance? }`
(stories: the Chief of Staff or the epic owner; tasks: the story's assignee or the Chief of Staff;
an open item with the same normalised title under the same parent is returned instead of a
duplicate), `item_update { itemId, status?, blockedReason?, waitingOn?, reviewerId?, points?, note? }`
(19.3 rules; an agent can never set done on its own work), `item_comment { itemId, text }`,
`flag_stall { itemId?, reason, waitingOn?, recommendation? }`, `inbox_reply { inboxId, text }`,
`status_of { q }`, `item_handback { itemId?, note }` (19.6c; `item_update` and `flag_stall` gain
`kind?: review | work`); `ask_owner` and `escalate` gain a required `recommendation`, and `item_update` gains
`recommendation` (required with `waitingOn: owner`, as is `flag_stall`'s) — 19.5.
The handbook gains: one story per outcome; flag your own stall the moment it happens; short messages.
