import type { ReactNode } from 'react';

/**
 * The frame every screen sits in: title bar, left rail, content area.
 *
 * The rail and the tab bar are stubs. They become <ProjectRail /> and
 * <Tabs /> in the next step; nothing else about this file changes.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <Mark />
          JKJ
        </span>
        <span className="spacer" />
        {/* TODO: run counter, theme toggle, "New agent" button */}
      </header>

      <div className="main">
        <nav className="rail" aria-label="Workspace">
          <h3>Central</h3>
          <p className="placeholder">Context lives here.</p>
          <h3>Projects</h3>
          <p className="placeholder">None added yet.</p>
        </nav>

        <main className="content">{children}</main>
      </div>
    </div>
  );
}

function Mark() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M2 17 L9 10 L9 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity=".4" />
      <path d="M2 17 L11 10 L18 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity=".4" />
      <path d="M2 17 L10 17 L18 4" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="18" cy="4" r="2" fill="var(--accent)" />
    </svg>
  );
}
