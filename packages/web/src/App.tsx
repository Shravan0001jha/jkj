import { useEffect } from 'react';
import { AppShell } from './components/AppShell.js';
import { OfficeView } from './features/office/OfficeView.js';
import { OrgView } from './features/org/OrgView.js';
import { InboxView } from './features/inbox/InboxView.js';
import { RoomView } from './features/room/RoomView.js';
import { FeaturesView } from './features/features/FeaturesView.js';
import { EmployeeView } from './features/employee/EmployeeView.js';
import { AssignView } from './features/assign/AssignView.js';
import { ReleasesView } from './features/releases/ReleasesView.js';
import { SpendView } from './features/spend/SpendView.js';
import { applyServerEvent, loadWorkspace, setConnection, useStore, watchHash } from './state/store.js';
import { connect } from './api/socket.js';

/**
 * Composition root. The hash is the router; the socket keeps every screen
 * current once it has loaded.
 */
export function App() {
  const route = useStore(s => s.route);
  const error = useStore(s => s.error);
  const loading = useStore(s => s.loading);

  useEffect(() => {
    void loadWorkspace();
    const stopHash = watchHash();
    const stopSocket = connect(applyServerEvent, setConnection);
    return () => { stopHash(); stopSocket(); };
  }, []);

  return (
    <AppShell>
      {error && !loading ? (
        <div className="pane"><div className="note"><b>The Workplace server is not reachable.</b> {error}</div></div>
      ) : (
        <>
          {route.name === 'office' && <OfficeView />}
          {route.name === 'org' && <OrgView />}
          {route.name === 'inbox' && <InboxView />}
          {route.name === 'room' && <RoomView id={route.id} />}
          {route.name === 'features' && <FeaturesView />}
          {route.name === 'employee' && route.id && <EmployeeView id={route.id} />}
          {route.name === 'assign' && <AssignView />}
          {route.name === 'releases' && <ReleasesView />}
          {route.name === 'spend' && <SpendView />}
        </>
      )}
    </AppShell>
  );
}
