import type { Agent, ApprovalDecision, CreateAgentRequest, LogEntry, LogKind } from '@jkj/shared';
import { startRun, type RunHandle } from '../runtime/claude-agent.js';
import { getSnapshot } from './workspace.js';
import { log } from '../util/logger.js';

/**
 * Sessions JKJ started and therefore owns.
 *
 * A session opened in a terminal cannot be typed into from here — that
 * process owns its own input. So driving means starting the session
 * ourselves, and this module is the register of the ones we hold.
 */

interface Run {
  agent: Agent;
  entries: LogEntry[];
  handle: RunHandle;
  /** The session file this run is writing, once the SDK reports it. */
  sessionId?: string;
  /** Set while a tool call is parked waiting for the browser to answer. */
  pending?: { decide: (decision: 'allow' | 'deny') => void };
}

const runs = new Map<string, Run>();

type Listener = (event: { agent?: Agent; entry?: LogEntry }) => void;
const listeners = new Set<Listener>();

export function onRunEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function emit(event: Parameters<Listener>[0]): void {
  for (const fn of listeners) fn(event);
}

/* ---------- reads ---------- */

export const listRunAgents = (): Agent[] => [...runs.values()].map(r => r.agent);

export const getRunTranscript = (agentId: string): LogEntry[] | null =>
  runs.get(agentId)?.entries ?? null;

/**
 * Session files JKJ is writing right now. The disk reader would otherwise
 * surface the same conversation a second time, as a read-only session.
 */
export const ownedSessionIds = (): Set<string> =>
  new Set([...runs.values()].map(r => r.sessionId).filter((id): id is string => Boolean(id)));

/* ---------- starting ---------- */

export async function createRun(request: CreateAgentRequest): Promise<Agent> {
  const project = (await getSnapshot()).projects.find(p => p.id === request.projectId);
  if (!project) throw new Error(`Unknown project ${request.projectId}`);

  // Until the SDK reports one, the run needs an id of its own.
  const id = `run_${Math.random().toString(36).slice(2, 10)}`;

  const agent: Agent = {
    id,
    projectId: project.id,
    name: title(request.task),
    task: request.task,
    model: request.model,
    status: 'running',
    workspace: request.workspace,
    cwd: project.path,
    startedAt: new Date().toISOString(),
    messageCount: 1,
    driven: true,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };

  const run: Run = { agent, entries: [], handle: undefined as unknown as RunHandle };
  runs.set(id, run);

  append(run, 'user', '', request.task);

  run.handle = startRun(
    {
      cwd: project.path,
      model: request.model,
      prompt: request.task,
      permissionMode: request.permissionMode ?? 'default',
    },
    {
      onSessionId: sessionId => {
        // The run keeps its own id: the browser is already showing it, and
        // renaming an open conversation underneath the reader is worse than
        // carrying two identifiers. The session id is recorded so the disk
        // reader can skip the file this run is writing.
        run.sessionId = sessionId;
        log.info('runs', `${id} is session ${sessionId}`);
      },

      onText: text => append(run, 'assistant', '', text),

      onToolUse: (tool, input) => append(run, kindForTool(tool), tool, describeInput(tool, input)),

      onPermission: request2 => new Promise<'allow' | 'deny'>(resolve => {
        update(run, {
          status: 'waiting',
          approval: {
            id: `ap_${Math.random().toString(36).slice(2, 8)}`,
            tool: request2.tool,
            input: describeInput(request2.tool, request2.input),
            reason: request2.title,
            requestedAt: new Date().toISOString(),
          },
        });
        run.pending = {
          decide: decision => {
            run.pending = undefined;
            update(run, { status: decision === 'allow' ? 'running' : 'running', approval: undefined });
            resolve(decision);
          },
        };
      }),

      onUsage: (inputTokens, outputTokens) => update(run, {
        usage: {
          inputTokens: run.agent.usage.inputTokens + inputTokens,
          outputTokens: run.agent.usage.outputTokens + outputTokens,
          costUsd: 0,
        },
      }),

      onDone: () => update(run, { status: 'waiting' }),

      onError: message => {
        append(run, 'error', 'Failed', message);
        update(run, { status: 'error' });
      },
    },
  );

  emit({ agent: run.agent });
  return run.agent;
}

/* ---------- driving ---------- */

export function sendMessage(agentId: string, text: string): void {
  const run = require$(agentId);
  append(run, 'user', '', text);
  update(run, { status: 'running', messageCount: (run.agent.messageCount ?? 0) + 1 });
  run.handle.send(text);
}

export async function interruptRun(agentId: string): Promise<void> {
  const run = require$(agentId);
  await run.handle.interrupt();
  append(run, 'system', 'Stopped', 'Interrupted from JKJ. Anything already written stays written.');
  update(run, { status: 'waiting' });
}

export function resolveApproval(agentId: string, decision: ApprovalDecision): void {
  const run = require$(agentId);
  if (!run.pending) throw new Error('That request has already been answered.');

  // 'always' is treated as this once: persisting a rule would edit the
  // permission settings a running CLI also reads, which JKJ does not do yet.
  run.pending.decide(decision === 'deny' ? 'deny' : 'allow');
  append(run, 'system', decision === 'deny' ? 'Denied' : 'Allowed',
    decision === 'deny' ? 'You denied the request.' : 'You allowed the request.');
}

export function closeRun(agentId: string): void {
  const run = runs.get(agentId);
  if (!run) return;
  run.handle.close();
  runs.delete(agentId);
}

/* ---------- helpers ---------- */

function require$(agentId: string): Run {
  const run = runs.get(agentId);
  if (!run) throw new Error('JKJ does not own that session, so it cannot drive it.');
  return run;
}

function append(run: Run, kind: LogKind, label: string, text: string): void {
  const entry: LogEntry = {
    id: `ln_${Math.random().toString(36).slice(2, 9)}`,
    agentId: run.agent.id,
    at: new Date().toISOString(),
    kind,
    label,
    text,
  };
  run.entries.push(entry);
  emit({ entry });
}

function update(run: Run, patch: Partial<Agent>): void {
  run.agent = { ...run.agent, ...patch };
  emit({ agent: run.agent });
}

function kindForTool(tool: string): LogKind {
  if (tool === 'Read' || tool === 'NotebookRead') return 'read';
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return 'edit';
  if (tool === 'Bash' || tool === 'BashOutput') return 'bash';
  if (tool === 'Grep' || tool === 'Glob' || tool === 'WebSearch' || tool === 'WebFetch') return 'search';
  if (tool === 'Task' || tool === 'Agent') return 'task';
  return 'tool';
}

function describeInput(tool: string, input: Record<string, unknown>): string {
  for (const key of ['file_path', 'command', 'pattern', 'path', 'url', 'query', 'prompt', 'description']) {
    const value = input[key];
    if (typeof value === 'string' && value) return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  }
  const keys = Object.keys(input);
  return keys.length ? `${tool}(${keys.join(', ')})` : tool;
}

/** A short name for the tab, taken from the first few words of the task. */
function title(task: string): string {
  const words = task.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
  return words.length > 48 ? `${words.slice(0, 48)}…` : words || 'New session';
}
