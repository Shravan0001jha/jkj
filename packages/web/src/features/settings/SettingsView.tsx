import type { HygieneReport, SuperFocus } from '@jkj/shared';
import { v2Api } from '../../api/client.js';
import { useApi } from '../../lib/useApi.js';
import { message, showToast, toggleTheme } from '../../state/store.js';

/**
 * Settings (parity with the app's SettingsView, HLD §6): super focus (quiet hours off, night rings
 * allowed) and the board's hygiene score. Push devices and per-chat mute are phone-only and stay in the app.
 */
export function SettingsView() {
  const sf = useApi<SuperFocus>(() => v2Api.superFocus(), 'superfocus');
  const hy = useApi<HygieneReport>(() => v2Api.hygiene(), 'hygiene');
  const on = !!sf.data?.until && Date.parse(sf.data.until) > Date.now();
  const set = (hours: number): void => { v2Api.setSuperFocus(hours).then(() => { sf.reload(); showToast(hours ? `Super focus on for ${hours} h` : 'Super focus off'); }, err => showToast(message(err))); };
  return (
    <div className="pane">
      <div className="sec-h"><h2>Settings</h2></div>
      <section className="card formcard">
        <h3>Super focus</h3>
        <p className="muted">Quiet hours off and stalls may ring at night, until the time you pick.</p>
        <p>{on ? <>On until <b>{new Date(sf.data!.until!).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</b></> : 'Off'}</p>
        <div className="row">
          {[2, 4, 8, 24].map(h => <button key={h} className="btn sm" onClick={() => set(h)}>{h} h</button>)}
          {on && <button className="btn sm ghost" onClick={() => set(0)}>Turn off</button>}
        </div>
      </section>
      <section className="card formcard">
        <h3>Board hygiene</h3>
        {hy.data ? <p>{hy.data.cleanPct}% clean · {hy.data.violations.length} issue{hy.data.violations.length === 1 ? '' : 's'}{hy.data.pausedLine ? ` · ${hy.data.pausedLine}` : ''}</p> : <p className="muted">Loading…</p>}
        {hy.data?.violations.slice(0, 10).map(v => <p key={v.key} className="muted">• {v.what} — {v.fix}</p>)}
      </section>
      <section className="card formcard">
        <h3>Appearance</h3>
        <button className="btn sm" onClick={toggleTheme}>Switch light / dark</button>
      </section>
    </div>
  );
}
