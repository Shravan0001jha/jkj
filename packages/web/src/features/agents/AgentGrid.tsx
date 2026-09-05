import { useStore, currentProject, projectAgents } from '../../state/store.js';
import { AgentCard } from './AgentCard.js';

export function AgentGrid() {
  const project = useStore(currentProject);
  const agents = useStore(s => projectAgents(s, s.selectedProjectId));

  return (
    <>
      <div className="note">
        <b>Prototype.</b>
        <span>
          Sample data on a simulated stream. Open an agent's chat, approve its request, edit the
          central context, toggle an MCP server — the interactions are real, the work behind them is not.
        </span>
      </div>

      <div className="sec-h">
        <h2>{project.name}</h2>
        <p>{project.path} · {agents.length} agents, each on its own git worktree</p>
      </div>

      {agents.length === 0
        ? <p className="lede">No agents in this project yet. Start one with <b>New agent</b>.</p>
        : <div className="grid">{agents.map(a => <AgentCard key={a.id} agent={a} />)}</div>}
    </>
  );
}
