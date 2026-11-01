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
