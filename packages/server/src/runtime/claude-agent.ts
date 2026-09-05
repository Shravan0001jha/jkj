import type { Agent } from '@jkj/shared';

/**
 * The one place JKJ touches the Claude Agent SDK.
 *
 * Everything above this file speaks in domain types. Everything below it is
 * SDK-shaped. Keeping that boundary here means an SDK upgrade is a one-file
 * change, and tests can substitute a fake runtime.
 */

export interface RuntimeEvents {
  onText(text: string): void;
  onToolUse(tool: string, input: string): void;
  onPermissionRequest(tool: string, input: string, reason: string): void;
  onSubagentStart(name: string, task: string): void;
  onUsage(inputTokens: number, outputTokens: number): void;
  onDone(): void;
  onError(message: string): void;
}

export interface RuntimeHandle {
  /** Push a message from the user into the running turn. */
  send(text: string): void;
  /** Answer a pending permission request. */
  resolvePermission(decision: 'once' | 'always' | 'deny'): void;
  /** Abort the current turn. The worktree is left alone. */
  interrupt(): void;
}

/**
 * Start an agent run.
 *
 * TODO:
 *   - import { query } from '@anthropic-ai/claude-agent-sdk'
 *   - pass: cwd = agent.cwd, model = agent.model,
 *           systemPrompt = assembleContext(agent.projectId).text,
 *           mcpServers = the project's enabled servers,
 *           canUseTool = a callback that raises onPermissionRequest and
 *                        awaits the user's decision
 *   - iterate the async stream and translate each SDK message into the
 *     RuntimeEvents callbacks above
 */
export function startRun(agent: Agent, events: RuntimeEvents): RuntimeHandle {
  void agent;
  void events;

  return {
    send: () => { /* TODO: forward to the SDK input stream */ },
    resolvePermission: () => { /* TODO: resolve the pending canUseTool promise */ },
    interrupt: () => { /* TODO: abort the SDK query */ },
  };
}
