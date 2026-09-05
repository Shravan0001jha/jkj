import type { Agent, PermissionMode } from '@jkj/shared';
import { setPermissionMode } from '../../state/store.js';

const MODES: { id: PermissionMode; label: string; hint: string }[] = [
  { id: 'ask', label: 'Ask me', hint: 'Every tool call waits for you.' },
  { id: 'auto', label: 'Auto', hint: 'A classifier decides, and only the risky calls reach you.' },
  { id: 'acceptEdits', label: 'Edits', hint: 'File edits run without asking. Commands still ask.' },
  { id: 'dontAsk', label: 'Never ask', hint: 'Nothing is asked. Everything runs on your machine.' },
];

/**
 * How much this session asks, changeable while it runs.
 *
 * The whole point is not having to answer the same prompt twenty times, so
 * this is one click away from the transcript rather than buried in a setting
 * you can only choose before starting.
 */
export function PermissionModePicker({ agent }: { agent: Agent }) {
  const current = agent.permissionMode ?? 'ask';

  return (
    <div className="modepicker" title={MODES.find(m => m.id === current)?.hint}>
      <span className="mplabel">Asks</span>
      <div className="seg small">
        {MODES.map(mode => (
          <button
            key={mode.id}
            type="button"
            aria-pressed={current === mode.id}
            onClick={() => setPermissionMode(agent.id, mode.id)}
            title={mode.hint}
          >
            {mode.label}
          </button>
        ))}
      </div>
    </div>
  );
}
