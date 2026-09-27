import { useMemo, useState } from 'react';
import type { CharterSummary, Employee, LintFinding, OrgProposal } from '@jkj/shared';
import { answerInbox, hrefFor, useStore } from '../../state/store.js';
import { ago } from '../../lib/format.js';
import { Pill } from '../../components/Pill.js';
import { CharterModal } from './CharterModal.js';

/**
 * The org chart, the ownership map, what the lint found, and every proposal
 * to change any of it, with its diff and its history.
 */
export function OrgView() {
  const org = useStore(s => s.org);
  const [charter, setCharter] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  if (!org) return <div className="pane"><p className="lede">Reading the organisation…</p></div>;

  const roots = org.employees.filter(e => e.reportsTo === null || !org.employees.some(x => x.id === e.reportsTo));
  const errors = org.lint.filter(f => f.severity === 'error').length;

  return (
    <div className="pane">
      <div className="sec-h">
        <h2>Organisation</h2>
        <p>{org.employees.length} employees · {org.charters.length} charters · {org.units.length} units · {errors} lint error{errors === 1 ? '' : 's'}</p>
      </div>

      <div className="twocol">
        <section>
          <h3 className="group">Reporting lines</h3>
          <ul className="tree">
            {roots.map(e => <TreeNode key={e.id} employee={e} employees={org.employees} charters={org.charters} depth={0} />)}
          </ul>

          <h3 className="group">Units</h3>
          <div className="chips">
            {org.units.map(u => (
              <span key={u.id} className="chip" title={u.parentId ? `inside ${u.parentId}` : 'top level'}>
                {u.title}{u.kind === 'chapter' ? ' · chapter' : ''}{u.budget ? ` · ₹${u.budget.inrPerDay}/day` : ''}
              </span>
            ))}
          </div>
        </section>

        <section>
          <h3 className="group">Charters</h3>
          <div className="stack tight">
            {org.charters.map(c => (
              <button key={c.id} className="rowbtn" onClick={() => setCharter(c.id)}>
                <span className="rowtitle">{c.title}</span>
                <span className="chip">{c.axis}</span>
                <span className="muted">{c.holderIds.length ? c.holderIds.join(', ') : 'unheld'} · {c.tokens} tok · v{c.version}</span>
              </button>
            ))}
          </div>
        </section>
      </div>

      <h3 className="group">Lint</h3>
      {org.lint.length === 0 ? <p className="muted">Clean: every thing has one owner, every requirement is owned, every charter is held.</p> : <LintList findings={org.lint} />}

      <h3 className="group">Ownership map</h3>
      <div className="f" style={{ maxWidth: 360, marginBottom: 10 }}>
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter by key, charter or kind…" aria-label="Filter the map" />
      </div>
      <MapTable filter={filter} />

      <h3 className="group">Proposals</h3>
      {org.proposals.length === 0
        ? <p className="muted">No org changes proposed yet. Employees propose from their sessions; you approve here or in the Inbox.</p>
        : <div className="stack">{org.proposals.map(p => <ProposalCard key={p.id} proposal={p} />)}</div>}

      <h3 className="group">History</h3>
      <ul className="history">
        {org.history.map(h => (
          <li key={h.commit}><code>{h.commit}</code> <span>{h.message.split('\n')[0]}</span> <span className="muted">{ago(h.at)} ago</span></li>
        ))}
        {org.history.length === 0 && <li className="muted">No commits yet.</li>}
      </ul>

      {charter && <CharterModal id={charter} onClose={() => setCharter(null)} />}
    </div>
  );
}

function TreeNode({ employee, employees, charters, depth }: { employee: Employee; employees: Employee[]; charters: CharterSummary[]; depth: number }) {
  const reports = employees.filter(e => e.reportsTo === employee.id);
  const held = charters.filter(c => employee.charterIds.includes(c.id));
  return (
    <li className="treenode" style={{ ['--depth' as string]: depth }}>
      <a href={hrefFor('employee', employee.id)} className="treerow">
        <b>{employee.name}</b>
        <span className="muted">{employee.roleId} · {employee.unitId}{employee.chapterIds.length ? ` (+${employee.chapterIds.join(', ')})` : ''}</span>
        <span className="chips inline">{held.map(c => <span key={c.id} className="chip">{c.title}</span>)}</span>
      </a>
      {reports.length > 0 && (
        <ul>{reports.map(r => <TreeNode key={r.id} employee={r} employees={employees} charters={charters} depth={depth + 1} />)}</ul>
      )}
    </li>
  );
}

function LintList({ findings }: { findings: LintFinding[] }) {
  const groups = useMemo(() => {
    const out = new Map<string, LintFinding[]>();
    for (const f of findings) out.set(f.code, [...(out.get(f.code) ?? []), f]);
    return [...out.entries()];
  }, [findings]);
  return (
    <div className="stack tight">
      {groups.map(([code, items]) => (
        <details key={code} className="lintgroup" open={items.some(i => i.severity === 'error')}>
          <summary>
            <Pill tone={items[0]?.severity === 'error' ? 'error' : 'waiting'}>{code}</Pill>
            <span>{items.length}</span>
          </summary>
          <ul>{items.map((f, i) => <li key={i}><code>{f.subject}</code> {f.message}</li>)}</ul>
        </details>
      ))}
    </div>
  );
}

function MapTable({ filter }: { filter: string }) {
  const map = useStore(s => s.org?.map ?? []);
  const q = filter.trim().toLowerCase();
  const rows = q ? map.filter(m => `${m.kind} ${m.key} ${m.primary} ${m.consulted.join(' ')}`.toLowerCase().includes(q)) : map;
  return (
    <div className="tablewrap">
      <table className="table">
        <thead><tr><th>Kind</th><th>Key</th><th>Primary</th><th>Consulted</th></tr></thead>
        <tbody>
          {rows.slice(0, 300).map((m, i) => (
            <tr key={`${m.kind}:${m.key}:${i}`}>
              <td><span className="chip">{m.kind}</span></td>
              <td><code>{m.key}</code></td>
              <td>{m.primary}</td>
              <td className="muted">{[...m.contributors, ...m.consulted].join(', ')}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={4} className="muted">Nothing matches.</td></tr>}
        </tbody>
      </table>
      {rows.length > 300 && <p className="muted">{rows.length - 300} more; narrow the filter.</p>}
    </div>
  );
}

function ProposalCard({ proposal }: { proposal: OrgProposal }) {
  const tone = proposal.state === 'applied' ? 'done' : proposal.state === 'rejected' ? 'error' : proposal.state === 'approved' ? 'running' : 'waiting';
  const errors = proposal.lint.filter(f => f.severity === 'error');
  return (
    <article className="inboxcard">
      <div className="ih">
        <Pill tone={tone}>{proposal.state}</Pill>
        <h3>{proposal.kind}: {describe(proposal)}</h3>
        <span className="muted">{proposal.proposedBy} · {ago(proposal.createdAt)} ago{proposal.appliedCommit ? ` · ${proposal.appliedCommit}` : ''}</span>
      </div>
      <p className="reason">{proposal.reason}</p>
      {errors.length > 0 && <p className="muted">Cannot be approved: {errors.map(e => e.message).join('; ')}</p>}
      <details className="diff"><summary>Diff of the org files</summary><pre>{proposal.diff || '(no file changes)'}</pre></details>
      {proposal.state === 'pending' && (
        <div className="row">
          <button className="btn sm primary" disabled={errors.length > 0} onClick={() => void answerInbox(proposal.inboxId, 'approve')}>Approve</button>
          <button className="btn sm danger" onClick={() => void answerInbox(proposal.inboxId, 'reject')}>Reject</button>
        </div>
      )}
    </article>
  );
}

function describe(p: OrgProposal): string {
  const params = p.params as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (p.kind) {
    case 'hire': return `${s(params['name'])} as ${s(params['roleId'])}`;
    case 'retire': return s(params['employeeId']);
    case 'split': return `${s(params['charterId'])} → ${((params['into'] as { id?: string }[]) ?? []).map(t => t.id).join(' + ')}`;
    case 'merge': return `${((params['charterIds'] as string[]) ?? []).join(' + ')} → ${s(params['into'])}`;
    case 'reassign': return `${s(params['charterId'])} → ${s(params['toEmployeeId'])}`;
    case 'restructure': return 'units and reporting lines';
  }
}
