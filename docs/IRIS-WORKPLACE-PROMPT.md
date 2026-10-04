# Brief: rebuild JKJ as the Iris Workplace

## 0. Decisions already made with the owner (27 Sep; these are final)

- **The organisation is data** (§3). The first real job, after the Workplace exists, is **splitting the
  code into separate repos by ownership**. The Chief of Staff leads it: the leads propose their
  boundaries from their charters, the owner approves the split plan, and the migration keeps git
  history (git filter-repo). A small **shared contracts repo** (API schema, event shapes) sits between
  them, and changes to it need every affected lead.
- **After the split, leads hire.** Two levels only:
  - **Leads (level 1):** permanent, with a charter, memory files, a repo, and a budget.
  - **Hires (level 2):** **contractors** by default. They are spawned per task, narrow in scope, with
    no standing memory, work on a branch in the lead's repo, and are merged by the lead. A hire
    becomes permanent only with a case from the lead and the owner's approval.
  - **No level 3:** hires can't hire.
  - Define "agent" precisely in the HLD: its identity, its context layers, its tools, its permission
    mode, what it may do without asking, and its budget.
- **GitHub:**
  - The organization is **`shravan0001jha-iris-hq`**: Team plan, 1 seat (the owner), empty. The code
    is private `shravan0001jha-iris-hq/iris` (moved from `Shravan0001jha/hivemind-prototype` on 2026-10-04).
  - **One GitHub App per lead**, not bot user accounts. Apps take no seats and give an identity
    such as `iris-<charter>-lead[bot]`. Each App is installed only on its own repos, with minimal
    permissions (contents, pull requests, checks), and uses hourly installation tokens minted from its
    private key. Keys are stored mode 600 under `~/iris-ops/workplace/apps/` and never displayed.
  - Protected `main` on every repo, via org rulesets: PR required, CI required, one approval from a
    **different** identity, CODEOWNERS enforced.
  - The local `gh` login now has `admin:org` and `workflow` scopes.
  - GitHub's "sudo mode" prompts are answered by the owner on **GitHub Mobile**. Pick that option and
    ping him on Telegram. **Never** enter his password or 2FA codes.
- **Approvals.** Who approves what, enforced mechanically where possible (GitHub rulesets, Workplace
  gates). An AI manager's approval is **not** a safety gate: in Anthropic's Project Vend the AI "CEO"
  co-signed bad decisions.

  | Action | Approver |
  |---|---|
  | Branch work in own repo, run tests | Nobody (agent's freedom) |
  | Merge to own repo's main | CI green + a different identity: the lead for a hire's PR; **QA** for a lead's own PR |
  | PR into another lead's repo | That repo's lead + CI |
  | Change to the shared contracts repo | All affected leads + the Chief of Staff |
  | Hire a contractor within budget | The lead (automatic) |
  | Permanent hire; create, split or merge a charter; change the ownership map | **Owner** |
  | Release, deploy, TestFlight, store upload | **Owner** (QA prepares) |
  | Spend above the daily cap | **Owner** |
  | External messages (WhatsApp only ever to the owner) | **Owner** |
  | Force-push, history rewrite, deleting repos or data; access to a new secret | **Owner** |

- **Budget:**
  - **₹1000/day for all agents combined**, unless the owner specially approves more.
  - Agents run on the owner's **Claude subscription**: a long-lived token in
    `~/iris-ops/workplace/claude-oauth.env` (`CLAUDE_CODE_OAUTH_TOKEN`, mode 600, verified working).
    Load it into agent processes and **unset `ANTHROPIC_API_KEY`** for them, so they don't bill the
    API.
  - Track each agent's **equivalent API cost** (token usage × list price, converted to ₹) against
    the cap. Pause agents at the cap, and put an Inbox request to the owner.
  - The ₹1000 covers only the agents, not Iris's own running costs.
- **Talking to the owner:**
  - **Telegram now:** `~/iris-ops/notify.sh "text"` sends. Replies arrive in
    `~/iris-ops/state/inbox.jsonl` (a local bridge process appends them). Keep messages to 3–5 lines.
  - **A phone app:** the owner wants an app on his iPhone to talk to the employees. His **iPhone 16 is
    connected to this Mac** and visible to Xcode:
    `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun devicectl list devices`, UDID
    `00008140-001E50C61487001C`. The active `xcode-select` is CommandLineTools, so use `DEVELOPER_DIR`
    and don't switch it with sudo. Build a native iOS app (SwiftUI) over the Workplace API: Office,
    Inbox with one-tap approvals, Talk to any employee, Features, push-style alerts. Install it on his
    phone with a development build, as the existing Iris iOS project in `~/claude-dev-mobile/mobile/ios`
    does; reuse its signing team.
  - **Reach from the phone:** Tailscale is not installed yet. Its install, network-extension approval
    and account sign-in need the owner, so ask on Telegram when you get there. Until then, Telegram is
    the channel. Consider a relay that needs no setup on his side, but never a public unauthenticated
    endpoint.
- **The Mac** is kept awake with `caffeinate -dimsu`. Heavy builds are capped at 1–2 concurrent: Mac
  and iOS builds can only run here, and CoreAudio has overloaded under load before.
- **Reuse, don't reinvent.** The owner's other work is on this machine: the Iris codebase, JKJ, and
  Telegram tooling in `~/iris-ops/`. Read first.

You are taking over `~/jkj`, a local control plane for Claude Code. It is a TypeScript monorepo:
`packages/{server,web,shared}`, the Claude Agent SDK in `packages/server/src/runtime/`, REST +
WebSocket. Read `README.md` and `docs/architecture.md` first.

Today JKJ is a **general** tool for browsing and driving Claude Code sessions. Your job is to rebuild
it into **the Iris Workplace**: a place where the owner runs the Iris product through a staff of AI
agents who behave like **employees**. They own a charter, take assignments, work in parallel, report
results with evidence, raise decisions to the owner, and never need to be told the same detail twice.

This is not a general tool any more; every feature exists for Iris. Keep the solid parts of JKJ:
- the Agent SDK runtime;
- driven sessions with steering, interrupt and continue;
- per-tool approvals and the permission modes;
- transcripts;
- context-file editing, including the parent-`CLAUDE.md` inheritance chain;
- the `shared` contract.

Remove or hide what doesn't serve Iris.

## 1. Why this exists (the owner's words, paraphrased)

"We have Mac, Intel, Windows, iOS, Android, iPad… a lot of ventures now. I can't keep track of them
all. I want to talk about a feature once, and have independent sessions whose only work is their own
area, working out how to make it work properly there, so I don't have to think again and again about
every small detail. Like a workplace, where agents are employees who work for me."

And, as the most important design constraint:

> "I want a foundation of a structure that can grow — employees can increase, charters can increase —
> and the division shouldn't necessarily be per device."

**Success:**
- The owner opens one page, from the Mac or the phone, and sees who is working on what, what's done,
  what's blocked, and what needs him.
- He states a feature once and the right employees turn it into work in their own charters.
- He can talk to any employee directly.
- He can reshape the organisation (hire, split, merge, retire) as Iris grows, without code changes.
- Nothing ships without his approval.

## 2. How the owner wants work done (non-negotiable)

- **Build order for anything new:** HLD → LLD → TDD, in that order, as documents in `~/jkj/docs/`, then
  implementation. No skipping.
- **Every bug fix starts with an RCA** backed by evidence (logs, a reproduction), then an impact
  analysis of what else the fix could break, then tests that fail before the fix.
- **Production-grade only.** Iterate until it is correct.
- **Deliver the final product.** Work autonomously through the whole order. The docs record how and
  why decisions were made. Surface only the runnable product or a real blocker.
- **Numbers the owner states are hard contracts.** Never quietly relax them.
- **Verify visual work by measuring.** Never claim a UI works from one screenshot. Check each item, and
  run a control.
- **Honest reporting.** State test counts, what was live-verified, and what was not. Never "done"
  without evidence. The same rule applies to the employees (§6).
- **Messages to the owner on Telegram are short:** 3–5 lines.

## 3. The central idea: the organisation is data

Do **not** hard-code a device-per-employee structure, or any fixed structure. Build a small,
general **organisation model**, with Iris's first organisation as seed data inside it. Design it
properly in the HLD. These are the concepts it must support.

### 3.1 Charter: the unit of ownership (not the device)
A charter is a durable **area of responsibility**. It can be cut along any axis, and different axes
can coexist:
- a **capability**: voice and conversation, memory, the experts (device actions), the character and
  presence, the responsiveness contract;
- a **surface or platform**: Mac packaging, Windows, iOS, Android, server;
- a **function**: QA, release and ops, beta watch, security and privacy, docs;
- a **project or initiative**: "phone↔Mac parity", "India launch";
- a **customer segment**: students, accessibility.

A charter holds:
- **mission** and **scope**;
- **owned things**: code paths, services, API contracts, docs, features, metrics;
- **interfaces** it publishes and consumes;
- **rules and traps**;
- **definition of done**;
- **how to build, test and ship** its things;
- **who it must coordinate with**;
- **what needs owner approval**.

Charters are versioned files, readable by any session.

### 3.2 Ownership map: routing without hard-coding
There is one map from *things* to charters: paths, services, API routes, features, platforms and
keywords. For each thing it records:
- a **primary owner** (exactly one);
- **contributors or reviewers**;
- a **consulted-on-change** list.

It works like `CODEOWNERS`, generalised beyond paths. Work is routed by looking things up in the map,
never by a hard-coded "which device is this". The Workplace **lints** the map:
- orphans: things nobody owns;
- overlaps: two primaries for one thing;
- dead entries: paths that no longer exist.

It shows the lint results so the organisation stays healthy as it grows.

### 3.3 Roles, employees, teams: people separate from ownership
- A **role** is a template: default instructions, tools, permission mode, model, and budget class.
  Examples: engineer, lead, QA, release manager, analyst, chief of staff.
- An **employee** is an instance: a name, a role, the charters it holds (one or several), a workspace
  (repo and worktree or branch), a budget, a status and a handoff, and its sessions.
- A charter can be held by one or more employees, and an employee can hold several small charters.
  Start small; split when it grows.
- **Teams or units** group employees and charters and can nest into a hierarchy (a lead with reports).
  A matrix is allowed: a capability team plus a platform chapter, e.g. a "Memory" engineer who also
  sits in the "iOS" chapter for iOS-specific memory work.
- **Escalation follows the hierarchy:** an employee goes to its lead, the lead goes to the Chief of
  Staff, and the Chief of Staff goes to the owner, but only for real decisions.

### 3.4 Knowledge as layers, like the org
Context loads in layers, the same way JKJ already walks the parent `CLAUDE.md` chain:
1. the **company handbook** (global rules and guardrails, §5);
2. the **unit or team** doc;
3. the **charter**;
4. the employee's **status and handoff**;
5. the **assignment**.

Reorganising moves a charter between units and changes what it inherits. No prompt is rewritten.
Watch context size: charters stay concise, and detail lives in linked docs loaded on demand.

### 3.5 Org changes are first-class, versioned, and approved
The following are all **proposals**: a readable diff of the org data with a reason, which the owner
approves in the Inbox:
- hire (from a role template plus a charter);
- retire;
- split a charter (two new charters, and the owned things divided between them);
- merge charters;
- reassign a charter;
- create or restructure a team.

The Chief of Staff (or a lead) **may propose** org changes when there are signals:
- a charter's queue keeps growing;
- its sessions constantly hit context limits;
- two charters keep blocking each other;
- the lint finds orphans.

The org has a history, so "why is it shaped like this" always has an answer.

### 3.6 Work is independent of the org
- **Work items:** feature, assignment, bug, question and approval, each with an owner resolved
  through the map at routing time.
- **Feature flow:** stated once → a spec with acceptance criteria (Chief of Staff) → **decomposed by the
  ownership map** into assignments for whichever charters it touches. That may be three capability
  charters and two platform charters; it is not "one per device".
- **Each assignee replies with a plan first,** then builds, and attaches evidence.
- **Progress views are views over the data**, pivotable by any dimension: features × charters,
  features × platforms, features × teams. "Device parity" is just one pivot of this, not the structure.

### 3.7 Capacity and health
- **Per-employee and per-team budgets:** tokens/$ per day, and concurrent sessions.
- **Queues.**
- **Stall and loop detection.**
- **Simple performance signals** per employee and per charter:
  - throughput;
  - rework;
  - false-done rate, meaning "done" that failed verification;
  - cost per completed item.

These signals inform org proposals and charter improvements ("retraining" an employee means editing
its charter or role).

**Sessions are disposable; the memory is the files.** When a session gets long, the employee writes
its handoff, and a fresh session continues from the layered context. Decide in the HLD where the org
data and charter files live, and justify it. Two options:
- a `workplace/` directory versioned with the Iris repo;
- JKJ's own store with the charter text in files.

## 4. The terrain: facts about Iris (not the org chart)

Use these facts to seed the first organisation. They describe where things are, not how to divide the
people.

**The product.** Iris is a desktop companion character plus an assistant: voice, experts that act on
the device, memory, and a cloud agent. The main repo is `~/claude-dev` (branch `feat/iris-character`).
Separate git worktrees exist per line of work: `~/claude-dev-mobile` (`feat/mobile`),
`~/claude-dev-deploy` (`deploy/api-*`), `~/claude-dev-site`, `~/claude-dev-auth` and others.
`git worktree list` shows them all. Read `~/claude-dev/CLAUDE.md`, `docs/HLD-*.md`,
`docs/experts/*.md` and the product definition.

| Thing | Where | Build / test / ship | Traps |
|---|---|---|---|
| Desktop app (Mac Apple Silicon) | `desktop/` (Electron), `services/agent-svc/` (Python agent) | `services/agent-svc`: `../../.venv/bin/python -m pytest -q tests`; `desktop`: `npm test`; dev `npm start` (prestart rebuilds `character/stage.bundle.js`); release `scripts/release-iris.sh <ver>` (notarise, S3/CloudFront) | Latest 0.2.15. The release script kills the installed Iris and does not relaunch it. |
| Mac Intel build | same code, `.venv-x64`, `scripts/release-iris-x64.sh` | x64 release | Stuck on 0.2.4. |
| Windows build | `Procfile.windows`, `scripts/release-iris-win.ps1`, `scripts/build-agent.ps1` | 0.2.10 | A human teammate also develops Windows. Coordinate; never overwrite their work. |
| iPhone / iPad app | `~/claude-dev-mobile/mobile/ios/` (Xcode, `dev-run.sh`) | TestFlight via App Store Connect (server `asc.py`) | iPad live "talk" mode (`source=talk`). |
| Android app | `~/claude-dev-mobile/mobile/android/` (Gradle) | `./gradlew`; signing in `~/iris-ops/mobile/` | |
| Server | `services/iris-api/` (FastAPI, SQLite), `services/cloud-agent/` (Haiku chat, Sonnet work) | **Deploy only from `~/claude-dev-deploy`**: `scripts/deploy-api.sh`, `scripts/deploy-agent.sh` | Back up `/opt/iris-api/iris.db` first. SSH via `scripts/ssh-window.sh open/close`. Production keeps `IRIS_MEMORY_CONSOLIDATION=0` until the owner says otherwise. |
| Website | `web/`, `scripts/deploy-web.sh`, `~/claude-dev-site` | S3 + CloudFront | |
| Capabilities that cut across all of these | voice/STT/TTS, the responsiveness ladder (hard rule: something visible ≤ 500 ms while she works), experts and the no-lie guard, memory (account beliefs), the info expert (cloud answers), phone↔Mac errands, character and expressions | see `docs/experts/*.md`, `docs/HLD-*.md` | These are good candidates for capability charters. |

**Ops material** is in `~/iris-ops/`: infra.env, keys, `notify.sh` (Telegram), `admin_key`, and tester
logs via `/admin/logs`. These are **secrets: never display, copy or log them**. The UI may show that a
credential exists, never its value.

## 4b. The whole product, not just the code

The Workplace runs **everything the product definition asks for**, not only the engineering. Read the
sources with the Artifact tool's read action (they are the owner's private claude.ai artifacts):
- **Iris — Product Definition:** https://claude.ai/artifact/D3RnHZxvijew1JJj8hetQG
- **Iris Against Its Definition:** https://claude.ai/artifact/HQ9PXfpTVkkrLcJXMbHdRY. The status of all
  110 checklist features in 15 groups (52 built / 16 partial / 42 missing as of 27 Sep), plus what
  shipped that day.
- **Closing the Iris Gaps:** https://claude.ai/artifact/X1NjmtxguA2FacH3q83Lyj
- **Iris: the road from today's build to the product:** https://claude.ai/artifact/AYGc1twG1DLgVVbSNFMV6V
- **Watching Iris in Beta** (observability gaps): https://claude.ai/artifact/FBWoV1HvgXk4Cpy9AGmRDo

Make them first-class in the model:
- **Requirements** are imported from the product definition and the checklist. Each has a stable id,
  its section, the segment(s) it serves, and its status with evidence.
- **Every requirement must have exactly one owning charter.** Extend the ownership-map lint so that
  "unowned requirement" is a finding. **Coverage** (the share of the definition that is owned, planned,
  built, verified and released) is a headline number on the Office screen. Requirements feed features,
  and features feed work, so the owner can trace any line of the definition to the work and evidence
  behind it.
- **Charters are not only engineering.** The first organisation must be able to hold, now or through
  later hires, the non-code areas the definition covers, for example:
  - **Product and design:** the character, expressions and movement spec, "quiet by default", the
    three spoken moments.
  - **Pricing and billing:** tiers (Free / Pro / Power, India pricing), payments, the trial, the
    per-user cost audit.
  - **Legal, privacy and trust:** India's DPDP Act, 18+ at launch, AI disclosure, auto-hide on screen
    share (the one non-negotiable), memory view and delete, transcript retention.
  - **Security:** data egress, hijacking, permission modes.
  - **Growth and segments:** US students, early-career pros, creators, India campus and tech workers,
    accessibility.
  - **Platform roadmap** stages (Mac + iPhone first, then Windows + Android).
  - **Support and beta ops:** tester digests, alerts, crash reporting.
- **Non-code work produces documents, decisions and proposals,** not commits. Its evidence is the doc,
  the owner's decision in the Inbox, or data.
- **Decisions the definition leaves open** go to the owner as Inbox decisions. Examples: push-to-talk
  as the default, the pricing architecture, the platform order. They are not made silently by an
  employee.
- **Seed the Features board and the progress pivots from the real checklist**, so on day one the owner
  sees Iris's actual state against the definition, by charter and by requirement group.

## 5. Company handbook (global rules every employee inherits)

- **Evidence or it didn't happen.** Every "done" carries test counts, commits and, where relevant, live
  verification. Say explicitly what was not verified.
- **Stay inside your charter.** Changes to things you don't own go through their owner, via the map.
  Contract changes (APIs, event shapes) need both sides.
- **Before fixing:** RCA, then impact analysis, then tests that fail first. Production-grade only.
- **No outward actions without the owner's approval in the Inbox:** release, deploy, TestFlight or
  store upload, publishing, messages, payments, deleting data.
- **Messages:** WhatsApp only ever to the owner's own number. Nothing is sent to external people.
- **Act first, then acknowledge.** Never claim an action before it happened.
- **The owner's machine:** don't touch his running Iris or his live Terminal/Chrome without saying so,
  and restore the state afterwards.
- **Never display secrets.**
- **Write status and handoff before stopping.** Keep reports to the owner short; put detail in the
  body or the docs.

## 6. Screens (phone-friendly as well as desktop)

These are views over the data; design them in the HLD.
- **Office:** employees grouped by team, with state (working / idle / blocked / needs you), current
  work, last report, and spend.
- **Org:** the org chart and ownership map, the lint findings, and org-change proposals with their
  diffs and history.
- **Inbox:** every decision or approval that needs the owner, with context and one-tap answers where
  possible.
- **Features:** the board, plus the progress pivot (by charter, platform or team) with evidence
  links.
- **Talk:** chat with any employee, continuing its session, with its layered context visible.
- **Assign:** to an employee or a charter, or route a feature through the map.
- **Releases:** per-shippable version, what is merged but unreleased, and approve / reject.
- **Spend and health.**
- Inside each employee's page, keep JKJ's transcript view, tool approvals and permission-mode control.

**Reaching the owner:** the Workplace runs on the Mac, bound to loopback by default. Phone access is an
HLD decision; Tailscale is recommended. Never a public URL without strong auth: the page drives
sessions that edit code and run commands. Telegram (`~/iris-ops/notify.sh`) carries Inbox pings and
the daily digest.

## 7. Delivery plan

Refine this in the HLD. Each milestone must be runnable and verified.
- **M0 · Refocus:**
  - an Iris-only configuration;
  - hide or remove the generic multi-project surfaces;
  - all existing JKJ tests green.
- **M1 · The org model:**
  - charters, roles, employees, teams, the ownership map with lint, and layered context;
  - an Office screen and an Org screen;
  - talk to an employee;
  - disposable sessions that continue from files.

  Seed a **first organisation** from §4 and justify its shape in the HLD. It should be small (roughly
  5–8 employees) and deliberately mix axes (some capability charters, some platform charters, the
  function charters, and a Chief of Staff), so the model is proven to handle more than one axis from
  day one. Write the charters with real content, not placeholders.
- **M2 · Work:** work items routed through the map, assignment states with evidence, reports, the
  Inbox with approvals, and Telegram pings.
- **M3 · Features:**
  - spec → decomposition by the map → plans → builds;
  - the progress pivots;
  - seeded with a real feature (the phone→Mac errand flow, which crosses errands, the cloud agent,
    Android, iOS and the desktop) and Iris's real current statuses.
- **M4 · Org growth:**
  - proposals for hire, retire, split, merge and reassign, as diffs;
  - owner approval;
  - history;
  - health signals that trigger proposals.

  Demonstrate it for real: split one seeded charter and hire one new employee through the flow, then
  show the routing and context changed with **no code change**.
- **M5 · Releases, spend and reach:**
  - approval-gated release and deploy wired to the real scripts (never run without approval);
  - budgets and caps;
  - stall detection;
  - the phone-access decision implemented;
  - the daily digest.

**Also in M1:** import the product-definition requirements (§4b). Every requirement is owned (lint
clean), and the coverage numbers appear on the Office screen.

**Acceptance for the whole:**
0. Every product-definition requirement is traceable: requirement → owning charter → features and work
   → evidence. There are no orphans.
1. The owner states one feature.
2. It is routed through the ownership map to the right charters, whatever axis they are on.
3. Each assignee replies with a plan.
4. At least one builds it with evidence.
5. The release waits in the Inbox.
6. Separately, one org change (a split plus a hire) goes from proposal to approved to live, and the
   same kind of feature then routes to the new structure.

Measure it end to end, and report what was verified live.

## 8. Constraints on you

- **Where to work:** in `~/jkj` (its own git repo; commit as you go). Don't change Iris product code in
  `~/claude-dev` or its worktrees. The only exception is the Workplace's own files (org data,
  charters) if the HLD puts them in the Iris repo; then keep them on a branch and report it.
- **No releases or deploys of Iris, and no messages to anyone except the owner.**
- **Every JKJ test must stay green; add tests first for new behaviour.** The org model, map lint,
  routing and context layering need thorough unit tests: they are the foundation everything else
  grows on.
- **Keep the owner updated in 3–5 line Telegram notes at milestones only.** Surface a real blocker
  immediately.
- **When done:** the runnable Workplace, the docs (HLD, LLD, TDD, plus a short "how to use" page,
  including how to hire, split and reorganise), and an honest verification report.
