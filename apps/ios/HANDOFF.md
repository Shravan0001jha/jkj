# Iris Workplace iOS — handoff (29 Sep 2026, 03:05 IST)

Branch `iris-workplace-ios`, worktree `~/jkj-ios`, app in `apps/ios/`. `make gen && make test`
(contract check + 132 unit tests), `make uitest` (15 XCUITests against `make mock`), `make shots`.
Release plumbing (icon, privacy manifest, archive/export/upload) is the release agent's, merged
from `iris-workplace-ios-release` under `release/`.

## The morning build

HEAD of this branch is the candidate. Verified tonight:
- Unit: 132 green; `scripts/check-contract.mjs` green against `packages/shared` at c71036c (D16,
  requests, proposals, releases-ready, pivot items, room, push routes).
- UI (mock, simulator): 15 green — sign-in through a web page → callback → Office; Mac-offline and
  recovery; session-ended; danger confirm; needsNote; inline approval + streamed reply; card →
  Talk → profile → charter; alert banner → Inbox item; pairing refusal (developer path); Room list
  → thread → expand → post with @mention → live reply; Spend; employee Needs-you answer in place;
  Office counts + state reason + bell sheet; Inbox who/what/details/room link.
- Screenshots checked by eye: every screen in light, dark and XXXL type (`shots/`).
- Live relay: `/login?app=1` and `/login/enrol?app=1` render in the real ASWebAuthenticationSession
  sheet (`docs/evidence/live-*.png`), cancelled without signing in; `/relay/health` reports push
  ready; `/api/push/register` answers 401 without a session (as designed).
- Lossy network (proxy: 30 % dropped requests, ≤2.5 s delay, socket killed every 15 s, 4 min):
  14 socket kills, 14 reconnects, 13 dropped requests; data kept updating; no stuck spinner. One
  bug found and fixed: a late health probe could flip a reconnected socket back to "Connection
  lost" (regression test `testASlowProbeNeverOverwritesAReconnectedSocket`).

Not verified: the phone itself (with the owner overnight; TestFlight is the delivery); a real
push end to end; a real answer on the live Inbox (never done from tests); the cookie-session
confirm page (needs a signed-in browser; same sheet, same callback).

## Known gaps / next

- `CreateWorkRequest` has no `featureId`; Assign-under-a-feature puts "Feature: <id>" in the brief.
- `POST /api/talk` is wired (`talkAsha`) but Talk still uses `/employees/:id/talk` with the
  `chiefOfStaff` id from the Office; switch when the lead prefers.
- Health `workplace.push` and `resilience` are not shown in Settings yet (contract landed late).
- Push: needs the App ID capability + a TestFlight (production) build to test for real.
