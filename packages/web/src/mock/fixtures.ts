import type {
  ActivityEvent, Agent, ContextDoc, LogEntry, McpCatalogEntry, McpServer, Project,
} from '@jkj/shared';
import { uid } from '../lib/format.js';

/**
 * Seed data for the prototype. Fabricated — see ./README.md.
 *
 * The shapes are the real domain types, so replacing this with a fetch from
 * /api/* changes one call in App.tsx and nothing else.
 */

/* ---------- scripts ---------- */

/** One step an agent performs. A `task` step spawns a subagent. */
export type Step =
  | { kind: LogEntry['kind']; label: string; text: string }
  | { kind: 'task'; label: 'Task'; text: string; subName: string; sub: Step[] };

const step = (kind: LogEntry['kind'], label: string, text: string): Step => ({ kind, label, text });
const read = (path: string) => step('read', 'Read', path);
const edit = (path: string) => step('edit', 'Edit', path);
const bash = (cmd: string) => step('bash', 'Bash', cmd);
const say = (text: string) => step('assistant', '', text);
const fail = (text: string) => step('error', 'Failed', text);

const SCRIPTS: Record<string, Step[]> = {
  seatConflict: [
    read('internal/booking/handler.go'),
    read('internal/booking/store.go'),
    say('The 409 comes from a unique index on (flight_id, seat) — the retry path re-inserts instead of upserting.'),
    edit('internal/booking/store.go  +18 −6'),
    bash('go test ./internal/booking/... -run Seat'),
    say('All 14 tests pass. Adding a regression test for the double-submit case.'),
    edit('internal/booking/store_test.go  +41 −0'),
    bash('go test ./... && go vet ./...'),
  ],
  migration: [
    read('db/migrations/0042_seat_hold.sql'),
    {
      kind: 'task', label: 'Task', text: 'schema-auditor → scan 3 migrations for lock risk',
      subName: 'schema-auditor',
      sub: [
        read('db/migrations/0041_flights.sql'),
        bash('psql -c "EXPLAIN (ANALYZE, BUFFERS) ..."'),
        say('Migration 0042 takes an ACCESS EXCLUSIVE lock for about 4s on a 12M-row table.'),
        read('db/migrations/0040_seats.sql'),
        say('The other two are additive and safe. Only 0042 needs rewriting.'),
      ],
    },
    say('Rewriting 0042 as a concurrent index build so it can ship without a maintenance window.'),
    edit('db/migrations/0042_seat_hold.sql  +9 −4'),
    bash('make migrate-dryrun'),
  ],
  flake: [
    bash('go test ./internal/pricing/... -count=20'),
    fail('TestSurgeWindow failed 3 of 20 runs — timing dependent'),
    read('internal/pricing/surge.go'),
    say('The test asserts on wall-clock windows. It needs an injected clock.'),
    edit('internal/pricing/surge.go  +16 −7'),
    bash('go test ./internal/pricing/... -count=50'),
  ],
  changelog: [
    bash('gh pr list --state merged --limit 60 --json title,number'),
    say('41 PRs since v2.8. Grouping them by area and dropping the pure-chore ones.'),
    edit('RELEASE.md  +64 −0'),
  ],
  bundle: [
    read('app/(dashboard)/page.tsx'),
    bash('pnpm build --profile'),
    say('First-load JS on /dashboard is 412 kB. The date picker and the chart library are both in the route bundle.'),
    edit('app/(dashboard)/page.tsx  +12 −5'),
    {
      kind: 'task', label: 'Task', text: 'bundle-analyst → find remaining imports over 40 kB',
      subName: 'bundle-analyst',
      sub: [
        bash('pnpm analyze'),
        say('recharts (118 kB) is imported at the route root; only two panels use it.'),
        read('components/RevenuePanel.tsx'),
        say('Both panels sit below the fold — a dynamic import costs nothing here.'),
      ],
    },
    edit('components/RevenuePanel.tsx  +7 −2'),
    bash('pnpm build'),
  ],
  a11y: [
    read('components/Combobox.tsx'),
    say('The listbox has no aria-activedescendant, so screen readers announce nothing on arrow-key navigation.'),
    edit('components/Combobox.tsx  +23 −4'),
    bash('pnpm test:a11y'),
    say('Passing. Adding a Playwright test that drives it with the keyboard only.'),
    edit('e2e/combobox.spec.ts  +38 −0'),
  ],
  tokens: [
    bash('rg -n "#[0-9a-fA-F]{6}" src/ --glob "!tokens.css"'),
    say('34 hardcoded values across 11 components. Mapping each to the nearest token.'),
    edit('components/Badge.tsx  +6 −6'),
    fail('pnpm test:tokens — 4 snapshots out of date, needs a decision'),
  ],
  ofx: [
    read('src/parse/ofx.rs'),
    bash('cargo test --package ledger-parse'),
    say('Two banks emit a non-standard timezone offset. Normalising at the parse boundary rather than downstream.'),
    edit('src/parse/ofx.rs  +34 −11'),
    bash('cargo clippy -- -D warnings'),
  ],
  msrv: [
    bash('cargo +1.82 check --workspace'),
    say('Clean. Checking the three downstream crates that pin our MSRV.'),
  ],
};

/* ---------- agent definitions ---------- */

interface AgentSeed {
  name: string;
  task: string;
  model: string;
  status: Agent['status'];
  script: keyof typeof SCRIPTS;
  /** How many steps have already happened when the page loads. */
  played: number;
  approval?: { tool: string; input: string; reason: string };
}

const SEEDS: Record<string, AgentSeed[]> = {
  flightpath: [
    { name: 'seat-conflict', task: 'Fix the 409 returned when two passengers hold the same seat during a retry', model: 'opus-5', status: 'running', script: 'seatConflict', played: 3 },
    {
      name: 'lock-free-migration', task: 'Make migration 0042 safe to run against production without downtime',
      model: 'opus-5', status: 'waiting', script: 'migration', played: 3,
      approval: {
        tool: 'Bash',
        input: 'psql $PROD_URL -f db/migrations/0042_seat_hold.sql',
        reason: 'Runs a schema change against the production database.',
      },
    },
    { name: 'surge-flake', task: 'Track down the flaky pricing test that fails about 15% of CI runs', model: 'sonnet-5', status: 'running', script: 'flake', played: 2 },
    { name: 'changelog', task: 'Draft release notes for v2.9 from the merged pull requests', model: 'haiku-4.5', status: 'done', script: 'changelog', played: 3 },
  ],
  atlas: [
    { name: 'dashboard-weight', task: 'Get /dashboard first-load JS under 250 kB', model: 'opus-5', status: 'running', script: 'bundle', played: 5 },
    { name: 'combobox-a11y', task: 'Make the Combobox usable with VoiceOver and the keyboard alone', model: 'sonnet-5', status: 'running', script: 'a11y', played: 2 },
    { name: 'stale-tokens', task: 'Replace the 34 remaining hardcoded hex values with design tokens', model: 'haiku-4.5', status: 'error', script: 'tokens', played: 4 },
  ],
  ledger: [
    { name: 'ofx-dates', task: 'Two banks export OFX with a non-standard timezone offset; normalise it', model: 'opus-5', status: 'running', script: 'ofx', played: 3 },
    { name: 'msrv-bump', task: 'Check whether bumping MSRV to 1.82 breaks any downstream crate', model: 'sonnet-5', status: 'idle', script: 'msrv', played: 0 },
  ],
};

const PROJECTS: Project[] = [
  { id: 'flightpath', name: 'flightpath-api', path: '~/code/flightpath-api', branch: 'main', enabledMcpServers: ['postgres', 'sentry', 'github', 'filesystem'] },
  { id: 'atlas', name: 'atlas-web', path: '~/code/atlas-web', branch: 'release/12', enabledMcpServers: ['sentry', 'github', 'linear', 'filesystem', 'playwright'] },
  { id: 'ledger', name: 'ledger-cli', path: '~/code/ledger-cli', branch: 'main', enabledMcpServers: ['github', 'filesystem'] },
];

const PROJECT_CONTEXT: Record<string, string> = {
  flightpath: `Go 1.23, Postgres 16, deployed on Fly.io.

Every handler returns problem+json — never a bare string error.
Migrations are forward-only; no down migrations, ever.
Tests use testcontainers, not mocks, for anything touching the database.

Do not touch internal/legacy/ — it is scheduled for deletion in Q4.`,
  atlas: `Next.js 15 App Router, Tailwind, Playwright.

Server components by default. A "use client" directive needs a reason in the pull request description.
Every interactive component ships with a Playwright test, not just a unit test.
Design tokens live in tokens.css — never hardcode a hex value.`,
  ledger: `Rust 2021, zero unsafe, MSRV 1.79.

Parsing is fallible and total: never panic on user input, return ParseError.
The CLI surface is frozen — new behaviour goes behind a flag, defaults never change.`,
};

export const CENTRAL_CONTEXT = `Answer with the change, not a description of the change. Show me the diff.

I read code faster than prose — keep explanations to two or three sentences unless I ask for depth.

Never add a comment that restates the line below it.
Never introduce a dependency to save fewer than about 40 lines.
When you are unsure between two designs, build the smaller one and tell me what you gave up.

If a test is flaky, fix the test's assumption about time or order — do not add a retry.`;

const MCP_INSTALLED: McpServer[] = [
  { id: 'postgres', name: 'postgres', source: '@modelcontextprotocol/server-postgres', transport: 'stdio', health: 'healthy', toolCount: 6 },
  { id: 'sentry', name: 'sentry', source: 'sentry-mcp', transport: 'http', health: 'healthy', toolCount: 11 },
  { id: 'github', name: 'github', source: 'github-mcp-server', transport: 'http', health: 'healthy', toolCount: 42 },
  { id: 'linear', name: 'linear', source: 'linear-mcp', transport: 'http', health: 'degraded', toolCount: 14, note: 'Token expires in 3 days' },
  { id: 'filesystem', name: 'filesystem', source: '@modelcontextprotocol/server-filesystem', transport: 'stdio', health: 'healthy', toolCount: 8 },
  { id: 'playwright', name: 'playwright', source: '@playwright/mcp', transport: 'stdio', health: 'unreachable', toolCount: 21, note: 'Browser binary missing — run npx playwright install' },
];

const MCP_CATALOG: McpCatalogEntry[] = [
  { id: 'figma', name: 'figma', description: 'Read frames, variables and component specs from a Figma file.', source: 'figma-mcp', transport: 'http', toolCount: 9 },
  { id: 'stripe', name: 'stripe', description: 'Query customers, subscriptions and events in test mode.', source: 'stripe-mcp', transport: 'http', toolCount: 17 },
  { id: 'grafana', name: 'grafana', description: 'Pull dashboards, panels and alert state.', source: 'grafana-mcp', transport: 'http', toolCount: 12 },
  { id: 'slack', name: 'slack', description: 'Read channel history and post updates.', source: 'slack-mcp', transport: 'http', toolCount: 7 },
];

/* ---------- assembly ---------- */

export interface Fixtures {
  projects: Project[];
  agents: Agent[];
  transcripts: Record<string, LogEntry[]>;
  mcpInstalled: McpServer[];
  mcpCatalog: McpCatalogEntry[];
  central: ContextDoc;
  projectContexts: Record<string, ContextDoc>;
  activity: ActivityEvent[];
  /** Steps not yet played, keyed by agent id. Consumed by the simulator. */
  pending: Record<string, Step[]>;
}

export function buildFixtures(): Fixtures {
  const agents: Agent[] = [];
  const transcripts: Record<string, LogEntry[]> = {};
  const pending: Record<string, Step[]> = {};
  const now = Date.now();

  for (const project of PROJECTS) {
    for (const seed of SEEDS[project.id] ?? []) {
      const id = uid('ag');
      const script = SCRIPTS[seed.script] ?? [];
      const startedAt = new Date(now - (90_000 + Math.random() * 900_000)).toISOString();

      const agent: Agent = {
        id,
        projectId: project.id,
        name: seed.name,
        task: seed.task,
        model: seed.model,
        status: seed.status,
        workspace: seed.name === 'changelog' ? 'branch' : 'worktree',
        cwd: seed.name === 'changelog' ? project.path : `.jkj/worktrees/${seed.name}`,
        startedAt,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        approval: seed.approval
          ? { id: uid('ap'), ...seed.approval, requestedAt: new Date(now - 120_000).toISOString() }
          : undefined,
      };
      agents.push(agent);
      transcripts[id] = [];

      // Replay the steps that "already happened" before the page loaded.
      script.slice(0, seed.played).forEach((s, i) => {
        const at = new Date(new Date(startedAt).getTime() + (i + 1) * 45_000).toISOString();
        applyStep({ agent, step: s, at, agents, transcripts });
      });
      pending[id] = script.slice(seed.played);

      if (seed.status === 'done') {
        transcripts[id]!.push({
          id: uid('ln'), agentId: id, at: new Date(now - 60_000).toISOString(),
          kind: 'assistant', label: '', text: 'Done. Branch pushed and ready for review.',
        });
      }
    }
  }

  return {
    projects: PROJECTS,
    agents,
    transcripts,
    mcpInstalled: MCP_INSTALLED,
    mcpCatalog: MCP_CATALOG,
    central: { scope: 'central', projectId: null, body: CENTRAL_CONTEXT, updatedAt: new Date().toISOString() },
    projectContexts: Object.fromEntries(
      Object.entries(PROJECT_CONTEXT).map(([projectId, body]) => [
        projectId, { scope: 'project' as const, projectId, body, updatedAt: new Date().toISOString() },
      ]),
    ),
    activity: seedActivity(now),
    pending,
  };
}

/**
 * Turn one script step into a transcript entry, creating a subagent (a real
 * Agent with parentAgentId, exactly as the server will) when the step is a
 * Task. Shared by the fixtures and the simulator so both stay consistent.
 */
export function applyStep(args: {
  agent: Agent;
  step: Step;
  at: string;
  agents: Agent[];
  transcripts: Record<string, LogEntry[]>;
}): { entry: LogEntry; subagent?: Agent } {
  const { agent, step: s, at, agents, transcripts } = args;

  if (s.kind === 'task' && 'sub' in s) {
    const subId = uid('ag');
    const subagent: Agent = {
      id: subId,
      projectId: agent.projectId,
      parentAgentId: agent.id,
      name: s.subName,
      task: s.text.split('→')[1]?.trim() ?? s.text,
      model: agent.model,
      status: 'done',
      workspace: 'readonly',
      cwd: agent.cwd,
      startedAt: at,
      endedAt: at,
      usage: { inputTokens: 4200, outputTokens: 900, costUsd: 0.06 },
    };
    agents.push(subagent);
    transcripts[subId] = s.sub.map((child, i) => ({
      id: uid('ln'),
      agentId: subId,
      at: new Date(new Date(at).getTime() + (i + 1) * 9_000).toISOString(),
      kind: child.kind,
      label: child.label,
      text: child.text,
    }));

    const entry: LogEntry = { id: uid('ln'), agentId: agent.id, at, kind: 'task', label: 'Task', text: s.text, subagentId: subId };
    transcripts[agent.id] = [...(transcripts[agent.id] ?? []), entry];
    return { entry, subagent };
  }

  const entry: LogEntry = { id: uid('ln'), agentId: agent.id, at, kind: s.kind, label: s.label, text: s.text };
  transcripts[agent.id] = [...(transcripts[agent.id] ?? []), entry];
  return { entry };
}

function seedActivity(now: number): ActivityEvent[] {
  const rows: [ActivityEvent['kind'], string, string][] = [
    ['finished', 'flightpath', '**changelog** finished — 41 pull requests summarised into `RELEASE.md`'],
    ['failed', 'atlas', '**stale-tokens** stopped — 4 snapshot tests need a human decision'],
    ['waiting', 'flightpath', '**lock-free-migration** is asking to run a migration against production'],
    ['started', 'atlas', '**dashboard-weight** spawned subagent **bundle-analyst**'],
    ['started', 'ledger', '**ofx-dates** started on `.jkj/worktrees/ofx-dates`'],
    ['info', 'atlas', 'MCP server **linear** reconnected after a token refresh'],
  ];
  return rows.map(([kind, projectId, message], i) => ({
    id: uid('ev'), at: new Date(now - (i + 1) * 640_000).toISOString(), projectId, kind, message,
  }));
}
