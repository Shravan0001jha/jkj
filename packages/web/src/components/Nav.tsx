import { useState } from 'react';
import { hrefFor, useStore, type RouteName } from '../state/store.js';

const PRIMARY: { name: RouteName; label: string; glyph: string }[] = [
  { name: 'today', label: 'Today', glyph: '◎' },
  { name: 'sprint', label: 'Sprint', glyph: '▤' },
  { name: 'inbox', label: 'Inbox', glyph: '✉' },
  { name: 'talk', label: 'Talk', glyph: '◐' },
  { name: 'room', label: 'Room', glyph: '◫' },
];

const MORE: { name: RouteName; label: string; glyph: string }[] = [
  { name: 'backlog', label: 'Backlog', glyph: '☰' },
  { name: 'review', label: 'Review', glyph: '↺' },
  { name: 'teams', label: 'Teams', glyph: '▦' },
  { name: 'plan', label: 'Plan', glyph: '▣' },
  { name: 'dashboard', label: 'Dashboard', glyph: '◔' },
  { name: 'updates', label: 'Updates', glyph: '≡' },
  { name: 'alerts', label: 'Alerts', glyph: '△' },
  { name: 'office', label: 'Office', glyph: '◉' },
  { name: 'features', label: 'Features', glyph: '▧' },
  { name: 'org', label: 'Org', glyph: '⌥' },
  { name: 'assign', label: 'Assign', glyph: '+' },
  { name: 'releases', label: 'Releases', glyph: '⇪' },
  { name: 'spend', label: 'Spend & health', glyph: '₹' },
  { name: 'settings', label: 'Settings', glyph: '⚙' },
];

/** Screens that live under another nav entry (a drill-down highlights its parent). */
const PARENT: Partial<Record<RouteName, RouteName>> = { employee: 'talk', epic: 'sprint', feature: 'backlog', item: 'plan' };

/**
 * One list of destinations, two shapes: a rail beside the content on a wide
 * screen, a bar under it on a phone. The phone bar folds the three rarer
 * screens behind "More" so the five the owner opens daily stay one tap away.
 */
export function Nav({ needsYou }: { needsYou: number }) {
  const route = useStore(s => s.route);
  const [more, setMore] = useState(false);
  const unread = useStore(s => s.alerts.filter(a => !a.read).length);
  const current = (name: RouteName): boolean => route.name === name || PARENT[route.name] === name;
  const inMore = MORE.some(m => m.name === route.name || PARENT[route.name] === m.name);

  return (
    <>
      <nav className="rail" aria-label="Screens">
        <h3>Workplace</h3>
        {[...PRIMARY, ...MORE].map(item => (
          <a key={item.name} className="navitem" href={hrefFor(item.name)} aria-current={current(item.name)}>
            <span className="glyph" aria-hidden="true">{item.glyph}</span>
            <span>{item.label}</span>
            {item.name === 'inbox' && needsYou > 0 && <span className="badge">{needsYou}</span>}
            {item.name === 'alerts' && unread > 0 && <span className="badge">{unread}</span>}
          </a>
        ))}
      </nav>

      <nav className="tabbar" aria-label="Screens">
        {PRIMARY.map(item => (
          <a key={item.name} className="tabitem" href={hrefFor(item.name)} aria-current={current(item.name)} onClick={() => setMore(false)}>
            <span className="glyph" aria-hidden="true">{item.glyph}</span>
            <span>{item.label}</span>
            {item.name === 'inbox' && needsYou > 0 && <span className="badge">{needsYou}</span>}
          </a>
        ))}
        <button className="tabitem" aria-current={inMore} aria-expanded={more} onClick={() => setMore(v => !v)}>
          <span className="glyph" aria-hidden="true">⋯</span>
          <span>More</span>
        </button>
        {more && (
          <div className="moresheet" role="menu">
            {MORE.map(item => (
              <a key={item.name} role="menuitem" href={hrefFor(item.name)} onClick={() => setMore(false)}>
                <span className="glyph" aria-hidden="true">{item.glyph}</span>{item.label}
              </a>
            ))}
          </div>
        )}
      </nav>
    </>
  );
}
