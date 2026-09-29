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

### 7b. Sessions across a restart, and interrupts

Every session row records its SDK session id, its status and any pending tool approval as they change.
On boot, rows still open are closed as `lost-on-restart`; a `building` assignment is marked blocked with
the reason; and one Inbox question per lost session names the pending tool and the resumable SDK id, so
a decision is never dropped silently (iOS device test, 27 Sep). An interrupt leaves a session `idle`
with no approval attached; a message wakes it.

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
a cap; the Chief of Staff always. `EmployeeDetail.needsYou` lists open items whose `affects` includes
the employee. A denial (`reject`/`deny`/`no`) is delivered to the raiser: `runs.sendMessage` into its
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
settles an item within the COO's own authority (no owner Inbox item ever created).
`POST /api/coo/forward { itemId, recommendation }` raises it to the owner's Inbox with the
recommendation folded into the body. The §0/D8 owner-only gates (release, deploy, org changes, a
cap) are untouched — those are already separate, dedicated Inbox items from `releases.ts`/
`proposals.ts`/`spend.ts`, never routed through `room.escalate`, so this change never touches them.

**Loopback only, no exception.** Every `/api/coo/*` route calls the same guard `/api/pair` and
`/api/relay/off` use (`isLoopback(remoteAddress) && !headers['x-via-tunnel']`) — "the API needs no
auth beyond loopback" is read literally: the *entire* surface, including the owner's own outgoing
message, not just the lead's reply. The socket hub was leaking this: `wp.on(event => broadcast(event))`
fanned every event, including a new `coo.message`/`coo.item`, out to *every* connected client — a
paired phone with a valid bearer token would have received it over `/ws` even though the REST route
refused it. Fixed in `ws/hub.ts`: a socket's loopback-ness is captured once at the upgrade (same
check), and `coo.*` events are only ever sent to sockets that passed it.

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

### 18e. What changed in the existing contract, for the record

`Employee.virtual?`, `EmployeeState` gains `online`/`offline`, `LogEntry.kind` gains `'activity'`
with a new `LogEntry.activity` field, new types `CooMessage`/`CooItem`/`CooPresence`, new
`WorkplaceServerEvent` cases `coo.message`/`coo.item` (loopback-delivered only, §18b), new REST
`/api/coo/{log,message,reply,items,answer,forward,presence}`, `GET /api/agents/:id/log` gains
`?view=chat`. Nothing existing was removed or renamed. `packages/server/seed/org.yaml`/`roles.yaml`
gain the `coo` employee/role and change Asha's `reportsTo`; `proposals.ts`'s hire-with-no-`reportsTo`
default now explicitly prefers the chief-of-staff charter holder over "whoever is level 0" (the COO
is level 0 too, but virtual, and must never become a new hire's default lead);
`spend.ts`'s cap check skips virtual employees (a ₹0/day budget on an employee that never spends
would otherwise show as permanently "at cap" and pollute every paused-scope list).

