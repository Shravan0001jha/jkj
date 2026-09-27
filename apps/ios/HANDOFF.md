# Iris Workplace iOS — handoff (28 Sep 2026, 01:05 IST)

Branch `iris-workplace-ios`, worktree `~/jkj-ios`, app in `apps/ios/`. Build: `make gen && make test`
(unit + contract check), `make uitest` (needs `make mock`), `make device` (install on the owner's
iPhone). See `README.md` and `DESIGN.md`.

## On the owner's phone right now

Commit **a26056a** (relay build, installed 23:32): sign-in through `https://work.irisforu.com`
(passkey / enrol), Office, Inbox (one-tap answers with confirm and note), Talk (streamed log,
inline approvals, interrupt), Features (board, detail, pivot), Alerts, Settings, Mac-offline and
session-ended states, LAN pairing behind Developer options. The owner had not yet enrolled a passkey
when the day ended; the sign-in screen was showing.

## Done since (this branch, HEAD), not yet on the phone

- Contract update merged (server commits through babaec5): `Employee.stateReason`,
  `WorkItem.stalledSince`, `OfficeResponse.counts`, `EmployeeDetail.needsYou`, `InboxItem.affects /
  onApprove / onDeny / links / summary / details`, `AnswerVia.workplace`, the real-money
  `SpendEntry`/`SpendSummary` with `subscription` and rate-limit windows, `RoomThread`/`RoomMessage`
  with `headline`, the `/api/room*` routes and `room.thread`/`room.message` events, `LogEntry.summary /
  details`, `OwnerLine`. `scripts/check-contract.mjs` is green against `packages/shared`.
- Screens: Office counts incl. stalled and state reasons on cards; employee page (Talk) with a
  **Needs you** section and Approve/Deny (the item's options) plus note; Inbox item shows raised by,
  affects, what approve/deny do, links (a `#/room/<id>` link opens the thread); **Team Room** tab
  (thread list with headline + one-line status, thread view with one-line messages expandable,
  post as the owner with @mentions, resolve, new thread, live updates); **Spend** sheet (real money
  by source/basis against the cap, by employee; subscription usage marked free, tokens, windows);
  Alerts moved to a bell sheet on Office (Room took its tab).
- Compact chat: `CompactText` (server `summary`/`details`, else first line) used by Talk assistant
  rows, Room messages and Inbox summaries; tap/chevron expands.
- Reliability: `NWPathMonitor` reconnects on Wi-Fi ↔ cellular / airplane; WS close 4401 → sign in
  again, 1013 → Mac offline; `/relay/health` gates the re-probe while the Mac is down; 503
  "switched off" is its own state ("Access is switched off…"); DNS/no-internet worded as such;
  `User-Agent: IrisWorkplace/<v> CFNetwork Darwin/<n>`.
- Push, app side (LLD-workplace-push §2/§6): `aps-environment` entitlement, categories WP_INBOX
  (OPEN, DECIDE) / WP_ROOM / WP_ALERT, `POST /api/push/register` on token, sign-in and every
  foreground (`env` sandbox in Debug, production otherwise), `unregister` on sign-out, `link`
  routing (`inbox/<id>`, `room/<id>`, `employee/<id>`, `office`; same as `irisworkplace://…`),
  DECIDE scrolls to the options, device-owner (Face ID/passcode) gate before dangerous options and
  approval/release/org-change/cap answers, foreground dedupe against socket alerts (60 s), local
  notifications suppressed once registered, delivered-notification cleanup + badge = open count,
  Settings "This phone gets pushes: …" line and the devices list.
- Tests: 127 unit tests (see the last run in the report; the AppModel suite needed `pathMonitor:
  nil`, fixed in the final commit). Mock server (`mock/server.mjs`) covers the room routes,
  `/login` pages, `--mac-offline`, `POST /api/_offline`, `POST /api/_reset`.

## In progress / not verified

- The new screens have **not** been screenshotted or UI-tested yet (`WorkplaceUITests` still
  reference the removed Alerts tab: `testAlertBannerOpensTheInboxItem` needs the bell sheet;
  `shots.sh` needs `WORKPLACE_ROOM`, `WORKPLACE_SPEND`, `WORKPLACE_ALERTS` entries).
- Push has not been exercised end to end (needs the relay's `/api/push/*`, the App ID's Push
  capability in the developer portal, and the release agent's `project.yml` patch merged; the
  entitlement is already `development`).
- Not tested under the Network Link Conditioner; airplane-mode toggling is covered by unit tests
  through the fake path monitor only.
- LAContext gate is unit-tested with a fake; not yet tried on the device.

## Next steps, in order

1. `make test` green → `make uitest` (fix the two UI tests above) → `make shots` → check every
   screen → `make device` (install and launch), then a Telegram note to the owner.
2. Verify on the live relay: Office counts, Needs-you answering (only a test item the server agent
   labels as such; never a real decision), Room posting, Spend, push registration.
3. Merge the release agent's `project.yml` patch (icon, privacy manifest, versioning); keep the
   `aps-environment` entitlement and the `irisworkplace` URL scheme.
4. Implement the push spec's remaining app bits when the relay ships them: `GET /api/push/devices`
   is wired; test a real push → OPEN and DECIDE → LAContext → answer.

## Blocked / needs the owner

- Passkey enrolment on the phone (Face ID + Telegram code): the owner does it himself.
- TestFlight upload: release agent; owner approval first.
