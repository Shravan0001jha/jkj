import { useState } from 'react';
import type { PlannedEpic, TodayView as Today, WaitingOnYou } from '@jkj/shared';
import { sprintApi } from '../../api/client.js';
import { useApi } from '../../lib/useApi.js';
import { hrefFor } from '../../state/store.js';
import { EpicRow, Loading, SprintTabs, day } from './common.js';

/**
 * The owner's home (HLD §1.4): what finishes today, what slipped, what is stuck, and what waits on him.
 * Epics only; tap one for its stories.
 */
export function TodayView() {
  const { data, error } = useApi<Today>(() => sprintApi.today(), 'today');
  return (
    <div className="pane sprint">
      <SprintTabs />
      {!data ? <Loading error={error} /> : <TodayBody t={data} />}
    </div>
  );
}

function TodayBody({ t }: { t: Today }) {
  const daysLeft = Math.round((Date.parse(`${t.sprint.end}T00:00:00Z`) - Date.parse(`${t.date}T00:00:00Z`)) / 86_400_000) + 1;
  return (
    <>
      <div className="sec-h">
        <h2>Today · {day(t.date)}</h2>
        <p>Sprint {t.sprint.number} ({day(t.sprint.start)} – {day(t.sprint.end)}), {daysLeft} day{daysLeft === 1 ? '' : 's'} left{t.sprint.goal ? ` · Goal: ${t.sprint.goal}` : ''}</p>
      </div>

      <Waiting items={t.waitingOnYou} />

      {t.empty ? (
        <div className="note">
          <b>No dated epics yet.</b> The features still need splitting into 2–5 day epics with dates. Open <a href={hrefFor('backlog')}>Backlog</a> to add them, or ask the COO to.
        </div>
      ) : (
        <>
          <Group title="Due today" empty="Nothing is due today." epics={t.dueToday} />
          <Group title="Overdue" epics={t.overdue} hideEmpty />
          <Group title="Blocked" epics={t.blocked} hideEmpty />
          <Group title="At risk" epics={t.atRisk} hideEmpty />
          <Group title="In progress" epics={t.moving} hideEmpty />
          <Group title="Done today" epics={t.doneToday} hideEmpty />
        </>
      )}
    </>
  );
}

function Group({ title, epics, empty, hideEmpty }: { title: string; epics: PlannedEpic[]; empty?: string; hideEmpty?: boolean }) {
  if (!epics.length && hideEmpty) return null;
  return (
    <section>
      <h3 className="group">{title}{epics.length ? ` (${epics.length})` : ''}</h3>
      {epics.length ? <div className="stack tight">{epics.map(e => <EpicRow key={e.id} epic={e} />)}</div> : <p className="muted">{empty}</p>}
    </section>
  );
}

/** What only the owner can unblock, oldest first; the first five, then "show all". */
function Waiting({ items }: { items: WaitingOnYou[] }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, 5);
  return (
    <section className="waiting">
      <h3 className="group">Waiting on you ({items.length})</h3>
      <div className="stack tight">
        {shown.map(w => (
          <a key={`${w.kind}:${w.id}`} className="waitrow" href={w.kind === 'inbox' ? hrefFor('inbox') : hrefFor('item', w.id)}>
            <b>{w.title}</b>
            <span className="muted">{w.line}</span>
          </a>
        ))}
      </div>
      {items.length > 5 && <button className="btn sm ghost showall" onClick={() => setAll(v => !v)}>{all ? 'Show fewer' : `Show all ${items.length}`}</button>}
    </section>
  );
}
