import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as employees from '../src/services/employees.js';
import { guardTool } from '../src/services/guards.js';
import { BACKGROUND_WORK } from '../src/services/context-layers.js';
import { installFakeRuntime } from './fakes/fake-runtime.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * Owner rule (17 Oct): long work (full suites, builds, long investigations) goes to a background
 * subagent or a background command, so the session stays free for messages, mentions and reviews.
 * Every existing restriction still holds inside that background work.
 */

const tick = () => new Promise(r => setTimeout(r, 5));

type HookOut = { hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string } };

async function session() {
  const { wp, tmp } = testWorkplace();
  const fake = installFakeRuntime();
  employees.talk(wp, 'mira', 'What are you on?');
  await tick();
  const s = fake.last();
  const matcher = s.options.hooks!.PreToolUse![0]!;
  const hook = matcher.hooks[0]!;
  const run = (tool: string, input: Record<string, unknown>, agentId?: string) => hook({
    hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: s.options.cwd,
    ...(agentId ? { agent_id: agentId, agent_type: 'general-purpose' } : {}),
  } as never, 't', { signal: new AbortController().signal }) as Promise<HookOut>;
  return { wp, s, matcher, run, done: () => { fake.restore(); tmp.cleanup(); } };
}

test('an employee session may start a subagent and stop or read background work without a prompt', async () => {
  const { s, done } = await session();
  try {
    const allowed = s.options.allowedTools!;
    for (const t of ['Agent', 'Task', 'TaskOutput', 'TaskStop']) assert.ok(allowed.includes(t), `${t} is allowed`);
    assert.ok(allowed.includes('Bash(npm test:*)'), 'a background `npm test` is the same allowed command');
  } finally { done(); }
});

test('subagents carry every forbidden tool, cannot nest, and keep the parent permission mode', async () => {
  const { s, done } = await session();
  try {
    const agents = s.options.agents!;
    assert.deepEqual(Object.keys(agents).sort(), ['Explore', 'general-purpose']);
    for (const [name, def] of Object.entries(agents)) {
      for (const f of s.options.disallowedTools!) assert.ok(def.disallowedTools!.includes(f), `${name} disallows ${f}`);
      assert.ok(def.disallowedTools!.includes('Agent') && def.disallowedTools!.includes('Task'), `${name} cannot start subagents`);
      assert.equal(def.permissionMode, undefined, `${name} inherits the session's mode`);
    }
    assert.ok(s.options.disallowedTools!.includes('Bash(git push:*)'));
  } finally { done(); }
});

test('the PreToolUse guard sees subagent starts and every subagent tool call', async () => {
  const { s, matcher, run, done } = await session();
  try {
    const re = new RegExp(`^(${matcher.matcher})$`);
    for (const t of ['Agent', 'Task', 'Bash', 'Edit', 'Write', 'Read']) assert.ok(re.test(t), `the guard hooks ${t}`);

    // Starting a subagent: only the Workplace's own types, never in another worktree or remotely.
    assert.equal((await run('Agent', { description: 'suite', prompt: 'npm test', run_in_background: true })).hookSpecificOutput, undefined);
    assert.equal((await run('Agent', { description: 'suite', prompt: 'x', subagent_type: 'general-purpose' })).hookSpecificOutput, undefined);
    assert.equal((await run('Task', { description: 'look', prompt: 'x', subagent_type: 'Explore' })).hookSpecificOutput, undefined);
    for (const input of [
      { isolation: 'worktree' }, { isolation: 'remote' }, { subagent_type: 'fork' }, { subagent_type: 'release-bot' },
    ]) {
      const out = await run('Agent', { description: 'd', prompt: 'p', ...input });
      assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(input));
    }

    // Inside a subagent (agent_id set) the same guards hold, background or not.
    for (const command of ['git push origin HEAD', 'ssh mac', 'aws s3 ls', 'gh pr list', 'scripts/deploy-api.sh', 'git worktree add /tmp/x']) {
      const out = await run('Bash', { command, run_in_background: true }, 'a1');
      assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', command);
    }
    assert.equal((await run('Bash', { command: 'npm test', run_in_background: true }, 'a1')).hookSpecificOutput, undefined);
    const outside = await run('Edit', { file_path: '/Users/someone/elsewhere/a.ts' }, 'a1');
    assert.match(outside.hookSpecificOutput!.permissionDecisionReason, /outside your worktree/);
    void s;
  } finally { done(); }
});

test('guardTool: a subagent start is judged (read-only pause still lets the session look)', () => {
  const ctx = { worktree: '/tmp/wt', repoId: 'iris', charterIds: ['experts'], map: [], mainCheckouts: ['/repo'] };
  assert.equal(guardTool('Agent', { description: 'd', prompt: 'p' }, ctx).decision, 'allow');
  assert.equal(guardTool('Agent', { description: 'd', prompt: 'p', isolation: 'worktree' }, ctx).decision, 'deny');
  assert.equal(guardTool('Agent', { description: 'd', prompt: 'p', subagent_type: 'Plan' }, ctx).decision, 'deny');
});

test('the session prompt says long work goes to the background', async () => {
  const { s, done } = await session();
  try {
    assert.match(BACKGROUND_WORK, /background subagent or a background command/);
    assert.match(BACKGROUND_WORK, /free for messages/);
    assert.ok(s.options.systemPromptAppend!.includes(BACKGROUND_WORK));
  } finally { done(); }
});
