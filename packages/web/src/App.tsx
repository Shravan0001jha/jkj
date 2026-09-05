import { AppShell } from './components/AppShell.js';
import { NewAgentDialog } from './features/agents/NewAgentDialog.js';
import { AgentsView } from './features/agents/AgentsView.js';
import { ContextView } from './features/context/ContextView.js';
import { McpView } from './features/mcp/McpView.js';
import { ActivityFeed } from './features/activity/ActivityFeed.js';
import { initStore, useStore } from './state/store.js';
import { buildFixtures } from './mock/fixtures.js';
import { seedUsage, startSimulator } from './mock/simulator.js';

/**
 * Composition root.
 *
 * Today the store is seeded from ./mock and advanced by a timer. When the
 * server can do the work, this function fetches /api/* and subscribes to the
 * socket instead — and nothing below it changes.
 */
function seed(): void {
  const fixtures = buildFixtures();

  initStore({
    projects: fixtures.projects,
    agents: seedUsage(fixtures.agents, fixtures.transcripts),
    transcripts: fixtures.transcripts,
    mcpInstalled: fixtures.mcpInstalled,
    mcpCatalog: fixtures.mcpCatalog,
    central: fixtures.central,
    projectContexts: fixtures.projectContexts,
    activity: fixtures.activity,

    selectedProjectId: fixtures.projects[0]!.id,
    tab: 'agents',
    openAgentId: null,
    focusCentral: false,
    streamPaused: false,
    busyMcpId: null,
    newAgentOpen: false,
    toast: null,
  });

  // Runs for the lifetime of the page. Deliberately not torn down in an
  // effect — StrictMode's double mount would stop the stream on first render.
  startSimulator(fixtures.pending);
}

/** Seeded once, before the first render, so the app never paints empty. */
seed();

export function App() {
  const tab = useStore(s => s.tab);
  const newAgentOpen = useStore(s => s.newAgentOpen);

  return (
    <AppShell>
      {tab === 'agents' && <AgentsView />}
      {tab === 'context' && <div className="pane"><ContextView /></div>}
      {tab === 'mcp' && <div className="pane"><McpView /></div>}
      {tab === 'activity' && <div className="pane"><ActivityFeed /></div>}
      {newAgentOpen && <NewAgentDialog />}
    </AppShell>
  );
}
