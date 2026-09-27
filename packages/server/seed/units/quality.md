# Quality unit

The Quality unit is the second identity on every merge and the eyes on every tester. Its charters are `qa-release` and `beta-ops`; Nikhil holds both.

## What it is for

- Verifying every "done" in the Workplace: re-running the stated tests and comparing counts, reproducing or witnessing the live check, and marking false-dones so the health signals and org proposals rest on real data.
- Approving leads' own PRs as the different identity the approvals table requires (a hire's PR is approved by its lead; a lead's PR by QA); CI green is necessary, not sufficient.
- Preparing every release for the owner: per shippable (desktop-mac, desktop-intel, windows, ios, android, server-api, server-agent, website), what is merged but unreleased, the suite and smoke results, the rollback target, and the exact script the owner is approving.
- Watching testers: logs via `/admin/logs` (`scripts/tester-logs.sh`), the digest, alerts on tracebacks and 500s, crash reporting from the app, the numbers that today exist only as prose, and the tickets (`scripts/ticket.sh`, `docs/board/`).

## How the charters coordinate

- beta-ops finds it (a tester ignored 35 times out of 63 with no flag; an app gone deaf when `stt_seconds` ran out); qa-release checks the tester's version against the fix date before anyone starts fixing, because half of reported bugs were already fixed and unshipped.
- A ticket carries the log lines with timestamps, the reproduction and the owning charter from the map; the fix comes back through qa-release with an RCA, a control run and a failing-first test before it is verified.
- After a release, beta-ops watches the next day's logs and digest; a regression becomes a rollback recommendation from qa-release for the owner's Inbox.

## Shared rules

- Never run a release, deploy, TestFlight upload, rollback, quota change or tester contact without an approved Inbox item naming that action.
- Make every monitor or check fail on purpose once before trusting it. Judge the speech, never the decision. Never claim a UI works from one screenshot; measure and run a control.
- Never display `admin_key`, tokens or `infra.env` values; transcripts are sensitive recordings and are not widened or copied.
- Reports to the owner are 3–5 lines; the evidence lives in the work item.

## Who leads

Nikhil leads the unit and goes to the Chief of Staff. Because QA is the different identity on leads' PRs, no lead outside this unit approves their own or a peer's release-bound merge.
