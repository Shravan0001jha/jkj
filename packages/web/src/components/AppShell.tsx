import type { ReactNode } from 'react';
import { useStore, toggleTheme, setNewAgentOpen } from '../state/store.js';
import { ProjectRail } from './ProjectRail.js';
import { Tabs } from './Tabs.js';
import { Toast } from './Toast.js';

/** The frame every screen sits in: title bar, left rail, tabs, content. */
export function AppShell({ children }: { children: ReactNode }) {
  const agents = useStore(s => s.agents.filter(a => !a.parentAgentId));
  const connection = useStore(s => s.connection);

  const running = agents.filter(a => a.status === 'running').length;
  const waiting = agents.filter(a => a.status === 'waiting').length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Mark />
          <b>JKJ</b>
        </div>

        <div className="runcount">
          <span className={`beacon ${connection}`} />
          {connection === 'open'
            ? <span>{running} working · {waiting} waiting on you · {agents.length} sessions</span>
            : <span>{connection === 'connecting' ? 'connecting…' : 'server offline'}</span>}
        </div>

        <div className="spacer" />
        <button className="btn ghost" onClick={toggleTheme}>Theme</button>
        <button className="btn primary" onClick={() => setNewAgentOpen(true)}>＋ New session</button>
      </header>

      <div className="main">
        <ProjectRail />
        <section className="content">
          <Tabs />
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
      <path d="M2 17 L9 10 L9 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity=".4" />
      <path d="M2 17 L11 10 L18 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity=".4" />
      <path d="M2 17 L10 17 L18 4" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="18" cy="4" r="2" fill="var(--accent)" />
    </svg>
  );
}
