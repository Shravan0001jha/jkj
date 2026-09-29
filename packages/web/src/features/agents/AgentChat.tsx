import { useState } from 'react';
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
 * steer, interrupt, approve each tool call, change how much it asks. Defaults to the chat view
 * (owner 29 Sep); "Full log" switches to every tool call and search, still one tap away.
 */
export function AgentChat({ agent }: { agent: Agent; back?: () => void }) {
  const parent = useStore(s => agentById(s, agent.parentAgentId ?? null));
  const isSubagent = Boolean(parent);
  const live = agent.status === 'running' || agent.status === 'waiting';
  const [view, setView] = useState<'chat' | 'full'>('chat');

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
        <div className="seg small" style={{ marginLeft: isSubagent ? 0 : 'auto' }}>
          <button aria-pressed={view === 'chat'} onClick={() => setView('chat')}>Chat</button>
          <button aria-pressed={view === 'full'} onClick={() => setView('full')}>Full log</button>
        </div>
      </div>

      {agent.approval && <ApprovalPrompt agent={agent} approval={agent.approval} />}

      <Transcript agentId={agent.id} view={view} />
      {agent.status === 'running' && !agent.approval && <WorkingIndicator agent={agent} />}
      <Composer agent={agent} />
    </div>
  );
}
