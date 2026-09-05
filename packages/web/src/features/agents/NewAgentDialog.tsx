import { useState } from 'react';
import type { WorkspaceMode } from '@jkj/shared';
import {
  useStore, currentProject, projectContext, setNewAgentOpen, createAgent, openCentralContext,
} from '../../state/store.js';
import { estimateTokens, fmtTokens } from '../../lib/format.js';
import { Modal } from '../../components/Modal.js';

const WORKSPACES: { id: WorkspaceMode; label: string; hint: string }[] = [
  { id: 'worktree', label: 'New git worktree', hint: "Isolated checkout, so this agent can't collide with the others already running." },
  { id: 'branch', label: 'Current branch', hint: 'Shares the working tree. JKJ queues its writes behind the other agents.' },
  { id: 'readonly', label: 'Read-only', hint: 'Can read and run commands, but every edit needs your approval.' },
];

export function NewAgentDialog() {
  const project = useStore(currentProject);
  const contextTokens = useStore(s =>
    estimateTokens(s.central.body) + estimateTokens(projectContext(s, s.selectedProjectId).body) + 3550);

  const [task, setTask] = useState('Cache the airport lookup — it hits Postgres on every request');
  const [model, setModel] = useState('opus-5');
  const [workspace, setWorkspace] = useState<WorkspaceMode>('worktree');

  const close = () => setNewAgentOpen(false);

  return (
    <Modal
      title={`New agent in ${project.name}`}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={() => createAgent(task, model, workspace)}>Start agent</button>
        </>
      }
    >
      <div className="f">
        <label htmlFor="na-task">Task</label>
        <textarea id="na-task" value={task} onChange={e => setTask(e.target.value)} />
      </div>

      <div className="f">
        <label htmlFor="na-model">Model</label>
        <select id="na-model" value={model} onChange={e => setModel(e.target.value)}>
          <option value="opus-5">opus-5</option>
          <option value="sonnet-5">sonnet-5</option>
          <option value="haiku-4.5">haiku-4.5</option>
        </select>
      </div>

      <div className="f">
        <label>Workspace</label>
        <div className="seg">
          {WORKSPACES.map(w => (
            <button
              key={w.id}
              type="button"
              aria-pressed={workspace === w.id}
              onClick={() => setWorkspace(w.id)}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div className="hint">{WORKSPACES.find(w => w.id === workspace)?.hint}</div>
      </div>

      <div className="f">
        <label>Context it will receive</label>
        <div className="hint" style={{ margin: 0 }}>
          Central preferences + {project.name} context — {fmtTokens(contextTokens)} tokens.{' '}
          <button className="linkish" onClick={() => { close(); openCentralContext(); }}>
            Edit central context
          </button>
        </div>
      </div>
    </Modal>
  );
}
