import type { Agent } from '@jkj/shared';
import {
  useStore, currentProject, closeAgent, openAgent, openCentralContext,
  interruptAgent, restartAgent, archiveAgent, forkAgent, showToast,
  projectContext, agentById,
} from '../../state/store.js';
import { ago, estimateTokens, fmtCost, fmtTokens, totalTokens } from '../../lib/format.js';
import { Pill } from '../../components/Pill.js';
import { Transcript } from './Transcript.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { Composer } from './Composer.js';

/**
 * One conversation. Works for a top-level agent and for a subagent — the
 * only differences are the breadcrumb and which actions make sense.
 */
export function AgentChat({ agent }: { agent: Agent }) {
  const project = useStore(currentProject);
  const parent = useStore(s => agentById(s, agent.parentAgentId ?? null));
  const contextTokens = useStore(s =>
    estimateTokens(s.central.body) + estimateTokens(projectContext(s, s.selectedProjectId).body) + 3550);

  const stopped = agent.status === 'done' || agent.status === 'error' || agent.status === 'idle';
  const isSubagent = Boolean(parent);

  return (
    <div className="chat">
      <div className="crumb">
        <button onClick={closeAgent}>{project.name}</button>
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
          <Pill tone={isSubagent ? 'done' : agent.status}>{isSubagent ? 'subagent' : agent.status}</Pill>
        </div>
        <p className="task">{agent.task}</p>

        <dl className="kv">
          <div><dt>Workspace</dt><dd>{agent.cwd} ({agent.workspace})</dd></div>
          <div><dt>Model</dt><dd>{agent.model}</dd></div>
          {parent
            ? <div><dt>Parent</dt><dd>{parent.name}</dd></div>
            : (
              <div>
                <dt>Context</dt>
                <dd>
                  <button className="linkish" onClick={openCentralContext}>
                    central + {project.name}, {fmtTokens(contextTokens)} tok
                  </button>
                </dd>
              </div>
            )}
          <div>
            <dt>Usage</dt>
            <dd>{fmtTokens(totalTokens(agent.usage))} tok · {fmtCost(agent.usage.costUsd)} · {ago(agent.startedAt)}</dd>
          </div>
        </dl>
      </div>

      <div className="dactions">
        {isSubagent ? (
          <>
            <button className="btn sm" onClick={() => parent && openAgent(parent.id)}>
              ← Back to {parent?.name}
            </button>
            <button className="btn sm" onClick={() => showToast('Promoted — it gets its own worktree and chat.')}>
              Promote to its own agent
            </button>
          </>
        ) : (
          <>
            {stopped
              ? <button className="btn sm primary" onClick={() => restartAgent(agent.id)}>Restart</button>
              : <button className="btn sm" onClick={() => interruptAgent(agent.id)}>⏸ Interrupt</button>}
            <button className="btn sm" onClick={() => showToast(`Opens the diff for ${agent.cwd} — 3 files, +82 −24.`)}>
              View diff
            </button>
            <button className="btn sm" onClick={() => forkAgent(agent.id)}>Fork agent</button>
            <button className="btn sm" onClick={() => showToast(`Attaching a terminal to ${agent.cwd}…`)}>
              Open in terminal
            </button>
            <button className="btn sm danger" style={{ marginLeft: 'auto' }} onClick={() => archiveAgent(agent.id)}>
              Archive
            </button>
          </>
        )}
      </div>

      {agent.approval && <ApprovalPrompt agent={agent} approval={agent.approval} />}

      <Transcript agentId={agent.id} />
      <Composer agent={agent} />
    </div>
  );
}
