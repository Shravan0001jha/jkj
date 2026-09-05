import type { Agent } from '@jkj/shared';
import {
  useStore, currentProject, closeAgent, openAgent, openCentralContext,
  interruptAgent, archiveAgent, showToast, agentById,
} from '../../state/store.js';
import { ago, fmtTokens } from '../../lib/format.js';
import { Pill } from '../../components/Pill.js';
import { Transcript } from './Transcript.js';
import { Composer } from './Composer.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';

/**
 * One session's transcript. Works for a session and for a subagent run inside
 * one — the only differences are the breadcrumb and which actions apply.
 */
export function AgentChat({ agent }: { agent: Agent }) {
  const project = useStore(currentProject);
  const parent = useStore(s => agentById(s, agent.parentAgentId ?? null));

  const isSubagent = Boolean(parent);
  const live = agent.status === 'running' || agent.status === 'waiting';

  return (
    <div className="chat">
      <div className="crumb">
        <button onClick={closeAgent}>{project?.name}</button>
        <span>›</span>
        {parent ? (
          <>
            <button onClick={() => openAgent(parent.id)}>{parent.name}</button>
            <span>›</span>
            <span>{agent.name}</span>
          </>
        ) : (
          <span>{agent.name}</span>
        )}
      </div>

      <div className="dhead">
        <div className="r1">
          <h2>{agent.name}</h2>
          <Pill tone={isSubagent ? 'done' : agent.status}>
            {isSubagent ? 'subagent' : live ? agent.status : 'ended'}
          </Pill>
          {agent.driven && <Pill tone="idle">driven by JKJ</Pill>}
        </div>
        <p className="task">{agent.task}</p>

        <dl className="kv">
          <div><dt>Directory</dt><dd>{agent.cwd}</dd></div>
          <div><dt>Model</dt><dd>{agent.model}</dd></div>
          {parent
            ? <div><dt>Parent</dt><dd>{parent.name}</dd></div>
            : <div><dt>Session</dt><dd>{agent.id.slice(0, 8)}</dd></div>}
          <div>
            <dt>Usage</dt>
            <dd>
              {agent.messageCount ?? 0} messages · {fmtTokens(agent.usage.outputTokens)} tokens out ·
              started {ago(agent.startedAt)} ago{agent.endedAt ? `, ended ${ago(agent.endedAt)} ago` : ''}
            </dd>
          </div>
        </dl>
      </div>

      <div className="dactions">
        {isSubagent ? (
          <button className="btn sm" onClick={() => parent && openAgent(parent.id)}>
            ← Back to {parent?.name}
          </button>
        ) : (
          <>
            <button
              className="btn sm"
              disabled={agent.status !== 'running' || !agent.driven}
              onClick={() => interruptAgent(agent.id)}
            >
              ⏸ Interrupt
            </button>
            {agent.driven ? (
              <button className="btn sm danger" style={{ marginLeft: 'auto' }} onClick={() => void archiveAgent(agent.id)}>
                Close session
              </button>
            ) : (
              <button
                className="btn sm"
                onClick={() => showToast(`Continue it in a terminal with:  claude --resume ${agent.id}`)}
              >
                Resume command
              </button>
            )}
          </>
        )}
        <button className="btn sm ghost" onClick={openCentralContext}>Context</button>
      </div>

      {agent.approval && <ApprovalPrompt agent={agent} approval={agent.approval} />}

      <Transcript agentId={agent.id} />
      <Composer agent={agent} />
    </div>
  );
}
