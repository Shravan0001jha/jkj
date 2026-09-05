import { useEffect, useRef, useState } from 'react';
import type { Agent } from '@jkj/shared';
import { sendMessage } from '../../state/store.js';

/**
 * Steer a session JKJ started. One started in a terminal owns its own input,
 * so the box says why it is closed rather than pretending to send.
 */
export function Composer({ agent }: { agent: Agent }) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const canSend = agent.driven === true;

  // Opening a session you can drive should leave the cursor where you type.
  useEffect(() => {
    if (canSend) inputRef.current?.focus();
  }, [agent.id, canSend]);

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText('');
    sendMessage(agent.id, value);
  };

  // A disabled box that swallows clicks reads as a broken control. Say what
  // is going on instead, and offer the command that does work.
  if (!canSend) {
    return (
      <div className="composer readonly">
        <span>
          Started in a terminal, so only that terminal can type into it. Continue it there with{' '}
          <code>claude --resume {agent.id}</code>
        </span>
      </div>
    );
  }

  return (
    <form className="composer" onSubmit={submit}>
      <input
        ref={inputRef}
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={`Message ${agent.name}…`}
        aria-label="Message this session"
        autoComplete="off"
      />
      <button className="btn sm primary" type="submit" disabled={!text.trim()}>Send</button>
    </form>
  );
}
