import type { Agent } from '@jkj/shared';
import { useStore, closeAgent, openAgent, interruptAgent, agentById } from '../../state/store.js';
import { ago, fmtTokens, statusTone } from '../../lib/format.js';
import { Pill } from '../../components/Pill.js';
import { Transcript } from './Transcript.js';
import { Composer } from './Composer.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { PermissionModePicker } from './PermissionModePicker.js';
import { WorkingIndicator } from './WorkingIndicator.js';

/**
 * One session's transcript, with the controls the Workplace keeps from JKJ:
 * steer, interrupt, approve each tool call, change how much it asks.
 */
export function AgentChat({ agent }: { agent: Agent; back?: () => void }) {
  const parent = useStore(s => agentById(s, agent.parentAgentId ?? null));
  const isSubagent = Boolean(parent);
  const live = agent.status === 'running' || agent.status === 'waiting';

  return (
    <div className="chat">
      <div className="dhead slim">
        <div className="r1">
          {parent && <button className="linkish" onClick={() => openAgent(parent.id)}>← {parent.name}</button>}
          <h2>{agent.name}</h2>
          <Pill tone={isSubagent ? 'idle' : statusTone(agent.status)}>
            {isSubagent ? 'subagent' : live ? agent.status : 'ended'}
          </Pill>
          <span className="muted">
            {agent.model} · {agent.messageCount ?? 0} messages · {fmtTokens(agent.usage.outputTokens)} tok out
            {agent.contextTokens ? ` · ${fmtTokens(agent.contextTokens)} context` : ''} · started {ago(agent.startedAt)} ago
          </span>
        </div>
      </div>

      <div className="dactions">
        {agent.driven && <PermissionModePicker agent={agent} />}
        {!isSubagent && (
          <button className="btn sm" disabled={agent.status !== 'running' || !agent.driven} onClick={() => interruptAgent(agent.id)}>
            ⏸ Interrupt
          </button>
        )}
        {isSubagent && <button className="btn sm ghost" onClick={closeAgent}>Back to the session</button>}
      </div>

      {agent.approval && <ApprovalPrompt agent={agent} approval={agent.approval} />}

      <Transcript agentId={agent.id} />
      {agent.status === 'running' && !agent.approval && <WorkingIndicator agent={agent} />}
      <Composer agent={agent} />
    </div>
  );
}
