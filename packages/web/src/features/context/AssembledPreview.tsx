import { useStore, currentProject } from '../../state/store.js';

const COLORS = ['var(--accent)', 'var(--run)', 'var(--done)', 'var(--wait)'];

/**
 * What the layers add up to.
 *
 * Only what JKJ can measure is shown. The CLI's own system prompt and tool
 * schemas are not ours to count, and inventing a number for them would make
 * the total look authoritative when it is not.
 */
export function AssembledPreview() {
  const project = useStore(currentProject);
  const context = useStore(s => s.context);

  if (!project || !context) return null;

  const present = context.layers.filter(layer => layer.tokens > 0);
  const total = context.totalTokens;

  const text = context.layers
    .filter(layer => layer.body.trim())
    .map(layer => `# ${layer.label}\n${layer.body.trim()}`)
    .join('\n\n') || 'Nothing yet — a session in this project starts with no context of its own.';

  return (
    <aside className="preview">
      <div className="ph">
        <h3>What a session inherits</h3>
        <p>These files are read by the CLI itself, with or without JKJ running.</p>
      </div>

      <div className="bar">
        {total > 0
          ? present.map((layer, i) => (
              <span
                key={layer.id}
                style={{ width: `${(layer.tokens / total) * 100}%`, background: COLORS[i % COLORS.length] }}
              />
            ))
          : <span style={{ width: '100%', background: 'var(--surface-3)' }} />}
      </div>

      <div className="leg">
        {context.layers.map((layer, i) => (
          <div key={layer.id} style={{ opacity: layer.tokens > 0 ? 1 : 0.45 }}>
            <i style={{ background: layer.tokens > 0 ? COLORS[i % COLORS.length] : 'var(--surface-3)' }} />
            {layer.label}
            <b>{layer.tokens} tok</b>
          </div>
        ))}
        <div className="total"><i />Total<b>{total} tok</b></div>
      </div>

      <pre className="assembled">{text}</pre>
    </aside>
  );
}
