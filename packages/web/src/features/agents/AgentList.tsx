import { useStore, currentProject, projectAgents, openAgent, closeAgent } from '../../state/store.js';
import { statusColor } from '../../lib/format.js';

/** The column beside an open chat, so switching conversations is one click. */
export function AgentList() {
  const project = useStore(currentProject);
  const agents = useStore(s => projectAgents(s, s.selectedProjectId));
  const openId = useStore(s => s.openAgentId);

  return (
    <div className="chatlist">
      <div className="clh">
        <b>{project.name}</b>
        <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={closeAgent}>
          All agents
        </button>
      </div>
      {agents.map(a => (
        <button key={a.id} className="crow" aria-current={a.id === openId} onClick={() => openAgent(a.id)}>
          <div className="r1">
            <span className="cd" style={{ background: statusColor[a.status] }} />
            <span className="cn">{a.name}</span>
          </div>
          <div className="ct">{a.task}</div>
        </button>
      ))}
    </div>
  );
}
