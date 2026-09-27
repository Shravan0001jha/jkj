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
