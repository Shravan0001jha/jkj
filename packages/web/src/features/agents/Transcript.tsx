import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { toChatView } from '@jkj/shared';
import { useStore, transcriptOf, openAgent, loadTranscript } from '../../state/store.js';
import { TranscriptEntry } from './TranscriptEntry.js';

/**
 * The scrolling transcript. In `chat` view (the default: "Talk must read like a chat", owner 29
 * Sep) tool calls collapse into one expandable "worked · N steps · Xs" line and only the owner's
 * and the employee's messages stand out; `full` shows everything, dense and monospaced. The same
 * `toChatView` transform the server uses for `?view=chat` runs here too, live, over whatever is
 * already in the store — a raw tool-call entry that just arrived over the socket collapses the
 * moment it lands, not only on the next full reload.
 */
export function Transcript({ agentId, view = 'chat' }: { agentId: string; view?: 'chat' | 'full' }) {
  const raw = useStore(s => transcriptOf(s, agentId));
  const entries = useMemo(() => (view === 'chat' ? toChatView(raw) : raw), [raw, view]);
  const subagents = useStore(s => s.agents.filter(a => a.parentAgentId === agentId));
  const loaded = useStore(s => agentId in s.transcripts);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loaded) void loadTranscript(agentId);
  }, [agentId, loaded]);

  // A conversation opens where it left off, not at its beginning. Done
  // before paint so the newest message is simply there, with no visible jump.
  const landed = useRef<string | null>(null);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || entries.length === 0 || landed.current === agentId) return;
    landed.current = agentId;
    box.scrollTop = box.scrollHeight;
  }, [agentId, entries.length]);

  // After that, follow the stream only while the reader is already at the
  // bottom — yanking the view mid-read is worse than falling behind.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || landed.current !== agentId) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
    if (atBottom) box.scrollTop = box.scrollHeight;
  }, [agentId, entries.length]);

  // Subagent runs are listed once, after the transcript, because the records
  // do not say which Task call each one came from.
  return (
    <div className="log" ref={boxRef}>
      {!loaded && <div className="muted">Reading transcript…</div>}
      {loaded && entries.length === 0 && <div className="muted">This session has no readable messages.</div>}

      {entries.map(entry => (
        <TranscriptEntry key={entry.id} entry={entry} agentId={agentId} />
      ))}

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
