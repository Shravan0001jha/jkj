import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssembledContext, ContextDoc } from '@jkj/shared';
import { findClaudeHome, readTextFile } from '../runtime/claude-home.js';
import { getSnapshot } from './workspace.js';

/**
 * Context — two layers, both of them real files Claude Code already reads.
 *
 *   central   <configDir>/CLAUDE.md, loaded into every session on the machine
 *   project   <repo>/CLAUDE.md, loaded for sessions in that repo
 *
 * JKJ edits those files rather than inventing a store of its own, so what you
 * write here is what the CLI picks up, with or without JKJ running.
 */

export function centralContextPath(): string {
  return join(findClaudeHome().configDir, 'CLAUDE.md');
}

export function getCentralContext(): ContextDoc {
  const path = centralContextPath();
  return {
    scope: 'central',
    projectId: null,
    body: readTextFile(path) ?? '',
    updatedAt: new Date().toISOString(),
  };
}

export function setCentralContext(body: string): ContextDoc {
  writeFileSync(centralContextPath(), body, 'utf8');
  return { scope: 'central', projectId: null, body, updatedAt: new Date().toISOString() };
}

export async function projectContextPath(projectId: string): Promise<string | null> {
  const project = (await getSnapshot()).projects.find(p => p.id === projectId);
  return project ? join(project.path, 'CLAUDE.md') : null;
}

export async function getProjectContext(projectId: string): Promise<ContextDoc> {
  const path = await projectContextPath(projectId);
  return {
    scope: 'project',
    projectId,
    body: path ? readTextFile(path) ?? '' : '',
    updatedAt: new Date().toISOString(),
  };
}

export async function setProjectContext(projectId: string, body: string): Promise<ContextDoc> {
  const path = await projectContextPath(projectId);
  if (!path) throw new Error(`Unknown project ${projectId}`);
  writeFileSync(path, body, 'utf8');
  return { scope: 'project', projectId, body, updatedAt: new Date().toISOString() };
}

/** What a new session in this project would be told before it reads anything. */
export async function assembleContext(projectId: string): Promise<AssembledContext> {
  const central = getCentralContext().body;
  const project = (await getProjectContext(projectId)).body;
  const snapshot = await getSnapshot();
  const found = snapshot.projects.find(p => p.id === projectId);

  const text = [
    '# Central preferences',
    central.trim() || '(empty)',
    '',
    `# Project: ${found?.name ?? projectId}`,
    found ? `Repo: ${found.path} (${found.branch})` : '',
    project.trim() || '(empty)',
  ].join('\n');

  const segments = [
    { label: 'Central context', tokens: estimateTokens(central) },
    { label: 'Project context', tokens: estimateTokens(project) },
  ];

  return { text, segments, totalTokens: segments.reduce((n, s) => n + s.tokens, 0) };
}

/** Rough enough for a budget bar. Replace with a real tokenizer later. */
export function estimateTokens(text: string): number {
  return Math.round(text.length / 3.6);
}
