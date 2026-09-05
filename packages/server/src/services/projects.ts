import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type { Project } from '@jkj/shared';
import { readJsonFile } from '../runtime/claude-home.js';
import { getSnapshot } from './workspace.js';
import { BadRequest } from '../util/errors.js';
import { log } from '../util/logger.js';

/**
 * Projects.
 *
 * Most arrive on their own: any directory Claude Code has a session for is a
 * project. A directory you have not started a session in yet has nothing to
 * discover, so it can be added by hand — that list is JKJ's own, kept beside
 * its other state and never written into Claude Code's.
 */

let dataDir = join(homedir(), '.jkj');

export function configureProjects(dir: string): void {
  dataDir = dir;
}

const listPath = (): string => join(dataDir, 'projects.json');

export async function listProjects(): Promise<Project[]> {
  return (await getSnapshot()).projects;
}

export async function getProject(id: string): Promise<Project | undefined> {
  return (await getSnapshot()).projects.find(p => p.id === id);
}

/** Paths added by hand, in the order they were added. */
export function addedPaths(): string[] {
  return readJsonFile<string[]>(listPath()) ?? [];
}

export function addProject(rawPath: string): Project {
  const path = expand(rawPath);

  if (!isAbsolute(path)) throw new BadRequest('Give a full path, or one starting with ~.');
  if (!existsSync(path)) throw new BadRequest(`There is nothing at ${path}.`);
  if (!statSync(path).isDirectory()) throw new BadRequest(`${path} is a file, not a directory.`);

  const paths = addedPaths();
  if (!paths.includes(path)) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(listPath(), JSON.stringify([...paths, path], null, 2), 'utf8');
    log.info('projects', `added ${path}`);
  }

  return toProject(path);
}

/** Forgets a directory. Nothing on disk is touched, including its sessions. */
export function removeProject(id: string): void {
  const remaining = addedPaths().filter(path => encodeProjectKey(path) !== id);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(listPath(), JSON.stringify(remaining, null, 2), 'utf8');
}

/**
 * The id Claude Code would give this directory: the path with its separators
 * replaced. Using the same key means that once you start a session here, the
 * discovered project and the added one are the same row rather than two.
 */
export function encodeProjectKey(path: string): string {
  return path.replace(/[/\\.:]/g, '-');
}

export function toProject(path: string): Project {
  return {
    id: encodeProjectKey(path),
    name: basename(path) || path,
    path,
    branch: gitBranch(path),
    enabledMcpServers: [],
  };
}

/** `~` is what people type, and it means nothing to the filesystem. */
function expand(input: string): string {
  const trimmed = input.trim();
  const path = trimmed === '~' || trimmed.startsWith(`~${sep}`)
    ? join(homedir(), trimmed.slice(1))
    : trimmed;
  return resolve(path);
}

/** Best effort: a directory that is not a repo simply has no branch. */
function gitBranch(path: string): string {
  try {
    return execFileSync('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'unknown';
  } catch {
    return 'not a git repo';
  }
}
