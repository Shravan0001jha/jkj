import { useEffect } from 'react';
import { clearAlerts, hrefFor, markAlertsRead, useStore } from '../../state/store.js';

const GLYPH: Record<string, string> = { info: '·', 'needs-you': '!', blocked: '×', cap: '₹', ring: '◉' };

/** The app's Alerts sheet on the web (parity, HLD §6): socket alerts received since this page opened. */
export function AlertsView() {
  const alerts = useStore(s => s.alerts);
  useEffect(() => { markAlertsRead(); }, [alerts.length]);
  return (
    <div className="pane">
      <div className="sec-h"><h2>Alerts</h2><p>Since this page was opened: when someone needs you, is blocked, or a cap is reached.</p>
        <button className="btn sm ghost" onClick={clearAlerts} disabled={!alerts.length}>Clear</button></div>
      {alerts.length === 0 && <p className="muted">No alerts yet.</p>}
      <ul className="feed">
        {alerts.map((a, i) => (
          <li key={`${a.at}-${i}`}>
            <span aria-hidden="true">{GLYPH[a.level] ?? '•'}</span>{' '}
            {a.inboxId ? <a href={hrefFor('inbox')}><b>{a.title}</b></a> : <b>{a.title}</b>}
            <span className="muted"> · {new Date(a.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
            {a.body && <div className="muted">{a.body}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}
