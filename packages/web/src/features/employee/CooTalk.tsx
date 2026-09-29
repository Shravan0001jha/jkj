import { useEffect, useState } from 'react';
import { loadCooLog, sendToCoo, useStore } from '../../state/store.js';
import { hhmm } from '../../lib/format.js';
import { Markdown } from '../../components/Markdown.js';
import { GrowTextarea } from '../../components/GrowTextarea.js';

/**
 * The owner's Talk with "Claude — COO". Not a session: no tool calls, no thinking, no mirroring —
 * only what the owner sent here and what the lead sent back through `POST /api/coo/reply`. Loopback
 * only, like the bridge itself; opened through the published relay the log is simply empty.
 */
export function CooTalk({ online }: { online: boolean }) {
  const log = useStore(s => s.cooLog);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { void loadCooLog(); }, []);

  const send = async (): Promise<void> => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    await sendToCoo(value);
    setText('');
    setBusy(false);
  };

  return (
    <div className="chat cootalk">
      {!online && (
        <p className="lede">The COO is offline: messages wait; Asha handles routine work in the meantime.</p>
      )}
      <div className="log">
        {log.length === 0 && <div className="muted">Nothing yet. Say what you need.</div>}
        {log.map(m => (
          <div className={`turn ${m.from === 'owner' ? 'me' : 'them'}`} key={m.id}>
            <div className="stamp">{hhmm(m.at)}</div>
            <div className="bubble">{m.summary ?? m.text}</div>
            {m.details && <details className="more"><summary>Details</summary><Markdown text={m.details} /></details>}
          </div>
        ))}
      </div>
      <form className="composer" onSubmit={e => { e.preventDefault(); void send(); }}>
        <GrowTextarea value={text} onChange={setText} placeholder="Message the COO…" rows={1} minHeight={38} maxHeight={220} disabled={busy}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button className="btn sm primary" type="submit" disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Send'}</button>
      </form>
    </div>
  );
}
