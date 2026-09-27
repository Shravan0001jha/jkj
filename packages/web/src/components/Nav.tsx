import { useState } from 'react';
import { hrefFor, useStore, type RouteName } from '../state/store.js';

const PRIMARY: { name: RouteName; label: string; glyph: string }[] = [
  { name: 'office', label: 'Office', glyph: '◉' },
  { name: 'inbox', label: 'Inbox', glyph: '✉' },
  { name: 'room', label: 'Room', glyph: '◫' },
  { name: 'features', label: 'Features', glyph: '▦' },
  { name: 'org', label: 'Org', glyph: '⌥' },
];

const MORE: { name: RouteName; label: string; glyph: string }[] = [
  { name: 'assign', label: 'Assign', glyph: '＋' },
  { name: 'releases', label: 'Releases', glyph: '⇪' },
  { name: 'spend', label: 'Spend & health', glyph: '₹' },
];

/**
 * One list of destinations, two shapes: a rail beside the content on a wide
 * screen, a bar under it on a phone. The phone bar folds the three rarer
 * screens behind "More" so the five the owner opens daily stay one tap away.
 */
export function Nav({ needsYou }: { needsYou: number }) {
  const route = useStore(s => s.route);
  const [more, setMore] = useState(false);
  const current = (name: RouteName): boolean => route.name === name || (name === 'office' && route.name === 'employee');
  const inMore = MORE.some(m => m.name === route.name);

  return (
    <>
      <nav className="rail" aria-label="Screens">
        <h3>Workplace</h3>
        {[...PRIMARY, ...MORE].map(item => (
          <a key={item.name} className="navitem" href={hrefFor(item.name)} aria-current={current(item.name)}>
            <span className="glyph" aria-hidden="true">{item.glyph}</span>
            <span>{item.label}</span>
            {item.name === 'inbox' && needsYou > 0 && <span className="badge">{needsYou}</span>}
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
