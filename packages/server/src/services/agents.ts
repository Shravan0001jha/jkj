import { basename } from 'node:path';
import type {
  Agent, ApprovalDecision, Attachment, CreateAgentRequest, LogEntry, PermissionMode,
} from '@jkj/shared';
import { findClaudeHome } from '../runtime/claude-home.js';
import { listSessionFiles, readSession, type SessionDetail } from '../runtime/session-reader.js';
import * as runs from './runs.js';
import { BadRequest } from '../util/errors.js';

/**
 * Agents are Claude Code sessions.
 *
 * In the Workplace every session that matters is one the Workplace started,
 * so the list is the register of runs. A past session is still readable by
 * its id from the file the CLI wrote, which is how an employee's earlier
 * work stays on its page after the process is gone.
 */

export async function listAgents(): Promise<Agent[]> {
  return runs.listRunAgents();
}

export async function getAgent(id: string): Promise<Agent | undefined> {
  const live = runs.getRunAgent(id);
  if (live) return live;
  const detail = await readById(id);
  return detail ? fromDisk(detail) : undefined;
}

/** The transcript for one agent: the live run, or the file on disk. */
export async function getTranscript(agentId: string): Promise<LogEntry[]> {
  const driven = runs.getRunTranscript(agentId);
  if (driven) return driven;
  const [sessionId, subId] = agentId.split('::');
  const detail = sessionId ? await readById(sessionId) : null;
  if (!detail) return [];
  if (!subId) return detail.entries.map(e => ({ ...e, agentId }));
  const sub = detail.subagents.find(s => s.id === subId);
  return (sub?.entries ?? []).map(e => ({ ...e, agentId }));
}

export async function getImage(agentId: string, ref: string): Promise<{ mediaType: string; data: Buffer } | null> {
  const live = runs.getRunImage(agentId, ref);
  if (live) return live;
  const detail = await readById(agentId.split('::')[0] ?? '');
  return detail?.images.get(ref) ?? null;
}

/* ---------- driving ---------- */

export const createAgent = (request: CreateAgentRequest): Promise<Agent> => runs.createRun(request);

/** Continue a session that has ended, with its transcript carried over. */
export async function resumeAgent(agentId: string, text: string, attachments?: Attachment[]): Promise<Agent> {
  const agent = await getAgent(agentId);
  if (!agent) throw new BadRequest('That session is no longer on disk.');
  const history = await getTranscript(agentId);
  return runs.resumeRun(agent, history, text, attachments);
}

export const sendMessage = (agentId: string, text: string, attachments?: Attachment[], from: string = 'owner'): void =>
  void runs.sendMessage(agentId, text, attachments, { from });

export const interruptAgent = (agentId: string): Promise<void> => runs.interruptRun(agentId, { byOwner: true });

export const resolveApproval = (agentId: string, decision: ApprovalDecision): void =>
  runs.resolveApproval(agentId, decision);

export const setPermissionMode = (agentId: string, mode: PermissionMode): Promise<void> =>
  runs.setPermissionMode(agentId, mode);

export const archiveAgent = (agentId: string): void => runs.closeRun(agentId);

/* ---------- disk ---------- */

async function readById(sessionId: string): Promise<SessionDetail | null> {
  if (!sessionId || !/^[a-zA-Z0-9-]+$/.test(sessionId)) return null;
  const file = listSessionFiles(findClaudeHome()).find(f => f.sessionId === sessionId);
  return file ? readSession(file) : null;
}

function fromDisk(detail: SessionDetail): Agent {
  return {
    id: detail.sessionId,
    projectId: basename(detail.cwd) || detail.cwd,
    name: detail.title ?? `session ${detail.sessionId.slice(0, 8)}`,
    task: detail.lastPrompt ?? detail.title ?? 'No prompt recorded',
    model: detail.model ?? 'unknown',
    status: 'done',
    workspace: 'branch',
    cwd: detail.cwd,
    startedAt: detail.startedAt,
    endedAt: detail.endedAt,
    messageCount: detail.messageCount,
    usage: { inputTokens: detail.inputTokens, outputTokens: detail.outputTokens, costUsd: 0 },
  };
}
