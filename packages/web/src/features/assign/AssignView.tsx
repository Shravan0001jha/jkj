import { useState } from 'react';
import type { RouteResult, WorkKind } from '@jkj/shared';
import * as api from '../../api/client.js';
import { navigate, showToast, message, useStore } from '../../state/store.js';

const PLATFORMS = ['mac', 'intel', 'windows', 'ios', 'ipad', 'android', 'server', 'web'];

/**
 * Give work to an employee or a charter, or state a feature and let the
 * ownership map decide who it touches. "Preview route" shows the map's
 * answer before anything is created.
 */
export function AssignView() {
  const org = useStore(s => s.org);
  const requirements = useStore(s => s.requirements);
  const [kind, setKind] = useState<WorkKind>('feature');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [target, setTarget] = useState<'map' | 'charter' | 'employee'>('map');
  const [charterId, setCharterId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [reqFilter, setReqFilter] = useState('');
  const [reqIds, setReqIds] = useState<string[]>([]);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (list: string[], set: (v: string[]) => void, value: string): void =>
    set(list.includes(value) ? list.filter(v => v !== value) : [...list, value]);

  const preview = async (): Promise<void> => {
    try {
      setRoute(await api.previewRoute({ text: `${title}\n${body}`, platforms, requirementIds: reqIds }));
    } catch (err) {
      showToast(message(err));
    }
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      if (kind === 'feature') {
        const feature = await api.createFeature({ title, body, requirementIds: reqIds, platformIds: platforms });
        showToast('Feature stated. The Chief of Staff writes the spec next.');
        navigate('features', feature.id);
      } else {
        const item = await api.createWork({
          kind, title, body, requirementIds: reqIds, platformIds: platforms,
          ...(target === 'charter' && charterId ? { charterId } : {}),
          ...(target === 'employee' && employeeId ? { employeeId } : {}),
        });
        showToast(`${kind} created${item.employeeId ? ` for ${item.employeeId}` : ''}.`);
        if (item.employeeId) navigate('employee', item.employeeId); else navigate('office');
      }
    } catch (err) {
      showToast(message(err));
    }
    setBusy(false);
  };

  const filtered = requirements.filter(r => !reqFilter || `${r.id} ${r.group} ${r.title}`.toLowerCase().includes(reqFilter.toLowerCase())).slice(0, 40);

  return (
    <div className="pane">
      <div className="sec-h"><h2>Assign</h2><p>State it once; the map finds the charters it touches.</p></div>
      <form className="assignform" onSubmit={e => void submit(e)}>
        <div className="f">
          <label>Kind</label>
          <div className="seg">
            {(['feature', 'assignment', 'bug', 'question'] as WorkKind[]).map(k => (
              <button key={k} type="button" aria-pressed={kind === k} onClick={() => { setKind(k); if (k === 'feature') setTarget('map'); else if (target === 'map') setTarget('charter'); }}>{k}</button>
            ))}
          </div>
        </div>
        <div className="f"><label>Title</label><input value={title} onChange={e => setTitle(e.target.value)} placeholder={kind === 'feature' ? 'e.g. Phone→Mac errand flow' : 'What needs doing'} required /></div>
        <div className="f"><label>Details</label><textarea value={body} onChange={e => setBody(e.target.value)} placeholder="What, why, and what done looks like. Name the things it touches: paths, services, platforms." /></div>

        {kind !== 'feature' && (
          <div className="f">
            <label>Give it to</label>
            <div className="seg">
              <button type="button" aria-pressed={target === 'charter'} onClick={() => setTarget('charter')}>a charter</button>
              <button type="button" aria-pressed={target === 'employee'} onClick={() => setTarget('employee')}>an employee</button>
            </div>
            {target === 'charter' && (
              <select value={charterId} onChange={e => setCharterId(e.target.value)} style={{ marginTop: 6 }}>
                <option value="">Choose a charter (the least-loaded holder takes it)</option>
                {org?.charters.map(c => <option key={c.id} value={c.id}>{c.title} · {c.holderIds.join(', ') || 'unheld'}</option>)}
              </select>
            )}
            {target === 'employee' && (
              <select value={employeeId} onChange={e => setEmployeeId(e.target.value)} style={{ marginTop: 6 }}>
                <option value="">Choose an employee</option>
                {org?.employees.map(e => <option key={e.id} value={e.id}>{e.name} · {e.charterIds.join(', ')}</option>)}
              </select>
            )}
          </div>
        )}

        <div className="f">
          <label>Platforms</label>
          <div className="chips">
            {PLATFORMS.map(p => <button key={p} type="button" className={`chip toggle${platforms.includes(p) ? ' on' : ''}`} onClick={() => toggle(platforms, setPlatforms, p)}>{p}</button>)}
          </div>
        </div>

        <div className="f">
          <label>Requirements it advances {reqIds.length > 0 && `(${reqIds.length})`}</label>
          <input value={reqFilter} onChange={e => setReqFilter(e.target.value)} placeholder="Filter the definition…" />
          <div className="reqpick">
            {filtered.map(r => (
              <label key={r.id} className={`reqopt${reqIds.includes(r.id) ? ' on' : ''}`}>
                <input type="checkbox" checked={reqIds.includes(r.id)} onChange={() => toggle(reqIds, setReqIds, r.id)} />
                <code>{r.id}</code> {r.title} <span className="muted">· {r.group} · {r.status}</span>
              </label>
            ))}
            {requirements.length === 0 && <span className="muted">Reading the definition…</span>}
          </div>
        </div>

        <div className="row">
          <button type="button" className="btn" onClick={() => void preview()}>Preview route</button>
          <button type="submit" className="btn primary" disabled={busy || !title.trim()}>{busy ? 'Creating…' : kind === 'feature' ? 'State the feature' : `Create ${kind}`}</button>
        </div>

        {route && (
          <div className="note" style={{ display: 'block' }}>
            {route.primaries.length === 0 ? <b>The map routes this to nobody yet.</b> : (
              <ul className="routelist">
                {route.primaries.map(h => <li key={h.charterId}><b>{h.charterId}</b> <span className="muted">because {h.because.map(t => `${t.kind}:${t.key}`).join(', ')}</span></li>)}
              </ul>
            )}
            {route.consulted.length > 0 && <div>Consulted: {route.consulted.join(', ')}</div>}
            {route.unresolved.length > 0 && <div>Unresolved: {route.unresolved.map(t => `${t.kind}:${t.key}`).join(', ')}</div>}
          </div>
        )}
      </form>
    </div>
  );
}
