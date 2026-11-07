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
import { TodayView } from './features/sprint/TodayView.js';
import { SprintView } from './features/sprint/SprintView.js';
import { BacklogView } from './features/sprint/BacklogView.js';
import { ReviewView } from './features/sprint/ReviewView.js';
import { TeamsView } from './features/sprint/TeamsView.js';
import { EpicView, FeatureView } from './features/sprint/EpicView.js';
import { PlanView } from './features/plan/PlanView.js';
import { ItemView } from './features/item/ItemView.js';
import { TalkListView } from './features/talk/TalkListView.js';
import { DashboardView } from './features/dashboard/DashboardView.js';
import { UpdatesView } from './features/updates/UpdatesView.js';
import { AlertsView } from './features/alerts/AlertsView.js';
import { SettingsView } from './features/settings/SettingsView.js';
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
          {route.name === 'today' && <TodayView />}
          {route.name === 'sprint' && <SprintView />}
          {route.name === 'backlog' && <BacklogView />}
          {route.name === 'review' && <ReviewView />}
          {route.name === 'teams' && <TeamsView {...(route.id ? { id: route.id } : {})} />}
          {route.name === 'epic' && route.id && <EpicView id={route.id} />}
          {route.name === 'feature' && route.id && <FeatureView id={route.id} />}
          {route.name === 'plan' && <PlanView />}
          {route.name === 'item' && route.id && <ItemView id={route.id} />}
          {route.name === 'talk' && <TalkListView />}
          {route.name === 'dashboard' && <DashboardView />}
          {route.name === 'updates' && <UpdatesView />}
          {route.name === 'alerts' && <AlertsView />}
          {route.name === 'settings' && <SettingsView />}
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
