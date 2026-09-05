import { useStore, currentProject, projectContext } from '../../state/store.js';
import { estimateTokens } from '../../lib/format.js';

/**
 * The exact prompt a new agent would receive, and what each part costs.
 *
 * If this preview and the real prompt ever disagree, the preview is the bug —
 * so it is built from the same pieces rather than described separately.
 */
export function AssembledPreview() {
  const project = useStore(currentProject);
  const central = useStore(s => s.central.body);
  const projectBody = useStore(s => projectContext(s, s.selectedProjectId).body);
  const mcpNames = useStore(s =>
    s.mcpInstalled.filter(m => project.enabledMcpServers.includes(m.id)).map(m => m.name));

  const segments = [
    { label: 'System + tools', tokens: 2100, color: 'var(--line-strong)' },
    { label: 'Central context', tokens: estimateTokens(central), color: 'var(--accent)' },
    { label: 'Project context', tokens: estimateTokens(projectBody), color: 'var(--run)' },
    { label: 'MCP tool schemas', tokens: mcpNames.length * 240, color: 'var(--wait)' },
  ];
  const total = segments.reduce((n, s) => n + s.tokens, 0);

  const text = [
    '# How I like things',
    central.trim(),
    '',
    `# Project: ${project.name}`,
    `Repo: ${project.path} (${project.branch})`,
    projectBody.trim(),
    '',
    '# Tools available',
    mcpNames.join(', ') || 'none',
  ].join('\n');

  return (
    <aside className="preview">
      <div className="ph">
        <h3>Assembled prompt</h3>
        <p>Exactly what a new agent in {project.name} receives.</p>
      </div>

      <div className="bar">
        {segments.map(s => (
          <span key={s.label} style={{ width: `${(s.tokens / total) * 100}%`, background: s.color }} />
        ))}
      </div>

      <div className="leg">
        {segments.map(s => (
          <div key={s.label}>
            <i style={{ background: s.color }} />
            {s.label}
            <b>{s.tokens} tok</b>
          </div>
        ))}
        <div className="total">
          <i />
          Total
          <b>{total} tok</b>
        </div>
      </div>

      <pre className="assembled">{text}</pre>
    </aside>
  );
}
