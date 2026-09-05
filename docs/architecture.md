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

**Events flow one way.** Services emit; the hub fans out to every open tab;
the UI renders what it is told. The UI never mutates its own copy of an agent
and hopes the server agrees.

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
