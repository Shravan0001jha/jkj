import { useState } from 'react';
import type { FeatureState, PivotItem, PivotRows, RequestStatus, WorkItem } from '@jkj/shared';
import { hrefFor, loadPivot, loadRequirements, navigate, sendRequest, useStore } from '../../state/store.js';
import { GrowTextarea } from '../../components/GrowTextarea.js';
import { ago, stageTone, workTone } from '../../lib/format.js';
import { Pill } from '../../components/Pill.js';
import { CoverageBar } from '../../components/CoverageBar.js';
import { FeatureDetail } from './FeatureDetail.js';

const COLUMNS: FeatureState[] = ['stated', 'specced', 'decomposed', 'in-progress', 'built', 'released'];
const PLATFORMS = ['mac', 'intel', 'windows', 'ios', 'ipad', 'android', 'server', 'web'];

/**
 * The board, the pivot (features × charter / platform / team), and the
 * requirements the definition asks for, so any line traces to the work.
 */
export function FeaturesView() {
  const route = useStore(s => s.route);
  const board = useStore(s => s.features);
  const [tab, setTab] = useState<'board' | 'pivot' | 'requirements'>('board');
  const [requesting, setRequesting] = useState(false);

  if (route.id) return <div className="pane"><FeatureDetail id={route.id} /></div>;

  return (
    <div className="pane">
      <div className="sec-h">
        <h2>Features</h2>
        <p>{board ? `${board.features.length} stated` : 'Reading…'}</p>
        <div className="seg small" style={{ marginLeft: 'auto' }}>
          {(['board', 'pivot', 'requirements'] as const).map(t => (
            <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>
        <button className="btn sm primary" onClick={() => setRequesting(v => !v)}>{requesting ? 'Cancel' : 'New request'}</button>
        <a className="btn sm ghost" href={hrefFor('assign')}>State a feature</a>
      </div>

      {tab === 'board' && requesting && <NewRequest onDone={() => setRequesting(false)} />}

      {tab === 'board' && board && (
        <div className="board">
          {COLUMNS.map(col => (
            <div key={col} className="column">
              <h4><Pill tone={workTone(col)}>{col}</Pill><span className="n">{board.byState[col] ?? 0}</span></h4>
              {board.features.filter(f => f.state === col).map(f => <FeatureCard key={f.id} feature={f} status={board.status?.[f.id]} />)}
            </div>
          ))}
        </div>
      )}
      {tab === 'pivot' && <PivotPanel />}
      {tab === 'requirements' && <RequirementsPanel />}
    </div>
  );
}

function FeatureCard({ feature, status }: { feature: WorkItem; status?: RequestStatus }) {
  return (
    <a className="fcard" href={hrefFor('features', feature.id)}>
      <b>{feature.title}</b>
      {status && <span className="status"><Pill tone={stageTone(status.stage)}>{status.stage}</Pill><span>{status.line}</span></span>}
      <span className="muted">{feature.platformIds.join(', ') || 'no platform'} · {feature.requirementIds.length} req · {ago(feature.updatedAt)} ago</span>
    </a>
  );
}

/** The owner's request in his own words: Asha writes the spec and routes it. */
function NewRequest({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const toggle = (p: string): void => setPlatforms(l => (l.includes(p) ? l.filter(x => x !== p) : [...l, p]));
  const submit = async (): Promise<void> => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const id = await sendRequest(text.trim(), platforms);
    setBusy(false);
    if (id) { onDone(); navigate('features', id); }
  };
  return (
    <form className="newthread" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <div className="f"><label>What you want, in your words</label>
        <GrowTextarea value={text} onChange={setText} placeholder="e.g. Iris should greet me each morning with the weather. One sentence, no bubble reopening." rows={3} minHeight={70} maxHeight={280} autoFocus />
      </div>
      <div className="f"><label>Platforms (optional)</label>
        <div className="chips">
          {PLATFORMS.map(p => <button type="button" key={p} className={`chip toggle${platforms.includes(p) ? ' on' : ''}`} onClick={() => toggle(p)}>{p}</button>)}
        </div>
      </div>
      <div className="row">
        <button className="btn sm primary" type="submit" disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Send to Asha'}</button>
        <button className="btn sm ghost" type="button" onClick={onDone}>Cancel</button>
        <span className="muted">Asha writes the spec, routes it through the ownership map, and the status shows here.</span>
      </div>
    </form>
  );
}

function PivotPanel() {
  const pivot = useStore(s => s.pivot);
  const rows = useStore(s => s.pivotRows);
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="mplabel">rows</span>
        <div className="seg small">
          {(['charter', 'platform', 'team'] as PivotRows[]).map(r => (
            <button key={r} aria-pressed={rows === r} onClick={() => void loadPivot(r)}>{r}</button>
          ))}
        </div>
      </div>
      {!pivot ? <p className="muted">Reading…</p> : pivot.cols.length === 0 ? <p className="muted">No features decomposed yet.</p> : (
        <div className="tablewrap">
          <table className="table pivot">
            <thead><tr><th>{rows}</th>{pivot.cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {pivot.rows.map(r => (
                <tr key={r}>
                  <th>{r}</th>
                  {pivot.cols.map(c => {
                    const cell = pivot.cells[r]?.[c];
                    return (
                      <td key={c} className={cell && cell.total > 0 ? 'has' : ''}>
                        {cell && cell.total > 0 ? (
                          <span title={Object.entries(cell.byState).map(([s, n]) => `${s}: ${n}`).join(', ')}>
                            <b>{cell.total}</b>
                            <small>{Object.entries(cell.byState).map(([s, n]) => `${n} ${s}`).join(' · ')}</small>
                            {(cell.items ?? []).map(item => <PivotItemRow key={item.id} item={item} />)}
                          </span>
                        ) : '·'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** One assignment in a pivot cell: where it is, what it showed, where to see it. */
function PivotItemRow({ item }: { item: PivotItem }) {
  const e = item.evidence;
  return (
    <span className="pitem">
      <a href={item.href}>{item.title}</a>
      <Pill tone={workTone(item.state)}>{item.state}</Pill>
      {e && (
        <small className="pev">
          tests: {e.tests} · commits: {e.commits.length}{e.commits.slice(0, 3).map(c => <code key={c}>{c.slice(0, 7)}</code>)} · live: {e.liveVerified} · not verified: {e.notVerified}
        </small>
      )}
    </span>
  );
}

function RequirementsPanel() {
  const coverage = useStore(s => s.coverage);
  const requirements = useStore(s => s.requirements);
  const [group, setGroup] = useState<string | null>(null);

  if (!coverage) return <p className="muted">Reading…</p>;
  const groups = Object.entries(coverage.byGroup);

  return (
    <>
      <CoverageBar counts={coverage} />
      <div className="reqgroups">
        {groups.map(([name, counts]) => (
          <button key={name} className={`reqgroup${group === name ? ' on' : ''}`} onClick={() => { setGroup(name); void loadRequirements(name); }}>
            <span className="rowtitle">{name}</span>
            <span className="muted">{counts.built}/{counts.total} built · {counts.owned === counts.total ? 'all owned' : `${counts.total - counts.owned} unowned`}</span>
            <CoverageBar counts={counts} compact />
          </button>
        ))}
      </div>
      {group && (
        <>
          <h3 className="group">{group}</h3>
          <div className="stack tight">
            {requirements.filter(r => r.group === group).map(r => (
              <div key={r.id} className="reqrow">
                <Pill tone={r.status === 'missing' ? 'error' : r.status === 'partial' ? 'waiting' : 'done'}>{r.status}</Pill>
                <code>{r.id}</code>
                <span className="rowtitle">{r.title}</span>
                <span className="muted">{r.charterId ?? 'unowned'}{r.featureIds.length ? ` · ${r.featureIds.length} feature(s)` : ''}</span>
                {r.note && <span className="muted note-inline">{r.note}</span>}
              </div>
            ))}
            {requirements.filter(r => r.group === group).length === 0 && <p className="muted">Reading…</p>}
          </div>
        </>
      )}
    </>
  );
}
