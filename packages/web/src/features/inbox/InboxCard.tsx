import { useState } from 'react';
import type { InboxItem } from '@jkj/shared';
import type { InboxThread } from '@jkj/shared';
import { answerInbox, hrefFor, message, showToast } from '../../state/store.js';
import { v2Api } from '../../api/client.js';
import { ago } from '../../lib/format.js';
import { Markdown } from '../../components/Markdown.js';
import { Pill } from '../../components/Pill.js';

const KIND_TONE: Record<InboxItem['kind'], string> = {
  approval: 'waiting', decision: 'waiting', question: 'running', cap: 'error', 'org-change': 'waiting', release: 'waiting',
};

/**
 * One thing that needs the owner. Every option is its own button; an option
 * that needs a note opens a small field first so the answer carries it.
 */
export function InboxCard({ item, compact = false }: { item: InboxItem; compact?: boolean }) {
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const open = item.state === 'open';

  const answer = async (optionId: string): Promise<void> => {
    const option = item.options.find(o => o.id === optionId);
    if (option?.needsNote && noteFor !== optionId) { setNoteFor(optionId); return; }
    if (option?.needsNote && !note.trim()) return;
    setBusy(true);
    await answerInbox(item.id, optionId, note.trim() || undefined);
    setBusy(false);
    setNoteFor(null);
    setNote('');
  };

  return (
    <article className={`inboxcard${open ? '' : ' answered'}`}>
      <div className="ih">
        <Pill tone={open ? KIND_TONE[item.kind] : 'idle'}>{item.kind}</Pill>
        <h3>{item.title}</h3>
        <span className="muted">{item.raisedBy} · {ago(item.createdAt)} ago</span>
      </div>

      <p className="oneline">{item.summary || item.title}</p>
      {(open || !compact) && (item.details || item.body) && (item.details ?? item.body).trim() !== (item.summary ?? '').trim() ? (
        <details className="more"><summary>Details</summary><div className="ibody"><Markdown text={item.details ?? item.body} /></div></details>
      ) : null}

      {typeof item.context['diff'] === 'string' && item.context['diff'] && (
        <details className="diff"><summary>Diff</summary><pre>{String(item.context['diff'])}</pre></details>
      )}

      {(item.affects.length > 0 || (item.links?.length ?? 0) > 0) && (
        <div className="affects">
          {item.affects.length > 0 && <span className="muted">concerns</span>}
          {item.affects.map(id => <a key={id} className="chip" href={hrefFor('employee', id)}>{id}</a>)}
          {item.links?.map(l => <a key={l.href} className="chip link" href={l.href}>{l.label} →</a>)}
        </div>
      )}

      {open && (item.onApprove || item.onDeny) && (
        <dl className="effects">
          {item.onApprove && <div><dt>{item.options[0]?.label ?? 'Yes'}</dt><dd>{item.onApprove}</dd></div>}
          {item.onDeny && <div><dt>{(item.options.find(o => o.danger) ?? item.options[1])?.label ?? 'No'}</dt><dd>{item.onDeny}</dd></div>}
        </dl>
      )}

      <Thread item={item} />

      {open ? (
        <>
          {noteFor && (
            <div className="f notefield">
              <label>{item.options.find(o => o.id === noteFor)?.label}: note</label>
              <input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. 1500" autoFocus />
            </div>
          )}
          <div className="row">
            {item.options.map(option => (
              <button
                key={option.id}
                className={`btn sm ${option.danger ? 'danger' : option.id === 'approve' || option.id === 'yes' ? 'primary' : ''}`}
                disabled={busy}
                onClick={() => void answer(option.id)}
              >
                {option.label}
              </button>
            ))}
            {noteFor && <button className="btn sm ghost" onClick={() => { setNoteFor(null); setNote(''); }}>Cancel</button>}
          </div>
        </>
      ) : item.answer ? (
        <div className="answerline">
          Answered <b>{item.options.find(o => o.id === item.answer!.optionId)?.label ?? item.answer.optionId}</b>
          {item.answer.note ? ` — ${item.answer.note}` : ''} · via {item.answer.via} · {ago(item.answer.at)} ago
        </div>
      ) : (
        <div className="answerline">Expired.</div>
      )}
    </article>
  );
}

/**
 * The item's reply thread (parity with the app, HLD §6): read what the raiser and the COO said, and reply
 * without answering — ask back or suggest something else; the asker answers in the same thread.
 */
function Thread({ item }: { item: InboxItem }) {
  const [thread, setThread] = useState<InboxThread | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const count = (item as InboxItem & { replies?: number }).replies ?? 0;
  const load = (): void => { v2Api.inboxThread(item.id).then(setThread, err => showToast(message(err))); };
  if (!thread) {
    return <button className="btn sm ghost" onClick={load}>{count ? `Thread (${count})` : 'Reply'}</button>;
  }
  const send = (): void => {
    if (!text.trim()) return;
    setBusy(true);
    v2Api.inboxReply(item.id, text.trim()).then(t => { setThread(t); setText(''); }, err => showToast(message(err))).finally(() => setBusy(false));
  };
  return (
    <div className="ithread">
      {thread.messages.map(m => <div key={m.id} className="comment"><b>{m.by === 'owner' ? 'You' : m.by}</b> <span className="muted">{ago(m.at)} ago</span><Markdown text={m.text} /></div>)}
      {thread.messages.length === 0 && <p className="muted">No replies yet.</p>}
      <form className="row" onSubmit={e => { e.preventDefault(); send(); }}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Reply without answering: ask back or suggest something" aria-label="Reply" />
        <button className="btn sm" type="submit" disabled={busy || !text.trim()}>Send</button>
      </form>
    </div>
  );
}
