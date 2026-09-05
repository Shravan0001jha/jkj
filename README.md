# JKJ

A local control plane for Claude Code. Run `jkj`, and a page opens in your
browser where you can start and steer many agents at once, across many
projects, with one place to keep the context you would otherwise repeat.

> **Status: early but real.** JKJ reads your actual Claude Code sessions,
> projects, context files and MCP configuration. It cannot yet start or steer
> a session — that is the next milestone. See [Roadmap](#roadmap).

## What it does

JKJ reads what the `claude` CLI already writes to disk and puts it in one
window.

- **Every session, every project.** Each directory Claude Code has worked in
  becomes a project; each session in it becomes a row you can open. Sessions
  running right now are separated from ones that have ended.
- **Real transcripts.** The prompts you wrote, the model's replies, and every
  tool call it made, with subagent runs linked from the session that spawned
  them.
- **Context in two layers.** `~/.claude/CLAUDE.md` for how you like things,
  and each repo's own `CLAUDE.md`. JKJ edits those files directly, so what you
  write is what the CLI reads next time — with or without JKJ running.
- **MCP configuration.** Every server the CLI knows about, where it was
  defined, and which projects enable it.

### What it does not do yet

Starting, steering, interrupting or forking a session all belong to the CLI
for now. JKJ is read-only, and the buttons for those say so rather than
pretending. Making them work is the next milestone.

## Requirements

- Node.js 20 or newer (`node -v`)
- npm 10 or newer
- git
- Claude Code, having run at least once on this machine — JKJ reads its state
  from `~/.claude` (or wherever `CLAUDE_CONFIG_DIR` points)

## Setup

```bash
git clone https://github.com/Shravan0001jha/jkj.git
cd jkj
npm install
```

## Running in development

```bash
npm run dev
```

That starts two processes:

| Process | URL | What it is |
| --- | --- | --- |
| server | http://127.0.0.1:4317 | REST API and WebSocket |
| web | http://127.0.0.1:5317 | Vite dev server with hot reload |

**Open http://127.0.0.1:5317.** Vite proxies `/api` and `/ws` through to the
server, so the browser only ever talks to one origin.

You should see your own projects in the left rail and your real sessions in
the grid. Open one to read its transcript, or switch to Context to edit the
`CLAUDE.md` files the CLI loads.

If the window is empty, JKJ says why: no Claude Code state on this machine, no
sessions recorded yet, or the server is not reachable.

## Running the built app

```bash
npm run build
npm start
```

This serves the compiled UI from the server itself on
http://127.0.0.1:4317 and opens your browser.

### Flags

```
jkj --port 4317          # change the port
jkj --host 127.0.0.1     # bind address; loopback only by default
jkj --no-open            # do not launch a browser
```

### Where JKJ reads from

Nothing is hardcoded to one machine or one operating system. JKJ looks for:

| What | Where |
| --- | --- |
| Config directory | `$CLAUDE_CONFIG_DIR`, else `~/.claude` |
| Session transcripts | `<config>/projects/<encoded path>/<session id>.jsonl` |
| Running sessions | `<config>/sessions/*.json` |
| Settings | `<config>/.claude.json`, else `~/.claude.json` |
| Central context | `<config>/CLAUDE.md` |
| Project context | `<repo>/CLAUDE.md` |
| Project MCP servers | `<repo>/.mcp.json` |

Missing files mean "not configured", never an error. Record shapes have
drifted across CLI versions, so every field is treated as optional and
unknown record types are skipped — an older or newer CLI degrades to less
detail rather than breaking.

A project directory's name is the repo path with the separators replaced,
which is **not** reversible: `claude-dev` and `claude/dev` encode the same.
So the real path is always read from the `cwd` recorded inside the session,
falling back to matching against paths the settings file already knows.

## Project layout

```
packages/
  shared/    Types and the wire protocol. Imported by both sides.
  server/    Node process: REST, WebSocket, agent supervision, MCP.
  web/       React UI served by Vite in dev, by the server in production.
```

Inside `packages/server/src`:

```
cli.ts                Entry point, flags, browser launch
index.ts              Boot sequence
config.ts             All configuration read in one place
http/server.ts        HTTP server and static file serving
http/routes.ts        Every REST route, in one table
ws/hub.ts             WebSocket fan-out; re-reads state and pushes changes
services/             Domain logic: workspace, projects, agents, context, mcp
runtime/claude-home   Locating Claude Code's files, portably
runtime/session-*     Reading session transcripts and live descriptors
runtime/claude-agent  Where driving a session will live (stubbed)
```

Inside `packages/web/src`:

```
App.tsx               Composes the screens
api/client.ts         One function per REST endpoint
api/socket.ts         The single WebSocket connection, with reconnect
state/store.ts        Client state and every action the UI can take
components/           Shared UI pieces: shell, rail, tabs, modal, toast
features/             One folder per tab: agents, context, mcp, activity
lib/format.ts         Pure formatting helpers
styles/tokens.css     Every colour and font, light and dark
```

### Conventions

- `@jkj/shared` may not import from the server or the web packages. It is
  types and pure helpers only — that rule is what keeps the two sides
  swappable.
- Domain logic lives in `services/`. HTTP and WebSocket handlers translate,
  they do not decide.
- Anything SDK-shaped stays inside `runtime/`, so an SDK upgrade is a
  one-file change.
- Colours come from `tokens.css`. No hex literals in components.
- Functions land with their final signature and a `TODO` body rather than
  being invented later — so wiring up a feature means replacing a body, not
  reshaping its callers.

## Roadmap

- [x] Repo, workspaces, build pipeline
- [x] Server skeleton: REST, WebSocket, service boundaries
- [x] Web shell and a connection check
- [x] The full interface
- [x] Read real projects, sessions and transcripts from disk
- [x] Live sessions separated from ended ones, updated over the socket
- [x] Context: edit the real `CLAUDE.md` files both layers live in
- [x] MCP: read every configured server and where it came from
- [ ] Start a session from JKJ
- [ ] Steer, interrupt and fork a running session
- [ ] Permission prompts and approvals
- [ ] Probe MCP servers for real health and tool counts
- [ ] Git worktree per session, so parallel work cannot collide
- [ ] Auth token on the local URL

## Security

JKJ binds to `127.0.0.1` only, and today it only reads — the one exception is
the Context tab, which writes the `CLAUDE.md` files you edit.

Your session transcripts contain everything you have ever asked Claude Code,
including whatever it read from your files. Do not expose this to a network
you do not control. A token on the local URL is on the roadmap before any
`--host` use is recommended.

## Contributing

Issues and pull requests are welcome. Please read
[CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

MIT — see [LICENSE](LICENSE).
