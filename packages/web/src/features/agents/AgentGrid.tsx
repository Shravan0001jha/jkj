import { useStore, currentProject, projectAgents } from '../../state/store.js';
import { AgentCard } from './AgentCard.js';

export function AgentGrid() {
  const project = useStore(currentProject);
  const agents = useStore(s => projectAgents(s, s.selectedProjectId));

  if (!project) return null;

  const live = agents.filter(a => a.status === 'running' || a.status === 'waiting');
  const past = agents.filter(a => a.status !== 'running' && a.status !== 'waiting');

  return (
    <>
      <div className="sec-h">
        <h2>{project.name}</h2>
        <p>
          {project.path} · {live.length} live, {past.length} past
        </p>
      </div>

      {live.length > 0 && (
        <>
          <h3 className="group">Running now</h3>
          <div className="grid">{live.map(a => <AgentCard key={a.id} agent={a} />)}</div>
        </>
      )}

      {past.length > 0 && (
        <>
          <h3 className="group">Earlier sessions</h3>
          <div className="grid">{past.map(a => <AgentCard key={a.id} agent={a} />)}</div>
        </>
      )}

      {agents.length === 0 && (
        <p className="lede">
          No sessions recorded for this project yet.
        </p>
      )}
    </>
  );
}
