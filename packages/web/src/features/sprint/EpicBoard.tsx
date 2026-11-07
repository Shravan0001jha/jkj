import { useState } from 'react';
import type { BoardColumn, PlannedEpic } from '@jkj/shared';
import { BOARD_COLUMNS, BOARD_COLUMN_LABEL } from '@jkj/shared';
import { sprintApi } from '../../api/client.js';
import { message, showToast } from '../../state/store.js';
import { DateEdit, EpicCard, day } from './common.js';

/**
 * The one epic board (HLD D8, D9), shared by Sprint and Today: To do · In progress · In review · Done, the same
 * cards, flags and colours, swipeable columns with a switcher on a phone. Sprint adds the backlog column and
 * Backlog ↔ To do dragging; Today shows today's scope only.
 */

export async function act(fn: () => Promise<unknown>, reload: () => void, done?: string): Promise<void> {
  try { await fn(); if (done) showToast(done); reload(); } catch (err) { showToast(message(err)); }
}

/** The card menu: plan or unplan, park, move the date (a reason when it changes). */
export function cardMenu(sprintId: string, reload: () => void) {
  return (e: PlannedEpic, inBacklog: boolean) => (
    <details className="cardmenu">
      <summary aria-label="Card menu">⋯</summary>
      <div className="menubody">
        {inBacklog
          ? <button className="btn sm" onClick={() => void act(() => sprintApi.updateEpic(e.id, { planState: 'planned', sprintId }), reload, 'Planned')}>To this sprint</button>
          : <button className="btn sm" onClick={() => void act(() => sprintApi.updateEpic(e.id, { planState: 'backlog' }), reload, 'Back to the backlog')}>Back to backlog</button>}
        <button className="btn sm ghost" onClick={() => void act(() => sprintApi.updateEpic(e.id, { planState: 'parked' }), reload, 'Parked')}>Park</button>
        <DateEdit current={e.dueDate} onSave={async (date, reason) => { await act(() => sprintApi.updateEpic(e.id, { dueDate: date, ...(reason ? { reason } : {}) }), reload, `Due ${day(date)}`); }} />
      </div>
    </details>
  );
}

export interface BacklogColumn {
  epics: PlannedEpic[];
  empty: React.ReactNode;
}

export function EpicBoard({ board, backlog, lanes = false, menu, plan, emptyLine }: {
  board: Record<BoardColumn, PlannedEpic[]>;
  /** Sprint only: Jira's backlog as the first column. */
  backlog?: BacklogColumn;
  lanes?: boolean;
  menu?: (e: PlannedEpic, inBacklog: boolean) => React.ReactNode;
  /** Sprint only: dropping Backlog ↔ To do plans or unplans; other columns refuse (they follow the stories). */
  plan?: { toSprint: (id: string) => void; toBacklog: (id: string) => void };
  /** Shown above the (still visible) columns when nothing is on the board. */
  emptyLine?: string;
}) {
  const [over, setOver] = useState<string | null>(null);
  const all = BOARD_COLUMNS.flatMap(c => board[c]);
  const jump = (c: string): void => { document.getElementById(`jcol-${c}`)?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' }); };
  const laneList = lanes
    ? [...new Map(all.map(e => [e.featureId ?? '', e.featureTitle ?? 'No feature'])).entries()].map(([key, title]) => ({
      key, title,
      board: Object.fromEntries(BOARD_COLUMNS.map(c => [c, board[c].filter(e => (e.featureId ?? '') === key)])) as Record<BoardColumn, PlannedEpic[]>,
    }))
    : [{ key: 'all', title: '', board }];

  const drop = (target: 'backlog' | BoardColumn, id: string): void => {
    setOver(null);
    if (!plan) return;
    const inBacklog = backlog?.epics.some(e => e.id === id) ?? false;
    if (target === 'backlog' && !inBacklog) plan.toBacklog(id);
    else if (target === 'todo' && inBacklog) plan.toSprint(id);
    else if (target !== 'backlog' && target !== 'todo') showToast(`${BOARD_COLUMN_LABEL[target]} follows the stories: a card moves when its stories move.`);
  };
  const zone = (target: 'backlog' | BoardColumn) => plan ? {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setOver(target); },
    onDragLeave: () => setOver(o => (o === target ? null : o)),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain'); if (id) drop(target, id); },
  } : {};

  return (
    <>
      {emptyLine && all.length === 0 && <p className="muted boardempty">{emptyLine}</p>}
      <nav className="colswitch" aria-label="Jump to column">
        {backlog && <button className="btn sm" onClick={() => jump('backlog')}>Backlog {backlog.epics.length}</button>}
        {BOARD_COLUMNS.map(c => <button key={c} className="btn sm" onClick={() => jump(c)}>{BOARD_COLUMN_LABEL[c]} {board[c].length}</button>)}
      </nav>
      <div className="jboard">
        {backlog && (
          <div id="jcol-backlog" className={`jcol backlogcol${over === 'backlog' ? ' over' : ''}`} {...zone('backlog')}>
            <h4>Backlog <span className="muted">{backlog.epics.length}</span></h4>
            {backlog.epics.map(e => <EpicCard key={e.id} epic={e} draggable={!!plan} menu={menu?.(e, true)} />)}
            {backlog.epics.length === 0 && <p className="muted">{backlog.empty}</p>}
          </div>
        )}
        {BOARD_COLUMNS.map(c => (
          <div key={c} id={`jcol-${c}`} className={`jcol col-${c}${over === c ? (c === 'todo' ? ' over' : ' nodrop') : ''}`} {...zone(c)}
            title={plan && c === 'todo' ? 'Drop an epic from the backlog here to plan it' : 'Moves when its stories move'}>
            <h4><span className={`dot col-${c}`} />{BOARD_COLUMN_LABEL[c]} <span className="muted">{board[c].length}</span></h4>
            {laneList.map(l => (
              <div key={l.key} className="lane">
                {lanes && <div className="lanehead">{l.title}</div>}
                {l.board[c].map(e => <EpicCard key={e.id} epic={e} draggable={!!plan && c === 'todo'} menu={menu?.(e, false)} />)}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
