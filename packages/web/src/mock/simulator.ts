import type { Agent } from '@jkj/shared';
import { applyStep, type Step } from './fixtures.js';
import {
  addActivity, appendLog, getState, patchAgent, addAgent, makeEntry,
} from '../state/store.js';

/**
 * A stand-in for the server's event stream. Fabricated — see ./README.md.
 *
 * Every tick it advances one running agent by one scripted step, which is
 * roughly the cadence a real agent produces tool calls at. Delete this file
 * when the socket delivers real events.
 */

const TICK_MS = 2200;

export function startSimulator(pending: Record<string, Step[]>): () => void {
  const queues = new Map(Object.entries(pending).map(([id, steps]) => [id, [...steps]]));

  const timer = setInterval(() => {
    const state = getState();
    if (state.streamPaused) return;

    const running = state.agents.filter(a => a.status === 'running' && !a.parentAgentId);
    if (running.length === 0) return;

    const agent = running[Math.floor(Math.random() * running.length)]!;
    const queue = queues.get(agent.id);

    if (!queue || queue.length === 0) {
      finish(agent);
      return;
    }
    advance(agent, queue.shift()!);
  }, TICK_MS);

  return () => clearInterval(timer);
}

function advance(agent: Agent, step: Step): void {
  const state = getState();
  const agents = [...state.agents];
  const transcripts: Record<string, typeof state.transcripts[string]> = {};

  const { entry, subagent } = applyStep({
    agent, step, at: new Date().toISOString(), agents, transcripts,
  });

  if (subagent) {
    addAgent(subagent);
    // The subagent's transcript arrives complete; it ran to completion inline.
    for (const line of transcripts[subagent.id] ?? []) appendLog(line);
    addActivity(agent.projectId, 'started', `**${agent.name}** spawned subagent **${subagent.name}**`);
  }

  appendLog(entry);
  bumpUsage(agent);

  if (step.kind === 'error') {
    patchAgent(agent.id, { status: 'error' });
    addActivity(agent.projectId, 'failed', `**${agent.name}** hit a failure and is waiting on you`);
  }
}

function finish(agent: Agent): void {
  patchAgent(agent.id, { status: 'done', endedAt: new Date().toISOString() });
  appendLog(makeEntry(agent.id, 'assistant', '', 'Done. Branch pushed and ready for review.'));
  addActivity(agent.projectId, 'finished', `**${agent.name}** finished on \`${agent.cwd}\``);
}

function bumpUsage(agent: Agent): void {
  const input = agent.usage.inputTokens + 700 + Math.floor(Math.random() * 1800);
  const output = agent.usage.outputTokens + 120 + Math.floor(Math.random() * 600);
  patchAgent(agent.id, {
    usage: { inputTokens: input, outputTokens: output, costUsd: (input * 0.000003) + (output * 0.000015) },
  });
}

/** Give already-played steps a plausible usage number on first paint. */
export function seedUsage(agents: Agent[], transcripts: Record<string, unknown[]>): Agent[] {
  return agents.map(a => {
    const steps = (transcripts[a.id] ?? []).length;
    const input = steps * 1600;
    const output = steps * 380;
    return { ...a, usage: { inputTokens: input, outputTokens: output, costUsd: (input * 0.000003) + (output * 0.000015) } };
  });
}
