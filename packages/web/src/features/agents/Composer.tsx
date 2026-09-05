import { useState } from 'react';
import type { Agent } from '@jkj/shared';
import { sendMessage, showToast } from '../../state/store.js';

/** Steer a running agent without stopping it. */
export function Composer({ agent }: { agent: Agent }) {
  const [text, setText] = useState('');
  const isSubagent = Boolean(agent.parentAgentId);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText('');
    if (isSubagent) {
      showToast('Re-running the subagent with your brief.');
      return;
    }
    sendMessage(agent.id, value);
  };

  return (
    <form className="composer" onSubmit={submit}>
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={isSubagent ? 'Re-run this subagent with a different brief…' : `Message ${agent.name}…`}
        aria-label="Message this agent"
        autoComplete="off"
      />
      <button className="btn sm primary" type="submit">Send</button>
    </form>
  );
}
