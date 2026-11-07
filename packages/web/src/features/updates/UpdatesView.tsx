import { useState } from 'react';
import type { Update } from '@jkj/shared';
import { v2Api } from '../../api/client.js';
import { useApi } from '../../lib/useApi.js';
import { hrefFor, message, showToast } from '../../state/store.js';

/** The app's Updates feed on the web (parity, HLD §6): what changed, newest first, with "older" paging. */
export function UpdatesView() {
  const { data, error } = useApi<Update[]>(() => v2Api.updates(), 'updates');
  const [older, setOlder] = useState<Update[]>([]);
  const [more, setMore] = useState(true);
  if (!data) return <div className="pane">{error ? <div className="note"><b>Couldn't load.</b> {error}</div> : <div className="muted pad">Loading…</div>}</div>;
  const all = [...data, ...older];
  const loadOlder = (): void => {
    const last = all[all.length - 1];
    if (!last) return;
    v2Api.updates(last.id).then(page => { setOlder([...older, ...page]); if (page.length === 0) setMore(false); }, err => showToast(message(err)));
  };
  return (
    <div className="pane">
      <div className="sec-h"><h2>Updates</h2><p>Everything that changed on the board, newest first.</p></div>
      <ul className="feed">
        {all.map(u => (
          <li key={u.id}>
            <span className="muted">{new Date(u.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>{' '}
            {u.itemId ? <a href={hrefFor('item', u.itemId)}>{u.line}</a> : u.inboxId ? <a href={hrefFor('inbox')}>{u.line}</a> : u.line}
            {u.details && <div className="muted">{u.details}</div>}
          </li>
        ))}
      </ul>
      {more && all.length > 0 && <button className="btn" onClick={loadOlder}>Older</button>}
    </div>
  );
}
