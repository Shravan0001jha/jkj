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

## 10. Stall and loop detection (`services/health.ts`)

Every 30 s over running sessions: `idleMs > 600 000` → stalled; last 5 tool entries identical
(label + text hash) → looping. Action: interrupt, `state: blocked`, Inbox `question`. Signals
computed on request: throughput, rework, false-done rate, cost per completed item (7-day window).
Org signals: queue length per charter > 5, context-limit hits ≥ 3 in 7 days, mutual blocking pairs,
orphans → listed as "proposal triggers" on the Org screen.

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

### WebSocket `/ws` (`ServerEvent` additions)

`office.snapshot { office: OfficeResponse }` (once, on connect), `office.updated { card: EmployeeCard }`, `inbox.updated { item }`, `work.updated { item }`,
`proposal.updated { proposal }`, `release.log { id, line }`, `spend.updated { summary }`,
`alert { level: 'info'|'needs-you'|'blocked'|'cap'; title; body; inboxId? }`. The existing
`agent.updated` / `agent.log` stay. `ClientCommand` additions: `inbox.answer { id, optionId, note? }`.
Alerts are the phone's push-style feed; the phone shows them as notifications while open.

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
| `ping`/`pong` | both | liveness; the relay marks the Mac offline after 20 s |

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

**Verification (live, from outside the LAN):** no session → login page; wrong or absent factor →
refused; passkey → in; WebSocket without a session → rejected; tunnel down → "Mac offline";
new-device Telegram ping arrives.

