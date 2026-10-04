# LLD — App fixes: Talk threads, receipts, typing, replies, mentions, files, voice, Room, Plan

Status: **implemented** on `app/fixes` (tests: `packages/server/test/app-*.test.ts`).

Branch `app/fixes`. Server only (`packages/server`, `packages/shared`). This is the **contract the
iOS and Android apps code against**. Everything here is additive: no existing route, event or field
changes meaning except where §1 fixes a bug (the sender of a message).

Conventions: all routes need the bearer token off loopback, as today. Times are ISO-8601 UTC.
Errors are `{ "error": "<one sentence with the next step>" }` with 400/404/409/413/415/502/503.
Unknown fields are ignored by the server; apps must ignore unknown fields and event types.

---

## 0. Words

* **Thread** — one Talk conversation in the owner's app. One per employee, id = the employee id
  (`mira`, `asha`, …). The COO is the thread `coo` ("Claude — COO", backed by the COO bridge).
* **Inbound message** — to the agent (from `owner`, `coo`, `workplace`, or another employee id).
* **Outbound message** — from the agent (its prose, or a file it sent with `send_file`).
* **Sender (`from`)** — `'owner' | 'coo' | 'workplace' | <employeeId>`. Never inferred: recorded at
  the moment the message is sent.

## 1. Sender (bug fix)

| Sender | `from` | `fromName` |
|---|---|---|
| the owner (app, web, Telegram) | `owner` | `You` |
| the COO (any route with `x-workplace-actor: coo` from this Mac) | `coo` | `Claude — COO` |
| the Workplace itself (assignment prompt, moderation turn, mention wake-up, handoff, resume) | `workplace` | `Workplace` |
| an employee (agent prose, `send_file`) | `<employeeId>` | the employee's name |

* `LogEntry.from` (existing field, `GET /api/agents/:id/log` and `agent.log` events) is widened to
  the same values plus a new `fromName`. Absent still reads as `owner` for old entries only.
* `POST /api/talk`, `POST /api/employees/:id/talk`, `POST /api/agents/:id/message` record
  `from: 'coo'` when the request carries `x-workplace-actor: coo` from this Mac.
* Apps: render `fromName`; render `from === 'owner'` as the owner's bubble ONLY. `coo` is a
  distinct sender ("Claude — COO"); `workplace` is folded into the activity line as today.

## 2. Talk threads

### Types (`@jkj/shared` `talk.ts`)

```ts
type TalkFrom = 'owner' | 'coo' | 'workplace' | string;          // string = an employee id

interface TalkThread {
  id: string;                 // employee id, or 'coo'
  employeeId: string;         // same as id ('coo' for the COO)
  name: string;               // "Mira", "Claude — COO"
  role?: string;              // "Chief of Staff", "Lead — Platforms", …
  lastMessageAt?: string;
  lastMessage?: { id: string; from: TalkFrom; fromName: string; text: string };  // text: one line, ≤ 140 chars
  unreadCount: number;        // outbound messages after lastReadAt that count (see below)
  lastReadAt?: string;
  pinned: boolean;
  pinnedAt?: string;
  typing: boolean;            // §4
}

interface TalkAttachment {
  id: string;                 // "att_…"
  name: string;
  mediaType: string;
  size: number;               // bytes
  kind: 'image' | 'file' | 'voice';
  url: string;                // "/api/talk/attachments/att_…" (relative; send the bearer token)
}

interface TalkMessage {
  id: string;                 // "tm_…" (stable forever)
  threadId: string;
  at: string;
  from: TalkFrom;
  fromName: string;
  direction: 'in' | 'out';    // in = to the agent; out = from the agent
  text: string;               // for a voice note: the transcript
  replyTo?: { id: string; from: TalkFrom; fromName: string; text: string };  // quoted, one line ≤ 140
  mentions: string[];         // employee ids (may include 'coo')
  attachments: TalkAttachment[];
  voice?: { attachmentId: string; transcript: string; durationMs?: number };
  /** Inbound only. 'delivered' = stored and handed to the agent's session; 'read' = the agent's turn consumed it. */
  receipt?: 'delivered' | 'read';
  deliveredAt?: string;
  readAt?: string;
  /** Outbound prose written in a turn no human message started (assignment work narration). Not counted unread; apps may fold it like today's activity line. */
  quiet?: boolean;
  agentId?: string;           // the session (run) it belongs to, for the transcript/approvals
}
```

`unreadCount` counts outbound messages with `quiet` unset and `at > lastReadAt`. For `coo` it counts
messages from the COO after `lastReadAt`.

### Routes

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/talk/threads` | — | `TalkThread[]`, sorted: pinned first (newest pin first), then threads with `unreadCount > 0`, then `lastMessageAt` desc (no messages last, by name). Every non-virtual employee plus `coo` is listed. |
| GET | `/api/talk/threads/:id` | — | `TalkThread` |
| GET | `/api/talk/threads/:id/messages?limit=&before=` | — | `TalkMessage[]` oldest→newest. `limit` default 100, max 500; `before` = a message id: the page ends just before it. |
| POST | `/api/talk/threads/:id/messages` | `{ text?, replyTo?, mentions?: string[], attachmentIds?: string[], attachments?: Attachment[] }` | 201 `{ message: TalkMessage, agent?: Agent }` (`agent` absent for `coo`) |
| POST | `/api/talk/threads/:id/read` | `{ upTo?: messageId }` (default: newest) | `TalkThread` (unreadCount recomputed) |
| POST | `/api/talk/threads/:id/pin` | `{ pinned: boolean }` | `TalkThread` |
| POST | `/api/talk/threads/:id/attachments?name=<file name>` | raw bytes; `content-type` = the file's media type | 201 `TalkAttachment` (not yet sent; reference it in `attachmentIds` within 24 h) |
| POST | `/api/talk/threads/:id/voice?name=<file name>&durationMs=&replyTo=` | raw audio bytes; `content-type` `audio/mp4` / `audio/x-m4a` / `audio/m4a` / `audio/aac` / `audio/mpeg` / `audio/webm` / `audio/ogg` / `audio/wav` / `audio/x-wav` | 201 `{ message: TalkMessage, agent?: Agent }` — stored, transcribed, sent |
| GET | `/api/talk/attachments/:id` | — | the bytes, with `content-type`, `content-length`, `content-disposition: inline; filename="…"` (`?download=1` → attachment) |
| GET | `/api/mentionable` | — | `{ id, name, role?, kind: 'employee' \| 'coo' }[]` sorted by name |

Rules:

* Sending: `text` or at least one attachment/voice is required. `replyTo` must be a message id in the
  same thread (else 400). `mentions` must be known ids (unknown → 400 naming it); `@id`/`@Name` in the
  text are added too; mentioned employees (other than the thread's own) are woken exactly as an item
  comment mention is today.
* `POST /api/employees/:id/talk` and `POST /api/talk` (the Chief of Staff) keep working and accept the
  same optional `replyTo`, `mentions`, `attachmentIds`; they still return the `Agent`, now with one
  extra field `message: TalkMessage`.
* The `coo` thread takes text, `replyTo` and voice (transcribed; the COO receives the transcript).
  Files to the COO → 400 "The COO thread takes text and voice; send files to an employee."
* Size: 20 MB per file (413 "That file is over 20 MB; send a smaller one or a link."). Images, PDFs,
  text and any other type are accepted; the agent reads images inline and every other file from
  disk (§6).
* Opening a thread in the app: call `POST …/read` when the thread is shown and when a new message
  arrives while it is on screen.

### Events (websocket, existing `/ws`; upsert by `id`)

```ts
{ type: 'talk.message'; message: TalkMessage; thread: TalkThread }   // new message OR changed receipt
{ type: 'talk.thread'; thread: TalkThread }                          // read, pin, unread changed
{ type: 'talk.typing'; threadId: string; employeeId: string; typing: boolean; at: string }
```

`agent.log` / `agent.updated` continue unchanged for the transcript view.

## 3. Read receipts

* `delivered` the moment the message is stored and handed to the agent's session (queued or not).
* `read` when the SDK reports the turn that consumed it (`user_message_uuids` on the turn's first
  reply frame). A message the CLI folded into a running turn is marked read when a later turn shows
  it was consumed (messages are consumed in order), so `read` is never claimed early; it can lag.
* Each change is a `talk.message` event with the same message id.
* COO thread: the owner's message is `read` when the COO replies (`/api/coo/reply`).

## 4. Typing

`talk.typing { typing: true }` only when the agent's turn that consumed a message from the owner or
the COO in that thread starts producing output; `typing: false` when that turn ends (result), errors,
is interrupted or the session closes. Never while a message is merely queued. Turns started by the
Workplace (assignments, mention wake-ups) never show typing. `TalkThread.typing` carries the current
state for a client that (re)connects. Typing begins at the turn's first output block (the SDK runs
in complete-message mode, so that is when the server learns the turn consumed the message); expect it
a second or two after the agent starts thinking, not at once.

## 5. Mentions

* Item comments: `POST /api/items/:id/comments` accepts `mentions: string[]` (several), unioned with
  `@id`/`@Name` in the text, validated, de-duplicated. Every mentioned employee is woken (one turn per
  item per 10 min, as today); `coo` goes to the COO bridge.
* Room posts: `mentions` already accepted; now validated the same way.
* Talk messages: §2.
* `GET /api/mentionable` lists who can be tagged.

## 6. Files

* Stored at `~/iris-workplace/attachments/<threadId>/<att_id>-<safe name>`; metadata in the
  `talk_attachments` table. The route serves only ids found in that table, resolves the path and
  refuses anything outside the attachments root (no client path ever reaches the filesystem).
* Owner → agent: images go to the model as images (as today). Every other file (PDF, zip, docs, audio)
  is saved and the agent's message says `Attached file: <name> (<type>, <size>) at <absolute path>
  — read it with the Read tool.` Text files are still inlined as today, and also saved.
* Agent → owner: Workplace tool `send_file { path, caption? }`. Allowed only inside the agent's own
  worktree or `~/iris-workplace/evidence/`, ≤ 20 MB, a regular file (symlinks resolved first).
  Anything else: "Not sent: only files in your worktree or ~/iris-workplace/evidence/ can be sent."
  The file is copied into attachments and appears in the thread as an outbound `TalkMessage` with the
  caption as `text` (empty caption → the file name).

## 7. Voice notes

* `POST /api/talk/threads/:id/voice` stores the audio as a `voice` attachment and transcribes it with
  Deepgram (`nova-3`, `smart_format`, language auto). The agent receives
  `<transcript>\n\n(voice note)`. The message carries `voice { attachmentId, transcript, durationMs? }`
  and `attachments: [the audio]`; apps show a player with the transcript under it.
* No key configured → 503 "Voice notes are off: no speech-to-text key on the Mac." Deepgram failure or
  an empty transcript → 502 "Couldn't transcribe that voice note; try again or type it." Nothing is
  sent in either case.
* Key: `DEEPGRAM_API_KEY` read at start from `<opsDir>/workplace/stt.env` (mode 600), never logged.
* Agents never send voice.

## 8. Room long messages

* `room_post` (the agents' tool) refuses text over 600 characters: "Not posted: Room posts are short:
  put the detail on the item or in a doc and link it."
* Display: `RoomMessage.text` is the short form; when `truncated: true`, `details` is the **full
  text** (expand by showing `details` in place of `text`). Owner posts are never cut. (Chosen over a
  `fullTextUrl`: no extra round trip, and `details` already exists.)

## 9. Plan

* `GET /api/plan` sorting fix: a finished epic (done, or every story done) always sorts below every
  unfinished one, even with a stale owner flag.
* `GET /api/items` new optional query: `q` (text search over id, title, body; case-insensitive),
  `ownerId` (alias of `assigneeId`; `owner` = the owner's own items), `status` may be a comma list,
  `level`, `sort` = `rank` (default) | `updated` | `created` | `title`, `order` = `asc` | `desc`, and
  `finishedLast=1` (done items after open ones, keeping the chosen sort within each group).

## 10. Inbox duplicates (bug fix)

One thing reaches the owner once: while an open owner-facing question/decision exists for a work
item, a second one for the same item is not raised. No contract change for the apps.
`ask_owner` gains an optional `itemId` (default: the session's assignment).

## 11. Relay limits (apps off the home network)

The relay tunnel returns at most 12 MB per response (`tunnel.ts` `MAX_RESPONSE_BYTES`): an
attachment larger than that downloads on the LAN but answers 502 "Response too large for the relay"
through the relay. Uploads ride the same frames (base64); keep phone uploads under ~12 MB off-LAN
until the relay's frame limit is raised. Apps should show the server's error text.

---

## Design notes (HLD-level decisions)

* **Thread = employee.** The apps already open Talk per employee; the COO is a thread because the
  owner chats with the COO the same way. Messages are stored (`talk_messages`), not derived from
  session transcripts, so ids are stable across sessions and restarts, and receipts/unread/pins have
  somewhere to live.
* **Recorded where every message already passes.** `runs.append` sees every line to and from an
  agent; talk-store listens there, so every sender path (owner, COO, Workplace prompts, mention
  wake-ups, handoffs, resumes) is covered without touching each caller. Fields only the Talk routes
  know are staged by message id before the send.
* **Read = consumed by a turn**, from the SDK's `user_message_uuids` stamp on the turn's first reply
  frame, with in-order inference for folded messages. A queued message is never "read".
* **Typing = a turn that consumed a person's message is producing output**; cleared on result,
  error, interrupt, close.
* **Files live on the Mac**, served only by opaque id from a table, realpath-checked inside the
  attachments root. Agents read non-image files by absolute path (reads outside the worktree are
  allowed by the guards, except the owner's personal folders).
* **Room posts: refuse, don't cut**, in the agents' tool only (the owner and the HTTP route are
  unchanged): a refusal teaches; a silent cut does not.

## RCA 1 — wrong sender

`employees.talk()` set `from: ownerTalk ? 'owner' : 'workplace'` with `ownerTalk = !autonomous`, so
every non-autonomous caller was "the owner". The HTTP talk routes never read `x-workplace-actor`; the
COO drives those routes from this Mac, so its messages were stored and shown as the owner's. Two more
paths did the same: `POST /api/agents/:id/message` (always owner), and any transcript read back from
disk or carried into a resumed run (the SDK file keeps only "user"; absent `from` reads as owner).
Fix: the sender is passed in from the actor (`actorOf`) and recorded on the line and the Talk
message; `fromName` "Claude — COO" for `coo`; transcripts from disk get their sender back from the
Talk store (`overlaySenders`); only the owner's own "continue" lifts a cap pause.

## RCA 2 — duplicate Inbox items

Live data (`~/iris-workplace/workplace.db`, read-only): five question+decision pairs since 3 Oct,
e.g. `in_mutouze546paz` (decision, Rohan, `ask_owner`) and `in_mutov5srivxoj` ("Blocked on you", 8 s
later, body: "filed in his Inbox (in_mutouze546paz)"); `in_mutbn1dayww4h`/`in_mutbn5y02ab38`,
`in_mutbvs4g5l684`/`in_mutbvwvnm6wkm` (Nikhil); `in_murub3py3wvse` (Asha)/`in_muruofc5418x5` (Kabir);
`in_muruy9toymjht` (Asha)/`in_murvbqrr58mjk` (Tara). Cause: the agent files `ask_owner` (no link to
the work item, no dedupe key), then — as the tool descriptions tell it — marks the item blocked on
the owner; `trail.ownerBlock` then raises a second item with key `blocked:<item>`. The two keys never
meet, and the decision is not linked to the item, so nothing could tell they were the same ask.
Fix: `inbox.raiseOrReuse` keeps one open owner-facing ask per work item (a decision replaces the
Workplace's own "Blocked on you" question; anything else reuses the open one); `ownerBlock` treats a
block that names an open ask (`in_…`) as that ask and links it instead of raising; `ask_owner` links
its decision to the item. Cleanup of the one still-open duplicate: `node --import tsx
scripts/inbox-dedupe.ts` (dry run), `--apply` to withdraw.
