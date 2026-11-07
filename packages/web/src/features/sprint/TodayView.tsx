import { useState } from 'react';
import type { TodayView as Today, WaitingOnYou } from '@jkj/shared';
import { sprintApi } from '../../api/client.js';
import { useApi } from '../../lib/useApi.js';
import { hrefFor } from '../../state/store.js';
import { Loading, SprintTabs, day } from './common.js';
import { EpicBoard, cardMenu } from './EpicBoard.js';

/**
 * The owner's home (HLD D9): the same board as Sprint (To do · In progress · In review · Done), filtered to
 * today's scope — due today, overdue, at risk, blocked, moved today, done today. A compact "Waiting on you"
 * strip sits above it; the board never hides, even when nothing is due or moving.
 */
export function TodayView() {
  const { data, error, reload } = useApi<Today>(() => sprintApi.today(), 'today');
  return (
    <div className="pane sprint">
      <SprintTabs />
      {!data ? <Loading error={error} /> : (
        <>
          <div className="sec-h">
            <h2>Today · {day(data.date)}</h2>
            <p>Sprint {data.sprint.number} ({day(data.sprint.start)} – {day(data.sprint.end)}), {data.daysLeft} day{data.daysLeft === 1 ? '' : 's'} left{data.sprint.goal ? ` · Goal: ${data.sprint.goal}` : ''}</p>
          </div>
          <Waiting items={data.waitingOnYou} />
          {data.empty && (
            <p className="muted">No dated epics yet: split the features into 2–5 day epics on the <a href={hrefFor('backlog')}>Backlog</a>.</p>
          )}
          <EpicBoard board={data.board} menu={cardMenu(data.sprint.id, reload)} emptyLine="Nothing due or moving today." />
        </>
      )}
    </div>
  );
}

/** What only the owner can unblock: a count and one-line titles, three shown, the rest behind "Show all". */
function Waiting({ items }: { items: WaitingOnYou[] }) {
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, 3);
  return (
    <section className="waitstrip">
      <button className="wshead" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <span className="badge">{items.length}</span> Waiting on you <span className="muted">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul>
          {shown.map(w => (
            <li key={`${w.kind}:${w.id}`}>
              <a href={w.kind === 'inbox' ? hrefFor('inbox') : hrefFor('item', w.id)} title={w.line}>{w.title}</a>
            </li>
          ))}
          {items.length > 3 && <li><button className="btn sm ghost" onClick={() => setAll(v => !v)}>{all ? 'Show fewer' : `Show all ${items.length}`}</button></li>}
        </ul>
      )}
    </section>
  );
}
