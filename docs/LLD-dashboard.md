# LLD: Workplace dashboard, Phase 1

Builds on `HLD-dashboard.md`. Phase 1 uses only data recorded today. Phase 2 adds the new system records listed in HLD §3.

## 1. Modules (packages/server)

| File | Role | Pure? |
|---|---|---|
| `src/services/metrics/rows.ts` | Reads `workplace.db` read-only into plain rows: epics, stories, status transitions, merges, stalls, Inbox items, usage per story. | no (I/O) |
| `src/services/metrics/timeline.ts` | `storyTimeline(transitions)`: the story's status segments `{status, from, to}`. | yes |
| `src/services/metrics/causes.ts` | `waitCause(segment, ctx)`: the first-match rules from HLD §4, run over history. | yes |
| `src/services/metrics/forecast.ts` | `forecast(remaining, cycleDaysSample, people, fixedDays, now)`: returns `{p50, p90}`. | yes |
| `src/services/metrics/snapshot.ts` | `buildSnapshot(rows, now, opts)`: the v1 contract. | yes |
| `src/metrics-cli.ts` | Writes `~/iris-workplace/metrics/snapshot-v1.json` atomically (tmp then rename). With `--upload`, also runs `aws s3 cp` to the dash data bucket. | no |
| `http/routes.ts` | `GET /api/metrics/snapshot`: serves that file (owner session or bearer). 404 `{error}` when the file is missing. | no |

A systemd user timer, `iris-metrics.timer`, runs the CLI hourly at :07 with `--upload`. It is a oneshot and never keeps the box awake on its own: the sleep checker sees a 20-second job.

## 2. Definitions (Phase 1)

- **Feature:** an epic (`work.level='epic'`). Its stories are the rows whose `parent_id` is the epic.
- **Committed date:** `epic.targetDate`. **Original date:** the first `targetDate` in the epic's `activity` `field` changes, or `targetDate` itself when there are none.
- **State:**
  - `delivered` if `epic.status = 'done'`, with `deliveredAt` = the epic's `statusSince`.
  - `planned` if no story has ever been in progress.
  - `in-progress` otherwise.
- **Story status timeline:** from `activity` rows with kind `status`, ordered by `at`. Segment `i` runs from row `i` to row `i+1`, and the last segment runs to `now`.
- **Building time:** time in `in-progress`. **Waiting time:** time in `ready`, `in-review`, `blocked`, `waiting` or `parked` once the story has started. `backlog` before the first start does not count.
- **Send-back:** a transition from `in-review` to `in-progress`.
- **Escapes (Phase 1 proxy):** stories in the epic whose title starts with `Bug` or contains `bug` and were created after the epic's first story reached done. This is marked as a proxy until `foundAt` exists.
- **Cost:** the sum of `usage.equivalent_inr` over sessions whose `assignment_id` is a story in the epic.

## 3. Wait-cause rules (Phase 1, from history only)

For each waiting segment, the first matching rule wins:

1. `paused/pace-hold`: the segment overlaps a `pace`/`floor` stall (activity kind `stall` with text matching `/pace cap|paused/i`, or a stall event with `itemId` `weekly-pace`).
2. `budget-cap`: overlaps a `daily-spend-cap` or `GitHub` cap stall.
3. `staging-down`: overlaps a span where `staging-follow-trunk.log` says `staging not running` or `deferred`.
4. `review`: the status is `in-review`. The detail says `approval 1`, or `approval 2` if a `devApproval` happened inside the segment.
5. `dependency`: the status is `blocked` or `waiting`, and the story's `startsAfter` (or an earlier blocked note) names another item.
6. `mac-or-device`: the status is `blocked`/`waiting`, and the segment's activity text matches `/\bMac\b|device|iPhone|real phone/i`.
7. `owner-decision`: an Inbox item raised during the segment references the story or its epic and was answered after the segment started.
8. `queued-behind-busy`: the status is `ready`, and the assignee had another story `in-progress` for over 50% of the segment.
9. `parked`: the status is `parked`.
10. `unknown`: none of the above.

Rules 6 and 7 read agent-written text only to choose a category. No number comes from it, and anything that doesn't match becomes `unknown`. Phase 2 replaces both with the system records.

## 4. Forecast

- `remaining`: the number of the epic's stories not done or rejected.
- `cycleDaysSample`: the days from first `in-progress` to done, for that epic's charter, over the last 14 days. If there are fewer than 5, use all charters.
- `people`: how many distinct assignees moved one of the epic's stories in the last 7 days. Minimum 1.
- `p50 = now + ceil(remaining × median / people) + fixedDays`. `p90` uses the 90th-percentile cycle time instead of the median.
- `fixedDays` = 2: the staging batch, the CTO journey and the owner's device check, from the 6 Nov plan.
- **Health:**
  - `delivered`: done.
  - `late`: `now > committedDate`.
  - `at-risk`: `p50 > committedDate`.
  - `on-track`: otherwise.
- `healthReason` is the cause with the most open waiting time right now, written as a template: `waiting on <cause>, <d> d`.

## 5. Online dashboard (infra/dash)

```
infra/dash/site/index.html        single page, inline CSS/JS, renders snapshot v1
infra/dash/lambda/index.mjs       routes: POST /api/login/start, POST /api/login/verify, POST /api/logout, GET /api/snapshot, GET /api/me
infra/dash/lambda/auth.mjs        OTP + session logic (pure, injected store/clock/mail)
infra/dash/test/*.test.mjs        node:test, with a fake store, clock and mailer
infra/dash/deploy.sh              idempotent AWS CLI: S3 buckets, CloudFront+OAC, ACM cert (us-east-1), Route53 alias, DynamoDB (TTL, PITR), Lambda, HTTP API, IAM
```

- **CloudFront:** two origins. The default behaviour is S3 (site). `/api/*` goes to the HTTP API with caching disabled, and the viewer's cookies and headers are forwarded.
- **Lambda environment:** `OWNER_EMAIL`, `TABLE`, `DATA_BUCKET`, `MAIL_FROM=noreply@irisforu.com`. IAM allows only the table, `s3:GetObject` on the one snapshot key, and `ses:SendEmail` from irisforu.com.
- **Constant-time response:** `login/start` always waits until 600 ms have passed since the request before answering `{ok:true}`.
- **Codes:** 6-digit codes from `crypto.randomInt`. Only `sha256(code + email)` is stored.

## 6. Server push link fix (cloud side of the app fix)

In `push.ts`, an alert whose event has an `itemId` links to `item/<itemId>`. Otherwise it keeps the employee or office link. The summary keeps `inbox`. Tests are in `push.test.ts`.
