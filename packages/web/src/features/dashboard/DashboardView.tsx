import { v2Api } from '../../api/client.js';
import { useApi } from '../../lib/useApi.js';
import { day } from '../sprint/common.js';

/** The metrics snapshot v1 (docs/HLD-dashboard.md §2), as much of it as the web shows. Unknown fields are ignored. */
interface Snapshot {
  generatedAt?: string;
  products?: { id: string; name: string; health?: string; committedDate?: string; forecast?: { p50?: string | null; p90?: string | null }; done?: number; total?: number; weekly?: { delivered?: number[]; bugs?: number[] } }[];
  trends?: { weeks?: string[]; bugsOpenTotal?: number[]; medianHoursToDone?: number[]; waitByCause?: Record<string, number[]> };
  usage?: { utilization?: number; allowanceToday?: number; resetsAt?: string; projectedAtReset?: number };
  release?: { prodSha?: string; stagingSha?: string };
  gaps?: { window?: string; lostDaysByCause?: { cause: string; days: number }[]; reviewWaitHours?: { p50?: number; p90?: number }; sendBacks?: number; stagingDownDays?: number };
}

const HEALTH: Record<string, string> = { 'on-track': 'c-track', late: 'c-overdue', 'at-risk': 'c-risk', done: 'c-done' };

/**
 * The app's Dashboard tab on the web (parity, HLD §6): products with health and forecast, usage against
 * the weekly allowance, what is live where, and where time was lost. Built hourly by metrics-cli.
 */
export function DashboardView() {
  const { data, error } = useApi<Snapshot>(() => v2Api.snapshot() as Promise<Snapshot>, 'dashboard');
  if (!data) return <div className="pane">{error ? <div className="note"><b>No dashboard yet.</b> {error}</div> : <div className="muted pad">Loading…</div>}</div>;
  const u = data.usage;
  const last = <T,>(xs: T[] | undefined): T | undefined => (xs && xs.length ? xs[xs.length - 1] : undefined);
  return (
    <div className="pane">
      <div className="sec-h"><h2>Dashboard</h2><p>{data.generatedAt ? `Updated ${new Date(data.generatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</p></div>
      <div className="tiles">
        {u && <div className="tile"><span className="muted">Weekly usage</span><b>{Math.round((u.utilization ?? 0) * 100)}%</b><span className="muted">allowance today {Math.round((u.allowanceToday ?? 0) * 100)}%{u.projectedAtReset !== undefined ? ` · projected ${Math.round(u.projectedAtReset * 100)}% at reset` : ''}</span></div>}
        <div className="tile"><span className="muted">Open bugs</span><b>{last(data.trends?.bugsOpenTotal) ?? '–'}</b><span className="muted">median {last(data.trends?.medianHoursToDone) ?? '–'} h to done</span></div>
        {data.gaps && <div className="tile"><span className="muted">Review wait ({data.gaps.window})</span><b>{data.gaps.reviewWaitHours?.p50 ?? 0} h</b><span className="muted">p90 {data.gaps.reviewWaitHours?.p90 ?? 0} h · {data.gaps.sendBacks ?? 0} send-backs</span></div>}
        {data.release && <div className="tile"><span className="muted">Live</span><b className="mono">{data.release.prodSha?.slice(0, 8) ?? '–'}</b><span className="muted">staging {data.release.stagingSha?.slice(0, 8) ?? '–'}</span></div>}
      </div>
      <section>
        <h3 className="group">Products</h3>
        <div className="stack tight">
          {(data.products ?? []).map(p => (
            <div key={p.id} className="epicrow">
              <div className="em">
                <div className="t"><b>{p.name}</b>{p.health && <span className={`chip ${HEALTH[p.health] ?? 'c-parked'}`}>{p.health}</span>}</div>
                <div className="m muted">
                  {p.committedDate ? `committed ${day(p.committedDate)}` : 'no date'}
                  {p.forecast?.p50 ? ` · forecast ${day(p.forecast.p50)}${p.forecast.p90 ? ` (p90 ${day(p.forecast.p90)})` : ''}` : ''}
                  {p.total ? ` · ${p.done ?? 0}/${p.total} stories` : ''}
                  {p.weekly?.delivered ? ` · ${last(p.weekly.delivered) ?? 0} delivered last week` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
      {data.gaps?.lostDaysByCause && (
        <section>
          <h3 className="group">Where time was lost ({data.gaps.window}, story-days)</h3>
          <ul className="refs">{data.gaps.lostDaysByCause.filter(c => c.days > 0).map(c => <li key={c.cause}>{c.cause}: <b>{c.days.toFixed(1)}</b></li>)}</ul>
        </section>
      )}
    </div>
  );
}
