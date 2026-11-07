import { useState } from 'react';
import type { BacklogView as Backlog, PlannedEpic } from '@jkj/shared';
import { sprintApi } from '../../api/client.js';
import { useApi } from '../../lib/useApi.js';
import { hrefFor, message, showToast } from '../../state/store.js';
import { DateEdit, EpicRow, Loading, Progress, SprintTabs, day } from './common.js';

/**
 * The owner's planning screen (HLD §1.4, LLD §6): rank the backlog, plan an epic into this or the next
 * sprint, send it back, park it, move its date (with a reason), add epics and features, and adopt
 * epics the team filed outside the board.
 */
export function BacklogView() {
  const { data, error, reload } = useApi<Backlog>(() => sprintApi.backlog(), 'backlog');
  return (
    <div className="pane sprint">
      <SprintTabs />
      {!data ? <Loading error={error} /> : <Body b={data} reload={reload} />}
    </div>
  );
}

async function act(fn: () => Promise<unknown>, reload: () => void, done?: string): Promise<void> {
  try {
    await fn();
    if (done) showToast(done);
    reload();
  } catch (err) {
    showToast(message(err));
  }
}

function Body({ b, reload }: { b: Backlog; reload: () => void }) {
  const [drag, setDrag] = useState<string | null>(null);

  const move = (list: PlannedEpic[], id: string, delta: number): void => {
    const ids = list.map(e => e.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void act(() => sprintApi.rank(ids), reload);
  };
  const dropOn = (list: PlannedEpic[], target: string): void => {
    if (!drag || drag === target) return;
    const ids = list.map(e => e.id).filter(x => x !== drag);
    const at = ids.indexOf(target);
    if (at < 0) return;
    ids.splice(at, 0, drag);
    setDrag(null);
    void act(() => sprintApi.rank(ids), reload);
  };

  const controls = (list: PlannedEpic[], e: PlannedEpic, where: 'planned' | 'later' | 'backlog' | 'parked') => (
    <>
      {(where === 'planned' || where === 'backlog') && (
        <>
          <button className="btn sm ghost" title="Up" onClick={() => move(list, e.id, -1)}>↑</button>
          <button className="btn sm ghost" title="Down" onClick={() => move(list, e.id, 1)}>↓</button>
        </>
      )}
      {where !== 'planned' && <button className="btn sm" onClick={() => void act(() => sprintApi.updateEpic(e.id, { planState: 'planned', sprintId: b.sprint.id }), reload, `Planned into Sprint ${b.sprint.number}`)}>To this sprint</button>}
      {where !== 'later' && <button className="btn sm" onClick={() => void act(() => sprintApi.updateEpic(e.id, { sprintId: b.next.id }), reload, `Planned into Sprint ${b.next.number}`)}>Next sprint</button>}
      {where !== 'backlog' && <button className="btn sm" onClick={() => void act(() => sprintApi.updateEpic(e.id, { planState: 'backlog' }), reload, 'Back to the backlog')}>Backlog</button>}
      {where !== 'parked' && <button className="btn sm ghost" onClick={() => void act(() => sprintApi.updateEpic(e.id, { planState: 'parked' }), reload, 'Parked')}>Park</button>}
      <DateEdit current={e.dueDate} onSave={async (date, reason) => { await act(() => sprintApi.updateEpic(e.id, { dueDate: date, ...(reason ? { reason } : {}) }), reload, `Due ${day(date)}`); }} />
    </>
  );

  const list = (title: string, epics: PlannedEpic[], where: 'planned' | 'later' | 'backlog' | 'parked', hint?: string) => (
    <section>
      <h3 className="group">{title} ({epics.length})</h3>
      {hint && <p className="muted">{hint}</p>}
      <div className="stack tight">
        {epics.map(e => (
          <div key={e.id} draggable={where === 'planned' || where === 'backlog'} onDragStart={() => setDrag(e.id)} onDragOver={ev => ev.preventDefault()} onDrop={() => dropOn(epics, e.id)}>
            <EpicRow epic={e} actions={controls(epics, e, where)} />
          </div>
        ))}
      </div>
    </section>
  );

  return (
    <>
      <div className="sec-h">
        <h2>Backlog & planning</h2>
        <p>Sprint {b.sprint.number} runs {day(b.sprint.start)} – {day(b.sprint.end)}; Sprint {b.next.number} starts {day(b.next.start)}. Drag or use ↑↓ to rank.</p>
      </div>
      <NewEpic b={b} reload={reload} />
      {list(`This sprint (Sprint ${b.sprint.number})`, b.planned, 'planned')}
      {b.later.length > 0 && list('Planned for later sprints', b.later, 'later')}
      {list('Backlog', b.backlog, 'backlog', 'Ranked: the top of the list is what comes next.')}
      {b.parked.length > 0 && list('Parked', b.parked, 'parked')}
      {b.unplanned.length > 0 && <Unplanned b={b} reload={reload} />}
      <Features b={b} reload={reload} />
    </>
  );
}

function NewEpic({ b, reload }: { b: Backlog; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [featureId, setFeatureId] = useState('');
  const [due, setDue] = useState('');
  const [where, setWhere] = useState<'current' | 'backlog'>('backlog');
  const active = b.features.filter(f => f.status === 'active');
  if (!open) return <div className="row"><button className="btn primary" onClick={() => setOpen(true)}>New epic</button></div>;
  const ok = title.trim() && featureId && due;
  return (
    <form className="card formcard" onSubmit={e => {
      e.preventDefault();
      if (!ok) return;
      void act(() => sprintApi.createEpic({ title: title.trim(), featureId, dueDate: due, sprint: where }), () => { setOpen(false); setTitle(''); setDue(''); reload(); }, 'Epic added');
    }}>
      <h3>New epic (2–5 days of work)</h3>
      <input value={title} onChange={e => setTitle(e.target.value)} placeholder="What it delivers, e.g. “Hinglish image asks reach image-making”" aria-label="Title" />
      <select value={featureId} onChange={e => setFeatureId(e.target.value)} aria-label="Feature">
        <option value="">Feature…</option>
        {active.map(f => <option key={f.id} value={f.id}>{f.title}</option>)}
      </select>
      <label className="row">Due <input type="date" value={due} onChange={e => setDue(e.target.value)} aria-label="Due date" /></label>
      <label className="row">
        <select value={where} onChange={e => setWhere(e.target.value as 'current' | 'backlog')} aria-label="Where">
          <option value="backlog">Backlog</option>
          <option value="current">This sprint</option>
        </select>
      </label>
      <div className="row">
        <button className="btn primary" type="submit" disabled={!ok}>Add</button>
        <button className="btn ghost" type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

function Unplanned({ b, reload }: { b: Backlog; reload: () => void }) {
  const [pick, setPick] = useState<Record<string, { featureId: string; due: string }>>({});
  return (
    <section>
      <h3 className="group">Epics filed outside the board ({b.unplanned.length})</h3>
      <p className="muted">Give each a feature and a date to put it on the board.</p>
      <div className="stack tight">
        {b.unplanned.map(u => {
          const p = pick[u.id] ?? { featureId: '', due: '' };
          const set = (patch: Partial<typeof p>) => setPick({ ...pick, [u.id]: { ...p, ...patch } });
          return (
            <div key={u.id} className="epicrow">
              <a className="em" href={hrefFor('item', u.id)}><b>{u.title}</b> <span className="muted">{u.status}</span></a>
              <div className="acts">
                <select value={p.featureId} onChange={e => set({ featureId: e.target.value })} aria-label="Feature">
                  <option value="">Feature…</option>
                  {b.features.map(f => <option key={f.id} value={f.id}>{f.title}</option>)}
                </select>
                <input type="date" value={p.due} onChange={e => set({ due: e.target.value })} aria-label="Due" />
                <button className="btn sm" disabled={!p.featureId || !p.due} onClick={() => void act(() => sprintApi.updateEpic(u.id, { featureId: p.featureId, dueDate: p.due, planState: 'backlog' }), reload, 'On the board')}>Adopt</button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Features({ b, reload }: { b: Backlog; reload: () => void }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  return (
    <section>
      <h3 className="group">Features ({b.features.length})</h3>
      <div className="stack tight">
        {b.features.map(f => (
          <div key={f.id} className={`epicrow${f.status !== 'active' ? ' dim' : ''}`}>
            <a className="em" href={hrefFor('feature', f.id)}>
              <div className="t"><b>{f.title}</b>{f.status !== 'active' && <span className="chip f-parked">{f.status}</span>}</div>
              <div className="m muted">due {day(f.dueDate)} · {f.progress.epicsTotal} epic{f.progress.epicsTotal === 1 ? '' : 's'}</div>
              <Progress pct={f.progress.pct} done={f.progress.epicsTotal ? f.progress.epicsDone : f.progress.storiesDone} total={f.progress.epicsTotal || f.progress.storiesTotal} />
            </a>
            <div className="acts">
              <DateEdit current={f.dueDate} onSave={async (date, reason) => { await act(() => sprintApi.updateFeature(f.id, { dueDate: date, ...(reason ? { reason } : {}) }), reload); }} />
              {f.status === 'active'
                ? <button className="btn sm ghost" onClick={() => void act(() => sprintApi.updateFeature(f.id, { status: 'parked' }), reload, 'Feature parked')}>Park</button>
                : <button className="btn sm ghost" onClick={() => void act(() => sprintApi.updateFeature(f.id, { status: 'active' }), reload, 'Feature active')}>Activate</button>}
            </div>
          </div>
        ))}
      </div>
      <form className="row newfeature" onSubmit={e => {
        e.preventDefault();
        if (!title.trim()) return;
        void act(() => sprintApi.createFeature({ title: title.trim(), ...(due ? { dueDate: due } : {}) }), () => { setTitle(''); setDue(''); reload(); }, 'Feature added');
      }}>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="New feature" aria-label="Feature title" />
        <input type="date" value={due} onChange={e => setDue(e.target.value)} aria-label="Feature due date" />
        <button className="btn" type="submit" disabled={!title.trim()}>Add feature</button>
      </form>
    </section>
  );
}
