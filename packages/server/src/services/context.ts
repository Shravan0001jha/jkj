import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import type { ContextKind, ContextLayer, ContextResponse } from '@jkj/shared';
import { findClaudeHome, readTextFile } from '../runtime/claude-home.js';
import { getSnapshot } from './workspace.js';
import { BadRequest } from '../util/errors.js';

/**
 * Reads and writes every file that reaches a session in a project.
 *
 * The order matters and mirrors the CLI: your own preferences, what Claude
 * remembers, then each CLAUDE.md from the outermost directory down to the
 * repo, then your uncommitted notes. A nested package inherits the root's
 * CLAUDE.md — leaving those out made a project look like it had no context
 * when it had plenty.
 */

export async function readContext(projectId: string): Promise<ContextResponse> {
  const layers = await buildLayers(projectId);
  return {
    projectId,
    layers,
    // Only what every session is actually given. The notes behind the memory
    // index are recalled when relevant, so adding them would report a budget
    // many times larger than the one a session really carries.
    totalTokens: layers.reduce((n, layer) => n + (layer.counted ? layer.tokens : 0), 0),
  };
}

export async function saveContext(projectId: string, id: string, body: string): Promise<ContextLayer> {
  // Resolved from the same list that was handed out, so a request can only
  // ever write to a file JKJ already told the browser about.
  const layer = (await buildLayers(projectId)).find(l => l.id === id);
  if (!layer) throw new BadRequest('That context file is no longer listed. Reload and try again.');

  mkdirSync(dirname(layer.path), { recursive: true });
  writeFileSync(layer.path, body, 'utf8');

  return { ...layer, body, exists: true, tokens: estimateTokens(body) };
}

/* ---------- assembly ---------- */

async function buildLayers(projectId: string): Promise<ContextLayer[]> {
  const snapshot = await getSnapshot();
  const project = snapshot.projects.find(p => p.id === projectId);
  if (!project) throw new BadRequest(`Unknown project ${projectId}`);

  const home = findClaudeHome();
  const memoryDir = join(home.projectsDir, project.id, 'memory');

  const layers: ContextLayer[] = [
    layer({
      id: 'user',
      kind: 'user',
      label: 'How I like things',
      summary: 'Yours, applied to every project on this machine.',
      path: join(home.configDir, 'CLAUDE.md'),
    }),
    layer({
      id: 'memory',
      kind: 'memory',
      label: 'What Claude remembers',
      summary: 'Claude writes this as it works, and may rewrite it while a session runs.',
      path: memoryIndexPath(project.id),
    }),
  ];

  for (const name of listNotes(memoryDir)) {
    layers.push(layer({
      id: `note:${name}`,
      kind: 'note',
      label: name.replace(/\.md$/, '').replace(/[_-]/g, ' '),
      summary: 'Recalled when it is relevant, rather than loaded into every session.',
      path: join(memoryDir, name),
    }));
  }

  // Outermost directory first, so the list reads in the order the model does.
  for (const dir of ancestry(project.path)) {
    const path = join(dir, 'CLAUDE.md');
    const inherited = dir !== project.path;
    if (inherited && !existsSync(path)) continue;   // only show what is really there

    layers.push(layer({
      id: `project:${dir}`,
      kind: 'project',
      label: inherited ? `${labelFor(dir)} (inherited)` : 'This repo',
      summary: inherited
        ? 'From a directory above this one, so it applies here too.'
        : 'Committed with the code, so the whole team gets it.',
      path,
      inherited,
    }));
  }

  layers.push(layer({
    id: 'local',
    kind: 'local',
    label: 'This repo, just for you',
    summary: 'Not committed. For anything true of your machine rather than the project.',
    path: join(project.path, 'CLAUDE.local.md'),
  }));

  return layers;
}

function layer(spec: {
  id: string; kind: ContextKind; label: string; summary: string; path: string; inherited?: boolean;
}): ContextLayer {
  const body = readTextFile(spec.path) ?? '';
  return {
    ...spec,
    inherited: spec.inherited ?? false,
    exists: existsSync(spec.path),
    body,
    tokens: estimateTokens(body),
    counted: spec.kind !== 'note',
  };
}

/**
 * Every directory from the home folder down to the project, so a package
 * nested in a monorepo picks up the root's CLAUDE.md the way the CLI does.
 * Stops at home: nothing above that belongs to one project.
 */
function ancestry(projectPath: string): string[] {
  const root = homedir();
  const rel = relative(root, projectPath);
  if (rel.startsWith('..')) return [projectPath];   // outside home, no chain to walk

  const dirs: string[] = [];
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    dirs.push(current);
  }
  return dirs.length > 0 ? dirs : [projectPath];
}

function memoryIndexPath(projectKey: string): string {
  const base = join(findClaudeHome().projectsDir, projectKey);
  const inside = join(base, 'memory', 'MEMORY.md');
  return existsSync(inside) ? inside : join(base, 'MEMORY.md');
}

function listNotes(memoryDir: string): string[] {
  try {
    return readdirSync(memoryDir)
      .filter(name => name.endsWith('.md') && name !== 'MEMORY.md')
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];   // no memory folder is the normal case for a new project
  }
}

const labelFor = (dir: string): string => dir.split(sep).filter(Boolean).pop() ?? dir;

/** Rough enough for a budget bar. Replace with a real tokenizer later. */
export function estimateTokens(text: string): number {
  return Math.round(text.length / 3.6);
}
