import { useEffect, useState } from 'react';
import { agentById, endEmployeeSession, hrefFor, talkTo, useStore } from '../../state/store.js';
import { inr, stateLabel, stateTone } from '../../lib/format.js';
import { Pill } from '../../components/Pill.js';
import { GrowTextarea } from '../../components/GrowTextarea.js';
import { AgentChat } from '../agents/AgentChat.js';
import { AssignmentRow } from '../features/FeatureDetail.js';
import { EmployeeContext } from './EmployeeContext.js';

/**
 * One employee: who they are, what they hold, what they are on, and the
 * session you talk to them through, with its transcript, tool approvals and
 * permission mode. The context panel shows every layer the session was given.
 */
export function EmployeeView({ id }: { id: string }) {
  const detail = useStore(s => s.employees[id]);
  const openAgentId = useStore(s => s.openAgentId);
  const open = useStore(s => {
    const explicit = agentById(s, s.openAgentId);
    if (explicit) return explicit;
    const sessions = s.employees[id]?.sessions ?? [];
    return sessions.find(a => a.driven && (a.status === 'running' || a.status === 'waiting')) ?? sessions.find(a => a.driven);
  });
  const [tab, setTab] = useState<'talk' | 'work' | 'context'>('talk');

  useEffect(() => { setTab('talk'); }, [id]);

  if (!detail) return <div className="pane"><p className="lede">Reading…</p></div>;
  const { employee, charters, signals } = detail;

  return (
    <div className="pane employee">
      <div className="crumb"><a href={hrefFor('office')}>Office</a><span>›</span><span>{employee.name}</span></div>
      <div className="dhead">
        <div className="r1">
          <h2>{employee.name}</h2>
          <Pill tone={stateTone(employee.state)}>{stateLabel(employee.state)}</Pill>
          <span className="muted">{employee.roleId} · {employee.unitId}{employee.level === 2 ? ' · contractor' : ''}{employee.reportsTo ? ` · reports to ${employee.reportsTo}` : ' · reports to the owner'}</span>
        </div>
        <div className="chips" style={{ marginTop: 6 }}>
          {charters.map(c => <span key={c.id} className="chip" title={c.mission}>{c.title}</span>)}
          {employee.githubApp && <span className="chip" title="GitHub App identity; the credential is never shown">{employee.githubApp}[bot]</span>}
        </div>
        <dl className="kv">
          <div><dt>Today</dt><dd>{inr(detail.spendTodayInr)} of {inr(employee.budget.inrPerDay)}</dd></div>
          <div><dt>Done 7d</dt><dd>{signals.throughput7d}</dd></div>
          <div><dt>Rework</dt><dd>{signals.rework7d}</dd></div>
          <div><dt>False done</dt><dd>{Math.round(signals.falseDoneRate7d * 100)}%</dd></div>
          <div><dt>₹ / done</dt><dd>{inr(signals.costPerDoneInr)}</dd></div>
          <div><dt>Workspace</dt><dd title={employee.workspace.repo}>{employee.workspace.branch ?? employee.workspace.repo}</dd></div>
        </dl>
      </div>

      <div className="dactions">
        <div className="seg small">
          {(['talk', 'work', 'context'] as const).map(t => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>)}
        </div>
        {open && open.driven && (
          <button className="btn sm danger" style={{ marginLeft: 'auto' }} onClick={() => void endEmployeeSession(employee.id)}>
            End session (writes handoff)
          </button>
        )}
      </div>

      {tab === 'talk' && (
        open
          ? <AgentChat agent={open} back={openAgentId && openAgentId !== open.id ? () => undefined : undefined} />
          : <StartTalk employeeId={employee.id} name={employee.name} />
      )}

      {tab === 'work' && (
        <div className="twocol">
          <section>
            <h3 className="group">Status</h3>
            <pre className="statusbox">{detail.status.trim() || 'No status written yet.'}</pre>
            <h3 className="group">Handoff</h3>
            <pre className="statusbox">{detail.handoff.trim() || 'No handoff written yet.'}</pre>
          </section>
          <section>
            <h3 className="group">Assignments</h3>
            <div className="stack tight">
              {detail.assignments.map(a => <AssignmentRow key={a.id} item={a} />)}
              {detail.assignments.length === 0 && <p className="muted">Nothing assigned. <a href={hrefFor('assign')}>Assign something.</a></p>}
            </div>
            <h3 className="group">Sessions</h3>
            <ul className="history">
              {detail.sessions.map(s => (
                <li key={s.id}>
                  <Pill tone={s.status === 'running' ? 'running' : s.status === 'waiting' ? 'waiting' : 'idle'}>{s.status}</Pill>
                  <span>{s.name}</span>
                  <span className="muted">{s.contextTokens ? `${s.contextTokens} context tok` : ''}</span>
                </li>
              ))}
              {detail.sessions.length === 0 && <li className="muted">No sessions yet.</li>}
            </ul>
          </section>
        </div>
      )}

      {tab === 'context' && <EmployeeContext employeeId={employee.id} />}
    </div>
  );
}

function StartTalk({ employeeId, name }: { employeeId: string; name: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (): Promise<void> => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    await talkTo(employeeId, value);
    setText('');
    setBusy(false);
  };
  return (
    <div className="starttalk">
      <p className="lede">No session is open. Your message starts one from the files: the handbook, the unit, the charters, the status and the handoff.</p>
      <form className="composer" onSubmit={e => { e.preventDefault(); void send(); }}>
        <GrowTextarea value={text} onChange={setText} placeholder={`Message ${name}…`} rows={1} minHeight={38} maxHeight={220} disabled={busy}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button className="btn sm primary" type="submit" disabled={busy || !text.trim()}>{busy ? 'Starting…' : 'Talk'}</button>
      </form>
    </div>
  );
}
