import type { Agent, ApprovalDecision, Attachment, CreateAgentRequest, LogEntry, LogKind } from '@jkj/shared';
import { startRun, type RunHandle, type RunImage } from '../runtime/claude-agent.js';
import { getSnapshot } from './workspace.js';
import { BadRequest } from '../util/errors.js';
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
  /** Images sent into this run, keyed by the entry that shows them. */
  images: Map<string, { mediaType: string; data: Buffer }>;
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

  return spawn({
    projectId: project.id,
    name: title(request.task),
    task: request.task,
    model: request.model,
    cwd: project.path,
    workspace: request.workspace,
    prompt: request.task,
    permissionMode: request.permissionMode ?? 'default',
    attachments: request.attachments,
  });
}

/**
 * Pick a finished session back up.
 *
 * The SDK continues the original conversation, so the model still has
 * everything that was said. The transcript already on disk is carried into
 * the run so the reader sees one continuous conversation rather than a new
 * window onto an old one.
 */
export async function resumeRun(
  agent: Agent,
  history: LogEntry[],
  text: string,
  attachments?: Attachment[],
): Promise<Agent> {
  if (agent.driven) throw new Error('That session is already running here.');
  if (agent.parentAgentId) throw new Error('A subagent run cannot be resumed on its own.');

  return spawn({
    projectId: agent.projectId,
    name: agent.name,
    task: agent.task,
    model: agent.model,
    cwd: agent.cwd,
    workspace: agent.workspace,
    prompt: text,
    permissionMode: 'default',
    attachments,
    resume: agent.id,
    history,
  });
}

interface SpawnOptions {
  projectId: string;
  name: string;
  task: string;
  model: string;
  cwd: string;
  workspace: Agent['workspace'];
  prompt: string;
  permissionMode: 'default' | 'acceptEdits' | 'plan';
  attachments?: Attachment[];
  /** Session id to continue, when this is not a fresh conversation. */
  resume?: string;
  /** Transcript to carry over, so a resumed session reads continuously. */
  history?: LogEntry[];
}

function spawn(options: SpawnOptions): Agent {
  // Until the SDK reports one, the run needs an id of its own.
  const id = `run_${Math.random().toString(36).slice(2, 10)}`;

  const agent: Agent = {
    id,
    projectId: options.projectId,
    name: options.name,
    task: options.task,
    model: options.model,
    status: 'running',
    workspace: options.workspace,
    cwd: options.cwd,
    startedAt: new Date().toISOString(),
    messageCount: 1,
    driven: true,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };

  const run: Run = {
    agent,
    entries: (options.history ?? []).map(e => ({ ...e, agentId: id })),
    handle: undefined as unknown as RunHandle,
    images: new Map(),
  };
  runs.set(id, run);

  const { images, text } = attach(run, options.attachments ?? []);
  append(run, 'user', '', options.prompt);
  const prompt = withFiles(options.prompt, text);

  run.handle = startRun(
    {
      cwd: options.cwd,
      model: options.model,
      prompt,
      images,
      permissionMode: options.permissionMode,
      ...(options.resume ? { resume: options.resume } : {}),
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

export function sendMessage(agentId: string, text: string, attachments: Attachment[] = []): void {
  const run = require$(agentId);
  const { images, text: files } = attach(run, attachments);
  append(run, 'user', '', text);
  update(run, { status: 'running', messageCount: (run.agent.messageCount ?? 0) + 1 });
  run.handle.send(withFiles(text, files), images);
}

/**
 * Text files travel inside the message, not beside it. The transcript shows
 * them as their own line because that reads better, but the model only sees
 * what is in the message — so the two are assembled separately on purpose.
 */
function withFiles(text: string, files: string[]): string {
  return files.length === 0 ? text : [...files, text].join('\n\n');
}

/** Images kept for a driven run, so the transcript can show them back. */
export const getRunImage = (agentId: string, ref: string) => runs.get(agentId)?.images.get(ref) ?? null;

/**
 * Turn what the browser sent into what the model receives.
 *
 * Images go through as images. Anything textual is inlined as a fenced block
 * — a file the model cannot read is worse than no file, and pretending
 * otherwise wastes a turn. Anything else is refused out loud.
 */
function attach(run: Run, attachments: Attachment[]): { images: RunImage[]; text: string[] } {
  const images: RunImage[] = [];
  const text: string[] = [];

  for (const file of attachments) {
    if (file.mediaType.startsWith('image/')) {
      const ref = `ln_${Math.random().toString(36).slice(2, 9)}`;
      run.images.set(ref, { mediaType: file.mediaType, data: Buffer.from(file.data, 'base64') });
      append(run, 'image', '', file.name || 'Pasted image', {
        id: ref,
        image: { mediaType: file.mediaType, ref },
      });
      images.push({ mediaType: file.mediaType, data: file.data });
      continue;
    }

    if (isTextual(file.mediaType, file.name)) {
      const body = Buffer.from(file.data, 'base64').toString('utf8');
      const block = ['```' + language(file.name), `// ${file.name}`, body, '```'].join('\n');
      append(run, 'user', '', block);
      text.push(block);
      continue;
    }

    throw new BadRequest(
      `${file.name || 'That file'} is a ${file.mediaType}, which cannot be read. Attach an image or a text file.`,
    );
  }

  return { images, text };
}

const TEXT_EXTENSIONS = /\.(txt|md|markdown|json|jsonc|ya?ml|toml|csv|tsv|log|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|html|css|scss|xml|ini|env|diff|patch)$/i;

const isTextual = (mediaType: string, name: string): boolean =>
  mediaType.startsWith('text/')
  || mediaType === 'application/json'
  || mediaType === 'application/xml'
  || TEXT_EXTENSIONS.test(name);

const language = (name: string): string => name.split('.').pop()?.toLowerCase() ?? '';

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

function append(
  run: Run,
  kind: LogKind,
  label: string,
  text: string,
  extra?: Partial<LogEntry>,
): LogEntry {
  const entry: LogEntry = {
    id: `ln_${Math.random().toString(36).slice(2, 9)}`,
    agentId: run.agent.id,
    at: new Date().toISOString(),
    kind,
    label,
    text,
    ...extra,
  };
  run.entries.push(entry);
  emit({ entry });
  return entry;
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
