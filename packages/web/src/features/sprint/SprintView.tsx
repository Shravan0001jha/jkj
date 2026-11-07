import { useEffect, useState } from 'react';
import type { SprintView as SprintData } from '@jkj/shared';
import { sprintApi } from '../../api/client.js';
import { useApi } from '../../lib/useApi.js';
import { hrefFor, message, showToast } from '../../state/store.js';
import { Loading, SprintTabs, day } from './common.js';
import { EpicBoard, act, cardMenu } from './EpicBoard.js';

/**
 * The sprint board, Jira-style (HLD D8): epics on four derived columns (To do · In progress · In review · Done),
 * the backlog beside them, flags on the cards. Backlog ↔ To do drags plan and unplan; the other columns follow
 * the stories and can't be dragged into. Swimlanes group the rows by feature.
 */
export function SprintView() {
  const { data, error, reload } = useApi<SprintData>(() => sprintApi.current(), 'sprint');
  return (
    <div className="pane sprint">
      <SprintTabs />
      {!data ? <Loading error={error} /> : <Board s={data} reload={reload} />}
    </div>
  );
}

const pref = (k: string, d: boolean): boolean => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch { return d; } };
const save = (k: string, v: boolean): void => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* private window */ } };

function Board({ s, reload }: { s: SprintData; reload: () => void }) {
  const [lanes, setLanes] = useState(() => pref('sprint.lanes', false));
  const [showBacklog, setShowBacklog] = useState(() => pref('sprint.backlog', true));
  useEffect(() => save('sprint.lanes', lanes), [lanes]);
  useEffect(() => save('sprint.backlog', showBacklog), [showBacklog]);
  const t = s.totals;
  return (
    <>
      <div className="sec-h">
        <h2>Sprint {s.sprint.number}</h2>
        <p>{day(s.sprint.start)} – {day(s.sprint.end)} · {t.done}/{t.epics} epics done{t.blocked ? ` · ${t.blocked} blocked` : ''}{t.atRisk ? ` · ${t.atRisk} at risk` : ''}</p>
      </div>
      <Goal sprintId={s.sprint.id} goal={s.sprint.goal} onSaved={reload} />
      <div className="row boardbar">
        <label className="muted"><input type="checkbox" checked={showBacklog} onChange={e => setShowBacklog(e.target.checked)} /> Backlog</label>
        <label className="muted"><input type="checkbox" checked={lanes} onChange={e => setLanes(e.target.checked)} /> Swimlanes by feature</label>
        <span className="muted">Drag between Backlog and To do to plan. The other columns follow the stories.</span>
      </div>
      <EpicBoard
        board={s.board}
        lanes={lanes}
        menu={cardMenu(s.sprint.id, reload)}
        {...(showBacklog ? { backlog: { epics: s.backlog, empty: <>Empty. Add epics on the <a href={hrefFor('backlog')}>Backlog</a> page.</> } } : {})}
        plan={{
          toSprint: id => void act(() => sprintApi.updateEpic(id, { planState: 'planned', sprintId: s.sprint.id }), reload, `Planned into Sprint ${s.sprint.number}`),
          toBacklog: id => void act(() => sprintApi.updateEpic(id, { planState: 'backlog' }), reload, 'Back to the backlog'),
        }}
      />

      <details className="timelinebox">
        <summary className="group">Next two weeks, by due date</summary>
        <div className="timeline" role="list">
          {s.timeline.map(d => (
            <div key={d.date} className={`tday${d.epics.length ? '' : ' empty'}`} role="listitem">
              <div className="td">{day(d.date)}</div>
              {d.epics.map(e => (
                <a key={e.id} className={`tchip ${e.overdue ? 'f-overdue' : e.state === 'done' ? 'col-done' : e.state === 'blocked' ? 'f-blocked' : e.state === 'at-risk' ? 'f-risk' : 'col-progress'}`} href={hrefFor('epic', e.id)} title={e.title}>{e.title}</a>
              ))}
            </div>
          ))}
        </div>
      </details>
    </>
  );
}

function Goal({ sprintId, goal, onSaved }: { sprintId: string; goal?: string; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(goal ?? '');
  const saveGoal = async (): Promise<void> => {
    try { await sprintApi.setGoal(sprintId, text); setEdit(false); onSaved(); } catch (err) { showToast(message(err)); }
  };
  if (!edit) {
    return (
      <div className="goal">
        <span><b>Goal:</b> {goal ?? <span className="muted">not set</span>}</span>
        <button className="btn sm ghost" onClick={() => { setText(goal ?? ''); setEdit(true); }}>{goal ? 'Edit' : 'Set goal'}</button>
      </div>
    );
  }
  return (
    <form className="goal" onSubmit={e => { e.preventDefault(); void saveGoal(); }}>
      <input value={text} onChange={e => setText(e.target.value)} maxLength={200} placeholder="One line: what this sprint is for" aria-label="Sprint goal" autoFocus />
      <button className="btn sm primary" type="submit" disabled={!text.trim()}>Save</button>
      <button className="btn sm ghost" type="button" onClick={() => setEdit(false)}>Cancel</button>
    </form>
  );
}
