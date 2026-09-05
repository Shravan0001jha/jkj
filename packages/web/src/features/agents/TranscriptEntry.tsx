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
    return (
      <div className="turn them">
        <div className="stamp">{hhmm(entry.at)}</div>
        <Markdown text={entry.text} />
      </div>
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
