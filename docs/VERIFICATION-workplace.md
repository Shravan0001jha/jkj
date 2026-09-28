# Verification report — the Iris Workplace (27 Sep 2026)

Honest reporting: what was measured, what was live-verified with the real model, and what was not.
Tests are counts from `npm test` in `~/jkj` and `pytest` in `~/claude-dev-deploy/services/workplace-relay`.

## Test counts

| Suite | Count | Time |
|---|---|---|
| Workplace (`~/jkj`, `node --test` via tsx): unit + HTTP/socket integration | **99** | ~30 s |
| Relay (`workplace-relay`, pytest): behaviour + the lead's review + the independent review | **27** | ~2.5 s |

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
| Worktree isolation with a real build | Mira built `greeting.py`, the `app.py` wiring and a test in `~/iris-work/mira/claude-dev` on `emp/mira/<assignment>`; the main checkout stayed at 0 tracked changes; her employee cap paused her at the test run |
| Restart recovery | an orderly shutdown closed her session as `shutdown`; a `lost-on-restart` row becomes an Inbox question (unit-tested; no crash happened live) |
| Published at https://work.irisforu.com (23:15 IST) | relay deployed as its own user; from this Mac over the internet: no session → 302 to /login, /api → 401, login page 200, HSTS/nosniff/no-referrer, /docs 401, bad factor 401 ×5 then 429, /ws without session 403, /api/pair 401, bad JSON 400, tunnel down → mac:"offline" with the login page up, back online in seconds; api.irisforu.com/healthz 200 and iris-agent active throughout |

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
- **Passkey sign-in and the new-device Telegram ping**: need the owner's enrolment (asked on Telegram at 23:16);
  the flow is unit-tested with the WebAuthn verifier stubbed, and the ping goes through the real tunnel.
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
8. Negative DNS caching: this Mac's resolver (and the owner's phone, reported as "not working" at 23:2x) had
   cached NXDOMAIN for `work.irisforu.com` from lookups made before the record existed; public resolvers
   answered. Recovery is airplane-mode toggle / cache flush / waiting out the TTL (HOWTO). The Mac's resolver had cached NXDOMAIN for `work.irisforu.com` from before the record existed; the tunnel now
   resolves the relay with a direct DNS query (and Node's `all: true` lookup shape was wrong at first).
10. The tunnel reconnected every 45 s after publishing: the Mac's watchdog waited for pongs, but the Mac never
   pings (the relay does); any relay frame now counts as liveness. Held connected for 4+ minutes afterwards.
9. Relay: the lead's review (spoofable XFF, brute-forceable enrolment, `!=` on the secret) and the independent review
   (bearer rotation, half-dead tunnel, token in the access log, pairing via the relay, sockets outliving logout, unit
   hardening, and ten smaller items) — every point fixed with a test that failed first.

## The owner's first day on the phone (27–28 Sep): RCA per item

1. **"Asha needs you: 9" but her page was empty.** The card counted items raised by the employee; the
   page had no list. Now `EmployeeDetail.needsYou` lists every open item that concerns the employee
   (`affects`: raiser, assignee, charter holders, cap scope; the Chief of Staff always).
2. **Asha's status/handoff overwritten.** `git log` showed her files written exactly once, by a probe
   session; her real spec session had been shut down at 22:13 without any handoff (the shutdown path
   never asked). Two causes, two fixes: probe sessions (`talk({probe: true})`) get no handoff prompt
   and their status/handoff tools refuse to write; a shutdown appends a machine note with what the
   transcript shows. Her files were reconstructed from the Workplace's records (feature, spec,
   decomposition, decisions, proposal) and committed as such; the other six employees' files were
   intact.
3. **Mira showed idle while cap-paused.** The pause lived in an in-memory override lost on every
   restart; the ledger was never consulted. State now reads the ledger and says "Paused — daily budget
   reached (₹151/₹150). You can still talk to Mira." (Superseded the same night by A: the pause was
   on free usage and is lifted.)
4. **Stalled work invisible.** Four leads had planned and stopped; restarts ended the rest; nothing
   showed. `stalledSince` is derived at read time (30 min without session activity), counted on the
   Office, and the Chief of Staff's routine resumes one stalled item per tick (once a day each) or
   files one Inbox note per item saying why it waits. Live, after the batch restart, ten assignments
   were stalled (every lead had stopped on 27 Sep); the first build would have resumed one and pinged
   the owner nine times "waits for the next round", so the server was stopped before its first tick
   (00:19–00:22 IST, ~3 min offline) and items that only queue behind a resume are now not noted.
5. **Owner talk never blocked.** A talk from the owner runs at any cap, read-only on the paused work
   until "continue", which lifts the pause for the day and is written to the events table.

**A. Budget is real money only.** The ₹ figure was the SDK's list-price estimate of subscription
turns: never money. The ledger is now two: subscription usage (free; turns, tokens, equivalent ₹, the
plan's limit windows from `rate_limit_event`) and real spend (Anthropic API, AWS, third parties) with
a basis (metered / estimated / reported). The 27 Sep rows (₹502) were relabelled subscription; Mira's
pause was lifted and its Inbox item resolved with the note. AWS actuals come from Cost Explorer once a
day and supersede that day's estimates. Not live-verified: a real Cost Explorer call (the fetcher is
faked in tests; the live poller runs at 09:05 IST tomorrow).

**B. Approvals in three places** and **C. the Team Room** are unit-tested (affects, live resolution,
denial delivery; threads, mentions, owner marking, context layer, resolve with follow-ups, escalation,
moderation hand-off, the seed from the real plans). Live: the five seed threads exist after the
restart; Asha's moderation session runs on the next routine tick.

## The stray process (found by the lead, 28 Sep 00:30): RCA

**What it was.** pid 64515, `node packages/server/dist/cli.js --no-open`, started 20:50:42 IST:
the first ever Workplace server, run for the M2 smoke test right after commit 3a2fcaf (20:50). Its
one session (Asha, 20:53–20:55) and Mira's 21:03–21:08 session are in the sessions table; the
latter ends with status `shutdown` at 21:08:38, which is when this process received SIGTERM for the
21:08 restart (commit 787ce9c). **Why it stayed.** That build's `stop()` cleared its timers, stopped
the Telegram tail, closed the sessions, then awaited `server.close()`, which waits for every open
connection: a browser tab's WebSocket to the Office page was still open, so the close never
finished, `process.exit` never ran, and the process lived on with no listener (the port was free,
so the next start bound it), one accepted socket, an open database handle and nothing scheduled.
The later `pkill -f` restarts did not end it either, because its SIGTERM handler was the same hung
stop. It exited at about 00:25 when that tab's socket finally closed. **What it did after 21:08.**
Nothing: no session, Inbox item, event, spend row or Telegram command is attributable to it (its
Telegram cursor is shared and consistent with the file size; no item was ever answered via
Telegram). The batch's `stop()` already calls `closeAllConnections()`; the lock, the listen
error and the 20 s exit deadline (HLD D17) make the failure impossible to repeat silently.

## The phone through the relay (item 3; green 29 Sep)

`phone-e2e.test.ts` now runs in the suite: it boots the committed relay (`~/claude-dev-deploy/services/
workplace-relay`, its venv) on a free port, publishes a temp Workplace to it over the real tunnel,
mints a bearer session as the app's login does, and drives the Office, an Inbox answer (`via:
'phone'`, never twice), talk to an idle and to a cap-paused employee, a Team Room thread and post as
the owner, a release approved from the phone and run (202, `done` as a socket event), the socket
snapshot and an answer sent back over it, and the two refusals (pairing 403, off switch 400). The
"hang" of 28 Sep was the test itself: a failure before its try/finally left the relay child alive and
the test runner waits for children. The failure it hid was real: with `--port 0` the tunnel forwarded
to `http://127.0.0.1:0` (502), so the tunnel now takes the port actually bound (`Tunnel.setLocal`).

### Earlier note (28 Sep)

Code review of every phone path (relay `proxy` + `/ws`, tunnel `proxyHttp`/`openLocal`, routes):
answering the Inbox, talk (also to a paused employee), Team Room posts and approvals all reach the
same routes as the web, with `via: 'phone'` from the app's User-Agent. Two things only worked on
loopback or the web and are fixed in code (not yet on the live server): **`POST
/api/releases/:id/run` awaited the whole script** (minutes) while the relay drops a request after
180 s, so the phone would see a failure while the release ran on; it now answers 202 with the
`running` row and `done` arrives as `release.updated` (api.test updated). **`POST /api/relay/off`
accepted a relay-forwarded request** because it arrives on loopback; it now refuses `x-via-tunnel`
like pairing. Live verification through work.irisforu.com needs a bearer session, which only the
owner's passkey login mints; SSH to the relay host timed out from tonight's network (the security
group allows port 22 from an earlier address), so the check was written as `phone-e2e.test.ts`
against a locally booted relay and the real tunnel. Its first run hung before the first assertion;
it is opt-in until diagnosed. Not verified live: anything on the phone.

## Spend

Own verification spend on the owner's subscription (equivalent API cost): about ₹300 across the live checks above,
inside the ₹1000/day cap the Workplace enforces on its agents.
