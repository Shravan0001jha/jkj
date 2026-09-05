import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import type { LogEntry, LogKind } from '@jkj/shared';
import type { ClaudeHome } from './claude-home.js';
import { log } from '../util/logger.js';

/**
 * Reads Claude Code session transcripts.
 *
 * The files are JSONL, one record per line, and the record shape has drifted
 * across CLI versions. Every field is treated as optional and unknown record
 * types are skipped, so a newer or older CLI degrades to less detail rather
 * than an error.
 *
 * The project directory names are an encoding of the path with separators
 * replaced by dashes, which is not reversible — a directory called
 * `claude-dev` produces the same encoding as a nested `claude/dev`. So the
 * real path is always taken from the `cwd` field inside the records.
 */

export interface SessionSummary {
  sessionId: string;
  file: string;
  /** The directory the session ran in. Authoritative, read from records. */
  cwd: string;
  gitBranch: string;
  /** The title the CLI generated for the conversation, if it made one. */
  title: string | null;
  /** The most recent thing the user asked for. */
  lastPrompt: string | null;
  model: string | null;
  startedAt: string;
  endedAt: string;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
  /** True if any record was flagged as a subagent (sidechain) run. */
  hasSubagents: boolean;
}

export interface SessionDetail extends SessionSummary {
  entries: LogEntry[];
  /** Subagent runs found in this session, in the order they were spawned. */
  subagents: { id: string; name: string; task: string; entries: LogEntry[] }[];
  /**
   * Image bytes, keyed by the ref on the entry that shows them. Kept here and
   * served from their own route so transcripts stay small.
   */
  images: Map<string, { mediaType: string; data: Buffer }>;
}

/** Keep the transcript bounded — some sessions run to tens of thousands of lines. */
const MAX_ENTRIES = 500;

/* ---------- discovery ---------- */

export interface SessionFile {
  sessionId: string;
  file: string;
  /** The directory name under projects/. Opaque, but unique and stable. */
  projectKey: string;
  mtimeMs: number;
  size: number;
}

/** Every session file on disk, newest first. */
export function listSessionFiles(home: ClaudeHome): SessionFile[] {
  let dirs: string[];
  try {
    dirs = readdirSync(home.projectsDir);
  } catch {
    return [];
  }

  const files: SessionFile[] = [];
  for (const dir of dirs) {
    const projectDir = join(home.projectsDir, dir);
    let names: string[];
    try {
      names = readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = join(projectDir, name);
      try {
        const stat = statSync(file);
        files.push({
          sessionId: basename(name, '.jsonl'),
          file,
          projectKey: dir,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
      } catch {
        // A file can vanish between listing and stat. Skip it.
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/* ---------- parsing ---------- */

/** Parsed sessions are cached until the file changes underneath us. */
const cache = new Map<string, { mtimeMs: number; size: number; detail: SessionDetail }>();

export async function readSession(entry: SessionFile): Promise<SessionDetail | null> {
  const hit = cache.get(entry.file);
  if (hit && hit.mtimeMs === entry.mtimeMs && hit.size === entry.size) return hit.detail;

  const detail = await parseSession(entry);
  if (detail) cache.set(entry.file, { mtimeMs: entry.mtimeMs, size: entry.size, detail });
  return detail;
}

async function parseSession(file: SessionFile): Promise<SessionDetail | null> {
  const state = {
    cwd: '', gitBranch: '', title: null as string | null, lastPrompt: null as string | null,
    model: null as string | null, first: '', last: '',
    inputTokens: 0, outputTokens: 0, messageCount: 0,
  };
  const entries: LogEntry[] = [];
  const sidechain: LogEntry[] = [];
  const taskNames: { name: string; task: string }[] = [];
  const images = new Map<string, { mediaType: string; data: Buffer }>();

  try {
    const stream = createInterface({ input: createReadStream(file.file, { encoding: 'utf8' }), crlfDelay: Infinity });

    for await (const line of stream) {
      if (!line.trim()) continue;

      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;   // a partially written last line is normal on a live session
      }

      absorbMetadata(record, state);

      const produced = toEntries(record, file.sessionId, images);
      if (produced.length === 0) continue;

      state.messageCount += 1;
      const target = record['isSidechain'] === true ? sidechain : entries;
      target.push(...produced);
      if (target.length > MAX_ENTRIES * 2) target.splice(0, target.length - MAX_ENTRIES);

      for (const task of collectTasks(record)) taskNames.push(task);
    }
  } catch (err) {
    log.warn('sessions', `could not read ${file.file}: ${err instanceof Error ? err.message : err}`);
    return null;
  }

  if (!state.first) return null;   // no usable records

  return {
    sessionId: file.sessionId,
    file: file.file,
    cwd: state.cwd,
    gitBranch: state.gitBranch || 'unknown',
    title: state.title,
    lastPrompt: state.lastPrompt,
    model: state.model,
    startedAt: state.first,
    endedAt: state.last,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    messageCount: state.messageCount,
    hasSubagents: sidechain.length > 0,
    entries: entries.slice(-MAX_ENTRIES),
    subagents: groupSubagents(sidechain, taskNames),
    images,
  };
}

/** Pull the session-level facts that any record might carry. */
function absorbMetadata(record: Record<string, unknown>, state: {
  cwd: string; gitBranch: string; title: string | null; lastPrompt: string | null;
  model: string | null; first: string; last: string; inputTokens: number; outputTokens: number;
}): void {
  // The first cwd is where the session was launched, which is what the
  // project directory encodes. A session can cd elsewhere later; that must
  // not move it into a different project.
  const cwd = str(record['cwd']);
  if (cwd && !state.cwd) state.cwd = cwd;

  const branch = str(record['gitBranch']);
  if (branch) state.gitBranch = branch;

  const title = str(record['aiTitle']);
  if (title) state.title = title;

  const prompt = str(record['lastPrompt']);
  if (prompt) state.lastPrompt = prompt;

  const at = str(record['timestamp']);
  if (at) {
    if (!state.first) state.first = at;
    state.last = at;
  }

  const message = obj(record['message']);
  if (!message) return;

  const model = str(message['model']);
  if (model) state.model = model;

  const usage = obj(message['usage']);
  if (usage) {
    // Only genuinely new input. Cache reads are the same context re-sent every
    // turn, and cache writes repeat whenever the cache expires — summing
    // either reports tens of millions of tokens for an ordinary conversation.
    state.inputTokens += num(usage['input_tokens']);
    state.outputTokens += num(usage['output_tokens']);
  }
}

/** Which JKJ log kind a tool call belongs to. Unknown tools stay generic. */
function kindForTool(tool: string): LogKind {
  if (tool === 'Read' || tool === 'NotebookRead') return 'read';
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit' || tool === 'MultiEdit') return 'edit';
  if (tool === 'Bash' || tool === 'BashOutput') return 'bash';
  if (tool === 'Grep' || tool === 'Glob' || tool === 'WebSearch' || tool === 'WebFetch') return 'search';
  if (tool === 'Task' || tool === 'Agent') return 'task';
  return 'tool';
}

/** The one field of a tool's input worth showing on a single line. */
function describeToolInput(tool: string, input: Record<string, unknown>): string {
  const candidates = ['file_path', 'command', 'pattern', 'path', 'url', 'query', 'prompt', 'description', 'notebook_path'];
  for (const key of candidates) {
    const value = str(input[key]);
    if (value) return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  }
  const keys = Object.keys(input);
  return keys.length ? `${tool}(${keys.join(', ')})` : tool;
}

/** Turn one record into zero or more transcript entries. */
function toEntries(
  record: Record<string, unknown>,
  sessionId: string,
  images: Map<string, { mediaType: string; data: Buffer }>,
): LogEntry[] {
  const type = str(record['type']);
  if (type !== 'user' && type !== 'assistant') return [];
  if (record['isMeta'] === true) return [];

  const message = obj(record['message']);
  if (!message) return [];

  const at = str(record['timestamp']) ?? new Date().toISOString();
  const uuid = str(record['uuid']) ?? Math.random().toString(36).slice(2);
  const content = message['content'];
  const out: LogEntry[] = [];

  // Older records put a bare string here; newer ones use content blocks.
  if (typeof content === 'string') {
    const cleaned = type === 'user' ? cleanUserText(content) : { kind: 'user' as LogKind, text: content };
    if (cleaned && cleaned.text.trim()) {
      out.push(entry(`${uuid}:0`, sessionId, at,
        type === 'user' ? cleaned.kind : 'assistant', cleaned.label ?? '', cleaned.text));
    }
    return out;
  }

  if (!Array.isArray(content)) return out;

  content.forEach((raw, index) => {
    const block = obj(raw);
    if (!block) return;
    const id = `${uuid}:${index}`;

    switch (str(block['type'])) {
      case 'text': {
        const text = str(block['text']);
        if (!text?.trim()) break;

        if (type === 'assistant') {
          out.push(entry(id, sessionId, at, 'assistant', '', text));
          break;
        }
        const cleaned = cleanUserText(text);
        if (cleaned) out.push(entry(id, sessionId, at, cleaned.kind, cleaned.label ?? '', cleaned.text));
        break;
      }
      case 'tool_use': {
        const tool = str(block['name']) ?? 'tool';
        const input = obj(block['input']) ?? {};
        out.push(entry(id, sessionId, at, kindForTool(tool), tool, describeToolInput(tool, input)));
        break;
      }
      case 'image': {
        // Pasted images arrive as base64 in the record. Decode once, hand the
        // entry a reference, and let the image route serve the bytes.
        const source = obj(block['source']);
        const data = str(source?.['data']);
        if (!data) break;

        const mediaType = str(source?.['media_type']) ?? 'image/png';
        images.set(id, { mediaType, data: Buffer.from(data, 'base64') });

        const line = entry(id, sessionId, at, 'image', '', 'Pasted image');
        line.image = { mediaType, ref: id };
        out.push(line);
        break;
      }
      case 'tool_result': {
        // Results are only worth a line when something went wrong.
        if (block['is_error'] !== true) break;
        const text = typeof block['content'] === 'string' ? block['content'] : 'Tool call failed';
        out.push(entry(id, sessionId, at, 'error', 'Failed', firstLines(text, 3)));
        break;
      }
      default:
        break;   // thinking, images, and anything a future version adds
    }
  });

  return out;
}

/**
 * A "user" record is not always something a person typed. The CLI puts slash
 * commands, their output, injected reminders and background notifications in
 * the same place. Showing those verbatim buries the actual conversation, so
 * each is either reduced to one line or dropped.
 */
function cleanUserText(raw: string): { kind: LogKind; label?: string; text: string } | null {
  const text = raw.trim();

  const command = /^<command-name>([^<]+)<\/command-name>/.exec(text);
  if (command) return { kind: 'system', label: 'Command', text: command[1]!.trim() };

  // Command output, queued work and hook chatter are machinery, not dialogue.
  if (/^<(local-command-stdout|command-message|command-args|task-notification)>/.test(text)) return null;

  // Reminders are injected around what the person actually wrote.
  const withoutReminders = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!withoutReminders) return null;

  // Tool results the CLI feeds back in are already shown as their tool call.
  if (/^<(tool_use_error|function_results)>/.test(withoutReminders)) return null;

  return { kind: 'user', text: withoutReminders };
}

function collectTasks(record: Record<string, unknown>): { name: string; task: string }[] {
  const message = obj(record['message']);
  const content = message?.['content'];
  if (!Array.isArray(content)) return [];

  const found: { name: string; task: string }[] = [];
  for (const raw of content) {
    const block = obj(raw);
    if (!block || str(block['type']) !== 'tool_use') continue;
    const name = str(block['name']);
    if (name !== 'Task' && name !== 'Agent') continue;
    const input = obj(block['input']) ?? {};
    found.push({
      name: str(input['subagent_type']) ?? str(input['description']) ?? 'subagent',
      task: str(input['prompt']) ?? str(input['description']) ?? '',
    });
  }
  return found;
}

/**
 * Subagent records are flagged but not linked back to the Task call that
 * started them. They arrive in order, and a run begins with a record that has
 * no parent, so runs are split on that boundary and matched to Task calls by
 * position. If the counts disagree the extra runs are still shown, unnamed.
 */
function groupSubagents(
  sidechain: LogEntry[],
  tasks: { name: string; task: string }[],
): SessionDetail['subagents'] {
  if (sidechain.length === 0) return [];

  const runs: LogEntry[][] = [];
  let current: LogEntry[] = [];

  for (const line of sidechain) {
    // Entry ids are "<record uuid>:<block index>"; a new record with block 0
    // that follows a different record starts a new visual group.
    if (current.length > 0 && line.id.endsWith(':0') && runs.length + 1 <= tasks.length && isBoundary(current, line)) {
      runs.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length) runs.push(current);

  return runs.map((entries, i) => ({
    id: `sub_${i}`,
    name: tasks[i]?.name ?? `subagent ${i + 1}`,
    task: tasks[i]?.task ?? '',
    entries,
  }));
}

/** A run boundary: the next entry is a user turn after assistant output. */
function isBoundary(current: LogEntry[], next: LogEntry): boolean {
  return next.kind === 'user' && current.some(e => e.kind === 'assistant');
}

/* ---------- tiny helpers ---------- */

function entry(id: string, agentId: string, at: string, kind: LogKind, label: string, text: string): LogEntry {
  return { id, agentId, at, kind, label, text: text.trim() };
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const obj = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const firstLines = (text: string, count: number): string =>
  text.split('\n').slice(0, count).join('\n');
