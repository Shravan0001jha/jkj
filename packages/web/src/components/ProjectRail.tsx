import { useStore, selectProject, openCentralContext, showToast } from '../state/store.js';
import { estimateTokens, statusColor } from '../lib/format.js';

/**
 * The left rail. Central context sits above the project list on purpose —
 * it applies to every project, so it does not belong inside one.
 */
export function ProjectRail() {
  const projects = useStore(s => s.projects);
  const agents = useStore(s => s.agents);
  const selectedId = useStore(s => s.selectedProjectId);
  const central = useStore(s => s.central);
  const centralFocused = useStore(s => s.tab === 'context' && s.focusCentral);

  const firstLine = central.body.split('\n').find(l => l.trim()) ?? '';

  return (
    <nav className="rail" aria-label="Workspace">
      <h3>Central</h3>
      <button className="central" aria-current={centralFocused} onClick={openCentralContext}>
        <span className="ct">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="2.6" fill="currentColor" />
            <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.2" opacity=".5" />
          </svg>
          How I like things
        </span>
        <p>{firstLine.slice(0, 78)}{firstLine.length > 78 ? '…' : ''}</p>
        <span className="cm">{estimateTokens(central.body)} tok · every agent, every project</span>
      </button>

      <h3>Projects</h3>
      {projects.map(project => {
        const own = agents.filter(a => a.projectId === project.id && !a.parentAgentId);
        const active = own.filter(a => a.status === 'running' || a.status === 'waiting').length;
        return (
          <button
            key={project.id}
            className="proj"
            aria-current={project.id === selectedId}
            onClick={() => selectProject(project.id)}
          >
            <div className="pname">{project.name}</div>
            <div className="ppath">{project.branch}</div>
            <div className="dots">
              {own.map(a => <i key={a.id} style={{ background: statusColor[a.status] }} />)}
              <span>{active ? `${active} active` : 'idle'}</span>
            </div>
          </button>
        );
      })}

      <div className="railfoot">
        <button
          className="btn sm"
          style={{ width: '100%' }}
          onClick={() => showToast('Add project opens a directory picker, then reads any CLAUDE.md it finds.')}
        >
          ＋ Add project
        </button>
      </div>
    </nav>
  );
}
