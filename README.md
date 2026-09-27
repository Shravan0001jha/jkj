# Iris Workplace

The place where the owner runs the Iris product through a staff of AI employees. Each employee holds
a **charter** (an area of responsibility), takes **assignments** routed through an **ownership map**,
replies with a plan, builds in its own git worktree with evidence, and raises real decisions to the
owner's **Inbox**. The organisation is **data** (versioned files), so hiring, splitting, merging and
reorganising are proposals the owner approves, never code changes. Every line of the product
definition is a requirement owned by exactly one charter.

Built on JKJ (the Claude Agent SDK runtime, driven sessions with steering, interrupt, per-tool
approvals and permission modes, transcripts, the layered context editor).

## Run

```bash
npm install && npm run build
npm start                     # http://127.0.0.1:4317 (loopback only)
npm test                      # 99 tests
```

Published for the owner at **https://work.irisforu.com** through an outbound tunnel to a relay on the
Iris API box (`~/claude-dev-deploy/services/workplace-relay`, 27 tests); passkey login; emergency
off switch: reply `off` on Telegram.

## Read

- `docs/WORKPLACE-HOWTO.md` — how to use it: state a feature, hire, split, reorganise, publish.
- `docs/HLD-workplace.md` — the decisions and why.
- `docs/LLD-workplace.md` — data, algorithms, the API contract (§14), GitHub Apps and repos (§12),
  publishing (§17).
- `docs/TDD-workplace.md` — what the tests pin.
- `docs/VERIFICATION-workplace.md` — what was measured, what was live-verified, what was not.
- `docs/IRIS-WORKPLACE-PROMPT.md` — the brief.

## Layout

```
packages/shared/   the contract (types, API paths, socket events) the web UI and the phone app build against
packages/server/   the Workplace: org, ownership map, requirements, work, inbox, approvals, sessions,
                   worktrees and guards, spend, health, proposals, releases, tunnel, Telegram
packages/server/seed/   the first organisation: handbook, units, charters, roles, map
packages/web/      the screens: Office, Inbox, Features, Org, Employee, Assign, Releases, Spend
```

Data lives in `~/iris-workplace` (its own git repo; every approved change is a commit) and
`~/iris-workplace/workplace.db`. Secrets stay in `~/iris-ops` and are never displayed.
