import { hrefFor, useStore } from '../../state/store.js';
import { fmtTokens, inr, pct } from '../../lib/format.js';
import { Pill } from '../../components/Pill.js';

const SOURCE_LABEL: Record<string, string> = {
  'anthropic-api': 'Anthropic API (on a key)', aws: 'AWS', 'third-party': 'Paid third-party APIs', subscription: 'Subscription (pre-28 Sep ledger)',
};
const BASIS_HELP: Record<string, string> = {
  metered: 'Read from the provider: tokens, a usage API, Cost Explorer.',
  estimated: 'Our own guess, labelled as such; superseded by the actual when it arrives.',
  reported: 'What a session said it spent through record_spend.',
};
const WINDOW_LABEL: Record<string, string> = {
  five_hour: '5-hour window', seven_day: 'Weekly', seven_day_opus: 'Weekly · Opus', seven_day_sonnet: 'Weekly · Sonnet', seven_day_overage_included: 'Weekly · overage included', overage: 'Overage', unknown: 'Unknown window',
};

/** The real-money ledger against its caps, the free subscription usage beside it, and the health signals that justify org proposals. */
export function SpendView() {
  const spend = useStore(s => s.spend);
  const signals = useStore(s => s.signals);
  const org = useStore(s => s.org);
  const office = useStore(s => s.office);
  const nameOf = (id: string): string => org?.employees.find(e => e.id === id)?.name ?? office?.units.flatMap(u => u.employees).find(c => c.employee.id === id)?.employee.name ?? id;

  return (
    <div className="pane">
      <div className="sec-h"><h2>Spend & health</h2><p>Real money only, in rupees, against the caps: Anthropic API on a key, AWS, paid third-party APIs. Subscription usage is free and shown separately.</p></div>

      {!spend ? <p className="muted">Reading…</p> : (
        <>
          <div className="capbar">
            <div className="track"><span style={{ width: `${Math.min(100, pct(spend.companyInr, spend.capInr))}%` }} className={spend.companyInr >= spend.capInr ? 'over' : ''} /></div>
            <div className="covlegend"><span>{inr(spend.companyInr)} of {inr(spend.capInr)} real money · {spend.day}</span>{spend.paused.length > 0 && <span className="pill error"><i />paused: {spend.paused.join(', ')}</span>}</div>
          </div>

          <div className="twocol">
            <section>
              <h3 className="group">By source</h3>
              <table className="table">
                <tbody>
                  {Object.entries(spend.bySource).sort((a, b) => b[1] - a[1]).map(([id, n]) => (
                    <tr key={id}><td>{SOURCE_LABEL[id] ?? id}</td><td className="num">{inr(n)}</td></tr>
                  ))}
                  {Object.keys(spend.bySource).length === 0 && <tr><td className="muted">No real money spent today.</td></tr>}
                </tbody>
              </table>
            </section>
            <section>
              <h3 className="group">By basis</h3>
              <table className="table">
                <tbody>
                  {Object.entries(spend.byBasis).sort((a, b) => b[1] - a[1]).map(([id, n]) => (
                    <tr key={id}><td title={BASIS_HELP[id]}>{id}</td><td className="num">{inr(n)}</td></tr>
                  ))}
                  {Object.keys(spend.byBasis).length === 0 && <tr><td className="muted">Nothing metered, estimated or reported.</td></tr>}
                </tbody>
              </table>
              <p className="muted" style={{ marginTop: 6 }}>An estimate is never a bill: AWS estimates are replaced by the daily actual from Cost Explorer, labelled metered.</p>
            </section>
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

          <h3 className="group">Subscription usage (free)</h3>
          <div className="subusage">
            <div className="stats">
              <div className="stat"><b>{spend.subscription.turns}</b><span>turns today</span></div>
              <div className="stat"><b>{fmtTokens(spend.subscription.inputTokens + spend.subscription.outputTokens)}</b><span>tokens in + out · {fmtTokens(spend.subscription.cacheReadTokens)} cache read</span></div>
              <div className="stat"><b>{inr(spend.subscription.equivalentInr)}</b><span>list-price equivalent · not money, never against a cap</span></div>
              {spend.ownerTalkInr > 0 && <div className="stat"><b>{inr(spend.ownerTalkInr)}</b><span>of it was your own conversations</span></div>}
            </div>
            <div className="twocol">
              <section>
                <h4 className="group">By employee</h4>
                <table className="table">
                  <tbody>
                    {Object.entries(spend.subscription.byEmployee).sort((a, b) => b[1].equivalentInr - a[1].equivalentInr).map(([id, u]) => (
                      <tr key={id}><td><a href={hrefFor('employee', id)}>{nameOf(id)}</a></td><td className="num">{u.turns} turn{u.turns === 1 ? '' : 's'}</td><td className="num">{inr(u.equivalentInr)}</td></tr>
                    ))}
                    {Object.keys(spend.subscription.byEmployee).length === 0 && <tr><td className="muted">No sessions today.</td></tr>}
                  </tbody>
                </table>
              </section>
              <section>
                <h4 className="group">Plan limits, as the SDK reports them</h4>
                {spend.subscription.windows.length === 0 ? <p className="muted">No limit report yet today. It arrives with the first session that gets one.</p> : (
                  <div className="stack tight">
                    {spend.subscription.windows.map(w => (
                      <div key={w.window} className="window">
                        <div className="wh">
                          <span>{WINDOW_LABEL[w.window] ?? w.window}</span>
                          <Pill tone={w.status === 'rejected' ? 'error' : w.status === 'allowed_warning' ? 'waiting' : 'done'}>{w.status.replace('_', ' ')}</Pill>
                          <span className="muted">{typeof w.utilization === 'number' ? `${Math.round(w.utilization * 100)}%` : '—'}{w.resetsAt ? ` · resets ${new Date(w.resetsAt).toLocaleString()}` : ''}</span>
                        </div>
                        {typeof w.utilization === 'number' && <div className="track"><span style={{ width: `${Math.min(100, Math.round(w.utilization * 100))}%` }} className={w.utilization >= 1 ? 'over' : ''} /></div>}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
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
