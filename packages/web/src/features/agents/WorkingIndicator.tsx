import { useEffect, useRef, useState } from 'react';
import type { Agent, LogEntry } from '@jkj/shared';
import { useStore, transcriptOf, interruptAgent } from '../../state/store.js';
import { fmtTokens } from '../../lib/format.js';

/**
 * Proof that something is happening.
 *
 * A transcript that has not printed a line for twenty seconds is
 * indistinguishable from one that has hung, so this sits under it while a
 * turn is in flight: what the session is doing right now, how long it has
 * been at it, and a way out.
 *
 * The phrase is taken from the last thing the session actually did whenever
 * there is one — a real "Reading src/App.tsx" beats a generic verb. The
 * cycling words are only for the stretch before the first tool call, where
 * there is genuinely nothing to report.
 */

const THINKING = [
  'Thinking', 'Working through it', 'Considering', 'Reasoning',
  'Weighing options', 'Piecing it together', 'Looking closer', 'Still going',
];

/** How often the placeholder word changes, when one is being used. */
const PHRASE_MS = 4000;

export function WorkingIndicator({ agent }: { agent: Agent }) {
  const entries = useStore(s => transcriptOf(s, agent.id));
  const [now, setNow] = useState(() => Date.now());
  const startedAt = useRef<number>(Date.now());
  const lastCount = useRef(entries.length);

  // The clock runs from the start of this turn, not the session, so the
  // number answers "how long has it been stuck" rather than "how old is it".
  if (entries.length !== lastCount.current) {
    lastCount.current = entries.length;
    startedAt.current = Date.now();
  }

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.round((now - startedAt.current) / 1000));
  const phrase = describe(entries[entries.length - 1], seconds);
  const tokens = agent.usage.outputTokens;

  return (
    <div className="working" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="phrase">{phrase}</span>
      <span className="meta">
        {seconds}s
        {tokens > 0 && <> · {fmtTokens(tokens)} tokens</>}
      </span>
      {agent.driven && (
        <button className="linkish" onClick={() => interruptAgent(agent.id)}>interrupt</button>
      )}
    </div>
  );
}

/** What to say we are doing, preferring fact over flavour. */
function describe(last: LogEntry | undefined, seconds: number): string {
  if (last && last.kind !== 'assistant' && last.kind !== 'user') {
    const target = shorten(last.text);
    switch (last.kind) {
      case 'read': return `Reading ${target}`;
      case 'edit': return `Editing ${target}`;
      case 'bash': return `Running ${target}`;
      case 'search': return `Searching ${target}`;
      case 'task': return 'Waiting on a subagent';
      default: return `${last.label || 'Working'} ${target}`.trim();
    }
  }

  // Nothing has happened yet this turn, so say something honest and move on.
  return THINKING[Math.floor(seconds / (PHRASE_MS / 1000)) % THINKING.length]!;
}

/** Paths keep their filename; commands keep their first clause. */
function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const compact = oneLine.includes('/') && !oneLine.includes(' ')
    ? oneLine.split('/').slice(-2).join('/')
    : oneLine;
  return compact.length > 52 ? `${compact.slice(0, 52)}…` : compact;
}
