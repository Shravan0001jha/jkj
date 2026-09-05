import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ContextLayer, ContextResponse, ContextScope, MemoryFile } from '@jkj/shared';
import { findClaudeHome, readTextFile } from '../runtime/claude-home.js';
import { getSnapshot } from './workspace.js';
import { BadRequest } from '../util/errors.js';

/**
 * Context, read from the files Claude Code actually loads.
 *
 * Four layers reach a session, from three different places, and only three of
 * them are yours to write. Showing fewer than that is how the preview stops
 * matching the prompt — the failure this whole tab exists to prevent.
 */

interface LayerSpec {
  id: ContextScope;
  label: string;
  summary: string;
  editable: boolean;
  path: (project: { id: string; path: string }) => string;
}

const LAYERS: LayerSpec[] = [
  {
    id: 'user',
    label: 'How I like things',
    summary: 'Yours, applied to every project on this machine.',
    editable: true,
    path: () => join(findClaudeHome().configDir, 'CLAUDE.md'),
  },
  {
    id: 'memory',
    label: 'What Claude remembers',
    summary: 'Written by Claude as it works. Read-only here so an edit cannot be overwritten mid-session.',
    editable: false,
    // Written beside the memory folder in some versions and inside it in
    // others, so take whichever is actually there.
    path: project => memoryIndexPath(project.id),
  },
  {
    id: 'project',
    label: 'This repo',
    summary: 'Committed with the code, so the whole team gets it.',
    editable: true,
    path: project => join(project.path, 'CLAUDE.md'),
  },
  {
    id: 'local',
    label: 'This repo, just for you',
    summary: 'Not committed. For anything true of your machine rather than the project.',
    editable: true,
    path: project => join(project.path, 'CLAUDE.local.md'),
  },
];

export async function readContext(projectId: string): Promise<ContextResponse> {
  const project = await requireProject(projectId);

  const layers: ContextLayer[] = LAYERS.map(spec => {
    const path = spec.path(project);
    const body = readTextFile(path) ?? '';
    return {
      id: spec.id,
      label: spec.label,
      summary: spec.summary,
      path,
      exists: existsSync(path),
      editable: spec.editable,
      body,
      tokens: estimateTokens(body),
    };
  });

  return {
    projectId,
    layers,
    memoryFiles: listMemoryFiles(project.id),
    totalTokens: layers.reduce((n, layer) => n + layer.tokens, 0),
  };
}

export async function saveContext(projectId: string, scope: ContextScope, body: string): Promise<ContextLayer> {
  const spec = LAYERS.find(l => l.id === scope);
  if (!spec) throw new BadRequest(`There is no ${scope} context.`);
  if (!spec.editable) throw new BadRequest(`${spec.label} is maintained by Claude, so JKJ will not overwrite it.`);

  const project = await requireProject(projectId);
  const path = spec.path(project);

  // A layer that did not exist yet is being created, so its folder might not
  // exist either — the user-level one lives in the config directory.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');

  return {
    id: spec.id,
    label: spec.label,
    summary: spec.summary,
    path,
    exists: true,
    editable: true,
    body,
    tokens: estimateTokens(body),
  };
}

/**
 * The individual notes behind MEMORY.md. They are listed rather than inlined:
 * there can be dozens, and the index already says what each one is for.
 */
function listMemoryFiles(projectKey: string): MemoryFile[] {
  const dir = join(findClaudeHome().projectsDir, projectKey, 'memory');

  try {
    return readdirSync(dir)
      .filter(name => name.endsWith('.md') && name !== 'MEMORY.md')
      .map(name => ({ name, bytes: statSync(join(dir, name)).size }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];   // no memory folder is the normal case for a new project
  }
}

function memoryIndexPath(projectKey: string): string {
  const base = join(findClaudeHome().projectsDir, projectKey);
  const inside = join(base, 'memory', 'MEMORY.md');
  return existsSync(inside) ? inside : join(base, 'MEMORY.md');
}

async function requireProject(projectId: string): Promise<{ id: string; path: string }> {
  const project = (await getSnapshot()).projects.find(p => p.id === projectId);
  if (!project) throw new BadRequest(`Unknown project ${projectId}`);
  return project;
}

/** Rough enough for a budget bar. Replace with a real tokenizer later. */
export function estimateTokens(text: string): number {
  return Math.round(text.length / 3.6);
}
