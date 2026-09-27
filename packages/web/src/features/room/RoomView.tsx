import { useEffect, useState } from 'react';
import type { RoomMessage, RoomThread } from '@jkj/shared';
import { hrefFor, navigate, openThread, postToThread, resolveThread, useStore } from '../../state/store.js';
import { ago } from '../../lib/format.js';
import { Pill } from '../../components/Pill.js';
import { GrowTextarea } from '../../components/GrowTextarea.js';
import { Markdown } from '../../components/Markdown.js';

/**
 * The Team Room: one persistent group chat, a thread per topic, led by the Chief of Staff.
 * Employees post here instead of editing outside their charter; the owner can read and
 * comment at any time, and what he writes is marked as his. Escalations are Inbox items
 * linked back to the thread.
 */
export function RoomView({ id }: { id?: string }) {
  const threads = useStore(s => s.room);
  const detail = useStore(s => (id ? s.roomThreads[id] : undefined));
  const [show, setShow] = useState<'open' | 'resolved'>('open');
  const [composing, setComposing] = useState(false);

  if (id) {
    if (!detail) return <div className="pane"><p className="lede">Reading the thread…</p></div>;
    return <ThreadView thread={detail.thread} messages={detail.messages} />;
  }

  const visible = threads.filter(t => t.state === show);
  return (
    <div className="pane">
      <div className="sec-h">
        <h2>Team Room</h2>
        <p>{threads.filter(t => t.state === 'open').length} open thread{threads.filter(t => t.state === 'open').length === 1 ? '' : 's'}. Asha moderates; you can read and comment any time.</p>
        <div className="seg small" style={{ marginLeft: 'auto' }}>
          {(['open', 'resolved'] as const).map(t => <button key={t} aria-pressed={show === t} onClick={() => setShow(t)}>{t}</button>)}
        </div>
        <button className="btn sm primary" onClick={() => setComposing(v => !v)}>{composing ? 'Cancel' : 'New thread'}</button>
      </div>

      {composing && <NewThread onDone={() => setComposing(false)} />}

      <div className="stack tight">
        {visible.map(t => <ThreadRow key={t.id} thread={t} />)}
        {visible.length === 0 && <p className="muted">{show === 'open' ? 'Nothing open. Threads appear when an employee raises a topic or you start one.' : 'Nothing resolved yet.'}</p>}
      </div>
    </div>
  );
}

function ThreadRow({ thread }: { thread: RoomThread }) {
  return (
    <a className="threadrow" href={hrefFor('room', thread.id)}>
      <div className="ar1">
        <Pill tone={thread.state === 'open' ? 'running' : 'done'}>{thread.state}</Pill>
        <span className="rowtitle">{thread.title}</span>
        {thread.escalations.length > 0 && <span className="subchip">{thread.escalations.length} escalated</span>}
      </div>
      <div className="threadmeta">
        <span>{thread.messageCount} message{thread.messageCount === 1 ? '' : 's'}</span>
        <span>last {ago(thread.lastAt)} ago</span>
        <span>by {thread.createdBy}</span>
        {thread.charterIds.map(c => <span key={c} className="chip">{c}</span>)}
        {thread.participants.map(p => <span key={p} className="chip faint">@{p}</span>)}
      </div>
      {thread.summary && <div className="muted" style={{ marginTop: 4 }}>{thread.summary}</div>}
    </a>
  );
}

function ThreadView({ thread, messages }: { thread: RoomThread; messages: RoomMessage[] }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [summary, setSummary] = useState('');
  const inbox = useStore(s => s.inbox);
  const escalations = inbox.filter(i => thread.escalations.includes(i.id));

  useEffect(() => { setText(''); setResolving(false); setSummary(''); }, [thread.id]);

  const send = async (): Promise<void> => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    await postToThread(thread.id, value);
    setText('');
    setBusy(false);
  };

  const resolve = async (): Promise<void> => {
    const value = summary.trim();
    if (!value || busy) return;
    setBusy(true);
    await resolveThread(thread.id, value);
    setBusy(false);
    setResolving(false);
  };

  return (
    <div className="pane thread">
      <div className="crumb"><a href={hrefFor('room')}>Team Room</a><span>›</span><span>{thread.title}</span></div>
      <div className="dhead">
        <div className="r1">
          <h2>{thread.title}</h2>
          <Pill tone={thread.state === 'open' ? 'running' : 'done'}>{thread.state}</Pill>
          <span className="muted">opened by {thread.createdBy} · {ago(thread.createdAt)} ago</span>
        </div>
        <div className="chips" style={{ marginTop: 6 }}>
          {thread.charterIds.map(c => <span key={c} className="chip">{c}</span>)}
          {thread.participants.map(p => <a key={p} className="chip faint" href={hrefFor('employee', p)}>@{p}</a>)}
        </div>
        {thread.summary && <p className="task"><b>Resolved:</b> {thread.summary}</p>}
        {escalations.length > 0 && (
          <div className="chips" style={{ marginTop: 6 }}>
            {escalations.map(i => <a key={i.id} className={`chip${i.state === 'open' ? ' link' : ''}`} href={hrefFor('inbox')}>{i.state === 'open' ? 'needs you' : 'answered'}: {i.title}</a>)}
          </div>
        )}
      </div>

      <div className="messages">
        {messages.map(m => (
          <article key={m.id} className={`msg${m.owner ? ' owner' : ''}${m.by === 'workplace' ? ' system' : ''}`}>
            <div className="mh">
              {m.owner ? <b>You</b> : m.by === 'workplace' ? <b>Workplace</b> : <a href={hrefFor('employee', m.by)}>{m.by}</a>}
              <span className="muted">{ago(m.at)} ago</span>
              {m.mentions.map(x => <span key={x} className="chip faint">@{x}</span>)}
            </div>
            <div className="mb"><Markdown text={m.text} /></div>
          </article>
        ))}
        {messages.length === 0 && <p className="muted">No messages yet.</p>}
      </div>

      {thread.state === 'open' ? (
        <>
          <form className="composer" onSubmit={e => { e.preventDefault(); void send(); }}>
            <GrowTextarea value={text} onChange={setText} placeholder="Comment as the owner… (@name to mention)" rows={1} minHeight={38} maxHeight={220} disabled={busy}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
            <button className="btn sm primary" type="submit" disabled={busy || !text.trim()}>Post</button>
          </form>
          <div className="row" style={{ marginTop: 10 }}>
            {resolving ? (
              <>
                <input className="wide" value={summary} onChange={e => setSummary(e.target.value)} placeholder="Summary: what was decided" autoFocus />
                <button className="btn sm primary" disabled={busy || !summary.trim()} onClick={() => void resolve()}>Resolve</button>
                <button className="btn sm ghost" onClick={() => setResolving(false)}>Cancel</button>
              </>
            ) : (
              <button className="btn sm ghost" onClick={() => setResolving(true)}>Resolve this thread…</button>
            )}
          </div>
        </>
      ) : (
        <p className="muted">Resolved. Asha's summary is above; follow-ups became assignments.</p>
      )}
    </div>
  );
}

function NewThread({ onDone }: { onDone: () => void }) {
  const org = useStore(s => s.org);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [charters, setCharters] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const toggle = (id: string): void => setCharters(c => (c.includes(id) ? c.filter(x => x !== id) : [...c, id]));

  const submit = async (): Promise<void> => {
    if (!title.trim() || !text.trim() || busy) return;
    setBusy(true);
    const id = await openThread(title.trim(), text.trim(), charters);
    setBusy(false);
    if (id) { onDone(); navigate('room', id); }
  };

  return (
    <form className="newthread" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <div className="f"><label>Topic</label><input value={title} onChange={e => setTitle(e.target.value)} placeholder="One line" autoFocus /></div>
      <div className="f"><label>First message</label>
        <GrowTextarea value={text} onChange={setText} placeholder="What needs deciding, and who should weigh in (@name)" rows={2} minHeight={60} maxHeight={260} />
      </div>
      {org && org.charters.length > 0 && (
        <div className="f"><label>Charters it touches</label>
          <div className="chips">
            {org.charters.map(c => (
              <button type="button" key={c.id} className={`chip toggle${charters.includes(c.id) ? ' on' : ''}`} onClick={() => toggle(c.id)}>{c.id}</button>
            ))}
          </div>
        </div>
      )}
      <div className="row">
        <button className="btn sm primary" type="submit" disabled={busy || !title.trim() || !text.trim()}>{busy ? 'Opening…' : 'Open thread'}</button>
        <button className="btn sm ghost" type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
