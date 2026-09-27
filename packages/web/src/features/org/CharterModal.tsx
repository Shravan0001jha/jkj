import { useEffect, useState } from 'react';
import type { Charter } from '@jkj/shared';
import * as api from '../../api/client.js';
import { saveCharter, showToast, message } from '../../state/store.js';
import { Modal } from '../../components/Modal.js';
import { Markdown } from '../../components/Markdown.js';
import { GrowTextarea } from '../../components/GrowTextarea.js';

/** A charter, readable as a document and editable as the file it is. */
export function CharterModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [charter, setCharter] = useState<Charter | null>(null);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api.getCharter(id).then(c => { if (alive) { setCharter(c); setBody(c.body); } }).catch(err => showToast(message(err)));
    return () => { alive = false; };
  }, [id]);

  const save = async (): Promise<void> => {
    setBusy(true);
    await saveCharter(id, body);
    const fresh = await api.getCharter(id).catch(() => null);
    if (fresh) { setCharter(fresh); setBody(fresh.body); }
    setBusy(false);
    setEditing(false);
  };

  return (
    <Modal
      title={charter ? `${charter.title} · v${charter.version}` : 'Charter'}
      onClose={onClose}
      footer={editing
        ? <><button className="btn" onClick={() => { setEditing(false); setBody(charter?.body ?? ''); }}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save (bumps version)'}</button></>
        : <><button className="btn" onClick={() => setEditing(true)}>Edit</button><button className="btn primary" onClick={onClose}>Close</button></>}
    >
      {!charter ? <p className="muted">Reading…</p> : (
        <>
          <div className="chips">
            <span className="chip">{charter.axis}</span>
            <span className="chip">{charter.holderIds.length ? `held by ${charter.holderIds.join(', ')}` : 'unheld'}</span>
            <span className="chip">{charter.tokens} tok</span>
            <span className="chip">{charter.owns.length} owned things</span>
          </div>
          <p className="lede">{charter.mission}</p>
          {editing
            ? <div className="doc"><GrowTextarea value={body} onChange={setBody} minHeight={300} maxHeight={520} aria-label="Charter body" /></div>
            : <Markdown text={charter.body} />}
        </>
      )}
    </Modal>
  );
}
