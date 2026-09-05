import type { Agent, LogEntry } from '@jkj/shared';
import { getSnapshot } from './workspace.js';
import { readSession } from '../runtime/session-reader.js';

/**
 * Agents are Claude Code sessions.
 *
 * Reading is complete; acting on them is not. Everything that would change a
 * session throws with a plain explanation rather than pretending to work —
 * see runtime/claude-agent.ts for where that lands.
 */

export async function listAgents(projectId?: string): Promise<Agent[]> {
  const { agents } = await getSnapshot();
  return projectId ? agents.filter(a => a.projectId === projectId) : agents;
}

export async function getAgent(id: string): Promise<Agent | undefined> {
  return (await getSnapshot()).agents.find(a => a.id === id);
}

/**
 * The transcript for one agent. A subagent id is "<sessionId>::<subId>", so
 * the session is read once and the right slice returned.
 */
export async function getTranscript(agentId: string): Promise<LogEntry[]> {
  const [sessionId, subId] = agentId.split('::');
  if (!sessionId) return [];

  const snapshot = await getSnapshot();
  const file = snapshot.files.get(sessionId);
  if (!file) return [];

  // Read past the cache when the session is live, so the view keeps up.
  const detail = await readSession(file);
  if (!detail) return [];

  if (!subId) return detail.entries.map(e => ({ ...e, agentId }));

  const sub = detail.subagents.find(s => s.id === subId);
  return (sub?.entries ?? []).map(e => ({ ...e, agentId }));
}

/** The bytes behind an image entry, or null if the reference is unknown. */
export async function getImage(
  agentId: string,
  ref: string,
): Promise<{ mediaType: string; data: Buffer } | null> {
  const sessionId = agentId.split('::')[0];
  if (!sessionId) return null;

  const snapshot = await getSnapshot();
  const file = snapshot.files.get(sessionId);
  if (!file) return null;

  const detail = await readSession(file);
  return detail?.images.get(ref) ?? null;
}

/* ---------- writes, not yet available ---------- */

const READ_ONLY = 'JKJ can read your sessions but not drive them yet.';

export function createAgent(): never { throw new Error(READ_ONLY); }
export function sendMessage(): never { throw new Error(READ_ONLY); }
export function interruptAgent(): never { throw new Error(READ_ONLY); }
export function resolveApproval(): never { throw new Error(READ_ONLY); }
export function archiveAgent(): never { throw new Error(READ_ONLY); }
