# Verification report — the Iris Workplace (27 Sep 2026)

Honest reporting: what was measured, what was live-verified with the real model, and what was not.
Tests are counts from `npm test` in `~/jkj` and `pytest` in `~/claude-dev-deploy/services/workplace-relay`.

## Test counts

| Suite | Count | Time |
|---|---|---|
| Workplace (`~/jkj`, `node --test` via tsx): unit + HTTP/socket integration | **95** | ~30 s |
| Relay (`workplace-relay`, pytest): behaviour + the security review | **20** | ~2 s |

All green at the time of writing. The security tests were run against the pre-fix relay commit: 7 of 9 fail
there (the two that pass are confirmations of things that were already right), so they fail first.

## Live-verified with the real model (subscription token, no API key)

| What | Evidence |
|---|---|
| A session starts with the layered context | Asha, 7,019 context tokens; session file on disk; reply named her two charters |
| Spend is recorded from the SDK's accounting | ₹8.47 for that turn; ₹270 after the M3 flow; ledger on the Spend screen |
| Session ends with status and handoff written through the Workplace tools | Kabir: both files in 18 s, committed in `~/iris-workplace`; nothing written into `~/claude-dev` |
| State a feature once → spec → decomposition → plans | "Daily greeting, weather-aware": Asha read `context/weather.py` and wrote a grounded spec via `write_spec`, decomposed; Kabir, Mira, Rohan and Dev each replied `## Plan` (captured on the assignments); feature `in-progress` |
| No session parks unattended | after the auto-mode/free-tools change, four sessions ran to their plan with `parked on: None` |
| Worktree isolation | Asha's session answered `pwd && git branch --show-current` with `~/iris-work/asha/claude-dev`, `emp/asha/general`; `~/claude-dev` 0 tracked changes before and after |
| Office, Org, Features, Inbox, Employee, Assign, Releases, Spend render real data | in Chrome on the built app; console clean; 8 routes, no page overflow at desktop and at 386 px (rail hidden, tab bar shown) |
| Lint on the real org | 0 findings after the repo-root and `iris:services` entries |
| Bearer auth off loopback | from the LAN interface: 401 without or with a wrong token, 200 with it; pair refused off loopback (400); exchange returns the token once; socket 401 without a token, `office.snapshot` with it |
| Telegram out | milestone notes and Inbox pings delivered (`sent`) |
| Digest | one real send from `POST /api/digest` |

## Not live-verified (and why)

- **An approval by the owner's Telegram reply.** The parser and the tail are unit-tested; the live proof needs his
  reply (`approve <id>`). The M4 split and hire proposals are in his Inbox for exactly that.
- **The org change going live** (M4): the mechanism is unit-tested end to end (split → diff → approve → files
  written → commit → routing changes; hire → new holder; a contractor's branch; no level 3). It applies when the
  owner approves in the Inbox; it was not applied by me on his behalf.
- **A build with evidence by an employee** (acceptance 4): sessions were stopped at the plan stage while worktree
  isolation was put in (the lead's rule). With isolation live, the next `assign` builds in `~/iris-work/...`.
- **The release gate on the real script**: the gate refusing without approval is verified over HTTP with the real
  script path; running the script itself was never done (no Iris release in this build), so "approved → runs" is
  verified with a fake spawner only.
- **Cap pause with a real overspend**: unit-tested at the boundary; the real ledger never reached ₹1000.
- **Stall and loop detection on a real session**: unit-tested (idle 10 min, 5 identical tool calls); the detector
  runs every 30 s in the live server but no real session stalled.
- **The relay in production**: built, 20 tests, security-reviewed; not deployed at the time of writing (the lead's
  go was pending). The tunnel client is verified against a fake relay only.
- **Tailscale**: not installed (needs the owner). The LAN listener was used for the iOS device test instead.
- **GitHub Apps**: JWT, installation-token caching and PR plumbing verified against a fake `fetch`; no App exists
  yet (the lead creates them; the list is in the LLD §12).

## Bugs found by live checks (RCA'd, fixed, pinned by tests)

1. The Workplace's MCP tools were invisible to sessions: a `z.record()` schema made the MCP SDK fail to list any
   tool of the server (a session then wrote `status.md` into the Iris repo; removed). Now `paramsJson`, and a test
   lists all eight tools through a real MCP client.
2. `close()` did not abort a running turn; a closed session kept running tools. Now aborted.
3. `acceptEdits` parked a read-only code-graph query for five minutes with nobody to answer; §0 says reads and tests
   are the agent's freedom. Roles run in `auto`, reads/searches/tests are allowed tools, and a prompt parked over
   two minutes raises a needs-you alert.
4. The handoff wait polled the file and missed a turn that ended between polls; it now subscribes to run events.
5. `server.close()` waited forever on an open WebSocket in tests; `stop()` terminates clients first.
6. The relay's `%`-templating broke on CSS; a wrong second factor consumed a right first one; a second `TestClient`
   ran a second event loop. All fixed with tests.
7. The first test run after adding worktrees cut `emp/*` branches in the real checkouts (no file changes); removed,
   and tests now build temp repos.

## Spend

Own verification spend on the owner's subscription (equivalent API cost): about ₹300 across the live checks above,
inside the ₹1000/day cap the Workplace enforces on its agents.
