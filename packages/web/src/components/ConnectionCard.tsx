import type { HealthResponse } from '@jkj/shared';
import type { SocketState } from '../api/socket.js';

/**
 * The hello-world panel. It exists to answer one question on first run:
 * is the browser actually talking to the server, over both transports?
 *
 * Delete this component once the Agents view lands.
 */
export function ConnectionCard({
  health,
  healthError,
  socket,
}: {
  health: HealthResponse | null;
  healthError: string | null;
  socket: SocketState;
}) {
  const restState = healthError ? 'bad' : health ? 'ok' : 'pending';
  const wsState = socket.status === 'open' ? 'ok' : socket.status === 'closed' ? 'bad' : 'pending';

  return (
    <>
      <p className="lede">
        <strong>JKJ is running.</strong> This screen is the boilerplate — it checks that the web UI
        can reach the server over REST and over the socket. Everything else gets built on top of it.
      </p>

      <div className="card">
        <header>
          <h2>Connection</h2>
        </header>
        <div className="rows">
          <div className="row">
            <dt>REST /api/health</dt>
            <dd>
              <span className={`pill ${restState}`}>
                <i />
                {healthError ? 'unreachable' : health ? 'ok' : 'checking'}
              </span>
              {healthError && <span> {healthError}</span>}
            </dd>
          </div>
          <div className="row">
            <dt>WebSocket /ws</dt>
            <dd>
              <span className={`pill ${wsState}`}>
                <i />
                {socket.status}
              </span>
            </dd>
          </div>
          <div className="row">
            <dt>Version</dt>
            <dd>{health?.version ?? '—'}</dd>
          </div>
          <div className="row">
            <dt>Uptime</dt>
            <dd>{health ? `${health.uptimeSeconds}s` : '—'}</dd>
          </div>
          <div className="row">
            <dt>Last event</dt>
            <dd>{socket.lastEvent ? socket.lastEvent.type : 'none yet'}</dd>
          </div>
        </div>
      </div>
    </>
  );
}
