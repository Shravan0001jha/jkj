import { useEffect, useRef } from 'react';
import { useStore, transcriptOf, openAgent } from '../../state/store.js';
import { hhmm } from '../../lib/format.js';

/**
 * The scrolling conversation. Tool calls read as a log; prose reads as chat;
 * a Task line carries a link into the subagent's own conversation.
 */
export function Transcript({ agentId }: { agentId: string }) {
  const entries = useStore(s => transcriptOf(s, agentId));
  const subagents = useStore(s => s.agents.filter(a => a.parentAgentId === agentId));
  const boxRef = useRef<HTMLDivElement>(null);

  // Follow the stream, but only when the reader is already at the bottom.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    if (atBottom) box.scrollTop = box.scrollHeight;
  }, [entries.length]);

  const subagentName = (id: string) => subagents.find(a => a.id === id)?.name ?? 'subagent';

  return (
    <div className="log" ref={boxRef}>
      {entries.length === 0 && <div className="muted">No output yet.</div>}

      {entries.map(entry => {
        if (entry.kind === 'user') {
          return (
            <div className="ln me" key={entry.id}>
              <span className="t">{hhmm(entry.at)}</span>
              <span className="v">{entry.text}</span>
            </div>
          );
        }
        if (entry.kind === 'assistant') {
          return (
            <div className="ln say" key={entry.id}>
              <span className="t">{hhmm(entry.at)}</span>
              <span className="v">{entry.text}</span>
            </div>
          );
        }
        return (
          <div key={entry.id}>
            <div className={`ln ${entry.kind}`}>
              <span className="t">{hhmm(entry.at)}</span>
              <span className="k">{entry.label}</span>
              <span className="v">{entry.text}</span>
            </div>
            {entry.subagentId && (
              <div className="subtree">
                <button className="subopen" onClick={() => openAgent(entry.subagentId!)}>
                  Open {subagentName(entry.subagentId)} chat →
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
