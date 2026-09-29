import type { LogEntry } from '@jkj/shared';
import { API } from '@jkj/shared';
import { hhmm } from '../../lib/format.js';
import { Markdown } from '../../components/Markdown.js';

/**
 * One line of a transcript. Three shapes, because three kinds of thing
 * happened: you said something, the model said something, or a tool ran.
 */
export function TranscriptEntry({ entry, agentId }: { entry: LogEntry; agentId: string }) {
  if (entry.kind === 'image' && entry.image) {
    return (
      <figure className="shot">
        <img src={API.agentImage(agentId, entry.image.ref)} alt="Pasted into the conversation" loading="lazy" />
        <figcaption>{hhmm(entry.at)} · pasted image</figcaption>
      </figure>
    );
  }

  if (entry.kind === 'user') {
    return (
      <div className="turn me">
        <div className="stamp">{hhmm(entry.at)}</div>
        <div className="bubble">{entry.text}</div>
      </div>
    );
  }

  if (entry.kind === 'assistant') {
    // One line to the owner (D16): the summary is the reply; the rest waits behind "Details".
    if (entry.summary) {
      return (
        <div className="turn them">
          <div className="stamp">{hhmm(entry.at)}</div>
          <div className="bubble">{entry.summary}</div>
          {entry.details && <details className="more"><summary>Details</summary><Markdown text={entry.details} /></details>}
        </div>
      );
    }
    return (
      <div className="turn them">
        <div className="stamp">{hhmm(entry.at)}</div>
        <Markdown text={entry.text} />
      </div>
    );
  }

  // The chat view (toChatView, @jkj/shared): a run of consecutive tool calls collapsed to one line,
  // expandable to the full log underneath it.
  if (entry.kind === 'activity' && entry.activity) {
    return (
      <details className="activity">
        <summary>{entry.text}</summary>
        <div className="activitylog">
          {entry.activity.entries.map(e => <TranscriptEntry key={e.id} entry={e} agentId={agentId} />)}
        </div>
      </details>
    );
  }

  // Everything else is a tool call: dense, monospaced, scannable in a column.
  return (
    <div className={`ln ${entry.kind}`}>
      <span className="t">{hhmm(entry.at)}</span>
      <span className="k">{entry.label}</span>
      <span className="v">{entry.text}</span>
    </div>
  );
}
