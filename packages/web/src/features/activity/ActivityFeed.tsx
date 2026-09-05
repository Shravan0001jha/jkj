import { useStore } from '../../state/store.js';
import { hhmm } from '../../lib/format.js';
import { Markdownish } from '../../components/Markdownish.js';

const TONE: Record<string, string> = {
  started: 'run', finished: 'done', failed: 'err', waiting: 'wait', info: 'info',
};

/** Every session across every project, most recently active first. */
export function ActivityFeed() {
  const activity = useStore(s => s.activity);
  const projects = useStore(s => s.projects);
  const nameOf = (id: string) => projects.find(p => p.id === id)?.name ?? id;

  return (
    <>
      <div className="sec-h">
        <h2>Activity</h2>
        <p>Every session on this machine, most recently active first.</p>
      </div>

      <div className="feed">
        {activity.length === 0 && <p className="lede">Nothing recorded yet.</p>}
        {activity.map(event => (
          <div className={`fitem ${TONE[event.kind]}`} key={event.id}>
            <div className="ft">{hhmm(event.at)} · {nameOf(event.projectId)}</div>
            <div className="fb"><Markdownish text={event.message} /></div>
          </div>
        ))}
      </div>
    </>
  );
}
