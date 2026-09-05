import { basename } from 'node:path';
import type { Agent, AgentStatus, Project } from '@jkj/shared';
import { findClaudeHome, readConfig, type ClaudeHome } from '../runtime/claude-home.js';
import { readLiveSessions, type LiveSession } from '../runtime/live-sessions.js';
import { listSessionFiles, readSession, type SessionDetail, type SessionFile } from '../runtime/session-reader.js';
import { listRunAgents, ownedSessionIds } from './runs.js';
import { addedPaths, toProject } from './projects.js';
import { log } from '../util/logger.js';

/**
 * Turns what is on disk into the domain model the UI speaks.
 *
 * One session file becomes one agent. A subagent run inside a session becomes
 * a child agent with parentAgentId set. A directory under projects/ becomes a
 * project, whose real path is read from the session records rather than
 * decoded from the directory name.
 */

export interface Snapshot {
  home: ClaudeHome;
  projects: Project[];
  agents: Agent[];
  /** Session id -> the file it was read from, for transcript lookups. */
  files: Map<string, SessionFile>;
  details: Map<string, SessionDetail>;
  builtAt: number;
}

/**
 * How many session files to read per project, newest first. Capped per
 * project rather than overall so a busy repo cannot hide a quiet one.
 */
const MAX_SESSIONS_PER_PROJECT = 40;

/** Rebuilding walks the disk, so a snapshot is reused for a moment. */
const TTL_MS = 3000;

let cached: Snapshot | null = null;
let inFlight: Promise<Snapshot> | null = null;

export async function getSnapshot(force = false): Promise<Snapshot> {
  if (!force && cached && Date.now() - cached.builtAt < TTL_MS) return cached;
  if (inFlight) return inFlight;

  inFlight = build().finally(() => { inFlight = null; });
  cached = await inFlight;
  return cached;
}

async function build(): Promise<Snapshot> {
  const home = findClaudeHome();
  const config = readConfig(home);
  const live = readLiveSessions(home);

  const files = newestPerProject(listSessionFiles(home));
  const details = new Map<string, SessionDetail>();
  const fileById = new Map<string, SessionFile>();

  for (const file of files) {
    const detail = await readSession(file);
    if (!detail) continue;
    details.set(detail.sessionId, detail);
    fileById.set(detail.sessionId, file);
  }

  const projects = withAdded(buildProjects(files, details, config.projects ?? {}));

  // Sessions JKJ is driving come from memory, not disk — the file it is
  // writing is incomplete, and the in-memory copy is the live one.
  const owned = ownedSessionIds();
  const agents = [
    ...listRunAgents(),
    ...buildAgents(files, details, live, projects).filter(a => !owned.has(a.id)),
  ];

  log.info('workspace', `${projects.length} projects, ${agents.length} agents, ${live.size} live`);

  return { home, projects, agents, files: fileById, details, builtAt: Date.now() };
}

/**
 * Directories added by hand that Claude Code has no sessions for yet. They use
 * the same id a discovered project would, so the moment a session starts there
 * the two become one row rather than two.
 */
function withAdded(discovered: Project[]): Project[] {
  const known = new Set(discovered.map(p => p.id));
  const extra = addedPaths()
    .map(toProject)
    .filter(project => !known.has(project.id));

  return [...discovered, ...extra].sort((a, b) => a.name.localeCompare(b.name));
}

/** listSessionFiles returns newest first, so taking the first N per key keeps the newest. */
function newestPerProject(files: SessionFile[]): SessionFile[] {
  const seen = new Map<string, number>();
  const kept: SessionFile[] = [];

  for (const file of files) {
    const count = seen.get(file.projectKey) ?? 0;
    if (count >= MAX_SESSIONS_PER_PROJECT) continue;
    seen.set(file.projectKey, count + 1);
    kept.push(file);
  }
  return kept;
}

/* ---------- projects ---------- */

function buildProjects(
  files: SessionFile[],
  details: Map<string, SessionDetail>,
  configProjects: Record<string, { mcpServers?: Record<string, unknown>; enabledMcpjsonServers?: string[] }>,
): Project[] {
  const byKey = new Map<string, Project>();
  const knownPaths = pathsByDirectoryName(Object.keys(configProjects));

  // files arrive newest first, so the first session in a directory wins.
  for (const file of files) {
    if (byKey.has(file.projectKey)) continue;

    // A transcript records the directory it ran in. When one is unreadable,
    // fall back to matching the encoded directory name against the paths the
    // settings file already knows about.
    const detail = details.get(file.sessionId);
    const path = detail?.cwd || knownPaths.get(file.projectKey);
    if (!path) continue;

    const settings = configProjects[path] ?? {};
    byKey.set(file.projectKey, {
      id: file.projectKey,
      name: basename(path) || path,
      path,
      branch: detail?.gitBranch ?? 'unknown',
      enabledMcpServers: [
        ...Object.keys(settings.mcpServers ?? {}),
        ...(settings.enabledMcpjsonServers ?? []),
      ],
    });
  }

  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Claude Code names a project directory after the path with the separators
 * replaced. That is not reversible — `claude-dev` and `claude/dev` encode the
 * same — but going the other way is, so known paths are encoded and indexed.
 */
function pathsByDirectoryName(paths: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const path of paths) {
    index.set(path.replace(/[/\\.:]/g, '-'), path);
  }
  return index;
}

/* ---------- agents ---------- */

function buildAgents(
  files: SessionFile[],
  details: Map<string, SessionDetail>,
  live: Map<string, LiveSession>,
  projects: Project[],
): Agent[] {
  const known = new Set(projects.map(p => p.id));
  const agents: Agent[] = [];

  for (const file of files) {
    const detail = details.get(file.sessionId);
    if (!detail || !known.has(file.projectKey)) continue;

    const session = live.get(detail.sessionId);
    const agent: Agent = {
      id: detail.sessionId,
      projectId: file.projectKey,
      name: sessionName(detail, session),
      task: detail.lastPrompt ?? detail.title ?? 'No prompt recorded',
      model: detail.model ?? 'unknown',
      status: statusOf(session),
      // Claude Code sessions run in the repo itself; JKJ does not move them.
      workspace: 'branch',
      cwd: detail.cwd,
      startedAt: detail.startedAt,
      endedAt: session ? undefined : detail.endedAt,
      messageCount: detail.messageCount,
      usage: {
        inputTokens: detail.inputTokens,
        outputTokens: detail.outputTokens,
        // Pricing is not recorded in the transcript, and guessing it would be
        // worse than leaving it out. The UI hides a zero.
        costUsd: 0,
      },
    };
    agents.push(agent);

    for (const sub of detail.subagents) {
      agents.push({
        ...agent,
        id: `${detail.sessionId}::${sub.id}`,
        parentAgentId: detail.sessionId,
        name: sub.name,
        task: sub.task || 'Subagent run',
        status: 'done',
        workspace: 'readonly',
        endedAt: detail.endedAt,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      });
    }
  }

  return agents;
}

/**
 * A live descriptor says what the session is doing; without one, the session
 * is simply over. 'busy' means the model is working, anything else means it
 * is sitting waiting for the person at the keyboard.
 */
function statusOf(session: LiveSession | undefined): AgentStatus {
  if (!session) return 'done';
  return session.status === 'busy' ? 'running' : 'waiting';
}

/**
 * The best name available. The generated title describes the work, so it
 * beats the handle a live CLI gives itself, which is derived from the
 * username and says nothing.
 */
function sessionName(detail: SessionDetail, session: LiveSession | undefined): string {
  return detail.title ?? session?.name ?? `session ${detail.sessionId.slice(0, 8)}`;
}
