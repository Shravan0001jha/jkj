import type { DateChange, EpicDetail, FeatureDetail$, Item } from '@jkj/shared';
import { TRUE_STATUS_LABEL } from '@jkj/shared';
import { sprintApi } from '../../api/client.js';
import { useApi } from '../../lib/useApi.js';
import { hrefFor, message, showToast } from '../../state/store.js';
import { DateEdit, EpicRow, Loading, Progress, StateChip, SprintTabs, day, useNames } from './common.js';

/** One epic (HLD §1.4): its state and date, then its stories, blocked first with what they wait on. */
export function EpicView({ id }: { id: string }) {
  const { data, error, reload } = useApi<EpicDetail>(() => sprintApi.epic(id), `epic:${id}`);
  return (
    <div className="pane sprint">
      <SprintTabs />
      {!data ? <Loading error={error} /> : (
        <>
          <div className="sec-h">
            <h2>{data.epic.title}</h2>
            <StateChip epic={data.epic} />
          </div>
          <p className="muted">
            {data.feature ? <><a href={hrefFor('feature', data.feature.id)}>{data.feature.title}</a> · </> : null}
            due {day(data.epic.dueDate)} · {data.epic.sprintId ? `Sprint ${data.epic.sprintId.replace('sp_', '')}` : data.epic.planState}
            {' · '}<a href={hrefFor('item', data.epic.id)}>item details</a>
          </p>
          <div className="row">
            <Progress pct={data.epic.progress.pct} done={data.epic.progress.storiesDone} total={data.epic.progress.storiesTotal} />
            <DateEdit current={data.epic.dueDate} onSave={async (date, reason) => {
              try { await sprintApi.updateEpic(id, { dueDate: date, ...(reason ? { reason } : {}) }); reload(); } catch (err) { showToast(message(err)); }
            }} />
          </div>
          {data.epic.carried?.map((c, i) => <p key={i} className="muted">Carried from {c.fromSprint.replace('sp_', 'Sprint ')}: {c.reason}</p>)}
          <Stories stories={data.stories} />
          <Dates dates={data.dates} />
        </>
      )}
    </div>
  );
}

export function Stories({ stories, title = 'Stories' }: { stories: Item[]; title?: string }) {
  const names = useNames();
  return (
    <section>
      <h3 className="group">{title} ({stories.length})</h3>
      {stories.length === 0 && <p className="muted">No stories filed yet.</p>}
      <div className="stack tight">
        {stories.map(s => {
          const st = s.trueStatus ?? s.status;
          return (
            <a key={s.id} className={`storyrow${s.blocker || s.status === 'blocked' ? ' blocked' : ''}${s.status === 'done' ? ' done' : ''}`} href={hrefFor('item', s.id)}>
              <span className="st">{TRUE_STATUS_LABEL[st as keyof typeof TRUE_STATUS_LABEL] ?? st}</span>
              <span className="tt">{s.title}</span>
              <span className="muted">{names(s.assigneeId)}</span>
              {s.blocker && <span className="kb">Waiting on {s.blocker.label}{s.blocker.reason ? `: ${s.blocker.reason}` : ''}</span>}
              {s.stall && <span className="kb">stalled {Math.round(s.stall.minutes / 60)} h</span>}
            </a>
          );
        })}
      </div>
    </section>
  );
}

function Dates({ dates }: { dates: DateChange[] }) {
  if (!dates.length) return null;
  return (
    <section>
      <h3 className="group">Date history</h3>
      <ul className="refs">
        {dates.map((d, i) => (
          <li key={i}>
            {d.from ? <>{day(d.from)} → <b>{day(d.to)}</b></> : <>Set to <b>{day(d.to)}</b></>}
            <span className="muted"> · {d.by === 'owner' ? 'you' : d.by} · {new Date(d.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · {d.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One feature: its epics with dates, and the stories still filed under its pre-sprint container epics. */
export function FeatureView({ id }: { id: string }) {
  const { data, error } = useApi<FeatureDetail$>(() => sprintApi.feature(id), `feature:${id}`);
  return (
    <div className="pane sprint">
      <SprintTabs />
      {!data ? <Loading error={error} /> : (
        <>
          <div className="sec-h"><h2>{data.feature.title}</h2><p>due {day(data.feature.dueDate)} · {data.feature.status}</p></div>
          <Progress pct={data.feature.progress.pct} done={data.feature.progress.epicsDone} total={data.feature.progress.epicsTotal} />
          <section>
            <h3 className="group">Epics ({data.epics.length})</h3>
            {data.epics.length === 0 && <p className="muted">Not split into epics yet. Add them from the <a href={hrefFor('backlog')}>Backlog</a>.</p>}
            <div className="stack tight">{data.epics.map(e => <EpicRow key={e.id} epic={e} showFeature={false} />)}</div>
          </section>
          {data.containerStoriesTotal > 0 && (
            <Stories stories={data.containerStories} title={`Earlier stories${data.containerStoriesTotal > data.containerStories.length ? ` (showing ${data.containerStories.length} of ${data.containerStoriesTotal}, open first)` : ''}`} />
          )}
          <Dates dates={data.dates} />
        </>
      )}
    </div>
  );
}
