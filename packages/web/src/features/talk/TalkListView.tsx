import type { TalkThread } from '@jkj/shared';
import { v2Api } from '../../api/client.js';
import { useApi } from '../../lib/useApi.js';
import { hrefFor } from '../../state/store.js';

/** The app's Talk tab on the web (parity, HLD §6): every 1:1 chat, pinned first, newest message first. */
export function TalkListView() {
  const { data, error } = useApi<TalkThread[]>(() => v2Api.talkThreads(), 'talk');
  if (!data) return <div className="pane">{error ? <div className="note"><b>Couldn't load.</b> {error}</div> : <div className="muted pad">Loading…</div>}</div>;
  const sorted = [...data].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
  return (
    <div className="pane">
      <div className="sec-h"><h2>Talk</h2><p>Your one-to-one chats. Open one to read it and reply.</p></div>
      <div className="stack tight">
        {sorted.map(t => (
          <a key={t.id} className="talkrow" href={hrefFor('employee', t.employeeId)}>
            <div className="t"><b>{t.name}</b>{t.role && <span className="muted"> · {t.role}</span>}{t.pinned && <span className="chip f-parked">pinned</span>}{t.unreadCount > 0 && <span className="badge">{t.unreadCount}</span>}{t.typing && <span className="muted"> typing…</span>}</div>
            {t.lastMessage && <div className="muted one">{t.lastMessage.fromName}: {t.lastMessage.text}</div>}
            {t.lastMessageAt && <div className="muted">{new Date(t.lastMessageAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>}
          </a>
        ))}
        {sorted.length === 0 && <p className="muted">No chats yet.</p>}
      </div>
    </div>
  );
}
