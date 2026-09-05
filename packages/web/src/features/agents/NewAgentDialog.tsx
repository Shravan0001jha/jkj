import { useStore, currentProject, setNewAgentOpen } from '../../state/store.js';
import { Modal } from '../../components/Modal.js';

/**
 * Starting a session is the CLI's job until JKJ can own a process. Rather
 * than a form that cannot submit, this hands over the exact command.
 */
export function NewAgentDialog() {
  const project = useStore(currentProject);
  const close = (): void => setNewAgentOpen(false);
  const command = project ? `cd ${project.path} && claude` : 'claude';

  return (
    <Modal
      title="Start a session"
      onClose={close}
      footer={<button className="btn primary" onClick={close}>Got it</button>}
    >
      <p className="lede" style={{ margin: 0 }}>
        JKJ reads what the CLI writes, so sessions still start in a terminal. Run this and it
        will appear here within a couple of seconds.
      </p>
      <pre className="command">{command}</pre>
      <p className="muted" style={{ margin: 0 }}>
        Starting and steering sessions from this window is the next thing on the roadmap.
      </p>
    </Modal>
  );
}
