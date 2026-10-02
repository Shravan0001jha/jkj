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

**`guards-worktrees.test.ts`** — edits stay inside the worktree and inside owned paths (the owner is
named), scratch is free, main checkouts never; commands that push/merge/rebase/reset/filter-repo, switch
to base branches, run release/deploy/testflight/ssh-window scripts, use ssh/scp/aws/gh/sudo/devicectl or
`rm -rf`, or name a main checkout are denied; a worktree is cut from the base tip on an `emp/` branch
with the venv linked and the main checkout untouched; a session's cwd is never a main checkout; the hook
denies/allows as the guard says; foreign changes are refused as evidence.

**`tunnel.test.ts`** — against a fake relay: the secret is checked, HTTP and sockets are proxied to
loopback, Telegram frames reach `notify`, ping/pong, reconnect after a drop, the off switch; a wrong secret
never connects and keeps retrying with backoff.

**`workplace-tools.test.ts`** — every Workplace MCP tool is listed through a real MCP client (the test that
caught the `z.record()` schema hiding all of them); `report_status`, `write_handoff`, `propose_org_change`
do what they say.

**`features.test.ts`** — the seeded phone→Mac feature routes to five charters with the real statuses and
marks its requirements planned; a feature stated without a spec is handed to the Chief of Staff whose
`write_spec`/`decompose_feature` tools move it on; the digest text.

**Relay (`workplace-relay`, pytest, 20):** `test_relay.py` (sessions rotate and expire, codes one-use with
five attempts, lockouts, no session → login page or 401, tunnel needs the secret, both factors or nothing,
CSRF on cookie sessions, proxying and socket bridging through a fake Mac, bearer sessions for the app,
offline page, the off switch) and `test_relay_security.py` (the lead's review: spoofed XFF, global send
limits with an alert, enrolment disabled after five wrong codes until `enrol on`, a second passkey needs a
session, failure pings rate-limited, a second live tunnel refused and reported, the allow-list enumerated,
health leaks nothing, 256-bit tokens stored hashed, audit free of secrets). Seven of the nine security
tests fail on the pre-fix commit.

**`fix-batch.test.ts`** (the owner's first day on the phone) — the employee page lists what the card
counts; a probe session never writes status or handoff and a shutdown leaves a note; a cap-paused
employee shows blocked with the plain reason and is counted; stalled work is derived and the routine
resumes once or explains; owner talk always runs and "continue" lifts the pause, audited.

**`money.test.ts`** — subscription usage is recorded as free (turns, tokens, equivalent ₹) and never
pauses; real spend from `record_spend` (reported/metered), from a release (estimated) and from the
daily AWS actual (metered, replacing estimates) sums into the caps; the migration relabels old rows
and lifts Mira's pause with a note; rate-limit events are kept per window.

**`approvals-everywhere.test.ts`** — `affects` is computed from raiser, assignment, charter and cap
scope, and always includes the Chief of Staff; answering once resolves it on every page; a denial
reaches the raiser's open session or its handoff.

**`room.test.ts`** — threads and messages persist; @mentions; the owner's messages are marked;
employees see their open threads in context; Asha's `room_resolve` writes the summary and creates the
follow-ups; `escalate` files an Inbox item linked to the thread; non-Asha cannot resolve; the seed
threads from the 27 Sep plans exist and mention the right people.

**`one-line.test.ts`** — a short sentence is its own summary; narration becomes one line with the
whole text as details; a long line is trimmed at a word to 120 with an ellipsis; a tiny first
sentence keeps the line; assistant entries carry summary/details, tool entries do not; Inbox items
carry them, the Telegram ping is one line, a raiser's own summary wins, old rows read with one; Team
Room headlines follow creation, posts and resolution and old rows read as their title; the digest is
at most four one-liners.

**`lock.test.ts`** — the lock holds the pid; a live holder refuses; the same pid re-acquires without
stealing; a dead holder is taken over; release removes only one's own lock; garbage is no holder; a
second `start()` on a taken port rejects with EADDRINUSE and leaves the lock; another live pid in the
lock refuses `start()` before anything opens; a squatted port fails the start and releases the lock.

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

## v2 (HLD §8, LLD §19) — tests written before the code, 2 Oct

| File | What it pins |
|---|---|
| `v2-items.test.ts` | one shape for epics/stories/tasks; tree and field validation (points 1/2/3/5/8, parents, the owner as assignee); the six-state machine (reviewer to enter review, reason + waiting-on to block, never done by the assignee, reopen needs a note, wont-do only by the owner); blocked-on-owner Inbox item and its withdrawal; the old engine keeps v2 in step (default reviewer on report_done, old blocks carry their reason, rejected → wont-do); reassign/reviewer/points as activity; started/blocked/unblocked/shipped feed lines with names and the epic room's named lines (never counts); epic progress, the Plan (areas, unfiled, mine, focus, flags, board); merge keeps history as a comment; comments with mentions, agent comments kept short |
| `v2-areas.test.ts` | ≤ 5 active areas (409), archive/re-activate; rooms (General, per area with a thread per epic, Releases); release posts grouped by area, an item ships once; a finished release run posts by itself |
| `v2-watch.test.ts` | Ready 15 min: in focus and free → started, else Backlog with the reason (not in focus, busy); Backlog never started, by the watcher or the old routine; idle 10 min → the COO at once, once per episode, never the owner; the open session asked to flag itself; COO offline → Asha resumes; review 30 min → the COO with the reviewer; the timers fire on their own; `flag_stall` |
| `v2-inbox-tools.test.ts` | free-text reply keeps the item open and reaches the asker (as the Workplace's prompt, not the owner's words); `inbox_reply`; an option answers it and posts "Decided"; the six agent tools (dedupe, who may create stories/tasks, no self-done, comments, status) |
| `v2-rhythm.test.ts` | the brief, the stand-up (authored by the Workplace, about the lead), the weekly review (reopens counted), once per IST day at 09:30 / 10:00 / Sunday 18:00; on-demand status by item, person, area |
| `v2-hygiene.test.ts` | the chat view folds Workplace prompts and system notes; sessions the Workplace starts are prompted as the Workplace; `short()`; agent Room posts kept short, the owner's never |
| `v2-migrate.test.ts` | legacy rows → level, parent, status, reason, reviewer, rank; COO-held blocked → Backlog; history → activity once; legacy threads → General; idempotent; nothing deleted |
| `v2-api.test.ts` | every v2 route over HTTP with the exact shapes; the Inbox thread routes; the old routes as adapters with v2 fields; through `x-via-tunnel` every v2 route passes and the COO's lead-only routes stay refused |
| `v2-push-mentions.test.ts` | pushed updates become `WP_UPDATE` intents (ids and the link only; shipped is not pushed); an @mention in a comment wakes the employee |

Changed on purpose: `chat-view.test.ts` — system notes now fold into the activity line (the owner's
2 Oct rule), still kept for "expand"; errors stay alone.
