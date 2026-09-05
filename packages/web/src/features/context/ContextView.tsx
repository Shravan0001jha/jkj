import { useEffect, useRef } from 'react';
import {
  useStore, currentProject, projectContext, setCentralContext,
  setProjectContextBody, showToast,
} from '../../state/store.js';
import { estimateTokens } from '../../lib/format.js';
import { AssembledPreview } from './AssembledPreview.js';
import { GrowTextarea } from '../../components/GrowTextarea.js';

/**
 * Two documents, one preview.
 *
 * The central doc is the hero because it is the thing people forget exists —
 * it is written once and silently shapes every agent afterwards.
 */
export function ContextView() {
  const project = useStore(currentProject);
  const central = useStore(s => s.central);
  const projectDoc = useStore(s => projectContext(s, s.selectedProjectId));
  const projects = useStore(s => s.projects);
  const focusCentral = useStore(s => s.focusCentral);
  const centralRef = useRef<HTMLDivElement>(null);

  // Arriving from the rail should land the cursor in the central document.
  useEffect(() => {
    if (focusCentral) centralRef.current?.querySelector('textarea')?.focus();
  }, [focusCentral]);

  return (
    <>
      <div className="sec-h">
        <h2>Context</h2>
        <p>Two layers. The central one is written once and reaches every agent you ever start.</p>
      </div>

      <div className="ctxwrap">
        <div>
          <article className="doc hero" ref={centralRef}>
            <div className="dh2">
              <h3>How I like things</h3>
              <span className="scope">central · all projects</span>
              <span style={{ marginLeft: 'auto' }}>
                <button className="btn sm" onClick={() => showToast('Reverted to the last saved version.')}>
                  Revert
                </button>
              </span>
            </div>
            <GrowTextarea
              value={central.body}
              onChange={setCentralContext}
              aria-label="Central context"
            />
            <div className="inherits">
              Inherited by {projects.map(p => <span className="chip" key={p.id}>{p.name}</span>)}
            </div>
            <div className="df">
              <span>~/.jkj/CENTRAL.md</span>
              <span style={{ marginLeft: 'auto' }}>{estimateTokens(central.body)} tok</span>
              <span className="pill done"><i />saved</span>
            </div>
          </article>

          <article className="doc">
            <div className="dh2">
              <h3>{project.name}</h3>
              <span className="scope">project</span>
              <span style={{ marginLeft: 'auto' }}>
                <button
                  className="btn sm"
                  onClick={() => showToast(`Wrote ${project.path}/CLAUDE.md from central + project context.`)}
                >
                  Sync to CLAUDE.md
                </button>
              </span>
            </div>
            <GrowTextarea
              value={projectDoc.body}
              onChange={body => setProjectContextBody(project.id, body)}
              aria-label={`${project.name} context`}
            />
            <div className="df">
              <span>{project.path}/.jkj/context.md</span>
              <span style={{ marginLeft: 'auto' }}>{estimateTokens(projectDoc.body)} tok</span>
              <span className="pill done"><i />saved</span>
            </div>
          </article>

          <p className="muted narrow">
            Edits apply to agents started from now on. Running agents keep the context they were
            given — JKJ will not rewrite an agent's history underneath it.
          </p>
        </div>

        <AssembledPreview />
      </div>
    </>
  );
}
