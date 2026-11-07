import type { EpicRef, ReviewView as Review, SprintReport } from '@jkj/shared';
import { sprintApi } from '../../api/client.js';
import { useApi } from '../../lib/useApi.js';
import { hrefFor } from '../../state/store.js';
import { Loading, SprintTabs, day } from './common.js';

/** The Saturday review (HLD §1.4): last sprint's done / slipped / carried, then every earlier sprint. */
export function ReviewView() {
  const { data, error } = useApi<Review>(() => sprintApi.review(), 'review');
  return (
    <div className="pane sprint">
      <SprintTabs />
      {!data ? <Loading error={error} /> : (
        <>
          <div className="sec-h"><h2>Sprint review</h2><p>Now in Sprint {data.current.number} ({day(data.current.start)} – {day(data.current.end)}).</p></div>
          {!data.last && <div className="note">No sprint has ended yet. Sprint 1's report appears here on {day(addDays(data.current.end, 1))}.</div>}
          {data.archive.map((r, i) => <Report key={r.sprintId} r={r} open={i === 0} />)}
        </>
      )}
    </div>
  );
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function Report({ r, open }: { r: SprintReport; open: boolean }) {
  const total = r.done.length + r.slipped.length;
  return (
    <details className="card report" open={open}>
      <summary>
        <b>Sprint {r.number}</b> <span className="muted">{day(r.start)} – {day(r.end)} · {r.done.length}/{total} done{r.slipped.length ? ` · ${r.slipped.length} slipped` : ''}</span>
      </summary>
      {r.goal && <p><b>Goal:</b> {r.goal}</p>}
      <Refs title="Done" refs={r.done} tone="c-done" />
      <Refs title="Slipped and carried over" refs={r.slipped} tone="c-overdue" />
    </details>
  );
}

function Refs({ title, refs, tone }: { title: string; refs: EpicRef[]; tone: string }) {
  if (!refs.length) return null;
  return (
    <>
      <h4>{title}</h4>
      <ul className="refs">
        {refs.map(e => (
          <li key={e.id}>
            <span className={`chip ${tone}`}>{title === 'Done' ? 'Done' : 'Slipped'}</span>{' '}
            <a href={hrefFor('epic', e.id)}>{e.title}</a>
            <span className="muted">{e.featureTitle ? ` · ${e.featureTitle}` : ''}{e.dueDate ? ` · was due ${day(e.dueDate)}` : ''}{e.reason ? ` · ${e.reason}` : ''}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
