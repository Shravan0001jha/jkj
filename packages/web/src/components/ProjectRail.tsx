import { useStore, selectProject, openCentralContext } from '../state/store.js';
import { estimateTokens, statusColor } from '../lib/format.js';

/**
 * The left rail. Central context sits above the project list on purpose — it
 * applies to every project, so it does not belong inside one.
 */
export function ProjectRail() {
  const projects = useStore(s => s.projects);
  const agents = useStore(s => s.agents);
  const selectedId = useStore(s => s.selectedProjectId);
  const central = useStore(s => s.central.body);
  const centralFocused = useStore(s => s.tab === 'context' && s.focusCentral);

  const firstLine = central.split('\n').find(l => l.trim()) ?? '';

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
        <p>
          {firstLine
            ? `${firstLine.slice(0, 78)}${firstLine.length > 78 ? '…' : ''}`
            : 'Empty — write it once and every session picks it up.'}
        </p>
        <span className="cm">
          {central ? `${estimateTokens(central)} tok · ` : ''}every session, every project
        </span>
      </button>

      <h3>Projects</h3>
      {projects.map(project => {
        const own = agents.filter(a => a.projectId === project.id && !a.parentAgentId);
        // A dot per live session. Past sessions are a count, not a row of
        // green — otherwise every project looks equally busy.
        const active = own.filter(a => a.status === 'running' || a.status === 'waiting');
        return (
          <button
            key={project.id}
            className="proj"
            aria-current={project.id === selectedId}
            onClick={() => selectProject(project.id)}
            title={project.path}
          >
            <div className="pname">{project.name}</div>
            <div className="ppath">{project.branch}</div>
            <div className="dots">
              {active.slice(0, 10).map(a => <i key={a.id} style={{ background: statusColor[a.status] }} />)}
              <span>
                {active.length > 0 ? `${active.length} live · ` : ''}
                {own.length - active.length} past
              </span>
            </div>
          </button>
        );
      })}
    </nav>
  );
}
