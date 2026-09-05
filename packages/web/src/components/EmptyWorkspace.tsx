import { useStore, setAddProjectOpen } from '../state/store.js';

/**
 * What the first run looks like when there is nothing to show. Each case says
 * what is missing and what to do about it, rather than an empty grid.
 */
export function EmptyWorkspace() {
  const loading = useStore(s => s.loading);
  const error = useStore(s => s.error);
  const claudeHome = useStore(s => s.claudeHome);

  if (loading) return <p className="lede">Reading your Claude Code sessions…</p>;

  if (error) {
    return (
      <>
        <div className="sec-h"><h2>Could not read your sessions</h2></div>
        <p className="lede">{error}</p>
        <p className="muted narrow">
          JKJ needs the server running on port 4317. In development that is the
          <code> server</code> half of <code>npm run dev</code>.
        </p>
      </>
    );
  }

  if (!claudeHome) {
    return (
      <>
        <div className="sec-h"><h2>No Claude Code state on this machine</h2></div>
        <p className="lede">
          JKJ reads what the <code>claude</code> CLI writes to disk. Nothing was found, which
          usually means Claude Code has not run here yet.
        </p>
        <p className="muted narrow">
          If your configuration lives somewhere unusual, point JKJ at it with{' '}
          <code>CLAUDE_CONFIG_DIR=/path/to/dir</code>.
        </p>
      </>
    );
  }

  return (
    <>
      <div className="sec-h"><h2>No sessions yet</h2></div>
      <p className="lede">
        Found Claude Code at <code>{claudeHome}</code>, but no sessions to show. Add a directory
        and start one from here, or run <code>claude</code> in a project and it will appear on
        its own.
      </p>
      <button className="btn primary" onClick={() => setAddProjectOpen(true)}>＋ Add a project</button>
    </>
  );
}
