import type { Agent, CreateAgentRequest, LogEntry } from '@jkj/shared';
import { createMemoryStore } from '../store/db.js';
import { log } from '../util/logger.js';

/**
 * Agents — the core of JKJ.
 *
 * This module owns the list of agents and their transcripts. It never talks
 * to the model itself; that is runtime/claude-agent.ts. Keeping the two apart
 * means we can stub the runtime in tests and swap SDK versions in one file.
 */

const agents = createMemoryStore<Agent>();
const transcripts = new Map<string, LogEntry[]>();

/** Anything that wants to know when an agent changes registers here. */
type Listener = (event: { agent?: Agent; entry?: LogEntry; removedId?: string }) => void;
const listeners = new Set<Listener>();

export function onAgentEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(event: Parameters<Listener>[0]): void {
  for (const fn of listeners) fn(event);
}

export function listAgents(projectId?: string): Agent[] {
  const all = agents.all();
  return projectId ? all.filter(a => a.projectId === projectId) : all;
}

export function getAgent(id: string): Agent | undefined {
  return agents.get(id);
}

export function getTranscript(agentId: string): LogEntry[] {
  return transcripts.get(agentId) ?? [];
}

/**
 * Create an agent and start it.
 *
 * TODO:
 *   - resolve a working directory: for `worktree`, `git worktree add`
 *     under <repo>/.jkj/worktrees/<name>
 *   - assemble the prompt via services/context.ts
 *   - hand off to runtime/claude-agent.ts and stream its events into
 *     appendLog() / updateAgent()
 */
export function createAgent(req: CreateAgentRequest): Agent {
  const name = slugify(req.task);
  const agent: Agent = {
    id: `ag_${Math.random().toString(36).slice(2, 9)}`,
    projectId: req.projectId,
    name,
    task: req.task,
    model: req.model,
    status: 'idle',
    workspace: req.workspace,
    cwd: '',                       // set once the worktree exists
    startedAt: new Date().toISOString(),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
  agents.put(agent);
  transcripts.set(agent.id, []);
  emit({ agent });
  log.info('agents', `created ${agent.name} (${agent.id})`);
  return agent;
}

/** Apply a partial change and notify everyone watching. */
export function updateAgent(id: string, patch: Partial<Agent>): Agent | undefined {
  const current = agents.get(id);
  if (!current) return undefined;
  const next = agents.put({ ...current, ...patch });
  emit({ agent: next });
  return next;
}

export function appendLog(entry: LogEntry): LogEntry {
  const list = transcripts.get(entry.agentId) ?? [];
  list.push(entry);
  transcripts.set(entry.agentId, list);
  emit({ entry });
  return entry;
}

/** Forward a message from the user into a running agent. */
export function sendMessage(agentId: string, text: string): void {
  // TODO: push onto the runtime's input queue for this agent.
  appendLog(makeEntry(agentId, 'user', '', text));
}

/** Stop an agent without losing its worktree. */
export function interruptAgent(agentId: string): void {
  // TODO: signal the runtime to abort the current turn.
  updateAgent(agentId, { status: 'idle' });
  appendLog(makeEntry(agentId, 'system', 'Stopped', 'Interrupted. The worktree was left untouched.'));
}

/** Answer the permission prompt an agent is blocked on. */
export function resolveApproval(agentId: string, _approvalId: string, decision: 'once' | 'always' | 'deny'): void {
  // TODO: resolve the runtime's pending permission promise with this decision,
  // and for 'always' persist the rule against the project.
  updateAgent(agentId, {
    status: decision === 'deny' ? 'error' : 'running',
    approval: undefined,
  });
}

export function archiveAgent(agentId: string): void {
  // TODO: remove the git worktree if it is clean, keep it if it has changes.
  agents.remove(agentId);
  transcripts.delete(agentId);
  emit({ removedId: agentId });
}

/* ---------- small helpers ---------- */

export function makeEntry(
  agentId: string,
  kind: LogEntry['kind'],
  label: string,
  text: string,
): LogEntry {
  return {
    id: `ln_${Math.random().toString(36).slice(2, 9)}`,
    agentId,
    at: new Date().toISOString(),
    kind,
    label,
    text,
  };
}

function slugify(task: string): string {
  return task.toLowerCase().split(/\s+/).slice(0, 3).join('-').replace(/[^a-z0-9-]/g, '') || 'agent';
}
