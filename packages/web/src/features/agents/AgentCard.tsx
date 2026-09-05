import type { Agent } from '@jkj/shared';
import { useStore, openAgent } from '../../state/store.js';
import { ago, fmtTokens } from '../../lib/format.js';
import { Pill } from '../../components/Pill.js';

/** One session at a glance. The whole card opens its transcript. */
export function AgentCard({ agent }: { agent: Agent }) {
  const subagentCount = useStore(s => s.agents.filter(a => a.parentAgentId === agent.id).length);
  const live = agent.status === 'running' || agent.status === 'waiting';

  return (
    <button className={`card s-${agent.status}`} onClick={() => openAgent(agent.id)}>
      <div className="stripe" />
      <div className="top">
        <div style={{ minWidth: 0 }}>
          <div className="an">{agent.name}</div>
          <div className="am">{agent.model}</div>
        </div>
        <Pill tone={agent.status}>{live ? agent.status : 'ended'}</Pill>
      </div>

      <div className="task">{agent.task}</div>

      <div className="foot">
        <span><b>{agent.messageCount ?? 0}</b> msgs</span>
        <span><b>{fmtTokens(agent.usage.outputTokens)}</b> out</span>
        <span>{live ? `started ${ago(agent.startedAt)} ago` : `${ago(agent.endedAt ?? agent.startedAt)} ago`}</span>
        {subagentCount > 0 && (
          <span className="subchip">{subagentCount} subagent{subagentCount > 1 ? 's' : ''}</span>
        )}
        <span className="open">Open →</span>
      </div>
    </button>
  );
}
