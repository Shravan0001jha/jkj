import type { BoardColumn, Item, Team, TeamBoard } from '@jkj/shared';
import { BOARD_COLUMNS } from '@jkj/shared';
import { sprintApi } from '../../api/client.js';
import { useApi } from '../../lib/useApi.js';
import { hrefFor, navigate } from '../../state/store.js';
import { Loading, SprintTabs, day, useNames } from './common.js';

const LABEL: Record<BoardColumn, string> = { todo: 'To do', progress: 'In progress', review: 'Review', qa: 'QA', done: 'Done' };

/**
 * Team story boards (HLD §1.4): one sprint calendar, one board per team; the switcher changes team.
 * Story level, for the leads and the COO; the owner can look in but plans at the epic level.
 */
export function TeamsView({ id }: { id?: string }) {
  const teams = useApi<Team[]>(() => sprintApi.teams(), 'teams');
  const teamId = id ?? teams.data?.[0]?.id;
  return (
    <div className="pane sprint">
      <SprintTabs />
      {!teams.data ? <Loading error={teams.error} /> : teams.data.length === 0 ? <div className="note">No teams in the organisation yet.</div> : (
        <>
          <div className="row teampick">
            <label className="muted" htmlFor="teampick">Team</label>
            <select id="teampick" value={teamId} onChange={e => navigate('teams', e.target.value)}>
              {teams.data.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          {teamId && <Board teamId={teamId} />}
        </>
      )}
    </div>
  );
}

function Board({ teamId }: { teamId: string }) {
  const { data, error } = useApi<TeamBoard>(() => sprintApi.team(teamId), `team:${teamId}`);
  const names = useNames();
  if (!data) return <Loading error={error} />;
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  return (
    <>
      <p className="muted">{data.team.memberIds.map(names).join(', ')} · Sprint {data.sprint.number}, {day(data.sprint.start)} – {day(data.sprint.end)}</p>
      <div className="kanban">
        {BOARD_COLUMNS.map(c => (
          <div key={c} className="kcol">
            <h4>{LABEL[c]} <span className="muted">{data.columns[c].length}</span></h4>
            {data.columns[c].map(s => <Card key={s.id} s={s} today={today} name={names(s.assigneeId)} />)}
          </div>
        ))}
      </div>
    </>
  );
}

function Card({ s, today, name }: { s: Item; today: string; name: string }) {
  const due = s.targetDate;
  const cls = ['kcard', s.blocker || s.status === 'blocked' ? 'blocked' : '', due === today && s.status !== 'done' ? 'today' : '', due && due < today && s.status !== 'done' ? 'overdue' : ''].filter(Boolean).join(' ');
  return (
    <a className={cls} href={hrefFor('item', s.id)}>
      <span className="kt">{s.title}</span>
      <span className="muted">{name}{due ? ` · ${day(due)}` : ''}{s.trueStatus === 'waiting' && s.waiting ? ` · waiting on ${s.waiting.on}` : ''}</span>
      {s.blocker && <span className="kb">Waiting on {s.blocker.label}{s.blocker.reason ? `: ${s.blocker.reason}` : ''}</span>}
    </a>
  );
}
