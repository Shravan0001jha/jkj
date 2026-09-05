# JKJ

A local control plane for Claude Code. Run `jkj`, and a page opens in your
browser where you can start and steer many agents at once, across many
projects, with one place to keep the context you would otherwise repeat.

> **Status: early.** The full interface is built and interactive, but it runs
> on fabricated data — agents are not yet wired to a real runtime. Everything
> fake lives in `packages/web/src/mock/`; deleting that folder is the whole
> migration. See [Roadmap](#roadmap).

## What it does

- **Many agents, many projects.** Each project is a directory on disk; each
  agent gets its own git worktree so parallel agents cannot collide.
- **Watch and steer.** A live transcript per agent, with the tool calls it
  makes, the subagents it spawns, and a box to redirect it mid-run.
- **Context in two layers.** One central document for how you like things,
  one per project for what is true about that repo. A preview shows the exact
  prompt an agent will receive, and what it costs.
- **MCP management.** Install a server once, switch it on per project, see
  its health, restart it without restarting your agents.

## Requirements

- Node.js 20 or newer (`node -v`)
- npm 10 or newer
- git

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

You should see three projects in the left rail and a grid of agents that
advances on its own. Open an agent's chat, approve the request the
`lock-free-migration` agent is blocked on, edit the central context and watch
the assembled prompt change, or restart an MCP server.

The data is fabricated. `packages/web/src/mock/fixtures.ts` is the seed and
`simulator.ts` is the timer that advances it; no component imports from that
folder, so replacing it with live data is a change to `App.tsx` alone.

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
jkj --data-dir ~/.jkj    # where state is kept
jkj --no-open            # do not launch a browser
```

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
ws/hub.ts             WebSocket fan-out and command handling
services/             Domain logic: projects, agents, context, mcp
runtime/              The only files that touch the Claude Agent SDK
store/                Persistence (in-memory today, SQLite next)
```

Inside `packages/web/src`:

```
App.tsx               Composes the screens
api/client.ts         One function per REST endpoint
api/socket.ts         The single WebSocket connection
state/store.ts        Client state and every action the UI can take
mock/                 Fabricated seed data and the stream simulator
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
- [x] The full interface, running on fabricated data
- [ ] Projects: add a directory, read its branch, import `CLAUDE.md`
- [ ] Agents: create, run against the Claude Agent SDK, stream the transcript
- [ ] Git worktree per agent
- [ ] Permission prompts and approvals
- [ ] Context: two layers, live assembled preview
- [ ] MCP: install, health, per-project toggles
- [ ] SQLite persistence and resume after restart
- [ ] Auth token on the local URL

## Security

JKJ binds to `127.0.0.1` only. It runs agents that can read your code and
execute commands on your machine — do not expose it to a network you do not
control. A token on the local URL is on the roadmap before any `--host` use
is recommended.

## Contributing

Issues and pull requests are welcome. Please read
[CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

MIT — see [LICENSE](LICENSE).
