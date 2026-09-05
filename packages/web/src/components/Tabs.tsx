import { useStore, setTab, currentProject, projectAgents, type TabId } from '../state/store.js';

const TABS: { id: TabId; label: string }[] = [
  { id: 'agents', label: 'Sessions' },
  { id: 'context', label: 'Context' },
  { id: 'mcp', label: 'MCP' },
  { id: 'activity', label: 'Activity' },
];

export function Tabs() {
  const tab = useStore(s => s.tab);
  const agentCount = useStore(s => projectAgents(s, s.selectedProjectId).length);
  const mcpCount = useStore(s => s.mcpInstalled.length);
  const project = useStore(currentProject);

  const counts: Partial<Record<TabId, number>> = { agents: agentCount, mcp: mcpCount };

  return (
    <div className="tabs" role="tablist">
      {TABS.map(t => (
        <button key={t.id} className="tab" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
          {t.label}
          {counts[t.id] !== undefined && <span className="n">{counts[t.id]}</span>}
        </button>
      ))}
      <div className="spacer" />
      {project && <span className="tabpath" title={project.path}>{project.path}</span>}
    </div>
  );
}
