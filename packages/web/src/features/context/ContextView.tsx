import { useEffect, useRef } from 'react';
import {
  useStore, currentProject, projectContext, setCentralContext, setProjectContextBody,
} from '../../state/store.js';
import { estimateTokens } from '../../lib/format.js';
import { AssembledPreview } from './AssembledPreview.js';
import { GrowTextarea } from '../../components/GrowTextarea.js';

/**
 * Two documents, one preview.
 *
 * These are the real CLAUDE.md files, not a JKJ store — what you type here is
 * what the CLI reads next time it starts. Saves are debounced; there is no
 * save button because there is no draft state to lose.
 */
export function ContextView() {
  const project = useStore(currentProject);
  const central = useStore(s => s.central.body);
  const projectDoc = useStore(s => projectContext(s, s.selectedProjectId));
  const projects = useStore(s => s.projects);
  const claudeHome = useStore(s => s.claudeHome);
  const focusCentral = useStore(s => s.focusCentral);
  const centralRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusCentral) centralRef.current?.querySelector('textarea')?.focus();
  }, [focusCentral]);

  if (!project) return null;

  return (
    <>
      <div className="sec-h">
        <h2>Context</h2>
        <p>Two layers. The central one is written once and reaches every session on this machine.</p>
      </div>

      <div className="ctxwrap">
        <div>
          <article className="doc hero" ref={centralRef}>
            <div className="dh2">
              <h3>How I like things</h3>
              <span className="scope">central · all projects</span>
            </div>
            <GrowTextarea
              value={central}
              onChange={setCentralContext}
              aria-label="Central context"
              placeholder="Nothing here yet. Whatever you write is read by every session you start."
            />
            <div className="inherits">
              Inherited by {projects.map(p => <span className="chip" key={p.id}>{p.name}</span>)}
            </div>
            <div className="df">
              <span>{claudeHome ?? '~/.claude'}/CLAUDE.md</span>
              <span style={{ marginLeft: 'auto' }}>{estimateTokens(central)} tok</span>
            </div>
          </article>

          <article className="doc">
            <div className="dh2">
              <h3>{project.name}</h3>
              <span className="scope">project</span>
            </div>
            <GrowTextarea
              value={projectDoc.body}
              onChange={body => setProjectContextBody(project.id, body)}
              aria-label={`${project.name} context`}
              placeholder="No CLAUDE.md in this repo yet. Type here to create one."
            />
            <div className="df">
              <span>{project.path}/CLAUDE.md</span>
              <span style={{ marginLeft: 'auto' }}>{estimateTokens(projectDoc.body)} tok</span>
            </div>
          </article>

          <p className="muted narrow">
            Edits are written to disk a moment after you stop typing. Sessions already running keep
            the context they started with.
          </p>
        </div>

        <AssembledPreview />
      </div>
    </>
  );
}
