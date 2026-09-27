import { useEffect, useState } from 'react';
import type { ContextLayer } from '@jkj/shared';
import { editEmployeeContext, useStore } from '../../state/store.js';
import { GrowTextarea } from '../../components/GrowTextarea.js';

const COLORS = ['var(--accent)', 'var(--run)', 'var(--done)', 'var(--wait)'];

/**
 * Every layer an employee's session is given, in the order it arrives:
 * the Workplace's layers (handbook, unit, charters, status, handoff) first,
 * then the repo's own CLAUDE.md chain. Each is the file it is, and editing
 * it edits the file.
 */
export function EmployeeContext({ employeeId }: { employeeId: string }) {
  const context = useStore(s => s.employeeContext[employeeId]);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!context) return;
    setOpen(new Set(context.layers.filter(l => l.body.trim() && l.kind !== 'note').slice(0, 4).map(l => l.id)));
  }, [employeeId, context?.layers.length]);

  if (!context) return <p className="lede">Reading the context…</p>;

  const notes = context.layers.filter(l => l.kind === 'note');
  const main = context.layers.filter(l => l.kind !== 'note');
  const present = main.filter(l => l.counted && l.tokens > 0);
  const total = context.totalTokens;

  const toggle = (id: string): void => setOpen(current => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  return (
    <div className="ctxwrap">
      <div>
        {main.map(layer => (
          <LayerCard key={layer.id} layer={layer} open={open.has(layer.id)} onToggle={() => toggle(layer.id)} onEdit={body => editEmployeeContext(employeeId, layer.id, body)} />
        ))}
        {notes.length > 0 && (
          <>
            <h3 className="group">{notes.length} notes · recalled when relevant, not loaded every time</h3>
            {notes.map(note => (
              <LayerCard key={note.id} layer={note} open={open.has(note.id)} onToggle={() => toggle(note.id)} onEdit={body => editEmployeeContext(employeeId, note.id, body)} />
            ))}
          </>
        )}
      </div>

      <aside className="preview">
        <div className="ph">
          <h3>What a session inherits</h3>
          <p>Layered at spawn; the repo's own files load underneath.</p>
        </div>
        <div className="bar">
          {total > 0
            ? present.map((layer, i) => <span key={layer.id} style={{ width: `${(layer.tokens / total) * 100}%`, background: COLORS[i % COLORS.length] }} />)
            : <span style={{ width: '100%', background: 'var(--surface-3)' }} />}
        </div>
        <div className="leg">
          {present.map((layer, i) => (
            <div key={layer.id}><i style={{ background: COLORS[i % COLORS.length] }} /><span className="legname">{layer.label}</span><b>{layer.tokens} tok</b></div>
          ))}
          <div className="total"><i />Total<b>{total} tok</b></div>
        </div>
      </aside>
    </div>
  );
}

function LayerCard({ layer, open, onToggle, onEdit }: { layer: ContextLayer; open: boolean; onToggle: () => void; onEdit: (body: string) => void }) {
  return (
    <article className={`doc${layer.inherited ? ' inherited' : ''}`}>
      <button className="dh2" onClick={onToggle} aria-expanded={open}>
        <span className="caretmark" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <h3>{layer.label}</h3>
        <span className="scope">{layer.kind}</span>
        <span className={`pill ${layer.exists ? 'idle' : 'idle faint'}`} style={{ marginLeft: 'auto' }}>
          <i />{layer.exists ? `${layer.tokens} tok` : 'empty'}
        </span>
      </button>
      {open && (
        <>
          <GrowTextarea value={layer.body} onChange={onEdit} aria-label={layer.label} placeholder={`Nothing here yet. ${layer.summary}`} minHeight={layer.body ? 140 : 72} />
          <div className="df">
            <span>{layer.summary}</span>
            <span style={{ marginLeft: 'auto' }} title={layer.path}>{shortenPath(layer.path)}</span>
          </div>
        </>
      )}
    </article>
  );
}

function shortenPath(path: string): string {
  const home = path.match(/^\/(Users|home)\/[^/]+/)?.[0];
  return home ? path.replace(home, '~') : path;
}
