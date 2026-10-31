# Prompt for the Claude session on the owner's Mac: Workplace iOS app fixes + mini dashboard

Paste everything below the line into the Claude session on the Mac.

---

You are updating the **Iris Workplace iOS app** (SwiftUI), for the owner only. The source is the `jkj` repo (GitHub org `shravan0001jha-iris-hq`), path `apps/ios`. The newest app code is on branch `origin/coo/ios-app-polish` (last commit 06e7572, 23 Oct). Branch off it as `mac/app-fixes-nov`. Build with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`, because xcode-select points at CommandLineTools. The owner's iPhone is UDID 00008140-001E50C61487001C.

Work in this order for each item: find the root cause with evidence first, then write a failing test, then fix, then run the full test suite. Never guess. If a root cause below turns out wrong, say so and follow the evidence.

## 1. The app keeps logging the owner out (P0)

Symptom: the owner is signed out again and again. He wants to stay signed in until he signs out himself.

What the cloud COO found (verify each one):
- The app goes to `.unauthorized` on any HTTP 401 (`RestClient.swift:161,216`) and when the socket closes with code 4401 (`AppModel.swift:559`). From there `RootView` shows the sign-in screen.
- The relay's sessions (`work.irisforu.com`, per `docs/LLD-workplace.md` §Login) are "idle 12 h, max 7 d". The app's bearer token is the same session id, so a phone left alone for 12 hours, or any phone after 7 days, gets 401 or 4401, and that looks like a logout. This is the most likely root cause.
- The relay code is not on the cloud server. It was deployed from this Mac. Find it here: look for the relay app with webauthn, `/login`, `wp_session` and `4401`.

Fix:
- **Relay:** bearer (app) sessions get their own policy: a 365-day sliding expiry, renewed on use, revocable with `/logout` and `/logout-all`. Cookie (browser) sessions keep the stricter rules. Add relay tests for both policies. Deploy the relay only after the owner says yes in this window. It is his infrastructure, so ask him once and show what changes.
- **App:** a 401 or 4401 should first try one silent re-auth if the relay supports it. Otherwise show a one-tap "Sign in again" banner over the cached content, not a blank sign-in screen. Never clear the cached data on 401.
- Never treat a server that is asleep or unreachable (connection refused, 502/503/504, or socket 1013) as a logout. That means offline: keep showing cached content and the offline badge.
- Tests: 401, 4401, 1013, 503 and timeout each map to the right state, and only a confirmed-invalid session asks for sign-in.

## 2. Tapping a notification opens the wrong place (P0)

What the cloud COO found in the server (`packages/server/src/services/push.ts`) and the app (`Net/Push.swift` `AppLink.parse`):
- The summary push ("N more things need you") sends `link: 'inbox'` with no id. `AppLink.parse` returns nil for `inbox` without an id, so the tap does nothing.
- Alerts (stall, blocked, auto-merge stopped) send `link: 'office'` or `employee/<id>`, even when the event has an item. They should open `item/<itemId>`.
- Room and COO links elsewhere use the web form `#/room/<threadId>` (`services/room.ts:129`, `services/coo.ts:257`). `AppLink.parse` does not accept a leading `#/`.

Fix:
- **App:** `AppLink.parse` accepts `inbox` with no id (opens the Inbox list) and strips a leading `#/` or `/`. Unknown links open the closest parent screen, never nothing. Add a test for every link form the server sends.
- **Server:** this is the cloud side. The cloud COO will change `push.ts` so alerts with an `itemId` link to `item/<id>`, and the summary keeps `inbox`. Do not change the server from here. Just make the app robust to all the forms above.
- Check by hand: after a fresh install, send a test push of each kind, if the server exposes one, and tap each from the lock screen while the app is killed, in the background and in the foreground.

## 3. Mini dashboard tab (owner wants it in the app, data stored on the phone)

- **Contract:** `docs/HLD-dashboard.md` §5, snapshot v1 (branch `coo/dashboard` in the jkj repo). Data comes from `GET /api/metrics/snapshot` through the relay with the existing bearer. The cloud COO is building that endpoint now. Until it exists, use a fixture file with the same shape.
- **Storage:** save the last snapshot with the existing `DiskCache`. Show it instantly on open, with "updated X min ago".
- **Refresh:** automatic only, on launch, on foreground and with `BGAppRefreshTask` (register the identifier in Info.plist). No pull-to-refresh is needed. Stale data is fine, and it must never block or blank the screen.
- **UI:** a new "Dashboard" tab with two parts.
  - Features: name, committed date, forecast, a health pill (on-track, at-risk, late) and a one-line reason. Tapping a feature opens its scope checklist and date history.
  - Gaps: the top 3 causes of lost days over 30 days.
  - Keep it compact and in the app's existing style. The full sci-fi look is for the web dashboard only.
- **Tests:** decoding the v1 fixture, an unknown future field is ignored, cache round-trip, and a stale timestamp is shown.

## Delivery

- Run all unit tests, plus the new ones, and include the counts in your report.
- Build a Debug build signed for the device. Install it on the owner's iPhone only when it is plugged in and he says OK.
- Push the branch, and append a short report to `~/iris-ops/coo/mac-side-inbox.md` on the server (the usual channel). Include the root causes you found (with evidence), what changed, the test counts, the relay deploy state and the install state.
- Do not touch the owner's Iris app, his Apple account settings, or any production Iris service.
