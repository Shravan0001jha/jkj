# LLD: push notifications for the Iris Workplace phone app

Status: spec, 28 Sep 2026. Server side (`~/jkj`, branch `iris-workplace-push`) and relay side
(`services/workplace-relay/`) are built against this document; the iOS app implements §2 and §6.

## 0. Why and what

The owner wants to leave the laptop and run the Workplace from the phone. The socket feed of `alert`
events (LLD-workplace §14) only reaches the app while iOS keeps the socket alive (minutes after
backgrounding). What needs him while the app is closed must arrive as an APNs push.

Three pieces, none of which changes iris-api:

| Piece | Where | Does |
|---|---|---|
| **Push intents** | Workplace server on the Mac, `services/push.ts` | Decides *what* pushes (§3), builds a short safe payload (§4), sends it as one tunnel frame |
| **Delivery** | Relay on the API box, `push.py` + `store.py` | Holds device tokens per signed-in app session, signs the APNs JWT with the team's `.p8`, POSTs over HTTP/2, drops dead tokens |
| **Registration and display** | iOS app | Registers its token through the relay, shows the push, deep-links, confirms actions in the app with Face ID |

The Mac never holds device tokens or the APNs key; the relay never sees Workplace content beyond the
one-liners it forwards.

```
Mac: alert / room.message ──push.ts──▶ tunnel frame {type:"push"} ──▶ relay ──HTTP/2 + ES256 JWT──▶ APNs ──▶ iPhone
iPhone: POST /api/push/register {token, env} ──bearer──▶ relay (answers itself; never proxied)
```

## 1. Vocabulary

- **Device token**: the 32-byte hex string iOS gives `didRegisterForRemoteNotificationsWithDeviceToken`.
  It is *not* secret in the sense of a credential (only the topic's key can push to it), but it is
  never logged, never shown on a page and never sent to the Mac.
- **env**: `sandbox` for builds run from Xcode (a development provisioning profile,
  `aps-environment = development`), `production` for TestFlight and the App Store. Apple keeps the two
  apart: a token only works against its own host, so the app must say which one it is.
- **App session**: the relay's `bearer` session the app got from `irisworkplace://auth#token=…`
  (LLD-workplace §17). Every registration is owned by one app session.

## 2. Registration (app ↔ relay)

All under the relay's own `/api/push/*`, answered by the relay, **never proxied** to the Mac (like
`/api/pair*`). Bearer sessions only; a cookie (browser) session gets 403. Errors are `{ error }`.

| Method & path | Body → Response | When the app calls it |
|---|---|---|
| `POST /api/push/register` | `{ token: hex, env: "sandbox" \| "production", device?: string }` → `{ ok: true, devices: n }` | Every launch and every foreground after `didRegisterForRemoteNotificationsWithDeviceToken` (the token can change), and again right after sign-in |
| `POST /api/push/unregister` | `{ token }` → `{ ok: true }` | Sign-out from the app (best effort; the relay also drops it with the session) |
| `GET /api/push/devices` | → `{ devices: [{ env, device, created, lastSeen, thisDevice }] }` | Settings screen; tokens are never returned |

Rules:
- `token` must be 64 hex characters (case-insensitive; stored lower-case); `env` must be one of the two;
  `device` is a free label ≤ 60 chars (e.g. "iPhone 16"), not a name or a number that identifies a
  person.
- One row per token. Registering a token that another session already holds **moves** it to the
  calling session (the phone signed in again). Re-registering the same token refreshes `last_seen`.
- Deleting a session (sign-out, sign-out-everywhere, idle/max expiry, the `off` switch) deletes its
  tokens. A device that is not signed in cannot receive pushes. This is the property that makes a
  stolen phone stop ringing after `logout-all`.
- Registration goes through the same rate limits and audit as every other mutating request
  (`audit.kind = "push:register"`).

## 3. Which events push (Mac side)

`push.ts` subscribes to the Workplace event bus like `telegram.ts` does. It pushes for:

| Trigger | Condition | Push |
|---|---|---|
| Inbox item needing the owner | `alert` with `inboxId` (every `inbox.raise`) | title = item title, body = one safe line (§4), link `inbox/<id>` |
| Alert at warn or above | `alert` with level `needs-you`, `blocked` or `cap` and no `inboxId` (a parked tool approval, a stall, a cap hit, a failed release) | title = alert title, body = alert body scrubbed (§4), link `office` or `employee/<id>` |
| Team Room @mention of the owner | `room.message` whose text contains `@owner` (or a handle from `WORKPLACE_OWNER_HANDLES`, default `owner,shravan`, case-insensitive), not posted by the owner | title = `<Employee> mentioned you in "<thread title>"`, body = the message's first line, link `room/<threadId>` |

It never pushes for `info` alerts, for `room.message` without an owner mention, for the owner's own
messages, for `inbox.updated` (answered items), or for anything while `config.push` is off
(`--no-push`, `WORKPLACE_PUSH=0`; tests run with it off). The daily digest stays on Telegram.

### Collapse and dedupe

- `collapseId` = `inbox:<inboxId>` for Inbox items, `room:<threadId>` for mentions,
  `alert:<slug of title>` otherwise. It becomes `apns-collapse-id`, so iOS shows one notification per
  subject and replaces it on repeat rather than stacking.
- `inbox.raise` with a `dedupeKey` returns the open item without emitting, so a re-raised item does not
  push twice; on top of that `push.ts` remembers the last 500 collapse ids with their time and drops a
  repeat within 10 minutes unless the title changed.
- `threadId` (the APNs `thread-id`, which groups notifications in the Notification Center) is `inbox`,
  `alerts` or `room`.

### Quiet behaviour

- **Burst cap.** At most 6 pushes per minute. Beyond that, one summary push per minute
  (`collapseId = summary`, title "N more things need you", body "Open the Inbox", link `inbox`)
  replaces the individual ones.
- **Nothing while the Mac is offline.** If the tunnel is not connected the intent is dropped, not queued:
  a stale push on reconnect would say "needs you" for something already handled. The Inbox is the
  source of truth when the app opens.
- **No quiet hours** by default. The owner asked to be reached; `WORKPLACE_PUSH_QUIET=23-07` (IST) is
  available and, when set, holds `needs-you` pushes but still sends `cap` and `blocked`.
- **Interruption levels.** `cap` and `blocked` → `time-sensitive`; `needs-you` and mentions → `active`.
  Nothing is `critical` (that needs an Apple entitlement and would bypass Focus).
- iOS itself suppresses the banner when the app is in the foreground and shows the alert from the
  socket instead; the app must not present a second local notification for a push it also saw on the
  socket (§6).

## 4. Payload (what actually leaves the Mac)

A `push` frame Mac → relay:

```json
{ "type": "push", "id": "<random>", "title": "Release 0.2.16 needs your approval",
  "body": "Approval · from Nikhil", "collapseId": "inbox:in_8f2k", "threadId": "inbox",
  "level": "needs-you", "category": "WP_INBOX",
  "data": { "link": "inbox/in_8f2k", "inboxId": "in_8f2k" } }
```

The relay turns it into this APNs body, for every registered device:

```json
{ "aps": { "alert": { "title": "…", "body": "…" }, "sound": "default", "thread-id": "inbox",
           "category": "WP_INBOX", "interruption-level": "active", "mutable-content": 0 },
  "link": "inbox/in_8f2k", "inboxId": "in_8f2k", "level": "needs-you" }
```

Headers: `apns-topic: com.irisforu.workplace`, `apns-push-type: alert`, `apns-priority: 10`,
`apns-collapse-id: <collapseId>`, `apns-expiration: now + 6 h` (a push older than that is stale).

Content rules, enforced on the Mac (`tests: push.test.ts`) before anything reaches the relay:
- `title` ≤ 80 chars, `body` ≤ 120 chars, both single-line; longer is cut with "…".
- **Bodies never carry secrets or long content.** For Inbox items the body is derived, not copied:
  `"<Kind> · from <raiser>"` (e.g. "Decision · from Asha"), not the item's text. Alert bodies are
  scrubbed: a body that matches a secret shape (`sk-`, `ghp_`, `AKIA`, `token=`, `password`,
  `Bearer `, a 32+ char hex or base64 run) is replaced by "Open the app for details"; the parked tool
  approval alert (whose body quotes tool input) always gets "Open the employee page to allow or deny."
- `data` holds ids and the link only: `link`, `inboxId?`, `threadId?`, `employeeId?`, `level`. No
  options, no bodies, no tokens.
- `category` is `WP_INBOX` for Inbox items, `WP_ROOM` for mentions, `WP_ALERT` otherwise.

Deep links (`link`, the app opens the matching screen): `inbox` · `inbox/<id>` · `room/<threadId>` ·
`employee/<id>` · `office`. In URL form: `irisworkplace://<link>`.

### Actions (categories) — security

- `WP_INBOX`: **Open** (foreground) and **Decide…** (foreground). Both open the app on the item.
  There is **no** Approve or Deny button on the lock screen: approving a release or a spend from a
  notification without unlocking is exactly the blind approval the brief §0 rules out. The app
  answers through the existing `POST /api/inbox/:id/answer` with its bearer session after a
  `LocalAuthentication` (Face ID / passcode) check for options marked `danger` or of kind
  `approval` / `release` / `org-change` / `cap`; the server has no "answer from a push" route, and the
  relay never accepts an answer of its own.
- `WP_ROOM`: **Open** only. Replying is done in the app.
- `WP_ALERT`: **Open** only.

## 5. Sandbox versus production

- The app registers with `env: "sandbox"` when built with a development profile (`#if DEBUG`, or
  better: read `aps-environment` from the embedded provisioning profile) and `"production"` for
  TestFlight / App Store. One phone can hold two registrations (a dev build and a TestFlight build)
  with different tokens; both get every push.
- The relay talks to `api.sandbox.push.apple.com` or `api.push.apple.com` by the row's `env`. Same
  `.p8` key (the team's token-based key, key id in `~/iris-ops/mobile/apns.env`, already used by
  iris-api for `com.irisforu.iris`), topic `com.irisforu.workplace`.
- A token registered under the wrong env comes back `400 BadDeviceToken` and is dropped (§7); the app's
  next launch re-registers with the right one, so a wrong guess costs one launch, not a support
  session.
- The relay needs, on the box: `/opt/workplace-relay/apns-key.p8` (mode 640, group
  `workplace-relay`; copied by `deploy-workplace-relay.sh` from `~/iris-ops/mobile/`) and in
  `/opt/workplace-relay/.env`: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_FILE`, `APNS_TOPIC`. Without
  them the relay answers registrations but reports `push: "unconfigured"` on `/relay/health` and the
  Mac logs a warning once.

## 6. iOS app side (for the iOS agent)

1. Add the Push Notifications capability (`aps-environment` in the entitlements) for
   `com.irisforu.workplace`, team M9YV87TCT9. The App ID needs the Push capability in the developer
   portal; the `.p8` key is team-wide and already exists.
2. On launch after sign-in: `registerForRemoteNotifications()`; on the token callback,
   `POST /api/push/register` with the hex token and env. Repeat on every foreground (cheap; the relay
   only refreshes `last_seen`). On sign-out, `POST /api/push/unregister` then drop the session.
3. Register the categories `WP_INBOX` (actions `OPEN`, `DECIDE`, both `.foreground`), `WP_ROOM`
   (`OPEN`), `WP_ALERT` (`OPEN`). No destructive or background actions.
4. Tapping a notification or an action opens `userInfo.link` (same routes as `irisworkplace://…`).
   `DECIDE` opens the item with the options sheet already up; the answer for a dangerous option or an
   approval-type kind is gated by `LAContext.evaluatePolicy(.deviceOwnerAuthentication)`.
5. Foreground: `willPresent` returns `[]` for pushes that carry an `inboxId`/`threadId` the socket
   already showed in the last minute (the app keeps the socket's `alert`s); otherwise `[.banner, .sound]`.
   The app must not raise a `LocalNotifier` notification for an alert that also came as a push: keep
   `LocalNotifier` only while registration has not succeeded (no token yet, or the relay said no).
6. Housekeeping: on foreground, remove delivered notifications whose `inboxId` is no longer open
   (`GET /api/inbox`), and set the badge to the open Inbox count. Also clear the notification for an
   item the moment the app answers it.
7. Settings shows the devices from `GET /api/push/devices` and a "This phone gets pushes: yes / no,
   reason" line (permission denied, not registered, relay unconfigured).

## 7. Delivery and token invalidation (relay side)

`push.py` (the pattern of iris-api's `apns.py`, not a copy of its tokens):

- ES256 JWT `{ alg: ES256, kid }` / `{ iss: team, iat }` signed with the `.p8`, cached and reused for
  50 minutes, re-signed on `403 ExpiredProviderToken` and retried once.
- One `httpx.Client(http2=True)` per environment, kept open (APNs wants long-lived connections).
- For each registered device: POST; on `200` → `last_seen` updated. On `410`, or on a reason in
  `BadDeviceToken`, `Unregistered`, `DeviceTokenNotForTopic` → the row is deleted and audited
  (`push:gone`). On `429`, `5xx` or a network error → logged, the row stays; there is no retry queue
  (the next event will push again, and the Inbox is the truth).
- Results go back to the Mac as `{ "type": "push-result", "id", "sent", "dropped", "failed" }` for its
  log and health line (`GET /api/health` → `push: { devices, lastSent }` from the last result).
- Sends run in a worker thread so the relay's event loop never waits on Apple; frames are handled in
  order per device.
- A push to zero devices is a no-op and is not an error.

### Store

```sql
create table if not exists push_devices (
  token text primary key,        -- 64 hex, lower-case; never logged
  env text not null,             -- sandbox | production
  session_hash text not null,    -- sessions.id (the token hash); rows go when the session goes
  device text,                   -- "iPhone 16" — a label, not an identity
  created integer not null,
  last_seen integer not null
);
```

`delete_session` / `delete_all_sessions` delete the matching rows (same hook that closes live
sockets); `touch_session` expiry does the same because it calls `delete_session`.

### Health

`GET /relay/health` gains `"push": "ready" | "unconfigured"`; on loopback also `"devices": n`.

## 8. Tunnel protocol additions (LLD-workplace §17 table)

| Frame | Direction | Fields |
|---|---|---|
| `push` | Mac → relay | `id, title, body, collapseId, threadId, level, category, data` |
| `push-result` | relay → Mac | `id, sent, dropped, failed` |

Unknown frames are ignored by both ends already, so an old relay with a new Mac (or the reverse) is
harmless: pushes just do not go out until both are deployed.

## 9. Tests (fail first)

Mac (`packages/server/test/push.test.ts`, node:test): an Inbox item becomes exactly one `push` frame
with a derived body and `inbox/<id>` link; an `info` alert does not; a `blocked` alert does; a tool
approval alert gets the generic body; a secret-shaped body is scrubbed; an owner @mention pushes with
`room/<threadId>`, an employee-only mention does not, the owner's own message does not; a repeat
collapse id within 10 min is dropped; the seventh push in a minute becomes a summary; nothing is sent
while the tunnel is offline; `--no-push` sends nothing.

Relay (`test_relay_push.py`, pytest with a fake APNs `post`): register needs a bearer session and a
valid token/env; a cookie session gets 403; the token moves between sessions; unregister works;
`logout-all` drops the tokens; a `push` frame from the Mac becomes one APNs POST per device with the
right host, topic, headers and body and a JWT that verifies against the key; `410` deletes the row;
`429` keeps it; `ExpiredProviderToken` re-signs once; the Mac receives `push-result`; `/api/push/*` is
never forwarded through the tunnel; tokens never appear in audit rows or health.

## 10. Config summary

Mac: `WORKPLACE_PUSH` (default on when a tunnel exists), `--no-push`, `WORKPLACE_OWNER_HANDLES`
(`owner,shravan`), `WORKPLACE_PUSH_QUIET` (unset).
Relay `.env`: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_FILE=/opt/workplace-relay/apns-key.p8`,
`APNS_TOPIC=com.irisforu.workplace`. Relay `requirements.txt` adds `h2` (HTTP/2 for httpx); `cryptography`
is already there via `webauthn`.
