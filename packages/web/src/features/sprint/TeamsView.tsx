import type { Team, TeamBoard } from '@jkj/shared';
import { BOARD_COLUMNS, BOARD_COLUMN_LABEL } from '@jkj/shared';
import { StoryCard } from './EpicView.js';
import { sprintApi } from '../../api/client.js';
import { useApi } from '../../lib/useApi.js';
import { navigate } from '../../state/store.js';
import { Loading, SprintTabs, day, useNames } from './common.js';


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
  return (
    <>
      <p className="muted">{data.team.memberIds.map(names).join(', ')} · Sprint {data.sprint.number}, {day(data.sprint.start)} – {day(data.sprint.end)}</p>
      <div className="jboard">
        {BOARD_COLUMNS.map(c => (
          <div key={c} className={`jcol col-${c}`}>
            <h4><span className={`dot col-${c}`} />{BOARD_COLUMN_LABEL[c]} <span className="muted">{data.columns[c].length}</span></h4>
            {data.columns[c].map(s => <StoryCard key={s.id} s={s} name={names(s.assigneeId)} />)}
          </div>
        ))}
      </div>
    </>
  );
}
