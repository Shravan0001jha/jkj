import { useStore, currentProject, projectContext } from '../../state/store.js';
import { estimateTokens } from '../../lib/format.js';

/**
 * The two documents a new session in this project will be given, and what
 * they cost. Only what JKJ can actually measure is shown — the CLI's own
 * system prompt and tool schemas are not ours to count.
 */
export function AssembledPreview() {
  const project = useStore(currentProject);
  const central = useStore(s => s.central.body);
  const projectBody = useStore(s => projectContext(s, s.selectedProjectId).body);

  if (!project) return null;

  const segments = [
    { label: 'Central context', tokens: estimateTokens(central), color: 'var(--accent)' },
    { label: 'Project context', tokens: estimateTokens(projectBody), color: 'var(--run)' },
  ];
  const total = segments.reduce((n, s) => n + s.tokens, 0);

  const text = [
    `# ${project.name}`,
    `${project.path} (${project.branch})`,
    '',
    '## Central',
    central.trim() || '(empty)',
    '',
    '## Project',
    projectBody.trim() || '(empty)',
  ].join('\n');

  return (
    <aside className="preview">
      <div className="ph">
        <h3>What a session inherits</h3>
        <p>Both files are read by the CLI itself, with or without JKJ running.</p>
      </div>

      <div className="bar">
        {total > 0
          ? segments.map(s => (
              <span key={s.label} style={{ width: `${(s.tokens / total) * 100}%`, background: s.color }} />
            ))
          : <span style={{ width: '100%', background: 'var(--surface-3)' }} />}
      </div>

      <div className="leg">
        {segments.map(s => (
          <div key={s.label}>
            <i style={{ background: s.color }} />
            {s.label}
            <b>{s.tokens} tok</b>
          </div>
        ))}
        <div className="total"><i />Total<b>{total} tok</b></div>
      </div>

      <pre className="assembled">{text}</pre>
    </aside>
  );
}
