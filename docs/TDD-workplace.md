# TDD — The Iris Workplace

Tests come before the behaviour they pin. Runner: Node's built-in `node:test` through `tsx`
(`node --import tsx --test`), so there is no new framework and the tests import the same `.ts`
sources the server runs. `npm test` runs everything; a milestone is not done while it is red.

## Fakes (in `packages/server/test/fakes/`)

| Fake | Replaces | Why |
|---|---|---|
| `fake-runtime.ts` | `runtime/claude-agent.ts startRun` | scripted sessions: emits text/tool/usage/result events on demand; no model, no spend |
| `fake-fetch.ts` | `fetch` in `github-apps.ts` | records requests; returns canned installation tokens and PR objects |
| `fake-spawn.ts` | script spawner in `releases.ts` / `deploys.ts` | asserts the real script path and args; never runs them |
| `fake-telegram.ts` | `notify.sh` and `inbox.jsonl` | captures sent lines; appends replies to a temp inbox file |
| `tmp-workplace.ts` | data directory | copies `packages/server/seed/` into a temp dir, sets `IRIS_WORKPLACE_DIR`, opens a fresh db |

Every test that touches the data directory uses `tmp-workplace.ts`; nothing writes to
`~/iris-workplace` or `~/iris-ops` from a test.

## Unit tests (file → what fails before the code exists)

**`org.test.ts`** — load seed; every employee's `roleId`, `unitId`, `charterIds`, `reportsTo`
resolve; levels: chief of staff 0, leads 1, hires 2; a hire proposed by a level-2 employee is
rejected ("no level 3"); a charter file with a bad front-matter field is reported with its path.

**`ownership.test.ts`** — `resolve` path longest-prefix (`services/agent-svc/experts/x.py` →
experts, `services/agent-svc/memory_client.py` → memory, `services/iris-api/` → server);
requirement by id then by group; `route` for the phone→Mac errand feature hits experts, server,
mobile, desktop-mac and consults conversation; unresolved things are listed, never dropped; lint on
the seed is error-free; each finding code has a test that introduces the fault (remove a path entry
→ orphan; duplicate a key with another primary → overlap; point a path at a missing dir → dead;
delete a requirement entry → unowned-requirement; drop a holder → unheld-charter; typo a charter id
→ unknown-ref).

**`requirements.test.ts`** — import of the checklist yields 110 items in 15 groups with the 27 Sep
counts (52 built + 16 partial + 42 missing before verified promotion); the extract's candidates add
the non-checklist requirements; ids are stable across two imports; a second import raises a
status but never lowers it; every requirement is owned on the seed; coverage totals add up per
group and overall.

**`context-layers.test.ts`** — order handbook → unit chain (outermost first) → charters in
`charterIds` order → status/handoff → assignment; a charter moved to another unit changes the unit
layer with no other change; over the token cap the assembler truncates charter detail after
"Rules" and reports it; the assignment block contains the plan-first instruction.

**`work.test.ts`** — assignment transitions table; `review` without evidence throws; `done` from
the assignee's own report moves to `review`; `done` needs a verifier different from the assignee;
false-done counter increments when review sends back; feature `decompose` makes one assignment per
routed charter assigned to the least-loaded holder; a plan is parsed from the first `## Plan` reply.

**`approvals.test.ts`** — the §0 table: every action maps to its approver; `gate('release')` is
refused without an approved Inbox item, refused with a rejected one, allowed with an approved one
whose subject matches; an AI approval never satisfies an owner gate; `gate('branch-work')` is
free.

**`spend.test.ts`** — usd→inr at the configured rate; per-IST-day bucketing at the midnight
boundary; the company cap pauses spawns and files one Inbox `cap` item (not one per session);
raising the cap for today via the Inbox answer unpauses; employee and unit caps independently.

**`inbox.test.ts`** — options validation (`needsNote` enforces a note); answering twice is 409;
answers via telegram carry `via: 'telegram'`; `approve <id>` / `reject <id>` / `talk` parsing.

**`proposals.test.ts`** — split `mobile` into `mobile-ios` + `mobile-android` with owned things
divided → diff lists the two new charter files and the map moves; hire from a role template with a
charter → new employee with workspace branch in the lead's repo; apply refuses while pending; apply
after approval writes files, lint stays clean, and a git commit exists with the reason; a proposal
whose result has lint errors cannot be approved; retire/merge/reassign symmetrical.

**`health.test.ts`** — idle 10 min → stalled; five identical tool entries → loop; interrupt and
Inbox question filed once; signals arithmetic on a fixture of work items.

**`github-apps.test.ts`** — JWT header/claims (RS256, `iat-60`, `exp≤600`) verified with the test
key; installation token cached until 5 min before expiry; `openPr` posts the right body; the key
path is never included in any log line or response.

**`releases.test.ts`** — `run` refuses without approval; with approval spawns exactly
`scripts/release-iris.sh <version>` in the Iris repo (fake spawner); log lines stream as
`release.log`; deploy for `server-api` runs from the deploy worktree, never the main repo.

**`auth.test.ts`** — loopback without a token passes; off-loopback without → 401; with the right
token passes; wrong token 401 (and constant-time compare used); pairing code single use, expires.

**`telegram.test.ts`** — new Inbox item sends one line ≤ 5 lines; digest format; cursor file is
the Workplace's own, `read_inbox.sh`'s cursor untouched.

**Kept from JKJ, now under test:** `session-reader` (parse a fixture transcript: entries, subagents,
images, cleaned user text), `context.ts` (ancestry chain, memory notes not counted),
`projects.encodeProjectKey`, `routes` validation (`validateCreate`, `validateMessage`).

## Integration tests (real HTTP, fake runtime)

`api.test.ts` boots the server on a random port against a temp workplace: `GET /api/office` shape;
create feature → decompose → assignments exist and the fake runtime received one spawn per charter
with the layered context in `systemPrompt.append` and `ANTHROPIC_API_KEY` absent from `env`;
`POST /api/inbox/:id/answer` flips a release to approved and `run` then spawns the fake; socket
receives `inbox.updated` and `alert`.

## Live verification (real model, real spend; recorded in the verification report)

1. Spawn one employee (Asha) with the real runtime, ask for a status line; confirm the session
   file on disk, the OAuth token in use (no API key), and a `SpendEntry` written from `modelUsage`.
2. Talk → end session → talk again: the second session's context contains the handoff written by
   the first.
3. State the phone→Mac errand feature; watch decomposition; at least one assignee returns a
   `## Plan`.
4. Send an Inbox ping through the real `notify.sh`; answer via Telegram reply; see `via: 'telegram'`.
5. M4: split `mobile` and hire an Android lead through the flow; re-route the same feature and see
   `mobile-android` in the primaries; `git log` in the data dir shows both commits.
6. Release gate: propose a desktop release; confirm `run` is refused until approved; do **not**
   run the real script (no Iris release in this build).

Everything not in this list is reported as "not live-verified".
