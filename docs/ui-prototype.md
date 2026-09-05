# UI prototype

The interaction design this repo is being built toward exists as a clickable
prototype with fabricated data. It is the reference for layout, naming and
flow — not for code.

What it demonstrates:

- Agent cards per project, each opening a full chat view
- Subagent conversations one level down, with their own breadcrumb
- A permission prompt with allow-once / allow-always / deny
- Central context pinned above projects, with a live assembled-prompt preview
- MCP servers with health, restart, per-project toggles, and a catalog

Design decisions carried into the code:

1. A git worktree per agent is the default, surfaced everywhere.
2. Context is exactly two layers. A third needs a real argument.
3. The assembled prompt is shown verbatim, never summarised.
