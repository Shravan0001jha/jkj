import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { BadRequest } from '../util/errors.js';

/**
 * Browsing the machine's own directories, so picking a project is pointing at
 * one rather than typing a path from memory.
 *
 * The browser cannot do this itself: its directory picker hands back a handle
 * with a name, never a location on disk, and JKJ needs the location. Since
 * the server is already running on the same machine and already reads the
 * session transcripts, listing directory names asks for nothing new.
 */

export interface BrowseEntry {
  name: string;
  path: string;
  /** Directories with a .git are almost always what someone is looking for. */
  isRepo: boolean;
}

export interface BrowseResponse {
  path: string;
  /** null at the filesystem root, where there is nowhere further up. */
  parent: string | null;
  /** Each step of the current path, for a breadcrumb. */
  crumbs: { name: string; path: string }[];
  entries: BrowseEntry[];
}

/** Listing is capped: some directories hold thousands of entries. */
const MAX_ENTRIES = 400;

export function browse(rawPath?: string): BrowseResponse {
  const path = resolve(expand(rawPath?.trim() || homedir()));

  if (!existsSync(path)) throw new BadRequest(`There is nothing at ${path}.`);
  if (!statSync(path).isDirectory()) throw new BadRequest(`${path} is a file, not a directory.`);

  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    throw new BadRequest(`${path} cannot be read.`);
  }

  const entries: BrowseEntry[] = [];
  for (const name of names) {
    // Dot-directories are noise when choosing a project, and node_modules is
    // the loudest noise of all.
    if (name.startsWith('.') || name === 'node_modules') continue;
    if (entries.length >= MAX_ENTRIES) break;

    const child = join(path, name);
    try {
      if (!statSync(child).isDirectory()) continue;
      entries.push({ name, path: child, isRepo: existsSync(join(child, '.git')) });
    } catch {
      // Permission denied, or it vanished mid-listing. Neither is our problem.
    }
  }

  entries.sort((a, b) => Number(b.isRepo) - Number(a.isRepo) || a.name.localeCompare(b.name));

  const parent = dirname(path);
  return {
    path,
    parent: parent === path ? null : parent,
    crumbs: crumbsFor(path),
    entries,
  };
}

function crumbsFor(path: string): { name: string; path: string }[] {
  const home = homedir();
  if (path === home || path.startsWith(home + sep)) {
    const rest = path.slice(home.length).split(sep).filter(Boolean);
    let current = home;
    return [{ name: '~', path: home }, ...rest.map(part => {
      current = join(current, part);
      return { name: part, path: current };
    })];
  }

  let current: string = sep;
  return [{ name: '/', path: sep }, ...path.split(sep).filter(Boolean).map(part => {
    current = join(current, part);
    return { name: part, path: current };
  })];
}

function expand(input: string): string {
  return input === '~' || input.startsWith(`~${sep}`) ? join(homedir(), input.slice(1)) : input;
}
