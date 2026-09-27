import { useStore } from '../../state/store.js';
import { InboxCard } from './InboxCard.js';

/** Every decision or approval that needs the owner. Open first, answered below. */
export function InboxView() {
  const inbox = useStore(s => s.inbox);
  const open = inbox.filter(i => i.state === 'open');
  const answered = inbox.filter(i => i.state !== 'open');

  return (
    <div className="pane">
      <div className="sec-h">
        <h2>Inbox</h2>
        <p>{open.length === 0 ? 'Nothing needs you right now.' : `${open.length} waiting for you.`}</p>
      </div>

      <div className="stack">
        {open.map(item => <InboxCard key={item.id} item={item} />)}
      </div>

      {answered.length > 0 && (
        <>
          <h3 className="group">Answered</h3>
          <div className="stack">
            {answered.map(item => <InboxCard key={item.id} item={item} compact />)}
          </div>
        </>
      )}
    </div>
  );
}
