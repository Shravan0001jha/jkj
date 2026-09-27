import { useState } from 'react';
import type { Release, Shippable } from '@jkj/shared';
import * as api from '../../api/client.js';
import { loadReleases, showToast, message, startRelease, useStore } from '../../state/store.js';
import { ago } from '../../lib/format.js';
import { Pill } from '../../components/Pill.js';

const SHIPPABLES: Shippable[] = ['desktop-mac', 'desktop-intel', 'windows', 'ios', 'android', 'server-api', 'server-agent', 'website'];

const TONE: Record<Release['state'], string> = {
  proposed: 'waiting', approved: 'running', rejected: 'error', running: 'running', done: 'done', failed: 'error',
};

/**
 * Per shippable: what is merged but unreleased, what has been proposed, and
 * the run button that only lights up once the owner has approved it.
 */
export function ReleasesView() {
  const releases = useStore(s => s.releases);
  const logs = useStore(s => s.releaseLogs);
  const [shippable, setShippable] = useState<Shippable>('desktop-mac');
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);

  const propose = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!version.trim() || busy) return;
    setBusy(true);
    try {
      await api.createRelease({ shippable, version: version.trim() });
      setVersion('');
      showToast('Proposed; it waits in the Inbox for your approval.');
      await loadReleases();
    } catch (err) {
      showToast(message(err));
    }
    setBusy(false);
  };

  return (
    <div className="pane">
      <div className="sec-h"><h2>Releases</h2><p>Nothing ships without your approval in the Inbox. The scripts are the real ones.</p></div>

      <form className="row proposeform" onSubmit={e => void propose(e)}>
        <select value={shippable} onChange={e => setShippable(e.target.value as Shippable)} aria-label="Shippable">
          {SHIPPABLES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <input value={version} onChange={e => setVersion(e.target.value)} placeholder="version, e.g. 0.2.16" aria-label="Version" />
        <button className="btn primary" type="submit" disabled={busy || !version.trim()}>Propose</button>
      </form>

      <div className="stack">
        {releases.map(r => (
          <article key={r.id} className="inboxcard">
            <div className="ih">
              <Pill tone={TONE[r.state]}>{r.state}</Pill>
              <h3>{r.shippable} {r.version}</h3>
              <span className="muted">{ago(r.createdAt)} ago</span>
              <button className="btn sm primary" style={{ marginLeft: 'auto' }} disabled={r.state !== 'approved'} onClick={() => void startRelease(r.id)}
                title={r.state === 'approved' ? 'Runs the real script now' : 'Needs your approval in the Inbox first'}>
                Run
              </button>
            </div>
            <details className="diff">
              <summary>Merged but unreleased ({r.unreleased.length})</summary>
              <ul>{r.unreleased.map(u => <li key={u}>{u}</li>)}{r.unreleased.length === 0 && <li className="muted">nothing recorded</li>}</ul>
            </details>
            {(logs[r.id]?.length || r.log) && (
              <pre className="rellog">{(logs[r.id]?.length ? logs[r.id] : (r.log ?? '').split('\n'))!.slice(-40).join('\n')}</pre>
            )}
          </article>
        ))}
        {releases.length === 0 && <p className="muted">No releases proposed yet.</p>}
      </div>
    </div>
  );
}
