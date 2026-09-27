import type { WorkItem } from '@jkj/shared';
import { decompose, hrefFor, useStore } from '../../state/store.js';
import { ago, workTone } from '../../lib/format.js';
import { Pill } from '../../components/Pill.js';
import { Markdown } from '../../components/Markdown.js';

/** One feature: its spec, why it routed where it did, and the assignments with their evidence. */
export function FeatureDetail({ id }: { id: string }) {
  const detail = useStore(s => s.featureDetails[id]);
  if (!detail) return <p className="lede">Reading the feature…</p>;
  const { feature, assignments, requirements, route } = detail;

  return (
    <>
      <div className="crumb"><a href={hrefFor('features')}>Features</a><span>›</span><span>{feature.title}</span></div>
      <div className="dhead">
        <div className="r1">
          <h2>{feature.title}</h2>
          <Pill tone={workTone(feature.state)}>{feature.state}</Pill>
        </div>
        <p className="task">{feature.body}</p>
        <dl className="kv">
          <div><dt>Platforms</dt><dd>{feature.platformIds.join(', ') || '—'}</dd></div>
          <div><dt>Requirements</dt><dd>{requirements.length}</dd></div>
          <div><dt>Stated</dt><dd>{ago(feature.createdAt)} ago</dd></div>
        </dl>
      </div>

      <div className="dactions">
        <button className="btn sm primary" disabled={feature.state === 'stated'} onClick={() => void decompose(feature.id)} title={feature.state === 'stated' ? 'The Chief of Staff writes the spec first' : 'Route through the ownership map'}>
          Decompose through the map
        </button>
      </div>

      <div className="twocol" style={{ marginTop: 14 }}>
        <section>
          <h3 className="group">Spec</h3>
          {feature.spec ? <Markdown text={feature.spec} /> : <p className="muted">No spec yet; the Chief of Staff writes one with acceptance criteria.</p>}

          <h3 className="group">Requirements it advances</h3>
          <div className="stack tight">
            {requirements.map(r => (
              <div key={r.id} className="reqrow">
                <Pill tone={r.status === 'missing' ? 'error' : r.status === 'partial' ? 'waiting' : 'done'}>{r.status}</Pill>
                <code>{r.id}</code><span className="rowtitle">{r.title}</span><span className="muted">{r.charterId ?? 'unowned'}</span>
              </div>
            ))}
            {requirements.length === 0 && <p className="muted">None linked.</p>}
          </div>
        </section>

        <section>
          <h3 className="group">Route</h3>
          {route.primaries.length === 0 ? <p className="muted">The map routes this nowhere yet: add the things it touches.</p> : (
            <ul className="routelist">
              {route.primaries.map(hit => (
                <li key={hit.charterId}>
                  <b>{hit.charterId}</b>
                  <span className="muted">because {hit.because.map(t => `${t.kind}:${t.key}`).join(', ')}</span>
                </li>
              ))}
            </ul>
          )}
          {route.consulted.length > 0 && <p className="muted">Consulted: {route.consulted.join(', ')}</p>}
          {route.unresolved.length > 0 && <p className="muted">Unresolved: {route.unresolved.map(t => `${t.kind}:${t.key}`).join(', ')}</p>}

          <h3 className="group">Assignments</h3>
          <div className="stack tight">
            {assignments.map(a => <AssignmentRow key={a.id} item={a} />)}
            {assignments.length === 0 && <p className="muted">Not decomposed yet.</p>}
          </div>
        </section>
      </div>
    </>
  );
}

export function AssignmentRow({ item }: { item: WorkItem }) {
  const e = item.evidence;
  return (
    <div className="assignrow">
      <div className="ar1">
        <Pill tone={workTone(item.state)}>{item.state}</Pill>
        <span className="rowtitle">{item.title}</span>
        {item.employeeId && <a className="chip" href={hrefFor('employee', item.employeeId)}>{item.employeeId}</a>}
        {item.charterId && <span className="chip">{item.charterId}</span>}
      </div>
      {item.plan && <details className="plan"><summary>Plan</summary><Markdown text={item.plan} /></details>}
      {e && (
        <div className="evidence">
          <span>{e.tests.passed} passed / {e.tests.failed} failed{e.tests.command ? ` · ${e.tests.command}` : ''}</span>
          <span>{e.commits.length} commit{e.commits.length === 1 ? '' : 's'}{e.commits.length ? `: ${e.commits.slice(0, 3).join(', ')}` : ''}</span>
          <span>live: {e.liveVerified.join(', ') || 'none'}</span>
          <span>not verified: {e.notVerified.join(', ') || 'none'}</span>
          {e.notes && <span>{e.notes}</span>}
          {item.verifiedBy && <span>verified by {item.verifiedBy}</span>}
        </div>
      )}
    </div>
  );
}
