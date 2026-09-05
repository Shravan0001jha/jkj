import { useEffect, useState } from 'react';
import type { HealthResponse } from '@jkj/shared';
import { getHealth } from './api/client.js';
import { useSocket } from './api/socket.js';
import { AppShell } from './components/AppShell.js';
import { ConnectionCard } from './components/ConnectionCard.js';

/**
 * Step 1: prove the pipe.
 *
 * The UI asks the server how it is doing over REST, then opens the socket and
 * reports what came back. Every feature we add from here plugs into AppShell.
 */
export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const socket = useSocket();

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch((err: unknown) => setHealthError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <AppShell>
      <ConnectionCard health={health} healthError={healthError} socket={socket} />
    </AppShell>
  );
}
