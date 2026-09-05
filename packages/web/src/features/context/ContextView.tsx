import { useEffect, useRef } from 'react';
import type { ContextLayer } from '@jkj/shared';
import { useStore, currentProject, editContext } from '../../state/store.js';
import { GrowTextarea } from '../../components/GrowTextarea.js';
import { AssembledPreview } from './AssembledPreview.js';

/**
 * Every file that reaches a session in this project, in the order it arrives.
 *
 * Two of them are yours, one is the repo's, and one is written by Claude. The
 * point of showing all four is that the preview beside them is the prompt —
 * if this page and the model ever disagree, this page is the bug.
 */
export function ContextView() {
  const project = useStore(currentProject);
  const context = useStore(s => s.context);
  const focusCentral = useStore(s => s.focusCentral);
  const firstRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (focusCentral) firstRef.current?.querySelector('textarea')?.focus();
  }, [focusCentral, context]);

  if (!project) return null;
  if (!context) return <p className="lede">Reading your context files…</p>;

  return (
    <>
      <div className="sec-h">
        <h2>Context</h2>
        <p>Everything a session in {project.name} is told before it reads a single file.</p>
      </div>

      <div className="ctxwrap">
        <div>
          {context.layers.map((layer, index) => (
            <LayerCard
              key={layer.id}
              layer={layer}
              hero={index === 0}
              ref={index === 0 ? firstRef : undefined}
            />
          ))}

          {context.memoryFiles.length > 0 && (
            <article className="doc">
              <div className="dh2">
                <h3>Memory notes</h3>
                <span className="scope">{context.memoryFiles.length} files</span>
              </div>
              <div className="memlist">
                {context.memoryFiles.map(file => (
                  <span className="chip" key={file.name} title={`${file.bytes} bytes`}>{file.name}</span>
                ))}
              </div>
              <div className="df">
                <span>Claude writes these as it learns. The index above is what a session reads.</span>
              </div>
            </article>
          )}
        </div>

        <AssembledPreview />
      </div>
    </>
  );
}

/** One file: what it is, where it lives, and whether you may change it. */
const LayerCard = ({ layer, hero, ref }: {
  layer: ContextLayer;
  hero: boolean;
  ref?: React.Ref<HTMLElement>;
}) => (
  <article className={`doc${hero ? ' hero' : ''}`} ref={ref}>
    <div className="dh2">
      <h3>{layer.label}</h3>
      <span className="scope">{layer.editable ? layer.id : 'read-only'}</span>
      <span className="pill idle" style={{ marginLeft: 'auto' }}>
        <i />{layer.exists ? `${layer.tokens} tok` : 'not created yet'}
      </span>
    </div>

    {layer.editable ? (
      <GrowTextarea
        value={layer.body}
        onChange={body => editContext(layer.id, body)}
        aria-label={layer.label}
        placeholder={`Nothing here yet. ${layer.summary}`}
        minHeight={layer.body ? 150 : 90}
      />
    ) : (
      <pre className="readonlydoc">{layer.body || 'Nothing remembered for this project yet.'}</pre>
    )}

    <div className="df">
      <span>{layer.summary}</span>
      <span style={{ marginLeft: 'auto' }} title={layer.path}>{shortenPath(layer.path)}</span>
    </div>
  </article>
);

/** Home is where most of these live, so the tilde earns its space. */
function shortenPath(path: string): string {
  const home = path.match(/^\/(Users|home)\/[^/]+/)?.[0];
  return home ? path.replace(home, '~') : path;
}
