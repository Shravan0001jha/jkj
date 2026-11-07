import { useState } from 'react';
import type { SprintView as SprintData } from '@jkj/shared';
import { sprintApi } from '../../api/client.js';
import { useApi } from '../../lib/useApi.js';
import { hrefFor, message, showToast } from '../../state/store.js';
import { EpicRow, Loading, Progress, SprintTabs, chip, day } from './common.js';

/**
 * The sprint (HLD §1.4): this sprint's epics grouped by feature, the next two weeks as a timeline, and
 * the sprint goal, which the owner edits here.
 */
export function SprintView() {
  const { data, error, reload } = useApi<SprintData>(() => sprintApi.current(), 'sprint');
  return (
    <div className="pane sprint">
      <SprintTabs />
      {!data ? <Loading error={error} /> : <Body s={data} onChanged={reload} />}
    </div>
  );
}

function Body({ s, onChanged }: { s: SprintData; onChanged: () => void }) {
  const t = s.totals;
  return (
    <>
      <div className="sec-h">
        <h2>Sprint {s.sprint.number}</h2>
        <p>{day(s.sprint.start)} – {day(s.sprint.end)} · {t.done}/{t.epics} epics done{t.atRisk ? ` · ${t.atRisk} at risk` : ''}{t.blocked ? ` · ${t.blocked} blocked` : ''}</p>
      </div>
      <Goal sprintId={s.sprint.id} goal={s.sprint.goal} onSaved={onChanged} />

      <section>
        <h3 className="group">Next two weeks</h3>
        <div className="timeline" role="list">
          {s.timeline.map(d => (
            <div key={d.date} className={`tday${d.epics.length ? '' : ' empty'}`} role="listitem">
              <div className="td">{day(d.date)}</div>
              {d.epics.map(e => {
                const [tone] = chip(e.state, e.overdue);
                return <a key={e.id} className={`tchip ${tone}`} href={hrefFor('epic', e.id)} title={e.title}>{e.title}</a>;
              })}
            </div>
          ))}
        </div>
      </section>

      {s.features.length === 0 && <div className="note">Nothing is planned into this sprint yet. Plan epics from the <a href={hrefFor('backlog')}>Backlog</a>.</div>}
      {s.features.map(g => (
        <section key={g.feature?.id ?? 'none'}>
          <div className="fhead">
            {g.feature ? <a href={hrefFor('feature', g.feature.id)}><h3 className="group">{g.feature.title}</h3></a> : <h3 className="group">No feature</h3>}
            {g.feature && <span className="muted">due {day(g.feature.dueDate)}</span>}
            {g.feature && <Progress pct={g.feature.progress.pct} done={g.feature.progress.epicsDone} total={g.feature.progress.epicsTotal} />}
          </div>
          <div className="stack tight">{g.epics.map(e => <EpicRow key={e.id} epic={e} showFeature={false} />)}</div>
        </section>
      ))}
    </>
  );
}

function Goal({ sprintId, goal, onSaved }: { sprintId: string; goal?: string; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(goal ?? '');
  const save = async (): Promise<void> => {
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
    <form className="goal" onSubmit={e => { e.preventDefault(); void save(); }}>
      <input value={text} onChange={e => setText(e.target.value)} maxLength={200} placeholder="One line: what this sprint is for" aria-label="Sprint goal" autoFocus />
      <button className="btn sm primary" type="submit" disabled={!text.trim()}>Save</button>
      <button className="btn sm ghost" type="button" onClick={() => setEdit(false)}>Cancel</button>
    </form>
  );
}
