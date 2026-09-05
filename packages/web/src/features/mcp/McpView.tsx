import { useStore, currentProject, toggleMcp, restartMcp, installMcp } from '../../state/store.js';
import { healthPill } from '../../lib/format.js';

/**
 * MCP servers are installed once for the machine and switched on per
 * project — so health and the toggle sit on the same row, at different
 * scopes, and the row says which is which.
 */
export function McpView() {
  const project = useStore(currentProject);
  const installed = useStore(s => s.mcpInstalled);
  const catalog = useStore(s => s.mcpCatalog);
  const busyId = useStore(s => s.busyMcpId);

  return (
    <>
      <div className="sec-h">
        <h2>MCP servers</h2>
        <p>Installed once, switched on per project. The toggle affects {project.name} only.</p>
      </div>

      <div className="mcp">
        {installed.map(server => {
          const busy = busyId === server.id;
          const health = busy ? healthPill.starting : healthPill[server.health];
          const enabled = project.enabledMcpServers.includes(server.id);
          const severity = server.health === 'healthy' ? 'ok' : server.health === 'degraded' ? 'warn' : 'down';

          return (
            <div className={`mrow ${severity}`} key={server.id}>
              <div className="mi">
                <div className="mn">{server.name}</div>
                <div className="md">
                  {server.source} · {server.transport}{server.note ? ` · ${server.note}` : ''}
                </div>
              </div>
              <div className="tools">{server.toolCount} tools</div>
              <span className={`pill ${health.cls}`}><i />{busy ? 'restarting' : health.label}</span>
              <button className="btn sm ghost" disabled={busy} onClick={() => restartMcp(server.id)}>
                {busy ? '…' : '↻ Restart'}
              </button>
              <button
                className="sw"
                role="switch"
                aria-checked={enabled}
                aria-label={`Enable ${server.name} for ${project.name}`}
                onClick={() => toggleMcp(project.id, server.id)}
              />
            </div>
          );
        })}
      </div>

      <div className="sec-h" style={{ marginTop: 26 }}>
        <h2>Catalog</h2>
        <p>Curated servers, verified to start.</p>
      </div>

      <div className="cat">
        {catalog.map(entry => (
          <div className="catitem" key={entry.id}>
            <div className="cn">{entry.name}</div>
            <p>{entry.description} · {entry.toolCount} tools</p>
            <button
              className="btn sm"
              disabled={busyId === entry.id}
              onClick={() => installMcp(entry.id)}
            >
              {busyId === entry.id ? 'Installing…' : 'Install'}
            </button>
          </div>
        ))}
        {catalog.length === 0 && <p className="muted">Everything in the catalog is installed.</p>}
      </div>
    </>
  );
}
