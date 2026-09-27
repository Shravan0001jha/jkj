import { useState } from 'react';
import type { FeatureState, PivotRows, WorkItem } from '@jkj/shared';
import { hrefFor, loadPivot, loadRequirements, useStore } from '../../state/store.js';
import { ago, workTone } from '../../lib/format.js';
import { Pill } from '../../components/Pill.js';
import { CoverageBar } from '../../components/CoverageBar.js';
import { FeatureDetail } from './FeatureDetail.js';

const COLUMNS: FeatureState[] = ['stated', 'specced', 'decomposed', 'in-progress', 'built', 'released'];

/**
 * The board, the pivot (features × charter / platform / team), and the
 * requirements the definition asks for, so any line traces to the work.
 */
export function FeaturesView() {
  const route = useStore(s => s.route);
  const board = useStore(s => s.features);
  const [tab, setTab] = useState<'board' | 'pivot' | 'requirements'>('board');

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
        <a className="btn sm primary" href={hrefFor('assign')}>State a feature</a>
      </div>

      {tab === 'board' && board && (
        <div className="board">
          {COLUMNS.map(col => (
            <div key={col} className="column">
              <h4><Pill tone={workTone(col)}>{col}</Pill><span className="n">{board.byState[col] ?? 0}</span></h4>
              {board.features.filter(f => f.state === col).map(f => <FeatureCard key={f.id} feature={f} />)}
            </div>
          ))}
        </div>
      )}
      {tab === 'pivot' && <PivotPanel />}
      {tab === 'requirements' && <RequirementsPanel />}
    </div>
  );
}

function FeatureCard({ feature }: { feature: WorkItem }) {
  return (
    <a className="fcard" href={hrefFor('features', feature.id)}>
      <b>{feature.title}</b>
      <span className="muted">{feature.platformIds.join(', ') || 'no platform'} · {feature.requirementIds.length} req · {ago(feature.updatedAt)} ago</span>
    </a>
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
