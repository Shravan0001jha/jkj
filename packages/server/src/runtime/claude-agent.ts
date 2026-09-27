import {
  query,
  type HookCallbackMatcher, type HookEvent, type McpServerConfig, type Options, type PermissionMode as SdkPermissionMode,
  type PermissionResult, type PermissionUpdate, type Query, type SDKUserMessage, type SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode } from '@jkj/shared';

/**
 * The one place JKJ touches the Claude Agent SDK.
 *
 * Everything above this file speaks in domain types; everything below it is
 * SDK-shaped. Keeping the boundary here means an SDK upgrade is a one-file
 * change and tests can substitute a fake runtime.
 */

export interface PermissionRequest {
  tool: string;
  input: Record<string, unknown>;
  /** The sentence the CLI would show, when it offers one. */
  title: string;
  /** Rules that would stop this prompt returning. Empty when there are none. */
  suggestions: readonly unknown[];
}

/** JKJ's four modes, in the SDK's vocabulary. */
export const SDK_MODES: Record<PermissionMode, SdkPermissionMode> = {
  ask: 'default',
  auto: 'auto',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  dontAsk: 'bypassPermissions',
};

export interface RunEvents {
  /** Fires once the SDK has a session id, which is also its file on disk. */
  onSessionId(sessionId: string): void;
  onText(text: string): void;
  onToolUse(tool: string, input: Record<string, unknown>): void;
  /**
   * Resolve to let the tool run. 'always' also stops the session asking about
   * that tool again — the SDK hands us the rules that would achieve it.
   */
  onPermission(request: PermissionRequest): Promise<'allow' | 'always' | 'deny'>;
  onUsage(inputTokens: number, outputTokens: number): void;
  /** The SDK's init message: which MCP servers connected and how many tools exist. */
  onInit?(init: { mcpServers: string[]; workplaceTools: number; tools: number }): void;
  /** Lines the CLI process writes to stderr; the only place MCP start-up errors appear. */
  onStderr?(line: string): void;
  /** The subscription's own limit windows, as the CLI reports them. */
  onRateLimit?(info: { rateLimitType?: string; status: string; utilization?: number; resetsAt?: number }): void;
  /**
   * The end of a turn, with the SDK's cumulative accounting for the whole
   * query: per-model tokens and estimated cost. Cumulative, so callers diff.
   */
  onResult?(result: RunResult): void;
  onDone(summary: string): void;
  onError(message: string): void;
}

/** An image the model should look at, already decoded from the wire. */
export interface RunImage {
  mediaType: string;
  /** base64, without a data: prefix. */
  data: string;
}

export interface RunHandle {
  /** Queue a message for the running turn, or the next one. */
  send(text: string, images?: RunImage[]): void;
  /** Abort the current turn. Files already written stay written. */
  interrupt(): Promise<void>;
  /** Change how much the session asks. Rejects if the CLI refuses the mode. */
  setMode(mode: PermissionMode): Promise<void>;
  /** Stop the run and release the process. */
  close(): void;
}

export interface RunModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

export interface RunResult {
  subtype: string;
  totalCostUsd: number;
  numTurns: number;
  modelUsage: Record<string, RunModelUsage>;
}

export interface RunOptions {
  cwd: string;
  model: string;
  prompt: string;
  /** Images to send with the opening message. */
  images?: RunImage[];
  /** Continue an existing session by id rather than starting a new one. */
  resume?: string;
  permissionMode?: PermissionMode;
  /**
   * The child's environment. When given it REPLACES process.env, which is how
   * ANTHROPIC_API_KEY is kept out of an employee's process: the subscription
   * token is in, the key is simply absent.
   */
  env?: Record<string, string | undefined>;
  /** Text appended to Claude Code's own system prompt: the layered context. */
  systemPromptAppend?: string;
  /** Which settings files load. 'project' is needed for the repo's CLAUDE.md. */
  settingSources?: SettingSource[];
  allowedTools?: string[];
  disallowedTools?: string[];
  /** The SDK stops the query at this estimated cost. */
  maxBudgetUsd?: number;
  maxTurns?: number;
  /** In-process MCP servers: the Workplace's own tools for the employee. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Hooks run inside the CLI before/after tools: the Workplace's guards. */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
}

export function startRun(options: RunOptions, events: RunEvents): RunHandle {
  const input = createInputQueue();
  input.push(options.prompt, options.images);
  const abort = new AbortController();

  const sdkOptions: Options = {
    abortController: abort,
    cwd: options.cwd,
    model: options.model,
    permissionMode: SDK_MODES[options.permissionMode ?? 'ask'],
    // Makes "don't ask" selectable later without making it the default. The
    // CLI refuses to switch into it otherwise, which reads as a broken
    // control rather than the deliberate rail it is.
    allowDangerouslySkipPermissions: true,
    ...(options.resume ? { resume: options.resume } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.systemPromptAppend
      ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: options.systemPromptAppend } }
      : {}),
    ...(options.settingSources ? { settingSources: options.settingSources } : {}),
    ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
    ...(options.disallowedTools ? { disallowedTools: options.disallowedTools } : {}),
    ...(options.maxBudgetUsd !== undefined ? { maxBudgetUsd: options.maxBudgetUsd } : {}),
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
    stderr: (data: string) => { for (const line of data.split('\n')) if (line.trim()) events.onStderr?.(line); },

    // Every tool call routes through the browser unless the mode auto-allows.
    canUseTool: async (toolName, toolInput, meta): Promise<PermissionResult> => {
      const decision = await events.onPermission({
        tool: toolName,
        input: toolInput,
        // The CLI writes a proper sentence when it has one. Otherwise say
        // which of your things is about to be touched, not just the verb.
        title: meta.title ?? describeRequest(toolName, toolInput),
        suggestions: meta.suggestions ?? [],
      });

      if (decision === 'deny') return { behavior: 'deny', message: 'Denied from JKJ.' };

      return {
        behavior: 'allow',
        updatedInput: toolInput,
        // 'always' is the CLI's own suggestion applied: the rules it offers
        // are exactly the ones that stop this prompt coming back.
        ...(decision === 'always' && meta.suggestions?.length
          ? { updatedPermissions: meta.suggestions as PermissionUpdate[] }
          : {}),
      };
    },
  };

  const stream: Query = query({ prompt: input.iterable, options: sdkOptions });
  void consume(stream, events);

  return {
    send: (text, images) => input.push(text, images),
    interrupt: async () => {
      try {
        await stream.interrupt();
      } catch (err) {
        events.onError(describe(err));
      }
    },
    // Deliberately not swallowed: the CLI refuses some modes depending on how
    // it was launched, and a refusal the caller cannot see becomes a UI that
    // claims a mode it does not have.
    setMode: mode => stream.setPermissionMode(SDK_MODES[mode]),
    // Ending the input is not enough: a turn in flight would keep running
    // tools with nobody watching. Abort the query so the process stops.
    close: () => { input.end(); abort.abort(); },
  };
}

/** Translate the SDK's message stream into the events above. */
async function consume(stream: Query, events: RunEvents): Promise<void> {
  try {
    for await (const message of stream) {
      switch (message.type) {
        case 'system':
          if ('session_id' in message && message.session_id) events.onSessionId(message.session_id);
          if ('subtype' in message && message.subtype === 'init') {
            const init = message as unknown as { mcp_servers?: { name: string; status: string }[]; tools?: string[] };
            events.onInit?.({
              mcpServers: (init.mcp_servers ?? []).map(s => `${s.name}:${s.status}`),
              workplaceTools: (init.tools ?? []).filter(t => t.startsWith('mcp__workplace__')).length,
              tools: (init.tools ?? []).length,
            });
          }
          break;

        case 'assistant': {
          for (const block of message.message.content) {
            if (block.type === 'text' && block.text.trim()) {
              events.onText(block.text);
            } else if (block.type === 'tool_use') {
              events.onToolUse(block.name, (block.input ?? {}) as Record<string, unknown>);
            }
          }
          const usage = message.message.usage;
          if (usage) events.onUsage(usage.input_tokens ?? 0, usage.output_tokens ?? 0);
          break;
        }

        case 'result': {
          // The end of a turn, not the end of the session. With streaming
          // input the query keeps running and waits for the next message —
          // returning here would make every session answer exactly once.
          const usage = message.modelUsage ?? {};
          events.onResult?.({
            subtype: String(message.subtype),
            totalCostUsd: message.total_cost_usd ?? 0,
            numTurns: message.num_turns ?? 0,
            modelUsage: Object.fromEntries(Object.entries(usage).map(([model, u]) => [model, {
              inputTokens: u.inputTokens ?? 0,
              outputTokens: u.outputTokens ?? 0,
              cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
              cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
              costUSD: u.costUSD ?? 0,
            }])),
          });
          events.onDone(String(message.subtype));
          break;
        }

        case 'rate_limit_event': {
          const info = (message as { rate_limit_info?: { status: string; rateLimitType?: string; utilization?: number; resetsAt?: number } }).rate_limit_info;
          if (info) events.onRateLimit?.(info);
          break;
        }

        default:
          break;   // partials, hooks, progress: nothing the transcript needs
      }
    }
    events.onDone('done');
  } catch (err) {
    events.onError(describe(err));
  }
}

/**
 * Streaming input is an async iterable the SDK pulls from, so follow-up
 * messages need somewhere to wait. This is a queue with one reader: push
 * hands a waiting reader its value, or parks the value until one arrives.
 */
function createInputQueue() {
  const pending: SDKUserMessage[] = [];
  let notify: (() => void) | null = null;
  let done = false;

  const iterable = (async function* (): AsyncGenerator<SDKUserMessage> {
    while (!done) {
      if (pending.length === 0) {
        await new Promise<void>(resolve => { notify = resolve; });
        continue;
      }
      yield pending.shift()!;
    }
  })();

  return {
    iterable,
    push(text: string, images?: RunImage[]): void {
      // With no images the plain string form is what the CLI itself sends;
      // content blocks are only used when there is something to attach.
      const content = images?.length
        ? [
            ...images.map(image => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: image.mediaType, data: image.data },
            })),
            { type: 'text' as const, text },
          ]
        : text;

      pending.push({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: '',
        origin: { kind: 'human' },
      } as SDKUserMessage);
      notify?.();
      notify = null;
    },
    end(): void {
      done = true;
      notify?.();
      notify = null;
    },
  };
}

/** A readable sentence for a permission prompt the CLI did not phrase. */
function describeRequest(tool: string, input: Record<string, unknown>): string {
  const path = typeof input['file_path'] === 'string' ? input['file_path'] : null;
  const command = typeof input['command'] === 'string' ? input['command'] : null;

  if (tool === 'Bash' && command) return `Run a command in your shell: ${truncate(command)}`;
  if (path) return `${tool} wants to touch ${path}`;
  return `${tool} wants to run on your machine`;
}

const truncate = (text: string): string => (text.length > 120 ? `${text.slice(0, 120)}…` : text);

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
