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
  const [busy, setBusy] = useState(false);

  // A session still open in a terminal is the only unreachable kind: that
  // process owns its input. A finished one is picked back up on send.
  const openElsewhere = !agent.driven && (agent.status === 'running' || agent.status === 'waiting');
  const isSubagent = Boolean(agent.parentAgentId);
  const canSend = !openElsewhere && !isSubagent;
  const resuming = !agent.driven && canSend;

  // Opening a session you can type into should leave the cursor in the box.
  useEffect(() => {
    if (canSend) inputRef.current?.focus();
  }, [agent.id, canSend]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setText('');
    setBusy(true);
    await sendMessage(agent.id, value);
    setBusy(false);
  };

  // A disabled box that swallows clicks reads as a broken control. Say what
  // is going on instead, and offer the command that does work.
  if (!canSend) {
    return (
      <div className="composer readonly">
        <span>
          {isSubagent
            ? 'A subagent run is part of its parent session. Continue the parent instead.'
            : <>This session is open in a terminal right now, so that terminal owns its input.
                Close it there and it becomes continuable here.</>}
        </span>
      </div>
    );
  }

  return (
    <form className="composer" onSubmit={e => void submit(e)}>
      <input
        ref={inputRef}
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={resuming ? 'Continue this session…' : `Message ${agent.name}…`}
        aria-label="Message this session"
        autoComplete="off"
        disabled={busy}
      />
      <button className="btn sm primary" type="submit" disabled={!text.trim() || busy}>
        {busy ? 'Continuing…' : resuming ? 'Continue' : 'Send'}
      </button>
    </form>
  );
}
