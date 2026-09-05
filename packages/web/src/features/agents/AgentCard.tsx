import type { Agent } from '@jkj/shared';
import { useStore, openAgent, transcriptOf } from '../../state/store.js';
import { ago, fmtCost, fmtTokens, totalTokens } from '../../lib/format.js';
import { Pill } from '../../components/Pill.js';

/** One agent at a glance. The whole card is the button that opens its chat. */
export function AgentCard({ agent }: { agent: Agent }) {
  const transcript = useStore(s => transcriptOf(s, agent.id));
  const subagentCount = useStore(s => s.agents.filter(a => a.parentAgentId === agent.id).length);

  const lastAction = [...transcript].reverse().find(l => l.kind !== 'assistant' && l.kind !== 'user');

  return (
    <button className={`card s-${agent.status}`} onClick={() => openAgent(agent.id)}>
      <div className="stripe" />
      <div className="top">
        <div style={{ minWidth: 0 }}>
          <div className="an">{agent.name}</div>
          <div className="am">{agent.model} · {agent.cwd.split('/').pop()}</div>
        </div>
        <Pill tone={agent.status}>{agent.status}</Pill>
      </div>

      <div className="task">{agent.task}</div>

      <div className="now">
        {lastAction ? `${lastAction.label} ${lastAction.text}` : 'not started'}
      </div>

      <div className="foot">
        <span><b>{fmtTokens(totalTokens(agent.usage))}</b> tok</span>
        <span><b>{fmtCost(agent.usage.costUsd)}</b></span>
        <span>{ago(agent.startedAt)}</span>
        {subagentCount > 0 && (
          <span className="subchip">{subagentCount} subagent{subagentCount > 1 ? 's' : ''}</span>
        )}
        <span className="open">Open chat →</span>
      </div>
    </button>
  );
}
