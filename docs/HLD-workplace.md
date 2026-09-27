# HLD — The Iris Workplace

Date: 27 Sep 2026. Brief: `docs/IRIS-WORKPLACE-PROMPT.md` (its §0 decisions are final and are not
re-argued here). Order of work: this HLD → `LLD-workplace.md` → `TDD-workplace.md` → code.

## 0. What it is, in one paragraph

JKJ becomes the **Iris Workplace**: one page (Mac or phone) where the owner runs the Iris product
through AI employees. Employees own **charters**, receive **assignments** routed through an
**ownership map**, reply with a plan, build with evidence, and raise real decisions to the owner's
**Inbox**. The organisation is **data** (files, versioned), so hiring, splitting, merging and
reorganising are edits approved in the Inbox, never code changes. Every line of the product
definition is a **requirement** owned by exactly one charter, so "how far is Iris from its
definition, and who is on it" is a number on the first screen.

## 1. What is kept from JKJ, what goes

| Kept (solid) | Why |
|---|---|
| `runtime/claude-agent.ts` (Agent SDK boundary) | one file touches the SDK; employees are sessions |
| driven sessions: steer, interrupt, continue, per-tool approvals, permission modes | this *is* "talk to an employee" and the tool gate |
| transcripts (`session-reader`, driven-run log) | evidence, and the employee page |
| context assembly with the parent-`CLAUDE.md` chain | reused as the bottom layers of the employee context |
| `@jkj/shared` as the one contract | the phone app is built against it in parallel |
| REST + WebSocket hub, web shell, tokens/styles | proven plumbing, restyled |

| Removed or hidden | Why |
|---|---|
| project rail, "add project by browsing", generic Agents grid, MCP tab, activity feed | generic multi-project surfaces; Iris is the only product |
| `projects.json` hand-added projects | the Workplace knows Iris's repos from the org data |

## 2. Decisions (each with its why)

### D1. Where the organisation lives: the Workplace data directory, its own git repo

Default `~/iris-workplace/` (override `IRIS_WORKPLACE_DIR`). Layout in LLD §1. It is initialised as
a git repository on first run and **every approved org change is a commit** with the proposal's
reason as the message. Seed content ships inside JKJ (`packages/server/seed/`) and is copied on
first run.

Why not `workplace/` inside the Iris repo: the first assignment after the Workplace exists is to
**split** that repo into several. An organisation that lives in one of the resulting repos would be
owned by one lead, and every reorg would be a PR into someone's repo. The org spans repos; it has to
sit beside them. Why files rather than only a database: charters must be readable by any session
(§3.1 of the brief), editable by hand, diffable in a proposal, and versioned; git gives all four
and answers "why is it shaped like this" with `git log`.

### D2. Two stores, one boundary

- **Org data = files** (charters `.md` with front-matter, `org.yaml`, `map.yaml`, `requirements.yaml`,
  per-employee `status.md` / `handoff.md`). Read into memory, validated, served as typed objects.
- **Operational data = SQLite** (`node:sqlite`, built into Node 22+): work items, inbox, events,
  sessions, spend ledger, approvals, pivots' cache. These change many times a minute and are queried
  by shape; a file per row would be wrong, a JSON blob would not survive a crash mid-write.

Why not one store: the org is human-readable and slow-changing; work is machine-written and fast.
Mixing them either makes the org unreadable or the work log a merge conflict.

### D3. What an "agent" is (precisely)

An **agent** is one employee's session, run through the Claude Agent SDK, and defined by:

| Facet | Definition | Source |
|---|---|---|
| Identity | employee id + name + role; for leads, the GitHub App identity `iris-<charter>-lead[bot]` | `org.yaml`, App config |
| Context | five layers, assembled at spawn (D4) | handbook, unit doc, charter, status/handoff, assignment |
| Tools | Claude Code's tools; the role template may restrict (`allowedTools`/`disallowedTools`) | `roles.yaml` |
| Permission mode | from the role, overridable per session in the UI: `acceptEdits` for engineers in their own worktree, `plan` for analysts, `ask` for anything touching another charter | `roles.yaml` |
| Freedom | branch work in own repo/worktree, run tests, read anything; nothing outward (§0 approvals table) | handbook + approval gates |
| Budget | ₹/day per employee, ₹/day per team, ₹1000/day company; concurrent sessions per employee | `org.yaml` |
| Workspace | repo + worktree/branch; hires get a branch in the lead's repo | `org.yaml` employee.workspace |
| Memory | the files: `status.md`, `handoff.md`; sessions are disposable | data dir |

Leads (level 1) are permanent employees; hires (level 2) are contractors spawned per assignment
with the same five layers but a contractor role, no `status.md`, and a branch in the lead's repo.
There is no level 3: the contractor role's tools exclude the Workplace's `hire` action, and the
server rejects a hire whose proposer is level 2.

### D4. Context is layered at spawn, not written into repos

The employee's system prompt is Claude Code's own preset plus an appended block assembled from:
1. company handbook (`handbook.md`) → 2. unit doc (`units/<unit>.md`) → 3. each charter the
employee holds → 4. `status.md` + `handoff.md` → 5. the assignment (spec, acceptance, plan-first
rule). SDK: `systemPrompt: { type: 'preset', preset: 'claude_code', append }` with
`settingSources: ['user', 'project']` so the repo's own `CLAUDE.md` chain still loads underneath.

Why not writing `CLAUDE.md` files into the Iris repo: it would touch product code (forbidden), and an
employee works in several worktrees. Reorganising then means moving one charter between units in
`org.yaml`; the next spawn inherits differently, with no prompt rewritten. Context size is guarded:
each charter has a token budget and the assembler reports the total; detail goes in linked docs the
employee reads on demand.

### D5. Ownership map: things → charter, and lint

`map.yaml` is a list of entries `{ kind, key, primary, contributors[], consulted[] }` with kinds
`path`, `service`, `route`, `feature`, `platform`, `keyword`, `requirement-group`, `requirement`.
Routing (LLD §4): paths by longest matching prefix; services/routes/platforms/features exact;
requirements by id first, then their group; keywords by scored match over the feature text. A
feature is decomposed by collecting every distinct primary its resolved things hit.

Lint findings: **orphan** (a thing no entry covers: a top-level repo path, a service, a requirement),
**overlap** (two primaries for one key), **dead** (a path that no longer exists on disk),
**unowned requirement**, **unheld charter** (no employee holds it), **unknown ref** (an entry names a
charter that does not exist). Findings are shown on the Org screen and block routing only for
`overlap`/`unknown ref`; the rest are health.

### D6. Requirements are first-class and imported, not typed in

`requirements.yaml` is generated by an importer from the product-definition extract (`seed/
product-definition-extract.md`, the checklist artifact and the deck). Each requirement has a stable
id (`REQ-<group>-<n>`), section, group, segments, status (`missing | partial | built | verified |
released`) with evidence, and an owner resolved through the map. **Coverage** = for the whole
definition and per group: owned %, planned % (has a feature), built %, verified %, released %.
Shown on Office. Requirements feed features (a feature lists the requirement ids it advances), and
features feed assignments, so the trace requirement → charter → feature → assignment → evidence is
a query.

### D7. Work model

Kinds: `feature`, `assignment`, `bug`, `question`, `approval` (Inbox items are approvals).
Assignment states: `proposed → planned (plan attached) → building → review (evidence attached) →
done | blocked | rejected`. A "done" without evidence is refused by the server; evidence is
`{ tests: {passed, failed}, commits[], liveVerified: string[], notVerified: string[], notes }`. A
feature is `stated → specced → decomposed → in-progress → built → released`. The Chief of Staff's
session writes the spec; the decomposer (deterministic, D5) makes one assignment per charter
touched; each assignee's first turn must produce a plan (the assignment prompt says so and the
server parses the `## Plan` heading before it will move the state).

### D8. Approvals are rules in code, mirrored by GitHub rulesets

The §0 table is encoded once (`approvals.ts`): an action → approver, and a **gate** the server
enforces: an outward action (release, deploy, TestFlight, store, external message, delete data,
force-push, new secret, spend above cap, permanent hire, org change) can only run through the
Workplace with an **approved Inbox item** whose id is passed to the runner. Release and deploy are
wired to the real scripts (`scripts/release-iris.sh`, `scripts/deploy-api.sh`, ...) but the
`runRelease` function refuses without an approval id in state `approved`. AI approvals (a lead
merging a hire's PR) are recorded but are never a gate on outward actions. On GitHub the lead
creates the rulesets (PR + CI + one approval from a different identity + CODEOWNERS); the Workplace
holds the App credentials and mints hourly installation tokens (D12).

### D9. Budget: equivalent API cost, in rupees, against three caps

Agents run on the subscription token (`CLAUDE_CODE_OAUTH_TOKEN` from `~/iris-ops/workplace/
claude-oauth.env`; `ANTHROPIC_API_KEY` is removed from the child env). Cost is still tracked: the
SDK's result message reports `modelUsage[model].costUSD` (list price × tokens, cumulative per
session); the ledger stores the delta per result per session, converts at `WORKPLACE_USD_INR`
(default 88, config), and sums per employee, team and company per IST day. Caps: employee, team
and the company's ₹1000. Reaching a cap **pauses** new spawns and interrupts running sessions for
that scope, and files an Inbox request ("raise the cap for today?"). The number the owner stated is
a hard contract; there is no soft threshold that quietly lets it through.

### D10. Sessions are disposable; memory is the files

A session ends when its assignment reaches `review`, when the employee writes a handoff, when the
context passes 70% of the window, or when stall detection fires. Before ending, the employee is told
to write `status.md` (three lines: doing / done / blocked) and `handoff.md`. The next session starts
from the layered context, which includes those files. "Talk to an employee" continues the current
session if one is open (SDK `resume`), else spawns a fresh one with the layered context.

### D11. Reaching the phone: Tailscale, a bearer token, nothing public

The server binds `127.0.0.1` by default. For the phone: the owner installs Tailscale (needs him:
install, network-extension approval, sign-in); the Workplace then starts with `--host <tailnet ip>`
and **requires** `Authorization: Bearer <token>` on every `/api` and `/ws` request that does not come
from loopback. The token is generated on first run into `~/iris-ops/workplace/api-token` (mode
600) and never shown in the UI; the phone gets it through a **pairing** call made from loopback
(`POST /api/pair` returns a one-time code; the phone exchanges it within 5 minutes). Loopback is
trusted because the Mac is the owner's. Until Tailscale exists, Telegram carries the Inbox: pings go
out through `notify.sh`, and replies `approve <id>` / `reject <id>` / `talk <employee> <text>` are
read from `inbox.jsonl` and applied, so one-tap approvals work from the phone on day one. A relay
was considered and rejected: any relay that needs no setup on his side is a public endpoint, and the
page drives sessions that edit code and run commands.

### D12. GitHub Apps: one per lead, credentials held by the Workplace, created by the lead

`~/iris-ops/workplace/apps/<charter>.json` (App id, installation id, key path) and
`<charter>.pem` (mode 600). `github-apps.ts` mints a 9-minute RS256 JWT and exchanges it for an
hourly installation token, cached until 5 minutes before expiry, with `fetch` injectable so tests
run against a fake. PR plumbing (open, request review, read checks, merge) uses that token. The UI
shows that a credential exists, never its value. The exact Apps, repos and permissions are listed in
LLD §12 for the lead to create.

### D13. Org changes are proposals, diffs, and commits

A proposal is `{ kind: hire|retire|split|merge|reassign|restructure, reason, before, after }`
computed against the live org; the UI shows the diff of the org files; the owner approves in the
Inbox; applying writes the files, validates the org (lint), and commits. The proposer can be the
Chief of Staff or a lead (their session has the `propose_org_change` MCP tool) or the owner from the
Org screen. A rejected proposal is kept with its reason. Signals that trigger a proposal (queue
length, context-limit hits, mutual blocking, orphans) are computed by the health service and shown;
they do not auto-apply anything.

### D14. Health: cheap signals, honest stall detection

Per employee and per charter: throughput (assignments done / 7 days), rework (assignments sent back
from review), false-done rate (done claims that failed verification), cost per completed item. A
session is **stalled** when no transcript entry for 10 minutes while `running`, or the same tool
call (name + input hash) repeats 5 times in a row; it is interrupted and an Inbox question is filed.

### D15. Telegram is the channel today and the alert channel always

Milestone notes and Inbox pings go through `~/iris-ops/notify.sh` (3–5 lines). The daily digest at
09:00 IST summarises: needs you, done yesterday, blocked, spend. The bridge process already appends
replies to `inbox.jsonl`; the Workplace tails it from its own cursor file so it never steals the
existing `read_inbox.sh` cursor.

## 3. The first organisation (seed) and why it is shaped this way

Seven employees, eleven charters, four units. The mix is deliberate: capability charters (how Iris
behaves), platform charters (where she runs), function charters (how work is checked and shipped),
and one non-code charter, so the model is proven to hold more than one axis from day one.

| Employee | Role | Charters | Unit | Reports to |
|---|---|---|---|---|
| Asha | chief-of-staff | `chief-of-staff`, `product-and-business` | Product | Owner |
| Dev | lead | `conversation`, `character` | Capabilities | Asha |
| Mira | lead | `experts` | Capabilities | Asha |
| Kabir | lead | `memory`, `server` | Capabilities (+ Platforms chapter) | Asha |
| Rohan | lead | `desktop-mac`, `windows` | Platforms | Asha |
| Tara | lead | `mobile` (iOS + Android) | Platforms | Asha |
| Nikhil | qa | `qa-release`, `beta-ops` | Quality | Asha |

Why these cuts: `conversation` and `character` are the two halves of "how she feels to talk to"
and share the responsiveness contract, so one lead. `experts` is the largest surface (nine expert
docs) and cross-cuts every platform, so it stands alone. `memory` spans client and server; the
server half is in `iris-api`, so the same lead holds `server` (and the deploy discipline that goes
with it). `desktop-mac` + `windows` share the Electron code. `mobile` is one charter today (iOS
first, Android exists); it is the planned M4 split (iOS / Android) with an Android hire, which shows
routing move with no code change. `qa-release` is the different identity the §0 table needs for a
lead's own PR, and `beta-ops` (tester digests, alerts, crash reporting) is the observability charter
the definition asks for. `product-and-business` holds the non-code areas now (pricing, legal/
privacy, growth, roadmap, character spec decisions) and is expected to split as work grows.

Requirement groups map to charters (LLD §5): Expressions/Movement/Touch/Looks → `character`;
Voice/Personality → `conversation`; System actions/Communication/Productivity/Context reactions →
`experts`; Memory → `memory`; Cross-device → `mobile` (with `experts` and `server` consulted);
Social → `product-and-business`; Privacy and safety/Promises → `product-and-business` (with the
building charter consulted); Theme, Segments, Pricing, Plan, Platforms → `product-and-business`;
observability → `beta-ops`.

## 4. Screens (views over the data)

Office · Org · Inbox · Features · Talk · Assign · Releases · Spend & Health · Employee page (Talk +
JKJ's transcript, tool approvals, permission mode, context layers). Phone-first layout: one column
under 720px, bottom tab bar, one-tap approve/reject. The same REST/WS contract serves the iOS app.

## 5. Milestones (each runnable and measured)

| M | Delivers | Measured by |
|---|---|---|
| M0 | Iris-only config; generic surfaces hidden; test runner; existing logic under test; all green | `npm test` count; UI shows no project rail |
| M1 | org model, map + lint, layered context, requirements import + coverage, Office, Org, Talk, disposable sessions | unit tests; lint = 0 orphans on seed; coverage numbers on Office; a real employee session started and continued from files |
| M2 | work items routed by map, assignment states + evidence, reports, Inbox, Telegram pings + replies | routing tests; an approval done via Telegram reply |
| M3 | features: spec → decompose → plans → builds; pivots; phone→Mac errand feature seeded with real statuses | the seeded feature routes to ≥4 charters; pivots by charter/platform/team |
| M4 | proposals (hire/retire/split/merge/reassign), approval, history, health signals | live: split `mobile`, hire Android lead, re-route the same feature; `git log` in data dir |
| M5 | release/deploy gates on the real scripts, budgets/caps, stall detection, phone access, digest | gate refuses without approval (test); cap pauses (test); token auth (test); digest sent |

## 6. Security

Loopback by default; bearer token off-loopback; secrets only ever as "present/absent" in the UI;
child env gets the OAuth token and loses `ANTHROPIC_API_KEY`; release/deploy only via approved
Inbox items; WhatsApp is never wired; every employee's outward action is a gate, not a prompt.

## 7. Risks and open questions

- The SDK's cost is an estimate (list price), not a bill; the cap is enforced on the estimate, which
  is the conservative side. — accepted.
- `git filter-repo` is not installed; the split machinery reports that as a precondition and the
  plan flow still works. — the split is the Chief of Staff's first assignment, not this build's.
- Tailscale needs the owner. — designed for, asked for in M5, Telegram carries approvals until then.
- The product-definition deck is read once by the importer; a re-import diff is provided so a
  changed definition updates requirements without losing statuses. — in LLD §5.
