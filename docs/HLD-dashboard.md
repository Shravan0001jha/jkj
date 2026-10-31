# HLD: Workplace dashboard (online + in-app mini view)

Owner ask, 1 Nov 2026. The goal is to see what happened and what is planned by when without asking the COO, and to find and fix the gaps in the Workplace. Metrics plan: https://claude.ai/artifact/DhtdZsTbPBJd3sErnr8X9N

## 1. What we are building

| Piece | Where it runs | Who sees it |
|---|---|---|
| Metrics engine | Workplace server (a script run hourly by a systemd timer, plus a 5-min wait-cause classifier) | none; it writes `metrics_*` tables and a snapshot |
| Snapshot | `snapshot-v1.json`: one JSON file that holds everything both UIs show | both UIs |
| Online dashboard | `dash.irisforu.com`: static site on S3 + CloudFront (OAC), auth via API Gateway HTTP API + Lambda, state in DynamoDB | the owner, on any device |
| In-app mini view | Workplace iOS app, new "Dashboard" tab | the owner |

The online dashboard cannot live on the Workplace server, because that server sleeps (`~/iris-ops/sleep`). It follows the hosting standard: serverless, inside the AWS budget.

## 2. Data flow

```
workplace.db --(hourly script)--> metrics tables --> snapshot-v1.json
     |                                                   |-- PUT s3://iris-dash-data-<acct>/snapshot-v1.json  (private bucket; only the Lambda reads it)
     |                                                   '-- GET /api/metrics/snapshot on the Workplace server (via the relay, for the app)
     '-- every 5 min: wait-cause classifier --> metrics_wait_segments
```

- The online site loads `GET /api/snapshot` from the dash Lambda. The Lambda checks the session cookie and then streams the S3 object. The snapshot is never public.
- The app calls `GET /api/metrics/snapshot` through the relay with its existing bearer session, stores the result on the phone (`DiskCache`), and refreshes it on launch, on foreground and with BGAppRefresh. When the server is asleep the app shows the cached copy and its age. There is no manual refresh.

## 3. Rule: system-recorded numbers

Every number comes from rows the server writes itself: status history (`activity` kind `status`), the PR record (`pushedAt`, approvals, `sendBack`, `merged`), `stall` events, `usage`, `inbox`, the staging deploy log, and the new records below. Agents never write a metric. The one agent-chosen value is the send-back reason, picked from a fixed list. Anything that cannot be classified is shown as `unknown`.

New system-recorded data, which is Phase 2 Workplace code:
1. `dispatch_skips` table: the dispatcher's existing in-memory skip reasons, saved to the database.
2. Feature register on the epic: `committedDate`, `scope[]` (user-visible items, each linked to story ids), and `dateHistory[]` (`{from, to, reason, approvedBy, at}`). It is written only through `POST /api/coo/feature-date`, which records the owner's approval.
3. `verifications` table: the owner marks a scope item verified on a device, from the dashboard or with a Telegram `verified <item>`.
4. Bug origin: `foundAt` (review | qa | staging | owner-device | prod), taken from the route that filed the bug, and `escapedFrom` (feature id).

## 4. Wait-cause classifier (deterministic, first match wins)

`paused/pace-hold` → `budget-cap` → `staging-down` → `review` (names the approval and the reviewer) → `dependency` → `mac-or-device` → `owner-decision` → `queued-behind-busy` → `parked` → `unknown`. Each 5-minute tick appends or extends a segment `{itemId, cause, detail, from, to}`. Backfill replays history from 27 Sep using the same rules.

## 5. Snapshot contract v1 (shared by the site and the app)

```json
{
  "version": 1,
  "generatedAt": "2026-11-01T12:00:00Z",
  "features": [{
    "id": "ep_x", "name": "Alarms & Reminders",
    "state": "in-progress | delivered | planned",
    "committedDate": "2026-11-06", "forecast": { "p50": "2026-11-06", "p90": "2026-11-08" },
    "health": "on-track | at-risk | late", "healthReason": "waiting on Mac build, 1.5 d",
    "startedAt": "...", "deliveredAt": null, "originalDate": "2026-10-31",
    "scope": [{ "label": "Repeating alarms", "status": "not-started|building|merged|staging|verified", "storyIds": [] }],
    "dateHistory": [{ "from": "...", "to": "...", "reason": "...", "approvedBy": "owner", "at": "..." }],
    "lostDays": { "review": 1.2, "mac-or-device": 1.5 },
    "escapes": 1, "costInr": 4120
  }],
  "gaps": {
    "window": "30d",
    "lostDaysByCause": [{ "cause": "review", "days": 6.5, "trend": [0.9, 1.4] }],
    "idleWhileQueuedHours": 41,
    "reviewWaitHours": { "p50": 3.1, "p90": 12 },
    "stagingSlots": { "planned": 10, "deployed": 6, "misses": [{ "at": "...", "why": "stopped" }] },
    "forecastAccuracyDays": [{ "feature": "...", "delta": 6 }],
    "ownerDecisionHours": { "p50": 2, "p90": 20 }
  },
  "unknownShare": 0.04
}
```

Each field is generated from section 3 data only. The app and the site render the same contract. The app shows features and health, plus the top 3 gap causes.

## 6. Online auth: email OTP, owner only

- `POST /api/login/start {email}`: always answers the same `{ok:true}` within a fixed time, whether or not the email is allowed. Only when the email equals `OWNER_EMAIL` (shravan0001jha@gmail.com) does it store `sha256(code)` with a 10-min TTL and 5 attempts in DynamoDB, and send the 6-digit code with SES from `noreply@irisforu.com`.
- Rate limits: 3 codes per 15 min and 10 per day, plus an attempts counter. Five wrong codes lock login for 15 min.
- `POST /api/login/verify {email, code}` → `Set-Cookie: __Host-dash=<256-bit random>; Secure; HttpOnly; SameSite=Strict`. The session row is stored hashed, has a 90-day sliding expiry, and records the device label. Log out is per device or all devices.
- Every API call checks the cookie. CSRF: non-GET calls need the `X-Dash-CSRF` header that matches a cookie.
- One DynamoDB table `iris-dash`: PK `otp#…`, `sess#…`, `rl#…`, TTL attribute on, PITR on.

## 7. Look

The look is sci-fi without hurting legibility: a dark mission-control style first, with a light theme too. Mobile first. Home is the roadmap timeline (delivered, in progress, planned). A feature opens its scope and its history. A second tab shows Workplace gaps. Details live in drill-downs, never on the home screen.

## 8. Cost (ap-south-1, verify with the Pricing API before creating anything)

- S3 and CloudFront: within the always-free tier.
- Lambda and HTTP API: under 10k requests a month, so about $0.01.
- DynamoDB on-demand plus PITR: under $0.10.
- SES: about $0.
- Total under $1 a month. October spend was $79.59 against the $110 cap.

## 9. Phases

- **P1:** metrics engine on existing data, snapshot, online dashboard and auth.
- **P2:** the new system records from §3.
- **P3:** the app's mini view and fixes. The Mac session does this from `docs/PROMPT-mac-workplace-app.md`.

Each phase is designed (LLD), then tested (TDD), then coded, in that order.
