import { useState } from 'react';
import type { Agent } from '@jkj/shared';
import { sendMessage } from '../../state/store.js';

/**
 * Steer a session JKJ started. One started in a terminal owns its own input,
 * so the box says why it is closed rather than pretending to send.
 */
export function Composer({ agent }: { agent: Agent }) {
  const [text, setText] = useState('');
  const canSend = agent.driven === true;

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText('');
    sendMessage(agent.id, value);
  };

  const placeholder = canSend
    ? `Message ${agent.name}…`
    : 'Started in a terminal — JKJ can read it, but only that terminal can type into it';

  return (
    <form className="composer" onSubmit={submit}>
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={placeholder}
        aria-label="Message this session"
        autoComplete="off"
        disabled={!canSend}
      />
      <button className="btn sm primary" type="submit" disabled={!canSend}>Send</button>
    </form>
  );
}
