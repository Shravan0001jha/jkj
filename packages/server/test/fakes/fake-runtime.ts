import type { RunEvents, RunHandle, RunOptions, RunResult } from '../../src/runtime/claude-agent.js';
import { useRuntime } from '../../src/services/runs.js';

/**
 * A scripted session: records what the Workplace asked for and lets a test
 * emit text, tool calls and results as if the model had. No model, no spend.
 */

export interface FakeSession {
  options: RunOptions;
  events: RunEvents;
  sent: { text: string; images: number }[];
  interrupted: number;
  closed: boolean;
  sessionId: string;
  say(text: string): void;
  tool(name: string, input: Record<string, unknown>): void;
  result(partial?: Partial<RunResult> & { model?: string; costUsd?: number; inputTokens?: number; outputTokens?: number }): void;
  /** Cumulative cost so far, as the SDK reports it. */
  cumulativeUsd: number;
}

export interface FakeRuntime {
  sessions: FakeSession[];
  last(): FakeSession;
  /** Script that runs when a session starts (e.g. reply with a plan). */
  onStart?: (session: FakeSession) => void;
  restore(): void;
}

export function installFakeRuntime(): FakeRuntime {
  const runtime: FakeRuntime = {
    sessions: [],
    last: () => runtime.sessions.at(-1)!,
    restore: () => useRuntime(null),
  };

  useRuntime((options, events): RunHandle => {
    const session: FakeSession = {
      options,
      events,
      sent: [],
      interrupted: 0,
      closed: false,
      sessionId: `fake-${runtime.sessions.length + 1}`,
      cumulativeUsd: 0,
      say: text => events.onText(text),
      tool: (name, input) => events.onToolUse(name, input),
      result: partial => {
        const model = partial?.model ?? 'claude-sonnet-5';
        session.cumulativeUsd += partial?.costUsd ?? 0.01;
        const usage = { inputTokens: partial?.inputTokens ?? 1000, outputTokens: partial?.outputTokens ?? 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: session.cumulativeUsd };
        events.onUsage(usage.inputTokens, usage.outputTokens);
        events.onResult?.({ subtype: 'success', totalCostUsd: session.cumulativeUsd, numTurns: 1, modelUsage: { [model]: usage }, ...partial });
        events.onDone('success');
      },
    };
    runtime.sessions.push(session);
    queueMicrotask(() => {
      events.onSessionId(session.sessionId);
      runtime.onStart?.(session);
    });
    return {
      send: (text, images) => { session.sent.push({ text, images: images?.length ?? 0 }); },
      interrupt: async () => { session.interrupted += 1; },
      setMode: async () => {},
      close: () => { session.closed = true; },
    };
  });

  return runtime;
}
