import { useEffect } from 'react';
import { AppShell } from './components/AppShell.js';
import { NewAgentDialog } from './features/agents/NewAgentDialog.js';
import { AgentsView } from './features/agents/AgentsView.js';
import { ContextView } from './features/context/ContextView.js';
import { McpView } from './features/mcp/McpView.js';
import { ActivityFeed } from './features/activity/ActivityFeed.js';
import { EmptyWorkspace } from './components/EmptyWorkspace.js';
import { applyServerEvent, loadWorkspace, setConnection, useStore } from './state/store.js';
import { connect } from './api/socket.js';

/**
 * Composition root. Loads the workspace once, then lets the socket keep it
 * current — the server watches Claude Code's files so the UI never polls.
 */
export function App() {
  const tab = useStore(s => s.tab);
  const loading = useStore(s => s.loading);
  const projects = useStore(s => s.projects);
  const newAgentOpen = useStore(s => s.newAgentOpen);

  useEffect(() => {
    void loadWorkspace();
    return connect(applyServerEvent, setConnection);
  }, []);

  return (
    <AppShell>
      {loading || projects.length === 0
        ? <div className="pane"><EmptyWorkspace /></div>
        : (
          <>
            {tab === 'agents' && <AgentsView />}
            {tab === 'context' && <div className="pane"><ContextView /></div>}
            {tab === 'mcp' && <div className="pane"><McpView /></div>}
            {tab === 'activity' && <div className="pane"><ActivityFeed /></div>}
          </>
        )}
      {newAgentOpen && <NewAgentDialog />}
    </AppShell>
  );
}
