import { useState } from 'react';
import type { ItemDetail, ItemStatus } from '@jkj/shared';
import { ITEM_STATUSES, TRUE_STATUS_LABEL } from '@jkj/shared';
import { v2Api } from '../../api/client.js';
import { useApi } from '../../lib/useApi.js';
import { hrefFor, message, showToast } from '../../state/store.js';
import { Markdown } from '../../components/Markdown.js';
import { Progress, day, useNames } from '../sprint/common.js';

/**
 * One item (parity with the app's ItemDetailView, HLD §6): where it sits, its status and blocker, its
 * PR, acceptance, children, comments and activity, with a comment box and a status move (reason required).
 */
export function ItemView({ id }: { id: string }) {
  const { data, error, reload } = useApi<ItemDetail>(() => v2Api.item(id), `item:${id}`);
  const names = useNames();
  if (!data) return <div className="pane">{error ? <div className="note"><b>Couldn't load.</b> {error}</div> : <div className="muted pad">Loading…</div>}</div>;
  const it = data.item;
  const st = it.trueStatus ?? it.status;
  return (
    <div className="pane item">
      <p className="muted crumbs">
        {data.epic && data.epic.id !== it.id ? <><a href={hrefFor('item', data.epic.id)}>{data.epic.title}</a> › </> : null}
        {data.parent && data.parent.id !== data.epic?.id ? <><a href={hrefFor('item', data.parent.id)}>{data.parent.title}</a> › </> : null}
        {it.level}{it.type ? ` (${it.type})` : ''} · {it.id}
      </p>
      <div className="sec-h"><h2>{it.title}</h2><span className="chip c-track">{TRUE_STATUS_LABEL[st as keyof typeof TRUE_STATUS_LABEL] ?? st}</span></div>
      <p className="muted">
        {it.assigneeId ? `With ${names(it.assigneeId)}` : 'Unassigned'}
        {it.reviewerId ? ` · reviewer ${names(it.reviewerId)}` : ''}
        {it.targetDate ? ` · due ${day(it.targetDate)}` : ''}
        {it.points ? ` · ${it.points} pt` : ''}
      </p>
      {it.blocker && <div className="note">Waiting on <b>{it.blocker.label}</b>{it.blocker.reason ? `: ${it.blocker.reason}` : ''} ({it.blocker.status})</div>}
      {it.waiting && <div className="note">Waiting on <b>{names(it.waiting.on)}</b>: {it.waiting.reason}</div>}
      {it.parked && <div className="note">Parked: {it.parked.reason}. Resumes when {it.parked.resumeWhen}.</div>}
      {it.pr && <p>PR <a href={it.pr.url} target="_blank" rel="noreferrer">#{it.pr.number}</a> · {it.pr.stage}{it.pr.tests ? ` · tests ${it.pr.tests}` : ''} · evidence {it.pr.evidence}</p>}
      {data.progress && <Progress pct={data.progress.pct} done={data.progress.storiesDone} total={data.progress.storiesTotal} />}
      {it.body && <div className="doc"><Markdown text={it.body} /></div>}
      {it.acceptance.length > 0 && <><h3 className="group">Acceptance</h3><ul>{it.acceptance.map((a, i) => <li key={i}>{a}</li>)}</ul></>}
      {data.children.length > 0 && (
        <section>
          <h3 className="group">{it.level === 'epic' ? 'Stories' : 'Tasks'} ({data.children.length})</h3>
          <div className="stack tight">{data.children.map(c => (
            <a key={c.id} className={`storyrow${c.status === 'done' ? ' done' : ''}${c.blocker ? ' blocked' : ''}`} href={hrefFor('item', c.id)}>
              <span className="st">{TRUE_STATUS_LABEL[(c.trueStatus ?? c.status) as keyof typeof TRUE_STATUS_LABEL] ?? c.status}</span>
              <span className="tt">{c.title}</span><span className="muted">{names(c.assigneeId)}</span>
            </a>
          ))}</div>
        </section>
      )}
      <Move id={id} current={it.status} onDone={reload} />
      <section>
        <h3 className="group">Comments ({data.comments.length})</h3>
        <div className="stack tight">{data.comments.map(c => (
          <div key={c.id} className="comment"><b>{names(c.by)}</b> <span className="muted">{new Date(c.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span><Markdown text={c.text} /></div>
        ))}</div>
        <CommentBox id={id} onDone={reload} />
      </section>
      <details>
        <summary className="group">Activity ({data.activity.length})</summary>
        <ul className="refs">{data.activity.slice(-80).reverse().map(a => <li key={a.id}><span className="muted">{new Date(a.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {names(a.by)}</span> {a.text}</li>)}</ul>
      </details>
    </div>
  );
}

function CommentBox({ id, onDone }: { id: string; onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form className="row" onSubmit={e => {
      e.preventDefault();
      if (!text.trim()) return;
      setBusy(true);
      v2Api.comment(id, text.trim()).then(() => { setText(''); onDone(); }, err => showToast(message(err))).finally(() => setBusy(false));
    }}>
      <input value={text} onChange={e => setText(e.target.value)} placeholder="Comment (use @name to tag someone)" aria-label="Comment" />
      <button className="btn" type="submit" disabled={busy || !text.trim()}>Post</button>
    </form>
  );
}

function Move({ id, current, onDone }: { id: string; current: ItemStatus; onDone: () => void }) {
  const [to, setTo] = useState<ItemStatus>(current);
  const [reason, setReason] = useState('');
  if (to === current && !reason) {
    return (
      <div className="row">
        <label className="muted" htmlFor={`mv-${id}`}>Move to</label>
        <select id={`mv-${id}`} value={to} onChange={e => setTo(e.target.value as ItemStatus)}>{ITEM_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}</select>
      </div>
    );
  }
  return (
    <form className="row" onSubmit={e => {
      e.preventDefault();
      v2Api.updateItem(id, { status: to, reason: reason.trim() }).then(() => { setReason(''); onDone(); }, err => showToast(message(err)));
    }}>
      <select value={to} onChange={e => setTo(e.target.value as ItemStatus)} aria-label="Status">{ITEM_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}</select>
      <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Why (required)" aria-label="Reason" />
      <button className="btn primary" type="submit" disabled={!reason.trim() || to === current}>Move</button>
      <button className="btn ghost" type="button" onClick={() => { setTo(current); setReason(''); }}>Cancel</button>
    </form>
  );
}
