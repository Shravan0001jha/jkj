import { hrefFor, useStore } from '../../state/store.js';
import { inr, pct } from '../../lib/format.js';
import { Pill } from '../../components/Pill.js';

/** The rupee ledger against its caps, and the health signals that justify org proposals. */
export function SpendView() {
  const spend = useStore(s => s.spend);
  const signals = useStore(s => s.signals);
  const org = useStore(s => s.org);
  const office = useStore(s => s.office);
  const nameOf = (id: string): string => org?.employees.find(e => e.id === id)?.name ?? office?.units.flatMap(u => u.employees).find(c => c.employee.id === id)?.employee.name ?? id;

  return (
    <div className="pane">
      <div className="sec-h"><h2>Spend & health</h2><p>Equivalent API cost of every session, in rupees, against the caps. The number you set is a hard contract.</p></div>

      {!spend ? <p className="muted">Reading…</p> : (
        <>
          <div className="capbar">
            <div className="track"><span style={{ width: `${Math.min(100, pct(spend.companyInr, spend.capInr))}%` }} className={spend.companyInr >= spend.capInr ? 'over' : ''} /></div>
            <div className="covlegend"><span>{inr(spend.companyInr)} of {inr(spend.capInr)} · {spend.day}</span>{spend.paused.length > 0 && <span className="pill error"><i />paused: {spend.paused.join(', ')}</span>}</div>
          </div>

          <div className="twocol">
            <section>
              <h3 className="group">By employee</h3>
              <table className="table">
                <tbody>
                  {Object.entries(spend.byEmployee).sort((a, b) => b[1] - a[1]).map(([id, n]) => (
                    <tr key={id}><td><a href={hrefFor('employee', id)}>{nameOf(id)}</a></td><td className="num">{inr(n)}</td></tr>
                  ))}
                  {Object.keys(spend.byEmployee).length === 0 && <tr><td className="muted">No spend today.</td></tr>}
                </tbody>
              </table>
            </section>
            <section>
              <h3 className="group">By unit</h3>
              <table className="table">
                <tbody>
                  {Object.entries(spend.byUnit).sort((a, b) => b[1] - a[1]).map(([id, n]) => (
                    <tr key={id}><td>{id}</td><td className="num">{inr(n)}</td></tr>
                  ))}
                  {Object.keys(spend.byUnit).length === 0 && <tr><td className="muted">No spend today.</td></tr>}
                </tbody>
              </table>
            </section>
          </div>
        </>
      )}

      <h3 className="group">Health signals · last 7 days</h3>
      {!signals ? <p className="muted">Reading…</p> : (
        <>
          <div className="tablewrap">
            <table className="table">
              <thead><tr><th>Employee</th><th className="num">Done</th><th className="num">Rework</th><th className="num">False done</th><th className="num">₹ / done</th></tr></thead>
              <tbody>
                {Object.entries(signals.employees).map(([id, s]) => (
                  <tr key={id}>
                    <td><a href={hrefFor('employee', id)}>{nameOf(id)}</a></td>
                    <td className="num">{s.throughput7d}</td>
                    <td className="num">{s.rework7d}</td>
                    <td className="num">{Math.round(s.falseDoneRate7d * 100)}%</td>
                    <td className="num">{inr(s.costPerDoneInr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="group">Charter queues</h3>
          <div className="chips">
            {Object.entries(signals.charters).map(([id, c]) => (
              <span key={id} className={`chip${c.queue > 5 ? ' hot' : ''}`}>{id} · {c.queue} open{c.contextLimitHits7d ? ` · ${c.contextLimitHits7d} context hits` : ''}</span>
            ))}
          </div>

          <h3 className="group">Proposal triggers</h3>
          {signals.proposalTriggers.length === 0 ? <p className="muted">Nothing suggests an org change right now.</p> : (
            <ul className="history">
              {signals.proposalTriggers.map((t, i) => <li key={i}><Pill tone="waiting">{t.code}</Pill><code>{t.subject}</code><span>{t.message}</span></li>)}
            </ul>
          )}

          {signals.stalled.length > 0 && (
            <>
              <h3 className="group">Stalled sessions</h3>
              <ul className="history">
                {signals.stalled.map(s => <li key={s.sessionId}><Pill tone="error">{s.reason}</Pill><a href={hrefFor('employee', s.employeeId)}>{nameOf(s.employeeId)}</a><span className="muted">{s.sessionId}</span></li>)}
              </ul>
            </>
          )}
          {signals.blockingPairs.length > 0 && (
            <>
              <h3 className="group">Charters blocking each other</h3>
              <div className="chips">{signals.blockingPairs.map(([a, b]) => <span key={`${a}${b}`} className="chip hot">{a} ↔ {b}</span>)}</div>
            </>
          )}
        </>
      )}
    </div>
  );
}
