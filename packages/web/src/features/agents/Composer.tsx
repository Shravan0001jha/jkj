import { useState } from 'react';
import type { Agent } from '@jkj/shared';
import { sendMessage } from '../../state/store.js';

/**
 * Steering a live session is the next thing JKJ learns to do. The box is here
 * so its shape is settled; today it explains why it cannot send.
 */
export function Composer({ agent }: { agent: Agent }) {
  const [text, setText] = useState('');
  const live = agent.status === 'running' || agent.status === 'waiting';

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!text.trim()) return;
    setText('');
    sendMessage();
  };

  return (
    <form className="composer" onSubmit={submit}>
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={live ? `Message ${agent.name}…` : 'This session has ended'}
        aria-label="Message this session"
        autoComplete="off"
        disabled={!live}
      />
      <button className="btn sm primary" type="submit" disabled={!live}>Send</button>
    </form>
  );
}
