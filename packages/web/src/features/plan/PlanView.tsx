import { useState } from 'react';
import type { EpicCard, PlanResponse } from '@jkj/shared';
import { v2Api } from '../../api/client.js';
import { useApi } from '../../lib/useApi.js';
import { hrefFor } from '../../state/store.js';
import { Progress, useNames } from '../sprint/common.js';

/**
 * The app's Plan tab on the web (parity, HLD §6): areas → epics with progress, what is blocked or
 * stalled and on whom, the owner's own items, story counts, and the Mac verification queue.
 */
export function PlanView() {
  const { data, error } = useApi<PlanResponse>(() => v2Api.plan(), 'plan');
  const [showDone, setShowDone] = useState(false);
  const names = useNames();
  if (!data) return <div className="pane">{error ? <div className="note"><b>Couldn't load.</b> {error}</div> : <div className="muted pad">Loading…</div>}</div>;
  const card = (c: EpicCard) => (
    <div key={c.epic.id} className={`epicrow${c.finished ? ' dim' : ''}`}>
      <a className="em" href={hrefFor('item', c.epic.id)}>
        <div className="t"><b>{c.epic.title}</b>{c.inFocus && <span className="chip c-track">Focus</span>}{c.finished && <span className="chip c-done">Done</span>}</div>
        {c.next && <div className="m muted">Next: {c.next.title}</div>}
        {c.flags.map(f => <div key={f.itemId} className="blk"><b className="bl">{f.kind === 'blocked' ? 'Blocked' : 'Stalled'}</b> {f.title} — {f.reason}{f.waitingOn ? ` (waiting on ${names(f.waitingOn)})` : ''}</div>)}
        <Progress pct={c.progress.pct} done={c.progress.storiesDone} total={c.progress.storiesTotal} />
      </a>
    </div>
  );
  const section = (title: string, cards: EpicCard[]) => {
    const shown = showDone ? cards : cards.filter(c => !c.finished);
    const done = cards.length - cards.filter(c => !c.finished).length;
    if (!cards.length) return null;
    return (
      <section key={title}>
        <h3 className="group">{title} <span className="muted">{shown.length}{!showDone && done ? ` (+${done} done)` : ''}</span></h3>
        <div className="stack tight">{shown.map(card)}</div>
      </section>
    );
  };
  return (
    <div className="pane">
      <div className="sec-h">
        <h2>Plan</h2>
        <p>{Object.entries(data.counts).filter(([, n]) => n > 0).map(([s, n]) => `${n} ${s}`).join(' · ')}</p>
        <label className="muted"><input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} /> show finished</label>
      </div>
      {data.mine.length > 0 && (
        <section>
          <h3 className="group">Yours ({data.mine.length})</h3>
          <div className="stack tight">{data.mine.map(i => <a key={i.id} className="storyrow" href={hrefFor('item', i.id)}><span className="st">{i.trueStatus ?? i.status}</span><span className="tt">{i.title}</span></a>)}</div>
        </section>
      )}
      {data.areas.map(a => section(a.area.title, a.epics))}
      {section('No area', data.unfiled)}
      {data.awaitingMac && data.awaitingMac.length > 0 && (
        <section>
          <h3 className="group">Done on staging, awaiting the Mac check ({data.awaitingMac.length})</h3>
          <div className="stack tight">{data.awaitingMac.map(m => <a key={m.id} className="storyrow" href={hrefFor('item', m.id)}><span className="tt">{m.title}</span><span className="muted">{m.note}</span></a>)}</div>
        </section>
      )}
    </div>
  );
}
