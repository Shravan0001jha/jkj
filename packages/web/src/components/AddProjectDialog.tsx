import { useEffect, useState } from 'react';
import type { BrowseResponse } from '@jkj/shared';
import { API } from '@jkj/shared';
import { addProject, setAddProjectOpen, showToast } from '../state/store.js';
import { Modal } from './Modal.js';

/**
 * Pointing at a directory rather than typing its path.
 *
 * The browser's own directory picker cannot help here: it returns a handle
 * with a name, never a location on disk. So the server lists directories and
 * this walks them — which it can do because it is already running on the same
 * machine as the folders in question.
 */
export function AddProjectDialog() {
  const [view, setView] = useState<BrowseResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const go = async (path?: string): Promise<void> => {
    try {
      const res = await fetch(API.browse(path));
      if (!res.ok) throw new Error((await res.json()).error ?? 'Could not read that folder');
      setView(await res.json());
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not read that folder');
    }
  };

  useEffect(() => { void go(); }, []);

  const close = (): void => setAddProjectOpen(false);

  const choose = async (): Promise<void> => {
    if (!view || busy) return;
    setBusy(true);
    await addProject(view.path);
    setBusy(false);
  };

  return (
    <Modal
      title="Add a project"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={() => void choose()} disabled={!view || busy}>
            {busy ? 'Adding…' : 'Use this folder'}
          </button>
        </>
      }
    >
      <p className="lede" style={{ margin: 0 }}>
        Any directory Claude Code has already worked in appears on its own. Pick one here to start
        a session somewhere new.
      </p>

      <nav className="crumbs" aria-label="Location">
        {view?.crumbs.map((crumb, i) => (
          <span key={crumb.path}>
            {i > 0 && <span className="sep">/</span>}
            <button onClick={() => void go(crumb.path)}>{crumb.name}</button>
          </span>
        ))}
      </nav>

      <div className="browser" role="listbox" aria-label="Folders">
        {view?.parent && (
          <button className="brow up" onClick={() => void go(view.parent!)}>
            <span className="ico" aria-hidden="true">↑</span> Up one level
          </button>
        )}

        {view?.entries.length === 0 && <div className="bempty">No folders in here.</div>}

        {view?.entries.map(entry => (
          <button key={entry.path} className="brow" onDoubleClick={() => void go(entry.path)} onClick={() => void go(entry.path)}>
            <span className="ico" aria-hidden="true">{entry.isRepo ? '◆' : '▸'}</span>
            <span className="bname">{entry.name}</span>
            {entry.isRepo && <span className="bgit">git</span>}
          </button>
        ))}

        {!view && <div className="bempty">Reading…</div>}
      </div>

      <div className="hint">
        Adding <code>{view?.path ?? '…'}</code>
      </div>
    </Modal>
  );
}
