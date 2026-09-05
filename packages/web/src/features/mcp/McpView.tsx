import { useStore, currentProject, toggleMcp } from '../../state/store.js';
import { healthPill } from '../../lib/format.js';

/**
 * MCP servers as Claude Code has them configured. JKJ reads the same files
 * the CLI does; it does not connect to the servers, so it reports what it can
 * see and says so rather than showing a health it did not measure.
 */
export function McpView() {
  const project = useStore(currentProject);
  const installed = useStore(s => s.mcpInstalled);

  return (
    <>
      <div className="sec-h">
        <h2>MCP servers</h2>
        <p>Read from your Claude Code configuration. Edit them with the CLI.</p>
      </div>

      {installed.length === 0 ? (
        <p className="lede">
          No MCP servers configured. Add one with <code>claude mcp add</code>, or drop a{' '}
          <code>.mcp.json</code> in a project.
        </p>
      ) : (
        <div className="mcp">
          {installed.map(server => {
            const health = healthPill[server.health];
            const enabledHere = project?.enabledMcpServers.includes(server.id) ?? false;

            return (
              <div className="mrow" key={server.id}>
                <div className="mi">
                  <div className="mn">{server.name}</div>
                  <div className="md">{server.source} · {server.transport}{server.note ? ` · ${server.note}` : ''}</div>
                </div>
                <span className={`pill ${health.cls}`}><i />{health.label}</span>
                <span className={`pill ${enabledHere ? 'done' : 'idle'}`}>
                  <i />{enabledHere ? `on in ${project?.name}` : 'not in this project'}
                </span>
                <button className="btn sm ghost" onClick={toggleMcp}>Change</button>
              </div>
            );
          })}
        </div>
      )}

      <p className="muted narrow" style={{ marginTop: 16 }}>
        Health stays unprobed because JKJ never starts these servers — the CLI owns them. Once
        JKJ runs sessions itself, it will connect and report the real state, along with the tools
        each one registers.
      </p>
    </>
  );
}
