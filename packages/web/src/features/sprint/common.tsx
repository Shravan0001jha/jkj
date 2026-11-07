import { useState } from 'react';
import type { BoardColumn, PlannedEpic } from '@jkj/shared';
import { BOARD_COLUMN_LABEL } from '@jkj/shared';
import { hrefFor, useStore } from '../../state/store.js';

/**
 * The board's vocabulary (HLD D8): one column chip (To do / In progress / In review / Done, Jira's names and
 * colours) plus flag badges (Blocked, At risk, Overdue, Due today). Flags are never columns.
 */
export function ColumnChip({ column }: { column: BoardColumn }) {
  return <span className={`chip col-${column}`}>{BOARD_COLUMN_LABEL[column]}</span>;
}

export function Flags({ epic }: { epic: Pick<PlannedEpic, 'flags' | 'state'> }) {
  const f = epic.flags;
  return (
    <>
      {f.blocked && <span className="chip f-blocked">Blocked</span>}
      {f.overdue ? <span className="chip f-overdue">Overdue</span> : f.atRisk && <span className="chip f-risk">At risk</span>}
      {f.dueToday && <span className="chip f-today">Due today</span>}
      {epic.state === 'parked' && <span className="chip f-parked">Parked</span>}
    </>
  );
}

/** The epic's chips: its column, then its flags. */
export function StateChip({ epic }: { epic: Pick<PlannedEpic, 'column' | 'flags' | 'state'> }) {
  return <><ColumnChip column={epic.column} /><Flags epic={epic} /></>;
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
    <div className={`epicrow${epic.flags.dueToday ? ' today' : ''}${epic.flags.overdue ? ' overdue' : ''}${epic.flags.blocked ? ' blockedrow' : ''}`}>
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

/**
 * One epic as a board card (HLD D8): title, feature tag, people, due date, stories done/total, flags, and the
 * first blocker. The card menu (Park, Move date, Backlog) is passed in by the board.
 */
export function EpicCard({ epic, menu, draggable, onDragStart }: { epic: PlannedEpic; menu?: React.ReactNode; draggable?: boolean; onDragStart?: () => void }) {
  const names = useNames();
  const first = epic.blockers[0];
  const p = epic.progress;
  return (
    <div className={`ecard${epic.flags.dueToday ? ' today' : ''}${epic.flags.overdue ? ' overdue' : ''}${epic.flags.blocked ? ' blocked' : ''}`}
      draggable={draggable} onDragStart={e => { e.dataTransfer.setData('text/plain', epic.id); onDragStart?.(); }}>
      <a className="et" href={hrefFor('epic', epic.id)}>{epic.title}</a>
      <div className="ef">
        {epic.featureTitle && <span className="chip ftag">{epic.featureTitle}</span>}
        <Flags epic={epic} />
      </div>
      {first && <div className="blk"><b className="bl">Blocked</b> {first.title}, waiting on <b>{first.blocker.label}</b></div>}
      <div className="em2 muted">
        <span>{day(epic.dueDate)}</span>
        <span>{p.storiesTotal ? `${p.storiesDone}/${p.storiesTotal}` : 'no stories'}</span>
        <span className="who">{epic.assignees.length ? epic.assignees.map(id => <span key={id} className="av" title={names(id)}>{initials(names(id))}</span>) : <span className="muted">unassigned</span>}</span>
      </div>
      {menu && <div className="emenu">{menu}</div>}
    </div>
  );
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).map(w => w[0]!.toUpperCase()).slice(0, 2).join('') || '?';
}
