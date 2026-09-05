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

  // Only files with something in them earn a row; the rest would be a legend
  // of zeroes on a project that has barely any context at all.
  const present = context.layers.filter(layer => layer.counted && layer.tokens > 0);
  const total = context.totalTokens;

  const text = context.layers
    .filter(layer => layer.counted && layer.body.trim())
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
        {present.map((layer, i) => (
          <div key={layer.id}>
            <i style={{ background: COLORS[i % COLORS.length] }} />
            <span className="legname">{layer.label}</span>
            <b>{layer.tokens} tok</b>
          </div>
        ))}
        {present.length === 0 && <div><i style={{ background: 'var(--surface-3)' }} />Nothing yet</div>}
        <div className="total"><i />Total<b>{total} tok</b></div>
      </div>

      <pre className="assembled">{text}</pre>
    </aside>
  );
}
