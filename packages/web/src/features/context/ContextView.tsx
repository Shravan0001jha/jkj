import { useEffect, useState } from 'react';
import type { ContextLayer } from '@jkj/shared';
import { useStore, currentProject, editContext } from '../../state/store.js';
import { GrowTextarea } from '../../components/GrowTextarea.js';
import { AssembledPreview } from './AssembledPreview.js';

/**
 * Every file that reaches a session in this project, in the order it arrives.
 *
 * Files that exist are open; files that do not are one line until you write
 * in them, because a page of empty boxes hides the one thing that has content.
 */
export function ContextView() {
  const project = useStore(currentProject);
  const context = useStore(s => s.context);
  const focusUser = useStore(s => s.focusCentral);
  const [open, setOpen] = useState<Set<string>>(new Set());

  // Files with something in them start open; empty ones stay folded away.
  useEffect(() => {
    if (!context) return;
    setOpen(new Set(context.layers.filter(l => l.body.trim() && l.kind !== 'note').map(l => l.id)));
  }, [context?.projectId, context?.layers.length]);

  useEffect(() => {
    if (focusUser) setOpen(current => new Set(current).add('user'));
  }, [focusUser]);

  if (!project) return null;
  if (!context) return <p className="lede">Reading your context files…</p>;

  const notes = context.layers.filter(l => l.kind === 'note');
  const main = context.layers.filter(l => l.kind !== 'note');

  const toggle = (id: string): void => setOpen(current => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  return (
    <>
      <div className="sec-h">
        <h2>Context</h2>
        <p>Everything a session in {project.name} is told before it reads a single file.</p>
      </div>

      <div className="ctxwrap">
        <div>
          {main.map(layer => (
            <LayerCard key={layer.id} layer={layer} open={open.has(layer.id)} onToggle={() => toggle(layer.id)} />
          ))}

          {notes.length > 0 && (
            <>
              <h3 className="group">
                {notes.length} notes behind that index · recalled when relevant, not loaded every time
              </h3>
              {notes.map(note => (
                <LayerCard key={note.id} layer={note} open={open.has(note.id)} onToggle={() => toggle(note.id)} />
              ))}
            </>
          )}
        </div>

        <AssembledPreview />
      </div>
    </>
  );
}

/** One file: what it is, where it lives, and an editor when you want one. */
function LayerCard({ layer, open, onToggle }: {
  layer: ContextLayer;
  open: boolean;
  onToggle: () => void;
}) {
  const hero = layer.kind === 'user';

  return (
    <article className={`doc${hero ? ' hero' : ''}${layer.inherited ? ' inherited' : ''}`}>
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
          <GrowTextarea
            value={layer.body}
            onChange={body => editContext(layer.id, body)}
            aria-label={layer.label}
            placeholder={`Nothing here yet. ${layer.summary}`}
            minHeight={layer.body ? 140 : 72}
          />
          <div className="df">
            <span>
              {layer.summary}
              {layer.kind === 'memory' && ' Your edits stick until Claude next rewrites it.'}
            </span>
            <span style={{ marginLeft: 'auto' }} title={layer.path}>{shortenPath(layer.path)}</span>
          </div>
        </>
      )}
    </article>
  );
}

/** Home is where most of these live, so the tilde earns its space. */
function shortenPath(path: string): string {
  const home = path.match(/^\/(Users|home)\/[^/]+/)?.[0];
  return home ? path.replace(home, '~') : path;
}
