import { useState } from 'react';
import type { PermissionMode } from '@jkj/shared';
import { useStore, currentProject, setNewAgentOpen, createSession } from '../../state/store.js';
import { Modal } from '../../components/Modal.js';

const MODES: { id: PermissionMode; label: string; hint: string }[] = [
  { id: 'ask', label: 'Ask me', hint: 'Every tool call that touches your machine waits for you here.' },
  { id: 'auto', label: 'Auto', hint: 'A classifier decides. Only the calls it considers risky reach you.' },
  { id: 'acceptEdits', label: 'Auto-accept edits', hint: 'File edits run without asking. Commands still ask.' },
  { id: 'plan', label: 'Plan only', hint: 'Reads and reasons, but changes nothing until you say so.' },
  { id: 'dontAsk', label: 'Never ask', hint: 'Nothing is asked at all. Everything runs on your machine.' },
];

/** Starts a session JKJ owns, which is the only kind it can then drive. */
export function NewAgentDialog() {
  const project = useStore(currentProject);
  const [task, setTask] = useState('');
  const [model, setModel] = useState('sonnet');
  const [mode, setMode] = useState<PermissionMode>('ask');
  const [starting, setStarting] = useState(false);

  const close = (): void => setNewAgentOpen(false);

  const start = async (): Promise<void> => {
    if (!task.trim() || starting) return;
    setStarting(true);
    await createSession(task.trim(), model, mode);
    setStarting(false);
  };

  return (
    <Modal
      title={`New session in ${project?.name ?? 'this project'}`}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={() => void start()} disabled={!task.trim() || starting}>
            {starting ? 'Starting…' : 'Start session'}
          </button>
        </>
      }
    >
      <div className="f">
        <label htmlFor="na-task">What should it do?</label>
        <textarea
          id="na-task"
          value={task}
          autoFocus
          placeholder="Find why the seat-hold retry returns a 409 and fix it"
          onChange={e => setTask(e.target.value)}
        />
        <div className="hint">Runs in {project?.path}</div>
      </div>

      <div className="f">
        <label htmlFor="na-model">Model</label>
        <select id="na-model" value={model} onChange={e => setModel(e.target.value)}>
          <option value="sonnet">sonnet</option>
          <option value="opus">opus</option>
          <option value="haiku">haiku</option>
        </select>
      </div>

      <div className="f">
        <label>Permissions</label>
        <div className="seg wrap">
          {MODES.map(m => (
            <button key={m.id} type="button" aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <div className="hint">{MODES.find(m => m.id === mode)?.hint}</div>
      </div>
    </Modal>
  );
}
