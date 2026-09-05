import type {
  Agent, ApprovalDecision, Attachment, CreateAgentRequest, LogEntry, PermissionMode,
} from '@jkj/shared';
import { getSnapshot } from './workspace.js';
import { readSession } from '../runtime/session-reader.js';
import * as runs from './runs.js';

/**
 * Agents are Claude Code sessions.
 *
 * Two kinds, and the difference matters: sessions JKJ started, which it can
 * message and interrupt, and sessions started in a terminal, which it can
 * only read. Nothing can type into someone else's terminal process, so the
 * second kind stays read-only and says so.
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
  const driven = runs.getRunTranscript(agentId);
  if (driven) return driven;

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
  // A driven run keeps its images in memory; nothing has been written yet.
  const live = runs.getRunImage(agentId, ref);
  if (live) return live;

  const sessionId = agentId.split('::')[0];
  if (!sessionId) return null;

  const snapshot = await getSnapshot();
  const file = snapshot.files.get(sessionId);
  if (!file) return null;

  const detail = await readSession(file);
  return detail?.images.get(ref) ?? null;
}

/* ---------- driving ---------- */

export const createAgent = (request: CreateAgentRequest): Promise<Agent> => runs.createRun(request);

/**
 * Continue a session that has ended. The transcript on disk comes with it, so
 * the conversation carries on rather than starting a second one beside it.
 */
export async function resumeAgent(
  agentId: string,
  text: string,
  attachments?: Attachment[],
): Promise<Agent> {
  const agent = await getAgent(agentId);
  if (!agent) throw new Error('That session is no longer on disk.');

  const history = await getTranscript(agentId);
  return runs.resumeRun(agent, history, text, attachments);
}

export const sendMessage = (agentId: string, text: string, attachments?: Attachment[]): void =>
  runs.sendMessage(agentId, text, attachments);

export const interruptAgent = (agentId: string): Promise<void> => runs.interruptRun(agentId);

export const resolveApproval = (agentId: string, decision: ApprovalDecision): void =>
  runs.resolveApproval(agentId, decision);

export const setPermissionMode = (agentId: string, mode: PermissionMode): Promise<void> =>
  runs.setPermissionMode(agentId, mode);

/**
 * Closing a run releases the process. The transcript stays on disk, where the
 * CLI wrote it, so it reappears as a past session on the next read.
 */
export const archiveAgent = (agentId: string): void => runs.closeRun(agentId);
