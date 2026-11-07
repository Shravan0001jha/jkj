import { useState } from 'react';
import type { Release, ReleasePost, ReleaseReadiness, Shippable } from '@jkj/shared';
import * as api from '../../api/client.js';
import { v2Api } from '../../api/client.js';
import { useApi } from '../../lib/useApi.js';
import { hrefFor, loadReleases, showToast, message, startRelease, useStore } from '../../state/store.js';
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
  const readiness = useStore(s => s.readiness);
  const [shippable, setShippable] = useState<Shippable>('desktop-mac');
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const last = readiness.find(r => r.shippable === shippable)?.last;

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
        <input value={version} onChange={e => setVersion(e.target.value)} placeholder={last ? `version; last was ${last.version}` : 'version, e.g. 0.2.16'} aria-label="Version" />
        <button className="btn primary" type="submit" disabled={busy || !version.trim()}>Propose</button>
      </form>

      {readiness.length > 0 && (
        <section className="ready">
          <h3 className="group">Ready to release</h3>
          <div className="stack tight">
            {readiness.map(r => <ReadyRow key={r.shippable} r={r} onPropose={() => setShippable(r.shippable)} />)}
          </div>
        </section>
      )}

      <h3 className="group">Proposed and past</h3>
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

      <MacQueue />
      <Posts />
    </div>
  );
}

/** The Mac test-slot queue (parity with the app, HLD §6): who holds the Mac, who waits, and a grant-now button. */
function MacQueue() {
  const { data, reload } = useApi(() => v2Api.macQueue(), 'macqueue');
  if (!data || (!data.active && data.queue.length === 0)) return null;
  const grant = (id: string): void => { v2Api.macGrant(id).then(() => { showToast('Granted'); reload(); }, err => showToast(message(err))); };
  return (
    <section>
      <h3 className="group">Mac test slot</h3>
      {data.active && <p>Now: <b>{data.active.emp}</b> on <a href={hrefFor('item', data.active.itemId)}>{data.active.itemId}</a>{data.active.until ? ` until ${new Date(data.active.until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''} — {data.active.why}</p>}
      <div className="stack tight">
        {data.queue.map(q => (
          <div key={q.id} className="epicrow">
            <div className="em"><b>{q.emp}</b> · {q.minutes} min · <a href={hrefFor('item', q.itemId)}>{q.itemId}</a><div className="muted">{q.why} · asked {ago(q.at)} ago</div></div>
            <div className="acts"><button className="btn sm" onClick={() => grant(q.id)}>Grant now</button></div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Release posts (parity with the app, HLD §6): what each release shipped, by area. */
function Posts() {
  const { data } = useApi<ReleasePost[]>(() => v2Api.releasePosts(), 'releaseposts');
  if (!data?.length) return null;
  return (
    <section>
      <h3 className="group">Release notes</h3>
      {data.slice(0, 10).map(p => (
        <details key={p.id} className="card report">
          <summary><b>{p.title}</b> <span className="muted">{p.version}{p.shippable ? ` · ${p.shippable}` : ''} · {ago(p.at)} ago</span></summary>
          {p.groups.map(g => (
            <div key={g.areaId ?? 'none'}>
              <h4>{g.areaTitle}</h4>
              <ul className="refs">{g.items.map(i => <li key={i.id}><a href={hrefFor('item', i.id)}>{i.title}</a>{i.kind === 'fix' ? <span className="muted"> · fix</span> : null}</li>)}</ul>
            </div>
          ))}
        </details>
      ))}
    </section>
  );
}

/** One shippable: what is done and unreleased, what is in flight, what shipped last. */
function ReadyRow({ r, onPropose }: { r: ReleaseReadiness; onPropose: () => void }) {
  const n = r.unreleased.length;
  return (
    <div className={`assignrow readyrow${n > 0 && !r.open ? ' hot' : ''}`}>
      <div className="ar1">
        <span className="rowtitle">{r.shippable}</span>
        <Pill tone={r.open ? TONE[r.open.state] : n > 0 ? 'waiting' : 'idle'}>{r.open ? `${r.open.version} ${r.open.state}` : n > 0 ? `${n} unreleased` : 'nothing pending'}</Pill>
        <span className="muted">{r.last ? `last ${r.last.version} · ${ago(r.last.createdAt)} ago` : 'never released'}</span>
        {n > 0 && !r.open && <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={onPropose}>Propose…</button>}
      </div>
      {n > 0 && (
        <details className="diff">
          <summary>Done and unreleased ({n})</summary>
          <ul>{r.unreleased.map(u => <li key={u}>{u}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
