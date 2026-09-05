import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Claude Code keeps its state on this machine.
 *
 * Nothing here may assume a username, a home directory layout, or an
 * operating system. Every path is derived, every read is optional, and a
 * missing file means "not configured", never a crash.
 */

export interface ClaudeHome {
  /** Usually ~/.claude, or wherever CLAUDE_CONFIG_DIR points. */
  configDir: string;
  /** Per-project session transcripts: <configDir>/projects/<encoded>/<id>.jsonl */
  projectsDir: string;
  /** Live session descriptors written by running CLI processes. */
  sessionsDir: string;
  /** The JSON settings file, if one exists. */
  configFile: string | null;
  /** True when this machine has any Claude Code state at all. */
  present: boolean;
}

export function findClaudeHome(): ClaudeHome {
  const configDir = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');

  // The settings file has lived in both places across versions.
  const configFile = [join(configDir, '.claude.json'), join(homedir(), '.claude.json')]
    .find(existsSync) ?? null;

  const projectsDir = join(configDir, 'projects');

  return {
    configDir,
    projectsDir,
    sessionsDir: join(configDir, 'sessions'),
    configFile,
    present: existsSync(projectsDir) || configFile !== null,
  };
}

/** Shape of the bits of the settings file JKJ actually reads. */
export interface ClaudeConfig {
  mcpServers?: Record<string, McpServerConfig>;
  projects?: Record<string, ClaudeProjectConfig>;
}

export interface ClaudeProjectConfig {
  mcpServers?: Record<string, McpServerConfig>;
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  allowedTools?: string[];
  lastSessionId?: string;
}

export interface McpServerConfig {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
}

/** Read the settings file. Returns an empty config rather than throwing. */
export function readConfig(home: ClaudeHome): ClaudeConfig {
  if (!home.configFile) return {};
  return readJsonFile<ClaudeConfig>(home.configFile) ?? {};
}

/** Parse a JSON file, or return null if it is missing or malformed. */
export function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Read a text file, or return null. Used for CLAUDE.md and friends. */
export function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
