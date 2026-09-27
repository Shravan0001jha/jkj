import type { ReactNode } from 'react';
import { needsYouCount, toggleTheme, useStore } from '../state/store.js';
import { inr } from '../lib/format.js';
import { Nav } from './Nav.js';
import { Toast } from './Toast.js';

/** The frame every screen sits in: title bar, navigation, content. */
export function AppShell({ children }: { children: ReactNode }) {
  const connection = useStore(s => s.connection);
  const needsYou = useStore(needsYouCount);
  const spend = useStore(s => s.spend ?? s.office?.spend ?? null);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Mark />
          <b>Iris Workplace</b>
        </div>

        <div className="runcount">
          <span className={`beacon ${connection}`} />
          {connection === 'open'
            ? <span>{needsYou} need{needsYou === 1 ? 's' : ''} you{spend ? ` · ${inr(spend.companyInr)} of ${inr(spend.capInr)} today` : ''}</span>
            : <span>{connection === 'connecting' ? 'connecting…' : 'server offline'}</span>}
        </div>

        <div className="spacer" />
        <button className="btn ghost sm" onClick={toggleTheme}>Theme</button>
      </header>

      <div className="main">
        <Nav needsYou={needsYou} />
        <section className="content">
          <div id="view">{children}</div>
        </section>
      </div>

      <Toast />
    </div>
  );
}

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.6" opacity=".4" />
      <circle cx="10" cy="10" r="3.2" fill="var(--accent)" />
    </svg>
  );
}
