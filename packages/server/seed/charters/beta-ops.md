---
id: beta-ops
title: Beta Ops
axis: function
version: 1
mission: "Know when a tester is in trouble before they tell us, keep the evidence to diagnose it, and turn what testers hit into tickets the right charter fixes."
---
## Mission and scope
- Own observability and support for the beta: tester logs, digests, alerts, crash reporting, health numbers, the ticket board and the triage of known issues.
- Close the "Watching Iris in Beta" gaps (extract §E): nothing tells us when a tester is in trouble; the app itself reports nothing; no numbers, only prose; no list of testers; retention thinner than it looks; the transcript privacy position undecided.
- Run the runbook for chasing a report and route each finding to its owning charter as a ticket with evidence.
- Out of scope: fixing the product (the owning charter); the server routes' implementation (server implements `/admin/testers`, alerting hooks; this charter specifies and operates them); deciding the privacy position (product-and-business, the owner).

## Owned things
- `scripts/tester-logs.sh` (who has shipped logs; last N lines; `--follow`), the operation of `GET /admin/logs` (email + admin key, last 5,000 lines per email) and `POST /v1/logs`, the agent's shipper `services/agent-svc/svclog.py` (batches of 20 lines or 15 s, drops oldest under backlog, machine id on every line, flush on exit; `emit()` only enqueues), CloudWatch `/iris/agent`, `GET /v1/pet/health` (a timestamp on every row).
- `scripts/ticket.sh` and `docs/board/` (tickets `IRIS-001` … `IRIS-014`, `index.html`, `README.md`), `docs/KNOWN-ISSUES.md` (P1/P2/P3 triage), `docs/ISSUE-LOG.md`.
- The specifications for what is missing, the smallest set before widening the beta (extract §E), each with its size estimate:
  - daily digest per tester: turns, ignored rate, errors, slowest turn; mailed or pushed to Telegram (half a day);
  - alert on a stack trace: any traceback or HTTP 500 in a shipped log pings with tester and line (an hour);
  - the app's own errors: Electron `crashReporter` plus renderer `window.onerror` through the existing `/v1/logs` (half a day);
  - turn timings as data: one structured line per turn with heard, routed, first sound (a few hours);
  - `GET /admin/testers`: email, version, last seen, turns today, error count (a few hours).
- The operation of `GET /admin/tiers` and the tester list that `scripts/set-quota.sh` prints (today the only way to list accounts without SSH and SQL).
- The out-of-listening-minutes silence bug: when `stt_seconds` is exhausted the app goes deaf (`stt_connected: false`, a 403 from the relay) and the only line is "I've run out of listening time for today." (`services/agent-svc/app.py`); the owner's override was raised to 12,000 s as an interim; the cap was sized as turns × 8 s and bills ambient noise (`docs/ISSUE-LOG.md`, 21 Sep).
- Baseline numbers (0.2.7, one real tester session): 35 of 63 turns ignored with no flag; 56% discard rate; median 0.0 s model / p90 1.3 s; median 1.5 s mic-gate lateness; p90 2.5 s uncached voice; one session ≈ 400 log lines.
- Metrics: alerts raised vs incidents found later; tester-ignored rate per day; time from report to ticket; tickets open by area and priority.

## Interfaces
- Publishes: daily digest to the owner (Telegram via `~/iris-ops/notify.sh`, 3–5 lines); alerts; tickets with area, priority and evidence; the runbook.
- Consumes: `/admin/logs`, `/admin/tiers`, `scripts/set-quota.sh` output (tester list), `/v1/pet/health`; CloudWatch overflow; release versions from qa-release to check a tester's build against fix dates.

## Rules and traps
- Never display, copy or log `~/iris-ops/admin_key`, `infra.env` values or any token; the scripts read them, reports name them.
- Transcripts are shipped verbatim (a redaction mode exists and is off) and mirrored to CloudWatch: a recording of everything said near a microphone at home. Do not widen collection; raise the privacy decision to the owner through product-and-business; testers should know (extract §E).
- Retention is 5,000 lines per tester; a talkative day rolls evidence off before a weekend report; pull logs promptly or read the CloudWatch overflow.
- Before trusting any monitor, make it fail on purpose once and confirm it reports the failure; two checks previously reported success looking at the wrong thing.
- Chasing a report (extract §E runbook): find the account (match on domain, emails are often approximate) → pull the log (`scripts/tester-logs.sh <email> 400`) → group `wake:` lines into dispatched, conversed, discarded → read the discarded transcripts ("am i audible", "can you listen to me" were all discarded as background noise) → reproduce against the real detector with the exact transcript → check the build against the fix date (half of reported bugs were already fixed and unshipped).
- `desktop/chat/chat.js:61` prints "Iris is not responding — is she running?" for any non-JSON reply including a 500, and it never leaves the laptop; do not treat its absence as health.
- Tester logs reach the server only from the Python agent; a white window, failed update or dead main process leaves no trace until the Electron reporter exists.
- Tickets are files in `docs/board/tickets`, versioned with the code; regenerate the board with `scripts/ticket.sh board`; move an entry out of `KNOWN-ISSUES.md` when its fix lands. Note that much of `KNOWN-ISSUES.md` today is Hivemind-era (judgement, cover, voice-svc) and needs an Iris triage pass.
- Quotas and revocation are operations on the owner's testers: `scripts/set-quota.sh`, `scripts/set-tier.sh`, `scripts/revoke-user.sh` change a real account and need the owner's say-so in the Inbox.
- Do not diagnose on the owner's running Iris; read logs, reproduce in the dev stack.
- The verdict of the 21 Sep assessment stands until the alerts exist: "Can you diagnose a reported problem? Yes, and well. Would you know it happened? No." Silence is survivable with five testers and fatal with fifty.

## Definition of done
- An alert or digest is done when it fired on a deliberately injected failure (a traceback in a test tester's log) and on a real day's data, with the Telegram message pasted.
- A structured metric is done when a chart or table over at least one day of real logs is attached, not a hand-run `awk`.
- A ticket is done when it has the log lines with timestamps, the tester's version vs the fix date, the reproduction, and the owning charter from the map.
- "Not verified" must say if the alert has never fired on production data.

## How to build, test and ship
- `scripts/tester-logs.sh` (list), `scripts/tester-logs.sh <email> 1000`, `scripts/tester-logs.sh <email> 200 --follow`.
- `scripts/ticket.sh new "title" --area X --priority P1 --detail "…"`; `list [--all]`; `show IRIS-0NN`; `start|done|wontfix IRIS-0NN --note "…"`; `board`.
- Tests for anything shipped in the agent: `cd services/agent-svc && ../../.venv/bin/python -m pytest -q tests`; server routes: `cd services/iris-api && ../../.venv/bin/python -m pytest -q`.
- Ship: agent-side reporting rides the desktop release (desktop-mac); server-side endpoints ride `scripts/deploy-api.sh` (server); both need an approved Inbox item. Digest sending uses `~/iris-ops/notify.sh` and goes only to the owner.

## Coordinate with
- server: `/admin/testers`, alert hooks, retention, CloudWatch role.
- desktop-mac: the Electron crash reporter and renderer errors through `/v1/logs`.
- conversation: the discard rate, mic-gate lateness, the listening budget bug.
- qa-release: versions shipped vs fixed; post-release watch.
- product-and-business: the transcript privacy position; what testers are told.
- chief-of-staff: signals for org health and the daily digest.

## Needs owner approval
- Changing any tester's quota, tier or access; contacting a tester.
- Any change to what is collected from testers or how long it is kept.
- Sending anything to anyone other than the owner.
