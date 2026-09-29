# Iris Workplace iOS — handoff (29 Sep 2026, 18:50 IST)

Branch `iris-workplace-ios`, worktree `~/jkj-ios`, app in `apps/ios/`. `make gen && make test`
(contract check + 138 unit tests), `make uitest` (18 XCUITests against `make mock`), `make shots`.
Release plumbing (icon, privacy manifest, archive/export/upload) is the release agent's, merged
from `iris-workplace-ios-release` under `release/`.

## Evening build: chat Talk, the COO bridge, General channel (29 Sep, 18:50 IST)

Merged `iris-workplace` through c18a934/797e320 (`docs/LLD-workplace.md` §18) and rebuilt against
the real shapes:

- **Talk reads as a chat.** Bubbles (owner right, employee left, tap to expand — existing
  `CompactRow`, now bubble-wrapped); a `WorkingBubble` while the session runs; date separators only
  across a >5 min gap. `ChatView.swift` ports `@jkj/shared/chat-view.ts`'s `toChatView` exactly: a
  run of 2+ tool-kind log entries collapses into one `activity` entry ("worked · N steps · Xs"), a
  lone one stays itself. Applied client-side to the live-streamed full log (not `?view=chat`), same
  as the web does, so it stays correct while a session runs.
- **"Claude — COO" card.** A virtual employee (`Employee.virtual`, `EmployeeState.online/offline`)
  living in her real unit (`product`); `OfficeStore.coo` pulls her out to show once, above the
  units, with a `PresenceDot`. Talk-to-COO is its own chat (`CooTalkView`/`CooStore`), not the
  session-based one: `GET/POST /api/coo/{log,message}`, `GET /api/coo/presence` (phone-safe now —
  normal session auth; `reply`/`items`/`answer`/`forward` stay loopback-only, no client here).
  `coo.message`/`coo.presence` handled live over the socket; presence also polled every 30 s.
- **Room's General channel is real**: `th_general` (`room.ensureGeneral`), pinned above the topic
  threads. `room.replying` (`started`/`done`/`skipped`) drives the "*name* is replying…" indicator
  for `@mentions` (`services/mentions.ts`'s rate-limited probe turn).
- **A real bug, found by a UI test, not by inspection**: tapping the COO card from a fresh Office
  screen silently opened Asha's chat instead — two `onChange(initial: true)` handlers raced (see
  the `TalkView.swift` comment at the fix). Fixed; would have hit the owner on first tap.
- Verified against the **live server** (127.0.0.1:4317, not the mock) read-only: `th_general`
  (currently auto-resolved by Asha as empty — the client renders that fine either way), the real
  `coo` employee record decodes field-for-field, `/api/coo/log` and `/api/coo/presence` return the
  real bridge transcript and heartbeat. Did not post into a real thread (budget/care, not need).
- Installed and launched on the owner's iPhone (UDID `00008140-…`) after the race fix; a later
  install attempt found the phone locked (devicectl can install but not auto-launch while locked —
  the fixed build is on the phone regardless, needs the owner to open it once, or a re-launch once
  unlocked).
- `make test`: 138/138. `make uitest`: green except one pre-existing, unrelated flake
  (`RelayUITests.testSignInThroughTheWebPageLandsOnTheOffice`, already failing before this session's
  changes — not investigated further, out of scope).

Not done this pass (owner explicitly deprioritized it — "ship the COO card plus the Talk-to-COO
chat plus the clean chat", "Room polish can follow in a second install"): the @mention picker and
avatar work in Room are in and unit-tested, but not re-verified end-to-end against the live
`room.replying` event; no new screenshots taken for the COO/chat/General screens (light+dark) —
`scripts/shots.sh` has the shot lines added (`32`–`35`) but they haven't been run since the
contract merge.

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

- `CreateWorkRequest.featureId`/`start` now decode (contract caught up, 29 Sep); the create-work
  call sites still don't pass them — Assign-under-a-feature still puts "Feature: <id>" in the brief.
- `POST /api/talk` is wired (`talkAsha`) but Talk still uses `/employees/:id/talk` with the
  `chiefOfStaff` id from the Office; switch when the lead prefers.
- `InboxItem.ownerFacing` decodes but nothing reads it yet (no client filtering needed today —
  the server already keeps non-owner-facing items off `/api/inbox`).
- Push: needs the App ID capability + a TestFlight (production) build to test for real.
- Room: the @mention picker/avatars/General-pin are in and unit-tested but not re-verified
  end-to-end against live `room.replying`; no fresh screenshots since the COO/chat-view merge
  (shots.sh lines 32–35 are ready, not run).
