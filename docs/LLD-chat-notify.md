# LLD: chat notifications, mute and shared items (server)

Implements the server side of `apps/ios/docs/CHAT-NOTIFY-CONTRACT.md` sections 1–3 (branch `mac/app-chat-notify`). Owner request, 1 Nov.

## 1. Mute prefs: `services/chat-prefs.ts` (new)

- **Storage:** the `settings` row `chat-pref:<threadId>` = `{ muted, mutedUntil }`. No new table.
- **Thread kinds:**
  - `coo` is the COO thread.
  - Every id in `talk-store.threadIds()` is a 1:1 Talk thread.
  - Every `room.listThreads()` id is a room.
  - Anything else is unknown, so PUT answers 404.
- **`effective(wp, id, kind, now)`:**
  - With a stored pref: `muted && (!mutedUntil || mutedUntil > now)`, plus its `mutedUntil`.
  - Without one: rooms are muted; `coo` and Talk threads are unmuted.
- **`all(wp, now)`:** the effective pref for every known thread (the app asked for every thread, not only the stored ones).
- **`set(wp, id, { muted, mutedUntil })`:**
  - validates `mutedUntil` (an ISO date or null);
  - stores the pref;
  - emits `{ type: 'chat.prefs', threadId, muted, mutedUntil }`;
  - returns the effective pref.

## 2. Routes (`http/routes.ts`)

- `GET /api/chats/prefs` returns `all()`.
- `PUT /api/chats/:id/prefs` with body `{ muted: boolean, mutedUntil: string | null }` returns the saved effective pref. It answers 404 for an unknown thread and 400 for a bad body.
- `GET /api/chats/:id/shared?kind=media|files|links&before=<iso>`:
  - Returns `{ items, next }`, newest first, 50 per page.
  - **media:** image attachments.
  - **files:** other attachments, not voice.
  - **links:** `https?://` URLs in message text, one item per URL per message.
  - **Sources:** Talk messages for a Talk thread; the COO log for `coo`; room messages for a room (text only, since rooms have no attachments).
  - `next` is the `at` of the last item when the page is full, else null.

## 3. Push (`services/push.ts`)

- `PushCategory` gains `WP_CHAT`, `PushLevel` gains `info`, and `PushIntent.threadId` becomes a string.
- **`chatIntentFor(wp, event, now)`** handles three events:
  - `coo.message` from `coo`, not from the owner. Thread `coo`, title `Claude — COO`, link `chat/coo`.
  - `talk.message` with direction `out` and not `quiet`. Thread `message.threadId`, title `fromName`, link `chat/<threadId>`, plus `employeeId`.
  - `room.message` that is not by the owner, not by `workplace`, and of kind absent or `message`. Thread `room/<id>`, title `<name> · <thread title>`.

  It returns null when the thread is effectively muted.
- **Body:** the text through the existing secret scrub, at most 1000 characters (`CHAT_BODY_MAX`). With no text, the first attachment becomes `📷 Photo`, `📄 <name>` or `🎤 Voice message`.
- **APNs thread-id:** `chat:<id>`. When that is longer than 32 characters, `chat:` plus the first 27 hex characters of sha1(id).
- **Collapse id:** `chat:<messageId>`.
- **In `Push.handle`:** chat intents bypass quiet hours, the Inbox burst window and the dedupe. A per-thread window applies instead:
  - Up to 4 messages in 60 s send as normal.
  - After that, at most one push per thread per minute, saying "<N> new messages", where N counts the messages held back.

## 4. Shared types (`packages/shared`)

`WorkplaceEvent` gains `{ type: 'chat.prefs'; threadId: string; muted: boolean; mutedUntil: string | null }`.

## Tests (`test/chat-notify.test.ts`)

- **Prefs:** the defaults; PUT round-trips; an expired `mutedUntil` reads as unmuted; an unknown thread gives 404; the socket event is emitted.
- **Push:**
  - COO and Talk messages push; the owner's own messages, quiet narration and workplace room updates do not.
  - A muted thread sends nothing; rooms send nothing by default and push once unmuted.
  - The body is capped at 1000; an attachment-only message gets its label; a long thread id is hashed to 32.
  - Coalescing: of 10 messages within one minute, 4 send individually and a 5th push summarises the rest; the window resets after 60 s.
- **Shared:** media, files and links come out separately and pagination works.
