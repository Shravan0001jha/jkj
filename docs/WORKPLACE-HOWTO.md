# The Iris Workplace — how to use it

## Start it

```bash
cd ~/jkj && npm install && npm run build
npm start                 # http://127.0.0.1:4317, opens the browser
# development: npm run dev  → http://127.0.0.1:5317 (Vite, hot reload) proxies to 4317
```

Flags: `--port 4317`, `--host 127.0.0.1` (anything else needs the bearer token), `--no-open`,
`--no-telegram`, `--no-seed`. Env: `IRIS_WORKPLACE_DIR` (default `~/iris-workplace`),
`IRIS_OPS_DIR` (`~/iris-ops`), `WORKPLACE_CAP_INR` (1000), `WORKPLACE_USD_INR` (88),
`WORKPLACE_CONTEXT_TOKENS` (24000), `WORKPLACE_DIGEST_HOUR` (9, IST).

First boot copies the seed organisation into `~/iris-workplace` (its own git repo), imports the
206 requirements, files the eight open product decisions to the Inbox, and creates the API token
at `~/iris-ops/workplace/api-token` (mode 600). Agents use `~/iris-ops/workplace/claude-oauth.env`;
`ANTHROPIC_API_KEY` never reaches them.

## One line to the owner

Everything the owner reads is one line: an Inbox item's `summary`, a reply's first sentence, a Team
Room thread's `headline`, a Telegram ping. The rest is behind "details". Employees are told so in
the handbook; the server trims what still runs long. Ask "details?" or tap expand to see the rest.

## One instance

The Workplace takes `workplace.lock` (pid) next to the database. A second start against the same
organisation exits with the running pid; a start on a taken port exits; a stop that hangs exits
after 20 s. If a start says "already running" and nothing is, the pid in the file is dead and the
next start takes over.

## Where things stand (29 Sep, night shift)

Live until the coordinated cutover: the D16/D17 build of 00:46 (pid in `workplace.lock`). On the
branch, waiting for that cutover: the 202 release run and the off-switch fix; the phone contract
(requests, proposal detail, release readiness, pivot evidence, `/api/talk`); the web for all of it
and for summary/details/headline; push (`iris-workplace-push`) and Mac resilience
(`iris-workplace-resilience`, launchd agent + watchdog) merged. The phone end-to-end test runs by
default now (`test/phone-e2e.test.ts`: real relay from `~/claude-dev-deploy`, real tunnel, a bearer
session; `WORKPLACE_PHONE_E2E=0` skips it).

## The owner's requests

"New request" (Features board, or POST `/api/requests` from the phone) takes free text. The first
line becomes the feature's title, Asha is asked for the spec, and the feature carries a status the
owner can read at every stage: with Asha → specced → routed → building / review / blocked → built →
released, one line each ("2 of 3 building, 1 in review"). `POST /api/talk` talks to Asha without
picking anyone.

## Who talks to the owner

The Workplace sends only its own automatic pings: Inbox items, enrolment and sign-in codes, new-device and
security alerts, cap notices, and the daily digest. Status updates and answers to the owner's questions go
through the lead, so he never hears the same thing twice.

## The screens

- **Office** — who is working on what, what needs you, coverage of the product definition, spend
  against the ₹1000 cap. Tap an employee to talk.
- **Inbox** — every decision and approval. One tap answers. From Telegram: reply
  `approve <id>` / `reject <id>` / `answer <id> <option> <note>` / `talk <employee> <text>` / `status`.
- **Features** — the board, the pivot (by charter, platform, team), and the requirements with
  coverage per group.
- **Org** — units, employees, charters (editable), the ownership map, lint, proposals with diffs,
  history.
- **Assign** — a feature (routed by the map), or an assignment/bug/question to a charter or employee.
- **Releases** — propose per shippable; the owner approves; run executes the real script.
- **Spend & health** — spend by employee and unit, signals, stalled sessions, proposal triggers.

## State a feature once

Assign → Feature. Give the title, what it should do, the platforms, and the requirement ids it
advances. Add a spec (acceptance criteria) or ask Asha to write one (Talk). Then **Decompose**: the
ownership map picks the charters (paths, services, platforms, requirements, keywords), one
assignment each, and each assignee's session starts with its layered context and must reply with
`## Plan` first. Reports arrive with evidence; "done" only after a different identity verifies.

## Hire, split, merge, reorganise (no code changes)

Every change is a proposal: Org → Proposals, or an employee's `propose_org_change` tool, or
`POST /api/proposals`. Examples:

```json
{ "kind": "split", "reason": "The phone queue keeps growing.", "params": { "charterId": "mobile",
  "into": [ { "id": "mobile-ios", "title": "Mobile: iOS", "keys": ["ios", "ipad", "iris-mobile:mobile/ios"] },
            { "id": "mobile-android", "title": "Mobile: Android", "keys": ["android", "iris-mobile:mobile/android"] } ] } }

{ "kind": "hire", "reason": "Android needs its own lead.", "params": { "name": "Arjun", "roleId": "lead",
  "charterIds": ["mobile-android"], "reportsTo": "asha", "unitId": "platforms" } }

{ "kind": "hire", "reason": "One task.", "params": { "name": "Priya", "roleId": "engineer",
  "charterIds": ["mobile-ios"], "reportsTo": "tara" } }          // a contractor: branch priya/work in Tara's repo

{ "kind": "merge", "reason": "...", "params": { "charterIds": ["qa-release", "beta-ops"], "into": "quality" } }
{ "kind": "reassign", "reason": "...", "params": { "charterId": "character", "toEmployeeId": "mira" } }
{ "kind": "retire", "reason": "...", "params": { "employeeId": "rohan", "successorId": "tara" } }
{ "kind": "restructure", "reason": "...", "params": { "units": [{ "id": "growth", "title": "Growth", "parentId": "product", "kind": "chapter" }],
  "moves": [{ "employeeId": "dev", "chapterIds": ["growth"] }] } }
```

The proposal shows the diff of the org files and the lint of the result; the owner approves it in
the Inbox; the files are written and committed (`git log` in `~/iris-workplace`). Routing and each
employee's context change on the next spawn. Hires cannot hire (no level 3).

To edit a charter by hand: Org → charter → edit, or edit `~/iris-workplace/charters/<id>.md` and
commit. The map is `map.yaml`; the org is `org.yaml`; roles are `roles.yaml`.

## Money, and what is free

Sessions run on the Claude subscription, which is **free**: the Office shows it as "Subscription usage
(free)" (turns, tokens, the list-price equivalent, and the plan's own five-hour / seven-day limits as
the SDK reports them). The **₹1000/day cap counts real money only**: Anthropic API calls on a key
(Iris's llm-gateway during tests), AWS work employees trigger (a release ≈ ₹2, a deploy ≈ ₹1,
estimated until the daily Cost Explorer actual replaces them), and paid third-party APIs, recorded by
the session with `record_spend`. A cap pauses paid actions and unattended work only; talking to any
employee always works, and "go ahead and continue" in that talk lifts the pause for the day (audited).

## Approvals, everywhere

Every Inbox item shows in the Inbox, on Asha's page, and on the page of each employee it concerns
(raiser, assignee, charter holders), with its options and a note; answering in one place resolves it
everywhere. A denial reaches the raiser: into its open session, or into its handoff for the next one.

## The Team Room

Cross-team work (an interface, a contract, a handoff, an ownership conflict) is a thread in the Team
Room (`#/room`), not an edit outside one's charter. Employees post with `room_post` and @mentions;
Asha moderates: assigns follow-ups, resolves with a summary, and escalates to you only what the
approvals table reserves for you (an Inbox item linked to the thread). You can read and comment
anytime; your messages are marked as yours.

## Stalled work

An assignment with no session activity for 30 minutes (`WORKPLACE_STALL_MINUTES`) is stalled: it shows
on the card and in the Office counts. Every five minutes Asha's routine resumes one (once a day per
item) or leaves one Inbox note saying why it waits ("Resume it now" starts it regardless). Items
that only wait for a later tick's slot are not noted.

## Approvals, caps, releases

Outward actions (release, deploy, TestFlight, store, external messages, deleting data, spending
above the cap, permanent hires, org changes) only happen through an approved Inbox item. The
release/deploy scripts are the real ones (`scripts/release-iris.sh`, `scripts/deploy-api.sh` from
`~/claude-dev-deploy`, ...) and refuse to run otherwise. At a cap (employee, unit, company) sessions
pause and a `cap` item asks whether to raise today's cap.

## From anywhere: https://work.irisforu.com

The Workplace on this Mac keeps an outbound tunnel to a small relay on the Iris API box; nothing
listens on the Mac. The relay proxies only an authenticated session. Sign in with your **passkey**
(Face ID on the iPhone); enrol it once at `/login/enrol` with a Telegram code. Fallback: an email
code **and** a Telegram code. Sessions expire after 12 h idle / 7 days; every new device pings
Telegram. **Emergency off:** reply `off` on Telegram, or `curl -X POST http://127.0.0.1:4317/api/relay/off`
on this Mac: the tunnel drops and every remote session is gone until the Workplace is restarted.
Files: `~/iris-ops/workplace/relay.env` (this Mac: `RELAY_URL`, `TUNNEL_SECRET`) and
`relay-server.env` (copied to the box by `~/claude-dev-deploy/scripts/deploy-workplace-relay.sh`).
The iOS app signs in through the same page and keeps a bearer session in the Keychain.

**If the name does not resolve on a device** ("not working" while the relay is up): a resolver that
looked the name up before the record existed caches the negative answer, up to the zone's SOA minimum
(irisforu.com: 86400 s; Route 53 caps it at 900 s, some resolvers hold longer). To recover: toggle
airplane mode on the phone, or flush the Mac's cache (`sudo dscacheutil -flushcache; sudo killall -HUP
mDNSResponder`), or wait. New hostnames: create the DNS record before anything looks the name up. The
Mac-side tunnel is immune: it resolves the relay with a direct DNS query and falls back to the OS.

## The phone on the LAN (development only)

`--host <lan or tailnet ip>` adds a token-protected listener; pair the app with `POST /api/pair`
from this Mac (a six-digit code the app exchanges within five minutes). Off by default.

## GitHub Apps (the lead creates them)

Put each App's `<slug>.json` (`appId`, `installationId`, `org`, `repos`) and `<slug>.pem` (mode 600)
under `~/iris-ops/workplace/apps/`. The Workplace mints installation tokens and does PR plumbing;
it never shows a key or a token. The list of Apps, repos and permissions is `docs/LLD-workplace.md`
§12.

## Keeping it up when nobody is at the Mac

The Workplace runs as a launchd user agent (`~/Library/LaunchAgents/com.irisforu.workplace.plist`):
it starts at login, restarts if it dies, keeps the Mac awake for as long as it runs
(`caffeinate -i -s`, the display may sleep), and logs to `~/Library/Logs/IrisWorkplace/` (rotated).
Only one copy runs (`workplace.lock`); a manual `npm start` and the agent cannot coexist.

```bash
scripts/workplace-service.sh status      # launchd, process, lock, caffeinate, /api/health, log tail
scripts/workplace-service.sh logs -f
scripts/workplace-service.sh restart     # launchd starts it again at once
scripts/workplace-service.sh install     # (re)render and load;  uninstall = unload and remove
```

If the tunnel to the relay is down for more than five minutes, or the process keeps restarting,
one Telegram ping arrives and one more when it is back. `/api/health` → `resilience` shows the
last tunnel connect, uptime and the restart count. Settings the owner must keep (we change none):
`docs/RESILIENCE-workplace.md` §6 — lid open, plugged in, "Prevent automatic sleeping on power
adapter" on, automatic macOS updates off; after a reboot someone must log in (FileVault).
