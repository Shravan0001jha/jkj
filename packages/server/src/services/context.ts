import type { AssembledContext, ContextDoc } from '@jkj/shared';

/**
 * Context — two layers and no more.
 *
 *   central   how you like things, applied to every agent in every project
 *   project   what is true about one repo
 *
 * A third layer is the thing that turns a context manager into a filing
 * system nobody maintains. If we ever add one, it needs a real argument.
 */

const DEFAULT_CENTRAL = `Answer with the change, not a description of the change.

Keep explanations to two or three sentences unless asked for depth.
Never add a comment that restates the line below it.
`;

let central: ContextDoc = {
  scope: 'central',
  projectId: null,
  body: DEFAULT_CENTRAL,
  updatedAt: new Date().toISOString(),
};

const projectDocs = new Map<string, ContextDoc>();

export function getCentralContext(): ContextDoc {
  // TODO: read from ~/.jkj/CENTRAL.md so it is editable outside the UI too.
  return central;
}

export function setCentralContext(body: string): ContextDoc {
  central = { ...central, body, updatedAt: new Date().toISOString() };
  return central;
}

export function getProjectContext(projectId: string): ContextDoc {
  // TODO: read from <repo>/.jkj/context.md, falling back to CLAUDE.md.
  return projectDocs.get(projectId) ?? {
    scope: 'project',
    projectId,
    body: '',
    updatedAt: new Date().toISOString(),
  };
}

export function setProjectContext(projectId: string, body: string): ContextDoc {
  const doc: ContextDoc = { scope: 'project', projectId, body, updatedAt: new Date().toISOString() };
  projectDocs.set(projectId, doc);
  return doc;
}

/**
 * Build the exact prompt a new agent in this project would receive, and
 * report what each part costs. The UI renders this verbatim — if the preview
 * and the real prompt ever diverge, this function is the bug.
 */
export function assembleContext(projectId: string): AssembledContext {
  const c = getCentralContext().body;
  const p = getProjectContext(projectId).body;

  const text = [
    '# How I like things',
    c.trim(),
    '',
    `# Project: ${projectId}`,
    p.trim(),
  ].join('\n');

  const segments = [
    { label: 'Central context', tokens: estimateTokens(c) },
    { label: 'Project context', tokens: estimateTokens(p) },
    // TODO: add 'MCP tool schemas' once the runtime reports the real count.
  ];

  return {
    text,
    segments,
    totalTokens: segments.reduce((n, s) => n + s.tokens, 0),
  };
}

/** Rough enough for a budget bar. Replace with the real tokenizer later. */
export function estimateTokens(text: string): number {
  return Math.round(text.length / 3.6);
}
