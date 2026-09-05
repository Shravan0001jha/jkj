# Architecture

## The shape

```
browser ──HTTP──▶ /api/*   ──▶ routes ──▶ services ──▶ store
        ◀─────────────────────                │
        ──WebSocket──▶ /ws  ──▶ hub  ◀────────┘ (events)
                                     │
                                     ▼
                                 runtime/  ──▶ Claude Agent SDK
                                              (one child per agent)
```

## Why it is split this way

**`shared` is the contract.** Both sides import the same types, so a change
to an event shape breaks the build rather than the running app. It is the
reason the server and the UI can be worked on independently.

**Services hold the decisions.** `routes.ts` and `hub.ts` translate between a
transport and a service call and do nothing else. That keeps the interesting
logic testable without a socket.

**`runtime/` is the only SDK-aware code.** Everything above it speaks in
`Agent`, `LogEntry`, `PendingApproval`. Swapping SDK versions, or stubbing
the runtime entirely in tests, is a one-file change.

**Two kinds of session, one model.** Sessions read from disk and sessions JKJ
drives arrive as the same `Agent`, distinguished by one flag. The snapshot
puts driven sessions first and drops the disk copy of the file they are
writing, so a live conversation never appears twice.

**Streaming input never ends.** A `result` message is the end of a turn, not
of the session — the SDK query keeps running and waits for the next message.
Treating it as the end makes every session answer exactly once, which is
exactly the bug this note exists to prevent recurring.

**Events flow one way.** Services emit; the hub fans out to every open tab;
the UI renders what it is told. The UI never mutates its own copy of an agent
and hopes the server agrees.

## Reaching a session open in a terminal

While a session runs in a terminal, that process owns its stdin, so JKJ cannot
type into it. A finished session has no such owner, which is why continuing
one is straightforward: the SDK is asked to `resume` the session id and the
conversation carries on.

There is a second door. Every running session opens a Unix socket —
`/tmp/cc-socks/<pid>.sock` — and writes a peer token beside it in
`<config>/sessions/<pid>.<hash>.key`. The descriptor advertises
`peerProtocol: 1` and a feature list. This is how Claude Code sessions message
each other on one machine.

JKJ does not speak it, on purpose:

- Neither the Agent SDK nor the CLI exposes it. The framing — an auth
  handshake, `<peer-message …>` envelopes, pid-domain checks, capability
  negotiation — is internal and unversioned, so an implementation would be
  reverse-engineered and could break silently on any release.
- The semantics differ from typing. A peer message arrives as another agent
  addressing that session, not as the person at the keyboard, so two parties
  end up steering one conversation.

`claude --bg` is the supported alternative worth exploring first: background
sessions have real `attach`, `logs` and `stop` commands, and
`claude agents --json` lists them, so the same session could be driven from
JKJ and picked up in a terminal.

## Open questions

- **Parallel agents on one repo.** A git worktree per agent is the plan. Open:
  what happens to a worktree with uncommitted changes when an agent is
  archived, and whether `node_modules` gets linked or reinstalled per tree.
- **Persistence.** In-memory today. `node:sqlite` is built into Node 22+ and
  is the likely answer, but resuming an interrupted agent needs the runtime to
  support resume first.
- **Secrets.** MCP servers need tokens. The OS keychain, not the data
  directory — but that means a native dependency or shelling out to
  `security` / `secret-tool`.
