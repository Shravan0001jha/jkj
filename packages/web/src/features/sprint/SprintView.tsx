import { useEffect, useState } from 'react';
import type { BoardColumn, PlannedEpic, SprintView as SprintData } from '@jkj/shared';
import { BOARD_COLUMNS, BOARD_COLUMN_LABEL } from '@jkj/shared';
import { sprintApi } from '../../api/client.js';
import { useApi } from '../../lib/useApi.js';
import { hrefFor, message, showToast } from '../../state/store.js';
import { DateEdit, EpicCard, Loading, SprintTabs, day } from './common.js';

type Lane = { key: string; title: string; board: Record<BoardColumn, PlannedEpic[]> };

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

async function act(fn: () => Promise<unknown>, reload: () => void, done?: string): Promise<void> {
  try { await fn(); if (done) showToast(done); reload(); } catch (err) { showToast(message(err)); }
}

function Board({ s, reload }: { s: SprintData; reload: () => void }) {
  const [lanes, setLanes] = useState(() => pref('sprint.lanes', false));
  const [showBacklog, setShowBacklog] = useState(() => pref('sprint.backlog', true));
  const [over, setOver] = useState<string | null>(null);
  useEffect(() => save('sprint.lanes', lanes), [lanes]);
  useEffect(() => save('sprint.backlog', showBacklog), [showBacklog]);
  const t = s.totals;
  const jump = (c: string): void => { document.getElementById(`jcol-${c}`)?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' }); };

  const all = BOARD_COLUMNS.flatMap(c => s.board[c]);
  const laneList: Lane[] = lanes
    ? [...new Map(all.map(e => [e.featureId ?? '', e.featureTitle ?? 'No feature'])).entries()].map(([key, title]) => ({
      key, title,
      board: Object.fromEntries(BOARD_COLUMNS.map(c => [c, s.board[c].filter(e => (e.featureId ?? '') === key)])) as Record<BoardColumn, PlannedEpic[]>,
    }))
    : [{ key: 'all', title: '', board: s.board }];

  const drop = (target: 'backlog' | BoardColumn, id: string): void => {
    setOver(null);
    const inBacklog = s.backlog.some(e => e.id === id);
    if (target === 'backlog' && !inBacklog) void act(() => sprintApi.updateEpic(id, { planState: 'backlog' }), reload, 'Back to the backlog');
    else if (target === 'todo' && inBacklog) void act(() => sprintApi.updateEpic(id, { planState: 'planned', sprintId: s.sprint.id }), reload, `Planned into Sprint ${s.sprint.number}`);
    else if (target !== 'backlog' && target !== 'todo') showToast(`${BOARD_COLUMN_LABEL[target]} follows the stories: a card moves when its stories move.`);
  };
  const zone = (target: 'backlog' | BoardColumn) => ({
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setOver(target); },
    onDragLeave: () => setOver(o => (o === target ? null : o)),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain'); if (id) drop(target, id); },
  });
  const menu = (e: PlannedEpic, inBacklog: boolean) => (
    <details className="cardmenu">
      <summary aria-label="Card menu">⋯</summary>
      <div className="menubody">
        {inBacklog
          ? <button className="btn sm" onClick={() => void act(() => sprintApi.updateEpic(e.id, { planState: 'planned', sprintId: s.sprint.id }), reload, 'Planned')}>To this sprint</button>
          : <button className="btn sm" onClick={() => void act(() => sprintApi.updateEpic(e.id, { planState: 'backlog' }), reload, 'Back to the backlog')}>Back to backlog</button>}
        <button className="btn sm ghost" onClick={() => void act(() => sprintApi.updateEpic(e.id, { planState: 'parked' }), reload, 'Parked')}>Park</button>
        <DateEdit current={e.dueDate} onSave={async (date, reason) => { await act(() => sprintApi.updateEpic(e.id, { dueDate: date, ...(reason ? { reason } : {}) }), reload, `Due ${day(date)}`); }} />
      </div>
    </details>
  );

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

      <nav className="colswitch" aria-label="Jump to column">
        {showBacklog && <button className="btn sm" onClick={() => jump('backlog')}>Backlog {s.backlog.length}</button>}
        {BOARD_COLUMNS.map(c => <button key={c} className="btn sm" onClick={() => jump(c)}>{BOARD_COLUMN_LABEL[c]} {s.board[c].length}</button>)}
      </nav>

      <div className={`jboard${showBacklog ? ' withbacklog' : ''}`}>
        {showBacklog && (
          <div id="jcol-backlog" className={`jcol backlogcol${over === 'backlog' ? ' over' : ''}`} {...zone('backlog')}>
            <h4>Backlog <span className="muted">{s.backlog.length}</span></h4>
            {s.backlog.map(e => <EpicCard key={e.id} epic={e} draggable menu={menu(e, true)} />)}
            {s.backlog.length === 0 && <p className="muted">Empty. Add epics on the <a href={hrefFor('backlog')}>Backlog</a> page.</p>}
          </div>
        )}
        {BOARD_COLUMNS.map(c => (
          <div key={c} id={`jcol-${c}`} className={`jcol col-${c}${over === c ? (c === 'todo' ? ' over' : ' nodrop') : ''}`} {...zone(c)}
            title={c === 'todo' ? 'Drop an epic from the backlog here to plan it' : 'Moves when its stories move'}>
            <h4><span className={`dot col-${c}`} />{BOARD_COLUMN_LABEL[c]} <span className="muted">{s.board[c].length}</span></h4>
            {laneList.map(l => (
              <div key={l.key} className="lane">
                {lanes && <div className="lanehead">{l.title}</div>}
                {l.board[c].map(e => <EpicCard key={e.id} epic={e} draggable={c === 'todo'} menu={menu(e, false)} />)}
              </div>
            ))}
          </div>
        ))}
      </div>

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
