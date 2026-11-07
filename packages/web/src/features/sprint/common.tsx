import { useState } from 'react';
import type { EpicState, PlannedEpic } from '@jkj/shared';
import { hrefFor, useStore } from '../../state/store.js';

/** The owner's chip vocabulary (LLD §6): green done, blue on track, amber at risk, red overdue, grey blocked. */
export function StateChip({ epic }: { epic: Pick<PlannedEpic, 'state' | 'overdue' | 'dueToday'> }) {
  const [tone, label] = chip(epic.state, epic.overdue);
  return <span className={`chip ${tone}`}>{label}{epic.dueToday && epic.state !== 'done' ? ' · due today' : ''}</span>;
}

export function chip(state: EpicState, overdue: boolean): [string, string] {
  if (overdue) return ['c-overdue', 'Overdue'];
  switch (state) {
    case 'done': return ['c-done', 'Done'];
    case 'at-risk': return ['c-risk', 'At risk'];
    case 'blocked': return ['c-blocked', 'Blocked'];
    case 'parked': return ['c-parked', 'Parked'];
    case 'backlog': return ['c-parked', 'Backlog'];
    case 'in-progress': return ['c-track', 'On track'];
    default: return ['c-track', 'Planned'];
  }
}

export function Progress({ pct, done, total }: { pct: number; done: number; total: number }) {
  return (
    <span className="prog" title={`${done} of ${total} done`}>
      <span className="bar"><i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></span>
      <span className="muted">{total ? `${done}/${total}` : 'no stories yet'}</span>
    </span>
  );
}

/** "Fri 13 Nov" from YYYY-MM-DD, read as a calendar date (no timezone shift). */
export function day(date: string | undefined): string {
  if (!date) return 'no date';
  const d = new Date(`${date}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function nameOf(id: string | undefined): string {
  return id ?? '';
}

/** Employee names from the office, falling back to the id. */
export function useNames(): (id: string | undefined) => string {
  const office = useStore(s => s.office);
  const org = useStore(s => s.org);
  return (id: string | undefined): string => {
    if (!id) return '';
    if (id === 'owner') return 'you';
    if (id === 'coo') return 'COO';
    for (const u of office?.units ?? []) for (const e of u.employees) if (e.employee.id === id) return e.employee.name;
    return org?.employees.find(e => e.id === id)?.name ?? id;
  };
}

/** One epic as a row: title, feature, chip, date, progress, the first blocker. Tapping opens the epic. */
export function EpicRow({ epic, showFeature = true, actions }: { epic: PlannedEpic; showFeature?: boolean; actions?: React.ReactNode }) {
  const names = useNames();
  const first = epic.blockers[0];
  return (
    <div className={`epicrow${epic.dueToday ? ' today' : ''}${epic.overdue ? ' overdue' : ''}`}>
      <a className="em" href={hrefFor('epic', epic.id)}>
        <div className="t">
          <b>{epic.title}</b>
          <StateChip epic={epic} />
        </div>
        <div className="m muted">
          {showFeature && epic.featureTitle ? <span>{epic.featureTitle} · </span> : null}
          <span>due {day(epic.dueDate)}</span>
          {epic.assignees.length > 0 && <span> · {epic.assignees.map(names).join(', ')}</span>}
          {epic.carried?.length ? <span> · carried from {epic.carried[epic.carried.length - 1]!.fromSprint.replace('sp_', 'Sprint ')}</span> : null}
        </div>
        {first && (
          <div className="blk">
            <b className="bl">Blocked</b> {first.title}, waiting on <b>{first.blocker.label}</b>{first.blocker.reason ? `: ${first.blocker.reason}` : ''}
            {epic.blockers.length > 1 ? ` (+${epic.blockers.length - 1} more)` : ''}
          </div>
        )}
        <Progress pct={epic.progress.pct} done={epic.progress.storiesDone} total={epic.progress.storiesTotal} />
      </a>
      {actions && <div className="acts">{actions}</div>}
    </div>
  );
}

/**
 * A due-date editor. The first date needs no reason; a change does (the owner's rule: dates move only
 * with a why, and every move is logged).
 */
export function DateEdit({ current, onSave }: { current?: string; onSave: (date: string, reason?: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(current ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const needsReason = !!current && date !== current;
  if (!open) return <button className="btn sm" onClick={() => { setDate(current ?? ''); setReason(''); setOpen(true); }}>{current ? 'Move date' : 'Set date'}</button>;
  const save = async (): Promise<void> => {
    if (!date || (needsReason && !reason.trim())) return;
    setBusy(true);
    try { await onSave(date, needsReason ? reason.trim() : undefined); setOpen(false); } finally { setBusy(false); }
  };
  return (
    <span className="dateedit">
      <input type="date" value={date} onChange={e => setDate(e.target.value)} aria-label="Due date" />
      {needsReason && <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Why it moves (required)" aria-label="Reason" />}
      <button className="btn sm primary" disabled={busy || !date || (needsReason && !reason.trim())} onClick={() => void save()}>Save</button>
      <button className="btn sm ghost" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  );
}

export function SprintTabs() {
  const route = useStore(s => s.route.name);
  const tabs: { name: 'today' | 'sprint' | 'backlog' | 'review' | 'teams'; label: string }[] = [
    { name: 'today', label: 'Today' }, { name: 'sprint', label: 'Sprint' }, { name: 'backlog', label: 'Backlog' },
    { name: 'review', label: 'Review' }, { name: 'teams', label: 'Teams' },
  ];
  return (
    <nav className="subtabs" aria-label="Sprint board">
      {tabs.map(t => <a key={t.name} href={hrefFor(t.name)} aria-current={route === t.name}>{t.label}</a>)}
    </nav>
  );
}

export function Loading({ error }: { error: string | null }) {
  return error ? <div className="note"><b>Couldn't load.</b> {error}</div> : <div className="muted pad">Loading…</div>;
}
