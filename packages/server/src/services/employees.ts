import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Agent, Attachment, Employee, EmployeeCard, EmployeeState, Evidence, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import type { RunResult } from '../runtime/claude-agent.js';
import * as runs from './runs.js';
import * as work from './work.js';
import * as spend from './spend.js';
import * as inbox from './inbox.js';
import { assembleContext } from './context-layers.js';
import { writeEmployeeFile, readEmployeeFile, summarise, commitOrg } from './org.js';
import { now } from './store.js';
import { BadRequest } from '../util/errors.js';
import { log } from '../util/logger.js';

/**
 * Employees and their sessions (HLD D3, D4, D10).
 *
 * A session is one employee's run through the Agent SDK: the layered context
 * appended to Claude Code's prompt, the subscription token in the child env
 * and the API key absent from it, the role's tools and permission mode, the
 * remaining budget as the SDK's own stop, and the Workplace's tools served
 * in-process so the employee can report, ask and propose.
 */

interface Session {
  agentId: string;
  employeeId: string;
  assignmentId?: string;
  startedAt: string;
  /** Last cumulative usage seen per model, so each result is recorded as a delta. */
  seen: Record<string, { costUSD: number; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number }>;
  planCaptured: boolean;
}

const sessions = new Map<string, Session>();   // by agent id

export const WORKPLACE_TOOLS = ['report_status', 'write_handoff', 'report_done', 'ask_owner', 'request_review', 'propose_org_change', 'write_spec', 'decompose_feature'] as const;
const stateOverride = new Map<string, EmployeeState>();
const lastReport = new Map<string, string>();

export function openSession(employeeId: string): Session | undefined {
  return [...sessions.values()].find(s => s.employeeId === employeeId);
}

export function sessionsOf(employeeId: string): Session[] {
  return [...sessions.values()].filter(s => s.employeeId === employeeId);
}

export const allSessions = (): Session[] => [...sessions.values()];

export function employee(wp: Workplace, id: string): Employee {
  const e = wp.org.employees.find(x => x.id === id);
  if (!e) throw new BadRequest(`No employee ${id}`);
  return e;
}

/* ---------- spawning ---------- */

export interface SpawnOptions {
  assignment?: WorkItem;
  prompt: string;
  attachments?: Attachment[];
  /** Continue this SDK session instead of starting a fresh one. */
  resume?: string;
}

export function spawn(wp: Workplace, employeeId: string, options: SpawnOptions): Agent {
  const emp = employee(wp, employeeId);
  const budget = spend.canSpend(wp, employeeId);
  if (!budget.ok) throw new BadRequest(`${emp.name} is paused: the ${budget.scope} spend cap for today is reached. Raise it in the Inbox.`);
  if (sessionsOf(employeeId).length >= emp.budget.concurrentSessions) {
    throw new BadRequest(`${emp.name} already has ${emp.budget.concurrentSessions} session(s) open. End one first, or talk to the open one.`);
  }

  const role = wp.org.roles.find(r => r.id === emp.roleId);
  const context = assembleContext(wp.org, emp, { ...(options.assignment ? { assignment: options.assignment } : {}), maxTokens: wp.config.contextTokens });
  const remaining = spend.remainingUsd(wp, employeeId);

  const session: Session = { agentId: '', employeeId, ...(options.assignment ? { assignmentId: options.assignment.id } : {}), startedAt: now(), seen: {}, planCaptured: !!options.assignment?.plan };

  const agent = runs.createRunDirect({
    projectId: `employee:${employeeId}`,
    name: options.assignment ? options.assignment.title : `${emp.name}`,
    task: options.prompt,
    model: role?.model ?? 'sonnet',
    cwd: emp.workspace.worktree ?? emp.workspace.repo,
    workspace: emp.workspace.worktree ? 'worktree' : 'branch',
    prompt: options.prompt,
    permissionMode: role?.permissionMode ?? 'ask',
    ...(options.attachments ? { attachments: options.attachments } : {}),
    ...(options.resume ? { resume: options.resume } : {}),
    employeeId,
    ...(options.assignment ? { assignmentId: options.assignment.id } : {}),
    contextTokens: context.tokens,
    extra: {
      env: childEnv(wp),
      systemPromptAppend: context.append,
      settingSources: ['user', 'project'],
      // The Workplace's own tools are the reporting channel; they never prompt.
      allowedTools: [...WORKPLACE_TOOLS.map(t => `mcp__workplace__${t}`), ...(role?.tools.allowed ?? [])],
      ...(role?.tools.disallowed?.length ? { disallowedTools: role.tools.disallowed.map(t => t.startsWith('mcp__') || /^[A-Z]/.test(t) ? t : `mcp__workplace__${t}`) } : {}),
      maxBudgetUsd: Math.max(0.05, remaining),
      mcpServers: { workplace: workplaceTools(wp, employeeId, () => session) },
    },
    onResult: result => recordUsage(wp, session, result),
    onSessionId: sdkId => { if (session.assignmentId) work.setSession(wp, session.assignmentId, sdkId); },
  });

  session.agentId = agent.id;
  sessions.set(agent.id, session);
  setState(wp, employeeId, 'working');
  wp.db.prepare('insert into sessions (id, employee_id, assignment_id, started_at, status, context_tokens, json) values (?, ?, ?, ?, ?, ?, ?)')
    .run(agent.id, employeeId, session.assignmentId ?? null, session.startedAt, 'running', context.tokens, JSON.stringify({ truncated: context.truncated }));
  log.info('employees', `${emp.name} started ${agent.id} (${context.tokens} context tokens${context.truncated ? ', truncated' : ''})`);

  // Watch the transcript for the first "## Plan" reply.
  runs.onRunEvent(({ entry }) => {
    if (!entry || entry.agentId !== agent.id || entry.kind !== 'assistant' || session.planCaptured || !session.assignmentId) return;
    const plan = work.parsePlan(entry.text);
    if (!plan) return;
    session.planCaptured = true;
    try { work.attachPlan(wp, session.assignmentId, plan, employeeId); } catch (err) { log.warn('employees', String(err)); }
  });

  return agent;
}

/** The child gets the subscription token; the API key is absent, not blank. */
export function childEnv(wp: Workplace): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env['ANTHROPIC_API_KEY'];
  delete env['ANTHROPIC_AUTH_TOKEN'];
  const token = readOauthToken(wp);
  if (token) env['CLAUDE_CODE_OAUTH_TOKEN'] = token;
  env['IRIS_WORKPLACE'] = '1';
  return env;
}

export function readOauthToken(wp: Workplace): string | null {
  try {
    const text = readFileSync(join(wp.config.opsDir, 'workplace', 'claude-oauth.env'), 'utf8');
    const line = text.split('\n').find(l => l.startsWith('CLAUDE_CODE_OAUTH_TOKEN='));
    const value = line?.slice('CLAUDE_CODE_OAUTH_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
    return value || null;
  } catch {
    return null;
  }
}

/* ---------- talking, ending ---------- */

/** Continue the open session, or start one from the files. */
export function talk(wp: Workplace, employeeId: string, text: string, attachments: Attachment[] = []): Agent {
  const open = openSession(employeeId);
  if (open) {
    const budget = spend.canSpend(wp, employeeId);
    if (!budget.ok) throw new BadRequest(`${employee(wp, employeeId).name} is paused: the ${budget.scope} spend cap for today is reached. Raise it in the Inbox.`);
    runs.sendMessage(open.agentId, text, attachments);
    return runs.getRunAgent(open.agentId)!;
  }
  return spawn(wp, employeeId, { prompt: text, attachments });
}

/** Start the session for an assignment (the assignment block is the fifth layer). */
export function assign(wp: Workplace, assignmentId: string): Agent {
  const item = work.require$(wp, assignmentId);
  if (!item.employeeId) throw new BadRequest(`${assignmentId} has no assignee`);
  const open = openSession(item.employeeId);
  if (open) {
    runs.sendMessage(open.agentId, `New assignment ${item.id}: ${item.title}\n\n${item.body}\n\nReply with "## Plan" first.`);
    work.setSession(wp, assignmentId, runs.sessionIdOf(open.agentId) ?? open.agentId);
    return runs.getRunAgent(open.agentId)!;
  }
  return spawn(wp, item.employeeId, { assignment: item, prompt: `Take assignment ${item.id}: ${item.title}. Read your context and reply with "## Plan" first.` });
}

const HANDOFF_PROMPT =
  'This session is ending. Using the Workplace tools: call report_status with three lines (doing / done / blocked) ' +
  'and write_handoff with what the next session needs to continue. Then stop.';

/** Ask for the handoff, wait a bounded time, close. */
export async function endSession(wp: Workplace, agentId: string, waitMs = 150_000): Promise<void> {
  const session = sessions.get(agentId);
  if (!session) return;
  const agent = runs.getRunAgent(agentId);
  if (agent && (agent.status === 'running' || agent.status === 'waiting') && waitMs > 0) {
    // Subscribe before sending, so a turn that ends at once is not missed.
    const waiting = waitForHandoff(wp, session, waitMs);
    runs.sendMessage(agentId, HANDOFF_PROMPT);
    await waiting;
  }
  close(wp, agentId, 'ended');
}

/**
 * The handoff turn is done when the run reports the end of a turn (its
 * status leaves `running`), when the handoff file changed, or when the wait
 * runs out. Subscribed, not polled: a turn can finish between two polls.
 */
function waitForHandoff(wp: Workplace, session: Session, waitMs: number): Promise<void> {
  const before = readEmployeeFile(wp.org, session.employeeId, 'handoff.md');
  return new Promise(resolve => {
    let done = false;
    const finish = (): void => { if (done) return; done = true; clearInterval(timer); clearTimeout(limit); unsubscribe(); resolve(); };
    const unsubscribe = runs.onRunEvent(({ agent }) => {
      if (agent?.id === session.agentId && agent.status !== 'running') finish();
    });
    const timer = setInterval(() => {
      if (readEmployeeFile(wp.org, session.employeeId, 'handoff.md') !== before && runs.getRunAgent(session.agentId)?.status !== 'running') finish();
    }, 500);
    const limit = setTimeout(finish, waitMs);
  });
}

export function close(wp: Workplace, agentId: string, reason: string): void {
  const session = sessions.get(agentId);
  if (!session) return;
  runs.note(agentId, 'Session', `Closed by the Workplace: ${reason}.`);
  runs.closeRun(agentId);
  sessions.delete(agentId);
  wp.db.prepare('update sessions set ended_at = ?, status = ? where id = ?').run(now(), reason, agentId);
  // The memory is the files: a session's status and handoff are history too.
  const name = wp.org.employees.find(e => e.id === session.employeeId)?.name ?? session.employeeId;
  commitOrg(wp.org.dir, `${name}: session ${agentId} ${reason} (status and handoff)`);
  if (sessionsOf(session.employeeId).length === 0 && stateOverride.get(session.employeeId) === 'working') setState(wp, session.employeeId, 'idle');
}

/** Interrupt and pause every session in a spend scope. */
export function pauseScope(wp: Workplace, scope: string): void {
  for (const s of allSessions()) {
    if (!spend.scopesOf(wp, s.employeeId).includes(scope)) continue;
    runs.note(s.agentId, 'Paused', `The ${scope} spend cap for today is reached.`);
    void runs.interruptRun(s.agentId).catch(() => {});
    setState(wp, s.employeeId, 'paused');
  }
  for (const e of wp.org.employees) {
    if (spend.scopesOf(wp, e.id).includes(scope)) setState(wp, e.id, 'paused');
  }
}

export function unpauseAll(wp: Workplace): void {
  for (const e of wp.org.employees) {
    if (stateOverride.get(e.id) === 'paused') setState(wp, e.id, sessionsOf(e.id).length ? 'working' : 'idle');
  }
}

/* ---------- state and cards ---------- */

export function setState(wp: Workplace, employeeId: string, state: EmployeeState): void {
  stateOverride.set(employeeId, state);
  const e = wp.org.employees.find(x => x.id === employeeId);
  if (e) e.state = state;
  wp.emit({ type: 'office.updated', card: card(wp, employeeId) });
}

export function stateOf(wp: Workplace, employeeId: string): EmployeeState {
  const e = employee(wp, employeeId);
  const override = stateOverride.get(employeeId);
  if (override === 'paused') return 'paused';
  if (inbox.list(wp, 'open').some(i => i.raisedBy === employeeId)) return 'needs-owner';
  const open = openSession(employeeId);
  if (open) {
    const agent = runs.getRunAgent(open.agentId);
    if (agent?.status === 'waiting' && agent.approval) return 'needs-owner';
    if (agent?.status === 'error') return 'blocked';
    return 'working';
  }
  if (work.list(wp, { kind: 'assignment', employeeId, state: 'blocked' }).length > 0) return 'blocked';
  return override === 'working' ? 'idle' : override ?? e.state ?? 'idle';
}

export function card(wp: Workplace, employeeId: string): EmployeeCard {
  const e = employee(wp, employeeId);
  const open = openSession(employeeId);
  const active = new Set(['proposed', 'planned', 'building', 'review', 'blocked']);
  const current = work.list(wp, { kind: 'assignment', employeeId }).find(a => active.has(a.state)) ?? null;
  const status = readEmployeeFile(wp.org, employeeId, 'status.md').trim();
  return {
    employee: { ...e, state: stateOf(wp, employeeId) },
    charters: e.charterIds.map(id => wp.org.charters.get(id)).filter((c): c is NonNullable<typeof c> => !!c).map(summarise),
    currentWork: current,
    lastReport: lastReport.get(employeeId) ?? (status || null),
    session: open ? runs.getRunAgent(open.agentId) ?? null : null,
    spendTodayInr: spend.summary(wp).byEmployee[employeeId] ?? 0,
    needsYou: inbox.list(wp, 'open').filter(i => i.raisedBy === employeeId).length,
  };
}

/* ---------- usage ---------- */

function recordUsage(wp: Workplace, session: Session, result: RunResult): void {
  for (const [model, usage] of Object.entries(result.modelUsage)) {
    const prev = session.seen[model] ?? { costUSD: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
    const delta = {
      usd: Math.max(0, usage.costUSD - prev.costUSD),
      inputTokens: Math.max(0, usage.inputTokens - prev.inputTokens),
      outputTokens: Math.max(0, usage.outputTokens - prev.outputTokens),
      cacheReadTokens: Math.max(0, usage.cacheReadInputTokens - prev.cacheRead),
      cacheWriteTokens: Math.max(0, usage.cacheCreationInputTokens - prev.cacheWrite),
    };
    session.seen[model] = { costUSD: usage.costUSD, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheRead: usage.cacheReadInputTokens, cacheWrite: usage.cacheCreationInputTokens };
    if (delta.usd === 0 && delta.inputTokens === 0 && delta.outputTokens === 0) continue;
    spend.record(wp, { employeeId: session.employeeId, sessionId: session.agentId, model, ...delta });
  }
}

/* ---------- the Workplace's own tools, served in-process ---------- */

export function workplaceTools(wp: Workplace, employeeId: string, session: () => Session) {
  const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
  return createSdkMcpServer({
    name: 'workplace',
    version: '1.0.0',
    tools: [
      tool('report_status', 'Write your status file: three short lines, doing / done / blocked. Do this before you stop.',
        { doing: z.string(), done: z.string(), blocked: z.string() },
        async ({ doing, done, blocked }) => {
          const body = `doing: ${doing}\ndone: ${done}\nblocked: ${blocked}\n`;
          writeEmployeeFile(wp.org, employeeId, 'status.md', body);
          lastReport.set(employeeId, body.trim());
          wp.emit({ type: 'office.updated', card: card(wp, employeeId) });
          return ok('Status written.');
        }),
      tool('write_handoff', 'Write your handoff: what the next session needs to continue this work.',
        { handoff: z.string() },
        async ({ handoff }) => { writeEmployeeFile(wp.org, employeeId, 'handoff.md', `${handoff.trim()}\n`); return ok('Handoff written.'); }),
      tool('report_done', 'Report an assignment as done, with evidence. It goes to review; a verifier marks it done.',
        {
          assignmentId: z.string().optional(),
          testsPassed: z.number().int().min(0), testsFailed: z.number().int().min(0), testCommand: z.string().optional(),
          commits: z.array(z.string()), liveVerified: z.array(z.string()), notVerified: z.array(z.string()), notes: z.string().optional(),
        },
        async (args) => {
          const id = args.assignmentId ?? session().assignmentId;
          if (!id) return ok('No assignment is attached to this session; say what you did in your handoff instead.');
          const evidence: Evidence = { tests: { passed: args.testsPassed, failed: args.testsFailed, ...(args.testCommand ? { command: args.testCommand } : {}) }, commits: args.commits, liveVerified: args.liveVerified, notVerified: args.notVerified, ...(args.notes ? { notes: args.notes } : {}) };
          try {
            const item = work.reportDone(wp, id, evidence, employeeId);
            lastReport.set(employeeId, `Reported ${item.title}: ${evidence.tests.passed} passed / ${evidence.tests.failed} failed; ${evidence.commits.length} commits; live: ${evidence.liveVerified.join(', ') || 'none'}; not verified: ${evidence.notVerified.join(', ') || 'none'}`);
            return ok(`Recorded. ${item.id} is in review; it becomes done when a verifier confirms it.`);
          } catch (err) {
            return ok(`Not recorded: ${err instanceof Error ? err.message : String(err)}`);
          }
        }),
      tool('ask_owner', 'Raise a real decision to the owner\'s Inbox. Use it only for what the handbook says needs the owner.',
        { title: z.string(), body: z.string(), options: z.array(z.string()).optional() },
        async ({ title, body, options }) => {
          const item = inbox.raise(wp, { kind: 'decision', title, body, raisedBy: employeeId, ...(options?.length ? { options: options.map(o => ({ id: o.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label: o })) } : {}) });
          setState(wp, employeeId, 'needs-owner');
          return ok(`Filed as ${item.id}. Continue with other work; the answer arrives in your next session's context.`);
        }),
      tool('request_review', 'Ask the reviewer (your lead, or QA for a lead) to verify an assignment in review.',
        { assignmentId: z.string(), note: z.string().optional() },
        async ({ assignmentId, note }) => {
          const item = work.get(wp, assignmentId);
          if (!item) return ok(`No assignment ${assignmentId}.`);
          inbox.raise(wp, { kind: 'question', title: `Review requested: ${item.title}`, body: note ?? 'Please verify.', raisedBy: employeeId, context: { assignmentId }, dedupeKey: `review:${assignmentId}` });
          return ok('Review requested.');
        }),
      tool('write_spec', 'Chief of Staff only: attach the spec (acceptance criteria) to a stated feature. It becomes "specced" and can be decomposed.',
        { featureId: z.string(), spec: z.string() },
        async ({ featureId, spec }) => {
          const emp = employee(wp, employeeId);
          if (!emp.charterIds.includes('chief-of-staff') && emp.level !== 0) return ok('Only the Chief of Staff writes specs.');
          try {
            const item = work.get(wp, featureId);
            if (!item || item.kind !== 'feature') return ok(`No feature ${featureId}.`);
            const next = item.state === 'stated' ? work.transition(wp, featureId, { to: 'specced', by: employeeId, spec }) : work.attachSpec(wp, featureId, spec);
            return ok(`Spec attached; ${next.id} is ${next.state}. Call decompose_feature to route it through the ownership map, or leave that to the owner.`);
          } catch (err) {
            return ok(`Not attached: ${err instanceof Error ? err.message : String(err)}`);
          }
        }),
      tool('decompose_feature', 'Chief of Staff only: route a specced feature through the ownership map into one assignment per charter and start their sessions.',
        { featureId: z.string(), paths: z.array(z.string()).optional(), services: z.array(z.string()).optional() },
        async ({ featureId, paths, services }) => {
          const emp = employee(wp, employeeId);
          if (!emp.charterIds.includes('chief-of-staff') && emp.level !== 0) return ok('Only the Chief of Staff decomposes features.');
          try {
            const result = work.decompose(wp, featureId, { ...(paths ? { paths } : {}), ...(services ? { services } : {}) }, employeeId);
            const started: string[] = [];
            for (const a of result.assignments) {
              if (a.state !== 'proposed' || !a.employeeId || a.sessionId || a.employeeId === employeeId) continue;
              try { assign(wp, a.id); started.push(a.charterId ?? a.id); } catch (err) { work.transition(wp, a.id, { to: 'blocked', by: 'workplace', note: err instanceof Error ? err.message : String(err) }); }
            }
            const r = result.route;
            return ok(`Routed to ${r.primaries.map(h => h.charterId).join(', ')}${r.consulted.length ? ` (consult ${r.consulted.join(', ')})` : ''}; sessions started for ${started.join(', ') || 'nobody new'}.` + (r.unresolved.length ? ` Unresolved: ${r.unresolved.map(t => `${t.kind}:${t.key}`).join(', ')}.` : ''));
          } catch (err) {
            return ok(`Not decomposed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }),
      tool('propose_org_change', 'Propose a hire, split, merge, reassign or restructure with a reason. The owner approves it in the Inbox. `paramsJson` is a JSON object as a string (see the handbook for the shape of each kind).',
        // A z.record() here makes the MCP SDK fail to list ANY tool of this server; a JSON string does not.
        { kind: z.enum(['hire', 'retire', 'split', 'merge', 'reassign', 'restructure']), reason: z.string(), paramsJson: z.string() },
        async ({ kind, reason, paramsJson }) => {
          const emp = employee(wp, employeeId);
          if (emp.level === 2) return ok('Contractors cannot propose org changes; ask your lead.');
          let params: Record<string, unknown>;
          try { params = JSON.parse(paramsJson) as Record<string, unknown>; } catch { return ok('paramsJson is not valid JSON.'); }
          const proposals = await import('./proposals.js');
          try {
            const p = proposals.propose(wp, { kind, reason, params, proposedBy: employeeId });
            return ok(`Proposed as ${p.id}; the owner decides in the Inbox.`);
          } catch (err) {
            return ok(`Not proposed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }),
    ],
  });
}
