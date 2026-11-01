# Chat notifications, mute and chat profile: server/app contract (1 Nov)

Owner request (1 Nov): "I want the Claude COO's text messages to be notified, actually all of the chats should
have option to mute/unmute notification, like a profile is there in Telegram, with details about the bot, and
docs, links and images that were shared. That notification should bring me directly to the chat of the person.
The notification should be like a Telegram message with text in the notification (however general messaging
apps handle it)."

Split: the server (jkj `packages/server`, cloud COO) decides and sends pushes; the app (jkj `apps/ios`, Mac
session) shows them, routes taps, and owns the mute switch and profile UI. The relay
(`services/workplace-relay`) forwards them; it needs one small change (body length), deployed only on the
owner's OK.

## 1. Chat push (server)

On every new message in a chat the owner is part of, sent by someone other than the owner:
- **Which chats:** the COO thread (`/api/coo/log`), every Talk thread (`/api/talk/threads`), and rooms.
- **Not sent:**
  - when the thread is muted (section 2);
  - for the owner's own messages;
  - for system or log lines that are not chat text (tool calls, status rows).

Push intent fields (`push.ts` `PushIntent`):

| field | value |
|---|---|
| title | the sender's display name (`Asha`, `Claude — COO`). For a room: `Asha · <room name>` (TITLE_MAX 80) |
| body | the message text through `scrub()`: whitespace collapsed, cut at 1000 chars with `…` (iOS shows ~2-4 lines in the banner and the full text when expanded, like Telegram). Attachment only: `📷 Photo`, `📄 <file name>`, `🎤 Voice message`. Text plus attachment: the text. |
| threadId (APNs thread-id) | `chat:<threadId>`, so iOS groups each chat's messages into one stack. The COO thread uses `chat:coo`. 32-char relay cap: hash longer ids, deterministically. |
| category | `WP_CHAT` |
| collapseId | `chat:<messageId>`: one notification per message, like Telegram. Never deduped against other messages. |
| level | `info` (normal sound, not critical, not a ring) |
| data | `{ link: 'chat/<threadId>', threadId: '<threadId>', employeeId?: '<sender employee id>' }`. COO: `{ link: 'chat/coo', threadId: 'coo' }`. Rooms: `{ link: 'room/<roomThreadId>', threadId }`. |

**Rate limiting:**
- Chat pushes do not count against the Inbox budget or summary (`seen` / `suppressed` in push.ts).
- More than 4 messages from one thread within 60 s are coalesced: the 5th onward become one push per minute, `"<N> new messages"` with the same thread-id.

**Badge:** unchanged. The app badge stays "things that need you"; chat unread is shown in the app.

## 2. Per-chat mute (server stores it, the app edits it)

```
GET  /api/chats/prefs                 -> { "<threadId>": { "muted": bool, "mutedUntil": iso|null } , ... }
PUT  /api/chats/<threadId>/prefs      body { "muted": bool, "mutedUntil": iso|null }  -> the saved pref
socket event { type: "chat.prefs", threadId, muted, mutedUntil }   (so every device updates)
```
- `threadId` is `coo` for the COO thread; otherwise the Talk/room thread id.
- **Defaults, when nothing is stored:** the COO thread and 1:1 Talk threads are unmuted; rooms are muted. The owner can change any of them.
- `mutedUntil` in the past means unmuted. The app offers: 1 hour, 8 hours, 1 day, Forever, Unmute.
- Persist in the Workplace DB. Owner-only, the same auth as the other `/api` routes through the relay.

## 3. Chat profile (Telegram-style "info" screen)

The app builds it from existing data plus one new server route:
- **Header:** avatar, name, role. From `GET /api/employees/:id`: role, charter or areas, reports-to, model, state or presence. COO: from `/api/coo/presence` plus a static description.
- **Actions:** Mute/Unmute (section 2); Search in chat (local).
- **Shared media**, three tabs: Media (images), Files (documents), Links (URLs found in message text). New route:
  ```
  GET /api/chats/<threadId>/shared?kind=media|files|links&before=<cursor>
  -> { items: [ { kind, messageId, at, url|attachmentId, name?, mime?, size?, thumbUrl? } ], next: cursor|null }
  ```
  Covers the whole thread history, not just the loaded page. Attachments are served by the existing
  `GET /api/talk/attachments/:id`. **Until this route ships,** the app derives the lists from the messages it
  has loaded and shows "Showing recent".

## 4. Relay (small change, needs the owner's OK to deploy)

- `push.py` BODY_MAX 120 → 1000 for category `WP_CHAT` only (APNs payload limit is 4 KB; 1000 chars of UTF-8 plus the rest fits); other categories stay at 120.
- Add `"mutable-content": 0` as it is now. No Notification Service Extension: avoids an App ID or extension change.

## 5. App behaviour

- **Tap:** `chat/<threadId>`, `chat/coo` and `room/<id>` open that chat directly, from killed, background or foreground. This uses the existing `AppLink` resolve and the queued-tap path.
- **Foreground:**
  - If that chat is the one on screen: no banner, a light haptic, and the message appears live.
  - If another chat or screen is open: a banner, as iOS presents it (`willPresent` returns `.banner, .sound, .list`).
- **Muted chats:** the server sends nothing. The app also drops any stray push for a muted thread in `willPresent`.
- **Grouping and privacy:** iOS groups by thread-id. Lock-screen privacy follows the iOS setting (Show Previews: When Unlocked), the same as Telegram.
- **Read sync:** opening a chat calls the existing `/read` route. The app removes that thread's delivered notifications (`removeDeliveredNotifications` by thread-id) so the lock screen clears.

---

## 6. App LLD (Mac session, 1 Nov)

Build order: this section, then the tests in §6.8, then the code. Nothing here changes §1–§4.

### 6.1 Thread ids, one namespace

| Chat | threadId | Opens | Where its messages live in the app |
|---|---|---|---|
| COO | `coo` | Talk → `ConversationView(employeeId: "coo")` (the COO card's id is `coo`) | `TalkThreadsStore.messages["coo"]`, else `CooStore.log` |
| 1:1 Talk | the employee id | Talk → `ConversationView(employeeId:)` | `TalkThreadsStore.messages[id]`, else `TalkStore.chatLog` |
| Room thread | the room thread id (`th_…`) | Room → `ThreadView(id:)` | `RoomStore.messages[id]` |

Talk thread ids equal employee ids (server `talk-store.ts` `requireThread`), so a chat link needs no lookup.

### 6.2 Routing (`Net/Push.swift`, `AppModel.open`)

- `AppLink.chat(String)` — `chat/<threadId>`, `chat/coo`, `#/chat/<id>`, `irisworkplace://chat/<id>`; `chat` with no id → `AppLink.talkList` (the Talk tab).
- `room/<id>` keeps meaning `AppLink.room` (already routed to `ThreadView`).
- `AppLink.resolve(userInfo:category:)`: the link first (as today). With no usable link and category `WP_CHAT`, the payload's `threadId` opens `.chat(threadId)` (not `.room`, which stays the fallback for other categories); a bare `WP_CHAT` opens the Talk list.
- `AppModel.open(.chat(id))` → `router.talk(to: id)`; `.talkList` → `router.openTalkList()`. Killed / background / foreground all go through `PushManager.didReceive → deliver → onOpen`, and a tap before `onOpen` is wired waits in `pendingLink` (unchanged).

### 6.3 Category `WP_CHAT` and its actions

| Action | Id | Kind | Behaviour |
|---|---|---|---|
| Reply | `REPLY` | `UNTextInputNotificationAction`, options `[.authenticationRequired]` (runs without opening the app, never from a locked phone) | `AppModel.replyFromNotification(threadId:link:text:)`: COO → `POST /api/coo/message`; Talk → `POST /api/talk/threads/:id/messages`; room → `POST /api/room/:id/messages` (the existing room post). Builds its own `RestClient` from the saved mode and credential when the app was launched in the background (same as the dashboard refresh). A failure posts one local notification "Couldn't send your reply" in the same thread stack. |
| Mute 1 h | `MUTE_1H` | `UNNotificationAction`, `[.authenticationRequired]` | `ChatPrefsStore.set(threadId, .hour)` (optimistic, local fallback rules as §6.4). |
| (tap) | default | — | opens the chat (§6.2). |

`WP_INBOX`/`WP_ROOM`/`WP_ALERT`/`WP_UPDATE` keep their foreground-only actions; the test that guards that now covers every category except `WP_CHAT`, and a second test pins `WP_CHAT`'s two background actions (never `.destructive`, always `.authenticationRequired`).

### 6.4 Foreground presentation (`ChatPushPolicy`, pure)

```
decide(category, userInfo, onScreen: Set<threadId>, isMuted: (threadId) -> Bool) -> .show([.banner,.sound,.list]) | .haptic | .drop | .notChat
```
- Only pushes whose category is `WP_CHAT`, or whose link is `chat/…`, are chat pushes. The thread is `data.threadId`, else the link's id.
- Muted (per the app's prefs) → `.drop` (returns `[]`, no sound, no haptic).
- On screen (the chat view is visible and the app is active) → `.haptic`: `[]` plus `UIImpactFeedbackGenerator(.light)`; the message arrives over the socket.
- Otherwise → `[.banner, .sound, .list]`. No `.badge` (the badge stays "needs you", §1).
- `.notChat` → today's path (socket-dedupe, `[.banner, .sound, .badge]`).

"On screen" is `AppModel.visibleChats` (thread id → count), counted in `onAppear` / `onDisappear` of `ConversationView` and `ThreadView`. It is separate from `openChats` (that one drives Talk re-sync and must never contain room ids). A pushed profile screen makes the chat not visible, so a banner shows there, as in Telegram.

Clearing: when a chat becomes visible, `PushManager.clear(threadId:)` removes delivered notifications whose `threadIdentifier` is `chat:<id>`, or whose `threadId` / link resolves to that chat.

### 6.5 `ChatPrefsStore` (`State/ChatPrefsStore.swift`)

```
ChatPref { muted: Bool, mutedUntil: String? }      // ISO-8601; past = unmuted
MuteOption: hour (1 h) | eightHours | day | forever | unmute  → pref(now)
supported: Bool?            // nil until GET answers; false on 404 (local only)
prefs: [threadId: ChatPref] // server's map, mirrored to UserDefaults "iris.chatPrefs.v1"
isMuted(id, isRoom: Bool = false, now) -> Bool  // explicit pref, else the contract default (rooms muted)
mutedUntilText(id) -> String?  // "Muted until 14:05", "Muted"
load(rest)  set(rest?, id, option) throws  handle(.chatPrefs)
```
- **Load:** hydrate from UserDefaults at init (so a cold-launch `willPresent` already knows); `GET /api/chats/prefs` replaces the map and the mirror; 404 → `supported = false`, keep the local map.
- **Set (optimistic):** write the new pref at once (UI updates), then `PUT /api/chats/:id/prefs`. 2xx → the server's copy. 404 → `supported = false`, keep it locally. Any other failure (offline, 5xx) → roll back to the previous value (or remove it), set `error`, rethrow so the screen says so.
- **Socket:** `chat.prefs {threadId, muted, mutedUntil}` overwrites the entry and the mirror.
- **Expiry:** `isMuted` compares with `now()`; a timer task bumps `revision` at the earliest future `mutedUntil` so icons drop without a reload.
- While `supported == false` the mute menu and the profile show "Mute applies on this phone until the server update".
- Paths are app-local (`API.chatPrefs`, `API.chatPref(id)`, `API.chatShared(id, kind, before)` in `Model/ContractChat.swift`), as `metricsSnapshot` is: `scripts/check-contract.mjs` checks TS → Swift only, so it needs no change until `packages/shared` declares the routes.

### 6.6 Chat profile (`UI/ChatProfileView.swift`)

Pushed (not a sheet) when the owner taps the chat header (`ChatTitle`, identifier `chat.title`) or "Info" in the menu; room threads via the header strip.

- **Header:** a 96 pt `InitialsAvatar(vivid)`, name, subtitle (COO: Online / Offline · last seen; employee: state; room: participants), presence dot.
- **About (`ChatProfileInfo`, pure):** COO → fixed "Your COO: runs the Workplace, routes work, reports to you." and Status / Last heartbeat from `/api/coo/presence`. Employee → `GET /api/employees/:id`: Role, Areas (charter titles), Reports to, Model (latest session's model, else "—"), State (+ reason). Room → participants and state. Missing data shows "—", never a blank screen.
- **Actions:** Notifications row (bell / bell.slash, current state, a Menu with the five options), "Charter and status" (employees, the existing sheet).
- **Shared:** segmented Media / Files / Links. `ChatSharedStore.load(threadId, kind)` → `GET /api/chats/:id/shared?kind=` with `before=` paging ("Load more" while `next != nil`). 404 → `SharedDerivation.items(from: sources)` over the messages already loaded, captioned "Showing recent".
- Media grid (3 columns) reuses `ImageAttachmentView`'s fetch + QuickLook (full screen, zoom, share); Files reuse `FileAttachmentView` (QuickLook, Share); Links open `SFSafariViewController` (in-app Safari).
- Theme: a `List` with `.themedRows()` / `.themedList()`, `SectionHeader`, `themedCard` for the header block — Default looks like an iOS inset-grouped settings page; Sci-fi gets its glass rows.

### 6.7 `SharedDerivation` (pure)

Input: `[SharedSource { messageId, at, text, attachments: [TalkAttachment] }]` built from `TalkMessage`, `CooMessage`, `RoomMessage`, `LogEntry`.
- Media: `kind == image` or mime `image/*` / `video/*`. Files: everything else except voice (`kind == voice`, mime `audio/*`), which Telegram keeps in its own tab and this screen leaves out.
- Links: `http(s)` URLs found by `NSDataDetector`; a Markdown `[title](url)` gives the title, else the host is the title. The app's own attachment paths are skipped.
- De-dupe: attachments by id; links by normalised URL (lower-cased scheme and host, no trailing `/`; the fragment is kept because the web app's routes live there).
- Order: newest message first; inside one message, in reading order.

### 6.8 Tests (written first)

| File | Covers |
|---|---|
| `ChatNotifyTests.swift` · `ChatLinkTests` | `chat/<id>`, `chat/coo`, `#/chat/x`, `irisworkplace://chat/x`, `chat` → Talk list, `room/<id>` unchanged; `resolve` for WP_CHAT with link, with only `threadId`, with nothing; `AppModel.open(.chat)` sets the Talk route; the WP_CHAT category and actions |
| `ChatNotifyTests.swift` · `ChatPushPolicyTests` | same thread on screen → haptic; another thread → banner `[.banner,.sound,.list]`; muted → drop; muted wins over on screen; non-chat → `.notChat`; thread from link when `threadId` is absent |
| `ChatPrefsTests.swift` | load; optimistic set + PUT body; rollback on 500; 404 → local and persisted, reload from defaults; socket `chat.prefs`; `mutedUntil` expiry; forever; room default muted; event decoding |
| `ChatSharedTests.swift` | mime classification, voice excluded, URL extraction with Markdown titles, de-dupe, order; the route's page decoding and its 404 fallback flag |
| `ChatProfileTests.swift` | `ChatProfileInfo` for an employee (role, areas, reports-to, model, state) and for the COO (fixed description, presence) and with missing data |
| `ChatNotifyUITests.swift` | open a chat → header → profile → mute 1 h → back: `bell.slash` in the header and the Talk row; the mock emits a `chat.prefs` event and the row follows; shared tabs show items. Run under `TEST_RUNNER_THEME=default` and `scifi`. |

### 6.9 Mock (`mock/chats.mjs`)

`GET /api/chats/prefs`, `PUT /api/chats/:id/prefs` (broadcasts `chat.prefs`), `GET /api/chats/:id/shared?kind=&before=` (derived from the mock's Talk/COO messages, page size 30), plus test hooks: `POST /api/_chats {on}` (off → every `/api/chats` route 404s, as today's server), `POST /api/_chat/message {threadId, text}` (a message from the other side over the socket), `POST /api/_chat/prefs {threadId, muted, mutedUntil}` (another device changed it). `--no-chats` starts with the routes off.
