import { useEffect, useRef } from 'react';
import { useStore, transcriptOf, openAgent, loadTranscript } from '../../state/store.js';
import { hhmm } from '../../lib/format.js';

/**
 * The scrolling transcript. Tool calls read as a log, prose reads as chat,
 * and a Task line links into the subagent's own transcript.
 */
export function Transcript({ agentId }: { agentId: string }) {
  const entries = useStore(s => transcriptOf(s, agentId));
  const subagents = useStore(s => s.agents.filter(a => a.parentAgentId === agentId));
  const loaded = useStore(s => agentId in s.transcripts);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loaded) void loadTranscript(agentId);
  }, [agentId, loaded]);

  // Follow the stream, but only when the reader is already at the bottom.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    if (atBottom) box.scrollTop = box.scrollHeight;
  }, [entries.length]);

  // Subagent runs are listed once, after the transcript, because the records
  // do not say which Task call each one came from.
  return (
    <div className="log" ref={boxRef}>
      {!loaded && <div className="muted">Reading transcript…</div>}
      {loaded && entries.length === 0 && <div className="muted">This session has no readable messages.</div>}

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
          <div className={`ln ${entry.kind}`} key={entry.id}>
            <span className="t">{hhmm(entry.at)}</span>
            <span className="k">{entry.label}</span>
            <span className="v">{entry.text}</span>
          </div>
        );
      })}

      {subagents.length > 0 && (
        <div className="subtree">
          {subagents.map(sub => (
            <button className="subopen" key={sub.id} onClick={() => openAgent(sub.id)}>
              Open {sub.name} →
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
