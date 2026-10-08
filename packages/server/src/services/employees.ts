import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Agent, Attachment, Employee, EmployeeCard, EmployeeState, Evidence, Item, WorkItem } from '@jkj/shared';
import type { Workplace } from './workplace.js';
import type { RunResult } from '../runtime/claude-agent.js';
import * as runs from './runs.js';
import * as floor from './floor.js';
import * as work from './work.js';
import * as githubFlow from './github-flow.js';
import * as evidenceRuns from './evidence.js';
import * as spend from './spend.js';
import * as inbox from './inbox.js';
import { assembleContext } from './context-layers.js';
import { changedFiles, commitsSince, uncommittedFiles, ensureWorktree, isMainCheckout, WorktreeSwitchError, type Worktree } from './worktrees.js';
import { guardTool, type GuardContext } from './guards.js';
import { resolve as resolveOwner } from './ownership.js';
import * as stall from './stall.js';
import * as room from './room.js';
import * as coo from './coo.js';
import * as items from './items.js';
import * as trail from './trail.js';
import * as watch from './watch.js';
import * as statusAnswers from './status.js';
import * as readTools from './read-tools.js';
// The owner's Inbox replies reach the asker durably (HLD D23, LLD §19.14); the module wires itself.
import './reply-delivery.js';
import { chiefOfStaffId, isWaitable, nameOf, rawGet } from './v2-map.js';
import { writeEmployeeFile, readEmployeeFile, summarise, commitOrg } from './org.js';
import { humanizeIds } from './id-names.js';
import { now } from './store.js';
import * as talkStore from './talk-store.js';
import { BadRequest } from '../util/errors.js';
import { log } from '../util/logger.js';
import { QA_DOC_FORMAT as qaDocFormat } from './qa-doc.js';

/**
 * Employees and their sessions (HLD D3, D4, D10).
 *
 * A session is one employee's run through the Agent SDK: the layered context
 * appended to Claude Code's prompt, the subscription token in the child env
 * and the API key absent from it, the role's tools and permission mode, the
 * remaining budget as the SDK's own stop, and the Workplace's tools served
 * in-process so the employee can report, ask and propose.
 */

export interface Session {
  agentId: string;
  employeeId: string;
  assignmentId?: string;
  worktree?: Worktree;
  unsubscribe?: () => void;
  /** A probe or verification session: never writes the employee's status or handoff. */
  probe?: boolean;
  /** Started by the owner talking (web, phone, Telegram): runs past any cap, tagged in spend. */
  ownerTalk?: boolean;
  guard?: GuardContext;
  startedAt: string;
  /** Last cumulative usage seen per model, so each result is recorded as a delta. */
  seen: Record<string, { costUSD: number; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number }>;
  planCaptured: boolean;
}

const sessions = new Map<string, Session>();   // by agent id

/** How much an owner-talk turn may spend past the cap, ₹ equivalent. */
export const OWNER_TALK_TURN_INR = 100;

/** The owner saying, in a talk, that paused work may go on. */
/** An SDK result that means the session's runaway budget is spent: no later turn in it can run. */
export function hitSessionBudget(subtype: string): boolean {
  return subtype === 'error_max_budget_usd';
}

export const CONTINUE_PHRASE = /\b(go ahead|continue|carry on|resume|proceed|keep going|keep working)\b/i;

export const WORKPLACE_TOOLS = ['report_status', 'write_handoff', 'report_done', 'ask_owner', 'request_review', 'propose_org_change', 'write_spec', 'decompose_feature', 'record_spend', 'room_post', 'room_read', 'room_resolve', 'escalate', 'item_create', 'item_update', 'item_comment', 'flag_stall', 'item_handback', 'inbox_reply', 'status_of', 'item_read', 'inbox_read', 'review_approve', 'review_send_back', 'review_dispute', 'send_file', 'run_evidence'] as const;

/**
 * What never asks, whatever the mode: reading, searching, the code graph,
 * and the commands the charters name for building and testing. Everything
 * outward still goes through the Workplace's gates, not through a prompt.
 */
/** Never, whatever the mode: the branch, the remotes and the release path are not the employee's. */
export const FORBIDDEN_TOOLS = [
  'Bash(git push:*)', 'Bash(git rebase:*)', 'Bash(git reset --hard:*)', 'Bash(git filter-repo:*)',
  'Bash(git worktree:*)', 'Bash(git remote:*)', 'Bash(ssh:*)', 'Bash(scp:*)', 'Bash(aws:*)', 'Bash(gh:*)', 'Bash(sudo:*)',
  'Bash(scripts/release-iris.sh:*)', 'Bash(scripts/release-iris-x64.sh:*)', 'Bash(scripts/deploy-api.sh:*)', 'Bash(scripts/deploy-agent.sh:*)', 'Bash(scripts/deploy-web.sh:*)',
];

export const FREE_TOOLS = [
  'Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'mcp__travsr__*', 'mcp__prior__prior_recall',
  'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git branch:*)', 'Bash(git show:*)', 'Bash(git worktree list:*)',
  // The PreToolUse guard (guards.ts) narrows this to merging the trunk into the employee's own branch.
  'Bash(git merge:*)', 'Bash(git merge-base:*)',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(find:*)', 'Bash(grep:*)', 'Bash(rg:*)', 'Bash(pwd)',
  'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(node --test:*)', 'Bash(../../.venv/bin/python -m pytest:*)', 'Bash(.venv/bin/python -m pytest:*)', 'Bash(python3 -m pytest:*)', 'Bash(pytest:*)',
];
const stateOverride = new Map<string, EmployeeState>();
const lastReport = new Map<string, string>();

export function openSession(employeeId: string): Session | undefined {
  return [...sessions.values()].find(s => s.employeeId === employeeId && isLive(s.agentId));
}

/** A run that is live work: running, or waiting between turns / for an approval. */
export function isLive(agentId: string): boolean {
  const a = runs.getRunAgent(agentId);
  return !!a && (a.status === 'running' || a.status === 'waiting');
}

/** A run the owner can still talk into: live, or interrupted and sitting idle (not errored, not gone). */
export function continuableSession(employeeId: string): Session | undefined {
  return [...sessions.values()].find(s => {
    if (s.employeeId !== employeeId) return false;
    const a = runs.getRunAgent(s.agentId);
    return !!a && a.status !== 'error';
  });
}

export const STALE_MS = 10 * 60_000;

/**
 * Sessions whose run is dead (interrupted and never resumed, errored, or gone) are closed once
 * they have been dead for ten minutes, so the employee's state is true and the next assignment
 * gets a fresh session instead of being pushed into a dead one (QA B4: Kabir "working" 30 h on).
 */
export function closeStale(wp: Workplace, nowMs = Date.now()): string[] {
  const closed: string[] = [];
  for (const s of allSessions()) {
    const a = runs.getRunAgent(s.agentId);
    if (a && (a.status === 'running' || a.status === 'waiting')) continue;
    const idle = runs.idleMs(s.agentId, nowMs);
    if (a && idle !== null && idle < STALE_MS) continue;
    close(wp, s.agentId, a ? `stale (${a.status} for ${Math.round((idle ?? 0) / 60_000)} min)` : 'stale (no run)', { redeliver: true });
    closed.push(s.agentId);
  }
  return closed;
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
  /**
   * A probe (a verification question, a smoke test): the session gets no handoff prompt at the
   * end and its status/handoff tools refuse to write. A probe once overwrote Asha's real
   * handoff with "this session did no substantive work" (27 Sep).
   */
  probe?: boolean;
  /** The owner is talking: the session runs even at a cap (read-only on paused work until "continue"). */
  ownerTalk?: boolean;
  /** Who wrote the prompt (docs/LLD-app-fixes.md §1). Default: 'owner' for owner talk, else 'workplace'. */
  from?: string;
  /** The Talk message the prompt is. */
  talkId?: string;
}

export function spawn(wp: Workplace, employeeId: string, options: SpawnOptions): Agent {
  const emp = employee(wp, employeeId);
  if (emp.virtual) throw new BadRequest(`${emp.name} is not spawned by the Workplace; reach it through the COO bridge (POST /api/coo/message).`);
  const budget = spend.canSpend(wp, employeeId);
  if (!budget.ok && !options.ownerTalk) throw new BadRequest(`${emp.name} is paused: the ${budget.scope} spend cap for today is reached. Raise it in the Inbox, or talk to ${emp.name} and say "continue".`);
  // "Pause all": nothing unattended starts; the owner's and the COO's own talk still does.
  if (!options.ownerTalk && floor.paused(wp)) throw new BadRequest(`${emp.name} was not started: ${floor.describe(wp)}.`);
  closeDead(wp, employeeId);
  if (sessionsOf(employeeId).length >= emp.budget.concurrentSessions) {
    throw new BadRequest(`${emp.name} already has ${emp.budget.concurrentSessions} session(s) open. End one first, or talk to the open one.`);
  }

  const role = wp.org.roles.find(r => r.id === emp.roleId);
  // Its own worktree, cut from the base branch: never the owner's checkout.
  const worktree = ensureWorktree(wp.config.workDir, emp, options.assignment?.id ?? null);
  if (isMainCheckout(wp.org, worktree.path)) throw new BadRequest(`Refusing to run ${emp.name} in a main checkout (${worktree.path}).`);
  const repoId = wp.org.repos.find(r => r.root === emp.workspace.repo)?.id ?? 'iris';
  const guard: GuardContext = {
    worktree: worktree.path, repoId, charterIds: emp.charterIds,
    // Read live, so POST /api/coo/reload-org reaches running sessions too (5 Oct).
    get map() { return wp.org.map; },
    mainCheckouts: wp.org.repos.map(r => r.root),
    ...(coo.liveWindowUntil(wp, employeeId) ? { liveWindowUntil: coo.liveWindowUntil(wp, employeeId)! } : {}),
    ...(!budget.ok ? { readOnly: `${emp.name} is paused by the ${budget.scope} spend cap: read and answer, but do not edit or run commands until the owner says "continue" in this talk` } : {}),
  };
  const context = assembleContext(wp.org, emp, { ...(options.assignment ? { assignment: options.assignment } : {}), maxTokens: wp.config.contextTokens, worktree: worktree.path, ownedPaths: ownedPaths(wp, emp, repoId), room: room.contextFor(wp, employeeId) });
  const remaining = spend.remainingUsd(wp, employeeId);
  // Talk a dead session took and never acted on rides in this session's first message.
  const carried = carryOver.get(employeeId) ?? [];
  carryOver.delete(employeeId);
  const prompt = carried.length ? `${options.prompt}\n\n${redeliveryText(carried)}` : options.prompt;

  const session: Session = { agentId: '', employeeId, ...(options.assignment ? { assignmentId: options.assignment.id } : {}), worktree, guard, startedAt: now(), seen: {}, planCaptured: !!options.assignment?.plan, ...(options.probe ? { probe: true } : {}), ...(options.ownerTalk ? { ownerTalk: true } : {}) };

  const agent = runs.createRunDirect({
    projectId: `employee:${employeeId}`,
    name: options.assignment ? options.assignment.title : `${emp.name}`,
    task: options.prompt,
    model: role?.model ?? 'sonnet',
    cwd: worktree.path,
    workspace: 'worktree',
    prompt,
    permissionMode: role?.permissionMode ?? 'ask',
    ...(options.attachments ? { attachments: options.attachments } : {}),
    ...(options.resume ? { resume: options.resume } : {}),
    // Only the owner's own Talk is the owner's words; everything else the Workplace sends (HLD D22).
    promptFrom: options.from ?? (options.ownerTalk ? 'owner' : 'workplace'),
    ...(options.talkId ? { promptTalkId: options.talkId } : {}),
    employeeId,
    ...(options.assignment ? { assignmentId: options.assignment.id } : {}),
    contextTokens: context.tokens,
    extra: {
      env: childEnv(wp, employeeId),
      systemPromptAppend: context.append,
      settingSources: ['user', 'project'],
      // The Workplace's own tools are the reporting channel; they never prompt.
      allowedTools: [...WORKPLACE_TOOLS.map(t => `mcp__workplace__${t}`), ...FREE_TOOLS, ...(role?.tools.allowed ?? [])],
      disallowedTools: [...FORBIDDEN_TOOLS, ...(role?.tools.disallowed ?? []).map(t => t.startsWith('mcp__') || /^[A-Z]/.test(t) ? t : `mcp__workplace__${t}`)],
      hooks: {
        PreToolUse: [{
          matcher: 'Read|Edit|Write|MultiEdit|NotebookEdit|Bash',
          hooks: [async input => {
            const i = input as { tool_name: string; tool_input: Record<string, unknown> };
            const d = guardTool(i.tool_name, i.tool_input ?? {}, guard);
            return d.decision === 'allow'
              ? { continue: true }
              : { continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: `Workplace guard: ${d.reason}` } };
          }],
        }],
      },
      // An owner-talk turn at the cap still needs room to answer: one turn's worth.
      // Subscription turns are free (the ₹ budget is real money only), so the SDK stop is a runaway
      // guard per session, never the employee's daily ₹ budget.
      maxBudgetUsd: Math.max(options.ownerTalk ? OWNER_TALK_TURN_INR / wp.config.usdInr : 0.05, remaining, wp.config.sessionRunawayUsd),
      mcpServers: { workplace: workplaceTools(wp, employeeId, () => session) },
    },
    onResult: result => {
      recordUsage(wp, session, result);
      // The SDK's runaway stop counts the whole resumed conversation, so once hit every later turn
      // stops at once and the employee sits stuck (Dev, Nikhil, 6 Oct). End the session: the
      // dispatcher resumes the assignment in a fresh one from the branch and the last handoff.
      // No handoff turn: a capped session cannot run one (it would only wait out the timeout).
      if (hitSessionBudget(result.subtype)) {
        log.warn('employees', `${emp.name}: ${agent.id} hit the session budget stop; ending it so the work restarts fresh`);
        setImmediate(() => { endSession(wp, agent.id, 0).catch(err => log.warn('employees', `end ${agent.id} after budget stop: ${err instanceof Error ? err.message : err}`)); });
      }
    },
    onRateLimit: info => spend.recordRateLimit(wp, info),
    onSessionId: sdkId => {
      if (session.assignmentId) work.setSession(wp, session.assignmentId, sdkId);
      // On the row at once: a crash before the next run event must still know which conversation to resume.
      if (session.agentId) { try { wp.db.prepare('update sessions set sdk_session_id = ? where id = ?').run(sdkId, session.agentId); } catch { /* db closed */ } }
    },
  });

  session.agentId = agent.id;
  sessions.set(agent.id, session);
  setState(wp, employeeId, 'working');
  wp.db.prepare('insert into sessions (id, employee_id, assignment_id, started_at, status, context_tokens, json) values (?, ?, ?, ?, ?, ?, ?)')
    .run(agent.id, employeeId, session.assignmentId ?? null, session.startedAt, 'running', context.tokens, JSON.stringify({ truncated: context.truncated, ...(options.probe ? { probe: true } : {}) }));
  log.info('employees', `${emp.name} started ${agent.id} (${context.tokens} context tokens${context.truncated ? ', truncated' : ''})`);

  // Watch the transcript for the first "## Plan" reply, and keep the row current so a restart
  // knows what the session was doing and what it was waiting for.
  const unsubscribe = runs.onRunEvent(({ entry, agent: updated }) => {
    if (updated?.id === agent.id) {
      try {
        wp.db.prepare('update sessions set sdk_session_id = ?, status = ?, json = ? where id = ?').run(
          runs.sessionIdOf(agent.id) ?? null, updated.status,
          // session.worktree: an open session moved onto a new assignment's branch (moveSession) records that branch.
          JSON.stringify({ truncated: context.truncated, cwd: (session.worktree ?? worktree).path, branch: (session.worktree ?? worktree).branch, prompt: options.prompt.slice(0, 500), pending: updated.approval ?? null, permissionMode: updated.permissionMode, ...(options.probe ? { probe: true } : {}) }),
          agent.id);
      } catch (err) {
        log.warn('employees', `could not record ${agent.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (!entry || entry.agentId !== agent.id || entry.kind !== 'assistant' || session.planCaptured || !session.assignmentId) return;
    const plan = work.parsePlan(entry.text);
    if (!plan) return;
    session.planCaptured = true;
    try { work.attachPlan(wp, session.assignmentId, plan, employeeId); } catch (err) { log.warn('employees', String(err)); }
  });
  session.unsubscribe = unsubscribe;

  return agent;
}

/**
 * POST /api/coo/live-window just opened (or changed) for `employeeId`: a session already running
 * picks it up at once, the same way a lifted spend-cap pause does, rather than only on its next spawn.
 */
export function refreshLiveWindow(_wp: Workplace, employeeId: string, untilMs: number | null): void {
  for (const s of sessionsOf(employeeId)) if (s.guard) s.guard.liveWindowUntil = untilMs ?? undefined;
}

/** A denial goes back to the raiser as a reason to act on: into its session, else into its handoff. */
export function deliverDenial(wp: Workplace, employeeId: string, title: string, note: string | undefined): void {
  const text = `The owner denied "${title}"${note ? `: ${note}` : ''}. Act on it: change the plan, or ask again with what is different.`;
  const open = openSession(employeeId);
  if (open) { runs.sendMessage(open.agentId, text, [], { from: 'workplace' }); return; }
  const current = readEmployeeFile(wp.org, employeeId, 'handoff.md').trimEnd();
  writeEmployeeFile(wp.org, employeeId, 'handoff.md', `${current}\n\n## Denied: ${title}\n${note ? `Reason: ${note}\n` : ''}${text}\n`);
}

/** The map's path keys this employee's charters own, in its repo, as relative paths. */
export function ownedPaths(wp: Workplace, emp: Employee, repoId: string): string[] {
  return wp.org.map
    .filter(m => m.kind === 'path' && emp.charterIds.includes(m.primary) && m.key.startsWith(`${repoId}:`))
    .map(m => m.key.slice(repoId.length + 1).replace(/\/+$/, '') || '(whole repo)')
    .sort();
}

/** Files changed on the branch that no charter of the employee owns. Empty is the only acceptable answer. */
export function foreignChanges(wp: Workplace, emp: Employee, worktree: Worktree): string[] {
  const repoId = wp.org.repos.find(r => r.root === worktree.repo)?.id ?? 'iris';
  return changedFiles(worktree.path, worktree.base).filter(f => {
    const owner = resolveOwner(wp.org.map, { kind: 'path', key: `${repoId}:${f}` });
    // A contributor charter may change the path too (map.yaml): Dev's conversation fix in agent-svc/app.py, 5 Oct.
    return !owner || !(emp.charterIds.includes(owner.primary) || owner.contributors.some(c => emp.charterIds.includes(c)));
  });
}

/** The child gets the subscription token; the API key is absent, not blank. */
export function childEnv(wp: Workplace, employeeId?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env['ANTHROPIC_API_KEY'];
  delete env['ANTHROPIC_AUTH_TOKEN'];
  const token = readOauthToken(wp);
  if (token) env['CLAUDE_CODE_OAUTH_TOKEN'] = token;
  env['IRIS_WORKPLACE'] = '1';
  // Who is running: scripts/pre-pr.sh records it as "run by <id>" (dry run #11: it showed the owner's git email).
  if (employeeId) env['WORKPLACE_EMPLOYEE'] = employeeId; else delete env['WORKPLACE_EMPLOYEE'];
  // The toolchains scripts/pre-pr.sh needs (Android SDK, JDK 17, full Xcode, not the CLI tools).
  env['ANDROID_HOME'] = wp.config.evidence.androidHome;
  env['JAVA_HOME'] = wp.config.evidence.javaHome;
  env['DEVELOPER_DIR'] = wp.config.evidence.developerDir;
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
/**
 * The owner talking to an employee (web, phone, Telegram). Always runs, even at a cap: the cap
 * protects the shared subscription from unattended work, not the owner from his staff. At a cap
 * the talk is read-only on the paused work until the owner explicitly says "continue", which
 * lifts that employee's pause for the day and resumes its work; that is his approval, recorded.
 * `autonomous: true` is for the Workplace's own use of talk (the Chief of Staff's spec), which
 * stays under the cap.
 */
export function talk(wp: Workplace, employeeId: string, text: string, attachments: Attachment[] = [], opts: { probe?: boolean; autonomous?: boolean; from?: string; talkId?: string } = {}): Agent {
  if (employee(wp, employeeId).virtual) throw new BadRequest(`${employee(wp, employeeId).name} is reached through POST /api/coo/message, not Talk.`);
  const ownerTalk = !opts.autonomous;
  // RCA (owner, 4 Oct: messages shown as his that he never sent): every non-autonomous caller was
  // recorded as the owner, the COO's talk included. The sender is now passed in, never inferred.
  const from = opts.from ?? (ownerTalk ? 'owner' : 'workplace');
  // Only the owner's own "continue" lifts a cap pause.
  if (ownerTalk && from === 'owner') maybeLiftPause(wp, employeeId, text);
  // The owner may carry on an interrupted session; autonomous work goes only to a live one (QA B4).
  const open = ownerTalk ? continuableSession(employeeId) : openSession(employeeId);
  if (open) {
    const budget = spend.canSpend(wp, employeeId);
    if (!budget.ok && !ownerTalk) throw new BadRequest(`${employee(wp, employeeId).name} is paused: the ${budget.scope} spend cap for today is reached. Raise it in the Inbox.`);
    if (ownerTalk) open.ownerTalk = true;
    runs.sendMessage(open.agentId, text, attachments, { from, ...(opts.talkId ? { talkId: opts.talkId } : {}) });
    return runs.getRunAgent(open.agentId)!;
  }
  // RCA (6 Oct, Rohan): a mention to someone whose story session had died spawned a talk session on
  // the general branch, which auto-saved and parked the story; he said "resuming now" from the wrong
  // branch and the story sat sessionless. Work in progress comes first: resume it, then deliver.
  // Mentions arrive as autonomous probes (mentions.ts), so skipping every probe skipped every mention
  // (Kabir, 7 Oct: a mention put him on emp/kabir/general and parked his story). Only a true probe,
  // the owner's verification question, stays out of the story.
  const resumed = opts.probe && !opts.autonomous ? undefined : resumeInProgress(wp, employeeId);
  if (resumed) {
    runs.sendMessage(resumed.id, text, attachments, { from, ...(opts.talkId ? { talkId: opts.talkId } : {}) });
    return resumed;
  }
  return spawn(wp, employeeId, { prompt: text, attachments, from, ...(opts.talkId ? { talkId: opts.talkId } : {}), ...(opts.probe ? { probe: true } : {}), ...(ownerTalk ? { ownerTalk: true } : {}) });
}

/** The employee's in-progress assignment restarted in its own session (on its branch), if there is one to resume. */
function resumeInProgress(wp: Workplace, employeeId: string): Agent | undefined {
  if (floor.paused(wp)) return undefined;
  const item = work.list(wp, { kind: 'assignment', employeeId }).find(a => a.status === 'in-progress');
  if (!item) return undefined;
  try { return assign(wp, item.id); } catch (err) {
    log.warn('employees', `talk: could not resume ${item.id} for ${employeeId}: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}

/** "Go ahead and continue" to a cap-paused employee: lift the pause for today, unlock the session, resume the work. */
function maybeLiftPause(wp: Workplace, employeeId: string, text: string): void {
  const budget = spend.canSpend(wp, employeeId);
  if (budget.ok || !CONTINUE_PHRASE.test(text)) return;
  const day = spend.dayOf();
  const scope = `employee:${employeeId}`;
  spend.liftPause(wp, scope, day, 'owner-talk');
  const emp = employee(wp, employeeId);
  for (const s of sessionsOf(employeeId)) {
    if (s.guard?.readOnly) { delete s.guard.readOnly; runs.note(s.agentId, 'Resumed', `The owner lifted ${emp.name}'s pause for today ("${text.slice(0, 60)}"); edits and commands are allowed again.`); }
  }
  setState(wp, employeeId, sessionsOf(employeeId).length ? 'working' : 'idle');
  const active = new Set(['planned', 'building', 'proposed']);
  // Backlog is parked: nothing automatic starts it (HLD D19).
  const item = work.list(wp, { kind: 'assignment', employeeId }).find(a => active.has(a.state) && a.status !== 'backlog');
  if (item && !openSession(employeeId)) {
    try { assign(wp, item.id); } catch (err) { log.warn('employees', `resume after lift: ${err instanceof Error ? err.message : err}`); }
  } else if (item && openSession(employeeId)) {
    runs.sendMessage(openSession(employeeId)!.agentId, `The owner says to continue. Resume assignment ${item.id}: ${item.title}. Work only in your worktree; report_done with evidence when done.`, [], { from: 'workplace' });
  }
  log.info('employees', `${emp.name}'s pause lifted for ${day} by the owner in talk`);
}

/** Start the session for an assignment (the assignment block is the fifth layer). */
export function assign(wp: Workplace, assignmentId: string): Agent {
  if (floor.paused(wp)) throw new BadRequest(`${assignmentId} was not started: ${floor.describe(wp)}.`);
  const agent = assignSession(wp, assignmentId);
  // v2: a session on a Ready/Backlog item means it is in progress now (a "Started" line).
  try { items.markStarted(wp, assignmentId, 'workplace'); } catch (err) { log.warn('employees', `mark started ${assignmentId}: ${err instanceof Error ? err.message : err}`); }
  return agent;
}

function assignSession(wp: Workplace, assignmentId: string): Agent {
  try {
    return startSession(wp, assignmentId);
  } catch (err) {
    // The worktree could not be put on this assignment's branch: block it with the reason,
    // never run it on another item's branch (2 Oct: Dev built a P0 on a parked item's branch).
    if (err instanceof WorktreeSwitchError) blockOnSwitch(wp, assignmentId, err);
    throw err;
  }
}

function startSession(wp: Workplace, assignmentId: string): Agent {
  const item = work.require$(wp, assignmentId);
  if (!item.employeeId) throw new BadRequest(`${assignmentId} has no assignee`);
  if (item.employeeId === 'owner') throw new BadRequest(`${assignmentId} is the owner's own item; nobody is started on it.`);
  // A dead session (interrupted, errored) is closed first, whatever its age: work goes to a live one.
  closeDead(wp, item.employeeId);
  const open = openSession(item.employeeId);
  // Dry run #17: a story assigned to the Chief of Staff is hers to route, not to build. Org design
  // (owner, 7 Oct): she also authors work (the product doc, the batch sign-off); a story with a
  // reviewer is work she delivers for someone to check, so it gets the author's prompt, not routing.
  const routing = isChiefOfStaff(wp, item.employeeId) && !item.reviewerId;
  if (open && carryOver.has(item.employeeId)) {
    const carried = carryOver.get(item.employeeId)!;
    runs.sendMessage(open.agentId, redeliveryText(carried), [], { from: carried[0]!.from });
    carryOver.delete(item.employeeId);
  }
  if (open) {
    // The open session takes the assignment, but on the assignment's branch (live 2 Oct: Dev began a
    // new story in his talk session's emp/dev/general, cut before that day's merge). Between turns the
    // worktree is switched now (auto-saving any uncommitted work, as at spawn); mid-turn, the switch
    // and the message wait for the end of that turn, so nothing is built on the old branch meanwhile.
    const prompt = routing ? routePrompt(item) : `New assignment ${item.id}: ${item.title}\n\n${item.body}\n\nReply with "## Plan" first.`;
    if (midTurn(open.agentId)) {
      queueSwitch(wp, open.agentId, item.id, prompt);
      return runs.getRunAgent(open.agentId)!;
    }
    handOver(wp, open, item, prompt);
    return runs.getRunAgent(open.agentId)!;
  }
  if (routing) return spawn(wp, item.employeeId, { assignment: item, prompt: routePrompt(item) });
  if (item.state === 'planned' || item.state === 'building') {
    // The plan exists (it is in the assignment layer): this session builds.
    const started = item.state === 'planned' ? work.transition(wp, item.id, { to: 'building', by: item.employeeId }) : item;
    return spawn(wp, item.employeeId, {
      assignment: started,
      prompt: `Build assignment ${item.id}: ${item.title}. Your plan is attached in your context; follow it. ` +
        'Work only in your worktree on your own branch, change only the paths your charters own, run the tests the charter names, ' +
        'commit on your branch (never push, merge or rebase), then call the Workplace tool report_done with the real test counts, ' +
        'the commit hashes, what you verified live and what you did not. If something outside your charter is needed, say so and ask_owner or stop.',
    });
  }
  return spawn(wp, item.employeeId, { assignment: item, prompt: `Take assignment ${item.id}: ${item.title}. Read your context and reply with "## Plan" first.` });
}

/** The Chief of Staff (role `chief-of-staff`, or the charter holder): she routes work, she does not build it. */
export function isChiefOfStaff(wp: Workplace, employeeId: string): boolean {
  return wp.org.employees.find(e => e.id === employeeId)?.roleId === 'chief-of-staff' || employeeId === chiefOfStaffId(wp);
}

export function routePrompt(item: WorkItem): string {
  return `Route this: assign it to the right developer by the ownership map. ${item.id}: ${item.title}\n\n${item.body ?? ''}\n\n` +
    'Read it (item_read), find the owning charter for what it changes, then item_update it with assigneeId set to that developer and say why in one line with item_comment. ' +
    'Do not plan or build it yourself.';
}

/**
 * The story a tool call means when it names none: the one whose branch (emp/<id>/<story>) is checked out
 * in the session's worktree, else the session's assignment. Mira (5 Oct) worked a second story on its own
 * branch while her session still pointed at the first, and three run_evidence calls landed on the first.
 */
export function currentStory(s: { assignmentId?: string; worktree?: Worktree; employeeId: string }): string | undefined {
  try {
    if (s.worktree?.path) {
      const branch = execFileSync('git', ['-C', s.worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const m = new RegExp(`^emp/${s.employeeId}/(as_[a-z0-9]+)$`).exec(branch);
      if (m) return m[1];
    }
  } catch { /* fall back to the assignment */ }
  return s.assignmentId;
}

/** A turn is running, or parked on a tool approval: not the moment to move the tree under it. */
/**
 * Point the author's open session back at `itemId` with `prompt` (a send-back). RCA (8 Oct): the
 * send-back message went into whatever story the open session was on (Ira had moved to the next
 * story), so it was read in the wrong worktree and twice never acted on. Same rules as a new
 * assignment: switched now between turns, queued until the turn ends mid-turn. Returns false when the
 * open session is already on the item (or there is none), so the caller just delivers the message.
 */
export function redirectTo(wp: Workplace, itemId: string, prompt: string): boolean {
  const item = work.require$(wp, itemId);
  if (!item.employeeId) return false;
  const open = openSession(item.employeeId);
  if (!open || open.assignmentId === itemId) return false;
  if (midTurn(open.agentId)) queueSwitch(wp, open.agentId, itemId, prompt);
  else handOver(wp, open, item, prompt);
  return true;
}

function midTurn(agentId: string): boolean {
  const a = runs.getRunAgent(agentId);
  return !a || a.status === 'running' || !!a.approval;
}

/**
 * Put an open session's worktree on the assignment's branch (`ensureWorktree`: auto-save, then switch;
 * WorktreeSwitchError when it cannot) and make the session that assignment's: the session row records
 * the new branch and assignment.
 */
function moveSession(wp: Workplace, session: Session, item: WorkItem): void {
  const wt = ensureWorktree(wp.config.workDir, employee(wp, session.employeeId), item.id);
  session.worktree = wt;
  session.assignmentId = item.id;
  session.planCaptured = !!item.plan;
  if (session.guard) session.guard.worktree = wt.path;
  wp.db.prepare("update sessions set assignment_id = ?, json = json_set(json, '$.branch', ?, '$.cwd', ?) where id = ?").run(item.id, wt.branch, wt.path, session.agentId);
  log.info('employees', `${session.employeeId}: open session ${session.agentId} moved to ${wt.branch} for ${item.id}`);
}

/** Switch, then send the assignment into the session. Throws WorktreeSwitchError (nothing sent). */
function handOver(wp: Workplace, session: Session, item: WorkItem, prompt: string): void {
  moveSession(wp, session, item);
  runs.sendMessage(session.agentId, prompt, [], { from: 'workplace' });
  work.setSession(wp, item.id, runs.sessionIdOf(session.agentId) ?? session.agentId);
}

/** Assignments waiting for an open session's turn to end, per agent id, oldest first. */
const pendingSwitch = new Map<string, { wp: Workplace; assignmentId: string; prompt: string }[]>();

function queueSwitch(wp: Workplace, agentId: string, assignmentId: string, prompt: string): void {
  const q = pendingSwitch.get(agentId) ?? [];
  if (!q.some(x => x.assignmentId === assignmentId)) q.push({ wp, assignmentId, prompt });
  pendingSwitch.set(agentId, q);
  log.info('employees', `${assignmentId}: queued for the end of ${agentId}'s turn (worktree switch, then the assignment)`);
}

/** Blocked with the reason, never run on another branch (as assignSession does at spawn). */
function blockOnSwitch(wp: Workplace, assignmentId: string, err: WorktreeSwitchError): void {
  const item = work.get(wp, assignmentId);
  if (item && item.state !== 'blocked' && item.state !== 'done' && item.state !== 'rejected') work.transition(wp, assignmentId, { to: 'blocked', by: 'workplace', note: err.message });
  log.error('employees', `${assignmentId} blocked: ${err.message}`);
}

/** A running or waiting session of this employee is on the item, or has it queued for its turn's end. */
export function sessionOn(employeeId: string, itemId: string): boolean {
  return sessionsOf(employeeId).some(s => isLive(s.agentId) && (s.assignmentId === itemId || (pendingSwitch.get(s.agentId) ?? []).some(x => x.assignmentId === itemId)));
}

/** An assignment is waiting for the end of this session's turn (the dispatcher counts that as busy). */
export const hasPendingSwitch = (agentId: string): boolean => (pendingSwitch.get(agentId)?.length ?? 0) > 0;

/** The turn ended: switch to the first queued assignment and send it (the next one waits for the turn after). */
export function drainSwitch(agentId: string): string | null {
  const q = pendingSwitch.get(agentId);
  const next = q?.shift();
  if (!q?.length) pendingSwitch.delete(agentId);
  const session = sessions.get(agentId);
  if (!next || !session) return null;
  const { wp, assignmentId, prompt } = next;
  const item = work.get(wp, assignmentId);
  if (!item || item.employeeId !== session.employeeId || item.state === 'done' || item.state === 'rejected') return null;
  try { handOver(wp, session, item, prompt); return assignmentId; } catch (err) {
    if (err instanceof WorktreeSwitchError) blockOnSwitch(wp, assignmentId, err);
    else log.warn('employees', `${assignmentId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

runs.onRunEvent(({ agent }) => {
  if (!agent || !pendingSwitch.has(agent.id) || agent.status !== 'waiting' || agent.approval) return;
  const id = agent.id;
  // While the floor is paused a queued assignment waits (the dispatcher picks it up after the resume).
  setImmediate(() => { const q = pendingSwitch.get(id)?.[0]; if (!midTurn(id) && !(q && floor.paused(q.wp))) drainSwitch(id); });
});

const HANDOFF_PROMPT =
  'This session is ending. Using the Workplace tools: call report_status with three lines (doing / done / blocked) ' +
  'and write_handoff with what the next session needs to continue. Your current status and handoff are in your ' +
  'context: keep everything in them that is still true and add what changed; never replace real work with ' +
  '"nothing done". Then stop.';

/** Ask for the handoff, wait a bounded time, close. */
export async function endSession(wp: Workplace, agentId: string, waitMs = 150_000, evenIfIdle = false, opts: CloseOptions = {}): Promise<void> {
  const session = sessions.get(agentId);
  if (!session) return;
  const agent = runs.getRunAgent(agentId);
  if (session.probe) { close(wp, agentId, 'probe ended'); return; }
  if (agent && (agent.status === 'running' || agent.status === 'waiting' || (evenIfIdle && agent.status === 'idle')) && waitMs > 0) {
    // Subscribe before sending, so a turn that ends at once is not missed.
    const waiting = waitForHandoff(wp, session, waitMs);
    runs.sendMessage(agentId, HANDOFF_PROMPT, [], { from: 'workplace' });
    await waiting;
  }
  close(wp, agentId, 'ended', opts);
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
    // A turn that ends with no model output since the prompt is not the handoff turn: it is the result
    // of a turn interrupted just before (4 Oct: that stale result closed Asha's session 8 ms after
    // the handoff prompt, with no handoff written).
    let answered = false;
    const unsubscribe = runs.onRunEvent(({ agent, entry }) => {
      if (entry?.agentId === session.agentId && OUTPUT_KINDS.has(entry.kind)) answered = true;
      if (agent?.id === session.agentId && (agent.status === 'error' || (agent.status !== 'running' && answered))) finish();
    });
    const timer = setInterval(() => {
      if (readEmployeeFile(wp.org, session.employeeId, 'handoff.md') !== before && runs.getRunAgent(session.agentId)?.status !== 'running') finish();
    }, 500);
    const limit = setTimeout(finish, waitMs);
  });
}

/** Told after a session closes (the reviewer's queue starts its next review then; review-wake.ts). */
type ClosedListener = (wp: Workplace, session: Session, reason: string) => void;
const closedListeners = new Set<ClosedListener>();
export function onSessionClosed(fn: ClosedListener): () => void {
  closedListeners.add(fn);
  return () => void closedListeners.delete(fn);
}

export interface CloseOptions {
  /**
   * Deliver again, in a new session, the owner's/COO's talk this session took and did not finish
   * acting on. For the closes nobody asked for (a stall, a stale or dead run); never for a shutdown
   * (the talk resumes on boot), the owner's own end-session, or test cleanup.
   */
  redeliver?: boolean;
}

export function close(wp: Workplace, agentId: string, reason: string, opts: CloseOptions = {}): void {
  const session = sessions.get(agentId);
  if (!session) return;
  const undelivered = opts.redeliver && !session.probe && reason !== 'shutdown' ? runs.unanswered(agentId) : [];
  // An orderly shutdown loses a pending decision as surely as a crash does: report it the same way,
  // and leave a machine-written note in the handoff so the work the model did is not forgotten
  // (Asha's spec session was shut down with no handoff on 27 Sep and her files stayed empty).
  if (reason === 'shutdown') {
    const run = runs.getRunAgent(agentId);
    // A talk/review session (no assignment) cut off mid-turn resumes on the next boot (QA, 2 Oct).
    if (!session.assignmentId && !session.probe && run && (run.status === 'running' || run.approval)) markTalkForResume(wp, agentId, session.employeeId, runs.sessionIdOf(agentId) ?? null);
    reportInterrupted(wp, session, run?.approval ?? null, 'shut down');
    if (!session.probe) appendShutdownNote(wp, session);
  }
  runs.note(agentId, 'Session', `Closed by the Workplace: ${reason}.`);
  runs.closeRun(agentId);
  session.unsubscribe?.();
  sessions.delete(agentId);
  wp.db.prepare('update sessions set ended_at = ?, status = ? where id = ?').run(now(), reason, agentId);
  // The memory is the files: a session's status and handoff are history too.
  const name = wp.org.employees.find(e => e.id === session.employeeId)?.name ?? session.employeeId;
  commitOrg(wp.org.dir, `${name}: session ${agentId} ${reason} (status and handoff)`);
  if (sessionsOf(session.employeeId).length === 0 && stateOverride.get(session.employeeId) === 'working') setState(wp, session.employeeId, 'idle');
  // Assignments queued for this session's turn end start in a session of their own (never on a shutdown).
  const queued = pendingSwitch.get(agentId) ?? [];
  pendingSwitch.delete(agentId);
  if (reason !== 'shutdown') {
    for (const q of queued) { try { assign(wp, q.assignmentId); } catch (err) { log.warn('employees', `${q.assignmentId}: ${err instanceof Error ? err.message : err}`); } }
  }
  if (undelivered.length) redeliver(wp, session.employeeId, undelivered);
  for (const fn of closedListeners) { try { fn(wp, session, reason); } catch (err) { log.warn('employees', `session-closed listener: ${err instanceof Error ? err.message : err}`); } }
}

const OUTPUT_KINDS = new Set(['assistant', 'read', 'edit', 'bash', 'search', 'task', 'tool']);

/* ---------- talk that must not be lost ---------- */

const REDELIVERED = 'Delivered again:';
/** Talk taken from dead sessions, for the next session this employee starts. */
const carryOver = new Map<string, runs.Unanswered[]>();

function redeliveryText(msgs: runs.Unanswered[]): string {
  return [
    `${REDELIVERED} your last session ended before you finished acting on ${msgs.length === 1 ? 'this message' : 'these messages'}. Act on ${msgs.length === 1 ? 'it' : 'them'} now.`,
    ...msgs.map(m => `(sent ${m.at.slice(11, 16)} UTC) ${m.text}`),
  ].join('\n\n');
}

/** Close this employee's dead sessions; what they had not acted on waits in carryOver for the next session. */
function closeDead(wp: Workplace, employeeId: string): void {
  for (const s of sessionsOf(employeeId)) {
    if (isLive(s.agentId)) continue;
    const msgs = s.probe ? [] : runs.unanswered(s.agentId);
    close(wp, s.agentId, 'replaced: the run was dead');
    if (msgs.length) carryOver.set(employeeId, [...(carryOver.get(employeeId) ?? []), ...msgs]);
  }
}

/** Start (or reach) a session with the lost talk. A message already delivered again once goes to the COO, not round again. */
function redeliver(wp: Workplace, employeeId: string, msgs: runs.Unanswered[]): void {
  const name = wp.org.employees.find(e => e.id === employeeId)?.name ?? employeeId;
  const tell = (list: runs.Unanswered[], why: string): void => {
    coo.notifyStall(wp, { itemId: '', by: 'workplace', title: `${name}: a talk message was not delivered`, body: `${why}\n\n${list.map(m => m.text).join('\n\n').slice(0, 1500)}` });
    log.warn('employees', `${name}: ${list.length} talk message(s) not delivered: ${why}`);
  };
  const again = msgs.filter(m => m.text.startsWith(REDELIVERED));
  const fresh = msgs.filter(m => !m.text.startsWith(REDELIVERED));
  if (again.length) tell(again, `Delivered again once and the session ended again before acting on it. Send it again yourself if it still stands.`);
  // One message per sender, so each stays attributed to whoever sent it (owner, COO).
  for (const from of [...new Set(fresh.map(m => m.from))]) {
    const mine = fresh.filter(m => m.from === from);
    try {
      talk(wp, employeeId, redeliveryText(mine), [], { from });
      log.info('employees', `${name}: delivered ${mine.length} talk message(s) from ${from} again`);
    } catch (err) {
      tell(mine, `The session ended before acting on it and a new one could not start: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** Interrupt and pause every session in a spend scope. */
export function pauseScope(wp: Workplace, scope: string): void {
  for (const s of allSessions()) {
    if (!spend.scopesOf(wp, s.employeeId).includes(scope)) continue;
    runs.note(s.agentId, 'Paused', scope === 'weekly-pace'
      ? "Today's share of the weekly usage limit is used; unattended work resumes on the next pace day."
      : `The ${scope} spend cap for today is reached.`);
    void runs.interruptRun(s.agentId).catch(() => {});
    setState(wp, s.employeeId, 'paused');
  }
  for (const e of wp.org.employees) {
    if (spend.scopesOf(wp, e.id).includes(scope)) setState(wp, e.id, 'paused');
  }
}

/** The usage ceiling: interrupt every running unattended turn (the owner's and the COO's talk is not touched). Returns how many. */
export function interruptUnattended(wp: Workplace, note: string): number {
  let n = 0;
  for (const s of allSessions()) {
    const a = runs.getRunAgent(s.agentId);
    if (!a || a.status !== 'running' || s.ownerTalk) continue;
    runs.note(s.agentId, 'Paused', note);
    void runs.interruptRun(s.agentId).catch(() => {});
    n += 1;
  }
  return n;
}

export function unpauseAll(wp: Workplace): void {
  for (const e of wp.org.employees) {
    if (stateOverride.get(e.id) === 'paused') setState(wp, e.id, sessionsOf(e.id).length ? 'working' : 'idle');
  }
}

/** Close every open session (shutdown, tests). */
export function closeAll(wp: Workplace, reason = 'shutdown'): void {
  for (const s of allSessions()) close(wp, s.agentId, reason);
}

function appendShutdownNote(wp: Workplace, s: Session): void {
  const entries = runs.getRunTranscript(s.agentId) ?? [];
  const said = entries.filter(e => e.kind === 'assistant');
  const tools = entries.filter(e => ['edit', 'bash', 'tool', 'read', 'search'].includes(e.kind));
  if (said.length === 0 && tools.length === 0) return;
  const last = said.at(-1)?.text.replace(/\s+/g, ' ').slice(0, 300) ?? '';
  const edits = entries.filter(e => e.kind === 'edit').map(e => e.text).slice(-5);
  const note = [
    '',
    `## Shut down by the Workplace at ${now()} (session ${s.agentId}${s.assignmentId ? `, assignment ${s.assignmentId}` : ''})`,
    'No handoff could be asked for. What the transcript shows:',
    `- ${said.length} replies, ${tools.length} tool calls${edits.length ? `; last edits: ${edits.join(', ')}` : ''}`,
    last ? `- last reply: ${last}` : '',
    '',
  ].filter(l => l !== undefined).join('\n');
  writeEmployeeFile(wp.org, s.employeeId, 'handoff.md', readEmployeeFile(wp.org, s.employeeId, 'handoff.md').trimEnd() + note);
}

/**
 * A session that ended without finishing its work: block the assignment with the reason, and ask
 * the owner when it was waiting for a decision. Used by shutdown and by recovery after a crash.
 */
function reportInterrupted(wp: Workplace, s: { agentId: string; employeeId: string; assignmentId?: string }, pending: { tool: string; input: string } | null, how: string): void {
  const name = wp.org.employees.find(e => e.id === s.employeeId)?.name ?? s.employeeId;
  if (s.assignmentId) markForResume(wp, s.assignmentId, s.agentId, `Session ${s.agentId} was ${how} by the Workplace${pending ? ` while waiting for approval of ${pending.tool}` : ''}; it resumes on the next boot from the branch and the handoff`);
  if (pending) {
    inbox.raise(wp, {
      kind: 'question',
      title: `${name} lost a pending approval (${how}): ${pending.tool}`,
      body: `The Workplace ${how} while ${name} was waiting for approval of ${pending.tool}: ${pending.input.slice(0, 300)}\n\nAnswer with what ${name} should do next, or start the assignment again.`,
      raisedBy: s.employeeId,
      context: { lostSession: s.agentId, assignmentId: s.assignmentId ?? null, pending },
      dedupeKey: `lost:${s.agentId}`,
    });
  }
}

/**
 * A building assignment whose session the Workplace itself ended (a shutdown, a restart, a crash).
 * QA 2 Oct: this used to move the item to Blocked, and the boot moved it straight back — every
 * restart posted a Blocked and an Unblocked line per story, seconds apart. A restart is not a
 * transition of the work: the status stays as it is, the interruption is a note on the item's
 * activity, and a `resume:<id>` marker tells the next boot to start it again.
 */
const RESUME_KEY = (id: string): string => `resume:${id}`;

/** The assignment states a restart may interrupt and the boot restarts. */
const RESUMABLE = new Set(['planned', 'building', 'proposed']);

function markForResume(wp: Workplace, assignmentId: string, sessionId: string, note: string): void {
  try {
    const item = work.get(wp, assignmentId);
    // Any active state, not only 'building': a story whose plan was posted ('planned') was dropped by
    // a restart and sat sessionless until hygiene (Neel, B9, 7 Oct).
    if (!item || !RESUMABLE.has(item.state)) return;
    wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(RESUME_KEY(assignmentId), sessionId);
    trail.record(wp, { itemId: assignmentId, by: 'workplace', kind: 'note', text: note });
  } catch (err) { log.warn('employees', String(err)); }
}

/**
 * A talk or review session (no assignment) the Workplace cut off mid-turn: `resume-talk:<sessionId>`
 * = its employee and SDK session id, so the boot continues that same conversation. A talk whose turn
 * had finished, or that ended normally, is never marked.
 */
const TALK_KEY = 'resume-talk:';

function markTalkForResume(wp: Workplace, sessionId: string, employeeId: string, sdkSessionId: string | null): void {
  if (!sdkSessionId) { log.warn('employees', `talk ${sessionId} was cut off mid-turn before the SDK named its session; it cannot be resumed`); return; }
  wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(`${TALK_KEY}${sessionId}`, JSON.stringify({ employeeId, sdkSessionId, at: now() }));
}

export const TALK_RESTART_PROMPT = 'The Workplace restarted while you were mid-turn; continue where you left off.';

/* ---------- recovery after a restart ---------- */

export interface LostSession {
  id: string;
  employeeId: string;
  assignmentId: string | null;
  sdkSessionId: string | null;
  pending: { tool: string; input: string } | null;
}

/**
 * A restart kills every child process. What was running is not lost silently: each open row is
 * closed as `lost-on-restart`, a pending tool approval becomes an Inbox question the owner can
 * answer by telling the employee what to do, and an assignment that was building is told so in
 * its history. The SDK session id stays on the row so the conversation can be resumed.
 */
export function recoverAfterRestart(wp: Workplace): LostSession[] {
  const rows = wp.db.prepare("select id, employee_id, assignment_id, sdk_session_id, status, json from sessions where ended_at is null").all() as { id: string; employee_id: string; assignment_id: string | null; sdk_session_id: string | null; status: string | null; json: string }[];
  const lost: LostSession[] = [];
  for (const row of rows) {
    let meta: { pending?: { tool: string; input: string } | null; prompt?: string; probe?: boolean } = {};
    try { meta = JSON.parse(row.json) as typeof meta; } catch { /* an older row */ }
    const pending = meta.pending ?? null;
    wp.db.prepare("update sessions set ended_at = ?, status = 'lost-on-restart' where id = ?").run(now(), row.id);
    const emp = wp.org.employees.find(e => e.id === row.employee_id);
    const name = emp?.name ?? row.employee_id;
    if (row.assignment_id) markForResume(wp, row.assignment_id, row.id, `Session ${row.id} was lost when the Workplace restarted${pending ? ` while waiting for approval of ${pending.tool}` : ''}; it resumes from the handoff`);
    else if (!meta.probe && (row.status === 'running' || pending)) markTalkForResume(wp, row.id, row.employee_id, row.sdk_session_id);
    inbox.raise(wp, {
      kind: 'question',
      title: pending ? `${name} lost a pending approval on restart: ${pending.tool}` : `${name}'s session was lost on restart`,
      body: (pending
        ? `The Workplace restarted while ${name} was waiting for approval of ${pending.tool}: ${pending.input.slice(0, 300)}\n\nThe session is gone; its SDK conversation ${row.sdk_session_id ? `(${row.sdk_session_id.slice(0, 8)}…) can be resumed` : 'was not recorded'}.`
        : `The Workplace restarted while ${name} had a session open${row.assignment_id ? ` on ${row.assignment_id}` : ''}.`) +
        ` Answer with what ${name} should do next, or start the assignment again from its handoff.`,
      raisedBy: row.employee_id,
      context: { lostSession: row.id, sdkSessionId: row.sdk_session_id, assignmentId: row.assignment_id, pending },
      dedupeKey: `lost:${row.id}`,
    });
    lost.push({ id: row.id, employeeId: row.employee_id, assignmentId: row.assignment_id, sdkSessionId: row.sdk_session_id, pending });
  }
  if (lost.length) log.warn('employees', `${lost.length} session(s) lost on restart; questions filed to the Inbox`);
  return lost;
}

export interface ResumeAfterShutdown {
  resumed: string[];
  /** Talk/review sessions cut off mid-turn, continued in their own SDK conversation. */
  resumedTalks: { sessionId: string; employeeId: string; agentId: string }[];
  skipped: { id: string; reason: string }[];
}

/**
 * On boot (1 Oct): every assignment interrupted only because the Workplace shut itself down or
 * restarted (marked `resume:<id>` by `markForResume`, its status untouched since 2 Oct; or, from
 * before that, blocked with `cause: workplace-shutdown`) — never one the owner blocked, a spend cap
 * paused, or whose start genuinely failed — is restarted at once, from its branch and its handoff. Before this, the only path back
 * was the Chief of Staff's stall routine, which resumes one item per tick and each item once a
 * day; after a restart with several employees mid-build, that left work (Kabir's, Rohan's) blocked
 * for days. Staggered two at a time so a restart with many blocked items does not spawn them all
 * in the same instant; an employee already at its own concurrent-session limit (spawn()'s own
 * check) is skipped, not forced, and tried again on the next boot.
 */
export async function resumeAfterShutdown(wp: Workplace, staggerMs = 1500): Promise<ResumeAfterShutdown> {
  const result: ResumeAfterShutdown = { resumed: [], resumedTalks: [], skipped: [] };
  // "Pause all" holds the boot's resumes too; the markers stay for the boot after the resume.
  if (floor.paused(wp)) {
    result.skipped.push({ id: 'floor', reason: floor.describe(wp) });
    log.info('employees', `resume after restart: none, ${floor.describe(wp)}`);
    return result;
  }
  const marked = (wp.db.prepare("select key from settings where key like 'resume:%'").all() as { key: string }[]).map(r => r.key.slice('resume:'.length));
  const items: WorkItem[] = [];
  for (const id of marked) {
    const item = work.get(wp, id);
    // Moved on since (the owner reassigned, parked or closed it): nothing to resume.
    if (!item || !RESUMABLE.has(item.state) || !item.employeeId) { wp.db.prepare('delete from settings where key = ?').run(RESUME_KEY(id)); continue; }
    items.push(item);
  }
  // Rows blocked by a shutdown before 2 Oct (the old behaviour) are still resumed once.
  items.push(...work.list(wp, { kind: 'assignment', state: 'blocked' })
    .filter(a => a.employeeId && a.history.at(-1)?.by === 'workplace' && a.history.at(-1)?.cause === 'workplace-shutdown'));

  const BATCH = 2;
  for (let i = 0; i < items.length; i += BATCH) {
    for (const item of items.slice(i, i + BATCH)) {
      try {
        const budget = spend.canSpend(wp, item.employeeId!);
        if (!budget.ok) { result.skipped.push({ id: item.id, reason: `spend cap reached (${budget.scope}); it resumes when the cap is raised or tomorrow` }); continue; }
        if (item.state === 'blocked') work.transition(wp, item.id, { to: 'building', by: 'workplace', note: 'resumed automatically: the previous block was the Workplace\'s own restart, not the owner, a cap, or a failure' });
        if (openSession(item.employeeId!)?.assignmentId !== item.id) assign(wp, item.id);
        wp.db.prepare('delete from settings where key = ?').run(RESUME_KEY(item.id));
        result.resumed.push(item.id);
      } catch (err) {
        result.skipped.push({ id: item.id, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    if (i + BATCH < items.length) await new Promise(r => setTimeout(r, staggerMs));
  }

  // Talks cut off mid-turn, after the assignments: one session per employee, so a busy or capped
  // employee keeps its marker for the next boot rather than displacing the open session.
  const talks = wp.db.prepare('select key, value from settings where key like ?').all(`${TALK_KEY}%`) as { key: string; value: string }[];
  for (const t of talks) {
    const sessionId = t.key.slice(TALK_KEY.length);
    let mark: { employeeId: string; sdkSessionId: string };
    try { mark = JSON.parse(t.value) as typeof mark; } catch { wp.db.prepare('delete from settings where key = ?').run(t.key); continue; }
    const emp = wp.org.employees.find(e => e.id === mark.employeeId);
    if (!emp || emp.virtual) { wp.db.prepare('delete from settings where key = ?').run(t.key); continue; }
    const budget = spend.canSpend(wp, emp.id);
    if (!budget.ok) { result.skipped.push({ id: `talk:${sessionId}`, reason: `${emp.name}: spend cap reached (${budget.scope}); the talk resumes on a later boot` }); continue; }
    if (openSession(emp.id) || sessionsOf(emp.id).length >= emp.budget.concurrentSessions) { result.skipped.push({ id: `talk:${sessionId}`, reason: `${emp.name} already has a session open; the talk resumes on a later boot` }); continue; }
    try {
      const agent = spawn(wp, emp.id, { prompt: TALK_RESTART_PROMPT, resume: mark.sdkSessionId });
      wp.db.prepare('delete from settings where key = ?').run(t.key);
      result.resumedTalks.push({ sessionId, employeeId: emp.id, agentId: agent.id });
    } catch (err) {
      result.skipped.push({ id: `talk:${sessionId}`, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  if (result.resumed.length || result.resumedTalks.length || result.skipped.length) {
    log.info('employees', `resume after restart: ${result.resumed.length} resumed, ${result.resumedTalks.length} talk(s) continued${result.skipped.length ? `, ${result.skipped.length} skipped (${result.skipped.map(s => s.id).join(', ')})` : ''}`);
  }
  return result;
}

/* ---------- state and cards ---------- */

export function setState(wp: Workplace, employeeId: string, state: EmployeeState): void {
  stateOverride.set(employeeId, state);
  const e = wp.org.employees.find(x => x.id === employeeId);
  if (e) e.state = state;
  wp.emit({ type: 'office.updated', card: card(wp, employeeId) });
}

export function stateOf(wp: Workplace, employeeId: string): EmployeeState {
  return stateWithReason(wp, employeeId).state;
}

/**
 * The honest state, with the reason when it is blocked or needs the owner. A spend cap is read
 * from the ledger, not from memory: the in-memory override was lost on every restart, so a
 * cap-paused employee showed "idle" (27 Sep).
 */
export function stateWithReason(wp: Workplace, employeeId: string): { state: EmployeeState; reason?: string } {
  const e = employee(wp, employeeId);
  // The COO is never spawned; its card shows presence (the lead's heartbeat), not session state.
  if (e.virtual) {
    const p = coo.presence(wp);
    return p.online ? { state: 'online' } : { state: 'offline', reason: 'messages wait; Asha handles routine' };
  }
  // Order: what needs the owner first (a parked tool call, an open question), then live work,
  // then what stops autonomous work (a cap, a blocked assignment), then idle.
  const open = openSession(employeeId);
  const agent = open ? runs.getRunAgent(open.agentId) : undefined;
  if (agent?.status === 'waiting' && agent.approval) return { state: 'needs-owner', reason: `waiting for approval of ${agent.approval.tool}` };
  // Routine housekeeping (a stall notice, a "did nothing" item) never overrides a live session's
  // true status (QA B16: a stale item raised by the employee showed a live, working session as
  // "needs-owner"/stalled). Only a real open item that needs the owner does that.
  const raised = inbox.ownerList(wp, 'open').find(i => i.raisedBy === employeeId);
  if (raised) return { state: 'needs-owner', reason: raised.title };
  if (agent?.status === 'error') return { state: 'blocked', reason: 'the session hit an error' };
  if (open) return { state: 'working' };
  const budget = spend.canSpend(wp, employeeId);
  if (!budget.ok) return { state: 'blocked', reason: pausedReason(wp, e, budget.scope!) };
  const blockedItem = work.list(wp, { kind: 'assignment', employeeId, state: 'blocked' })[0];
  if (blockedItem) return { state: 'blocked', reason: blockedItem.history.at(-1)?.note ?? `${blockedItem.title} is blocked` };
  const override = stateOverride.get(employeeId);
  return { state: override === 'working' || override === 'paused' ? 'idle' : override ?? e.state ?? 'idle' };
}

/** "Paused — daily budget reached (₹151/₹150). You can still talk to Mira." */
export function pausedReason(wp: Workplace, e: Employee, scope: string): string {
  if (scope === 'weekly-pace') {
    const until = (wp.db.prepare("select value from settings where key = 'pace:until'").get() as { value: string } | undefined)?.value;
    const at = until ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(until)) : 'the next pace day';
    return `Paused — today's share of the weekly limit is used; resumes ${at} IST. You can still talk to ${e.name}.`;
  }
  const s = spend.summary(wp);
  const [kind, id] = scope.split(':');
  const spent = kind === 'company' ? s.companyInr : kind === 'unit' ? (s.byUnit[id ?? ''] ?? 0) : (s.byEmployee[e.id] ?? 0);
  const cap = kind === 'company' ? s.capInr : kind === 'unit' ? (wp.org.units.find(u => u.id === id)?.budget?.inrPerDay ?? 0) : e.budget.inrPerDay;
  const whose = kind === 'company' ? 'company' : kind === 'unit' ? `${wp.org.units.find(u => u.id === id)?.title ?? id} unit` : 'daily';
  return `Paused — ${whose} budget reached (₹${Math.round(spent)}/₹${cap}). You can still talk to ${e.name}.`;
}

/**
 * Open Inbox items that concern this employee and that the owner decides: the same set the Inbox
 * shows (QA 2 Oct: Asha's page counted 21, 20 of them housekeeping that never reaches the owner).
 */
export function needsYouItems(wp: Workplace, employeeId: string) {
  return inbox.forEmployee(wp, employeeId).filter(inbox.isOwnerFacing);
}

// A denial reaches the raiser (an employee) as a reason to act on.
inbox.onAnswer((wp, item) => {
  if (!item.answer || !['reject', 'deny', 'no'].includes(item.answer.optionId)) return;
  if (!wp.org.employees.some(e => e.id === item.raisedBy)) return;
  try { deliverDenial(wp, item.raisedBy, item.title, item.answer.note); } catch (err) { log.warn('employees', `denial to ${item.raisedBy}: ${err instanceof Error ? err.message : err}`); }
});

export function card(wp: Workplace, employeeId: string): EmployeeCard {
  const e = employee(wp, employeeId);
  const open = openSession(employeeId);
  const active = new Set(['proposed', 'planned', 'building', 'review', 'blocked']);
  const current = stall.annotate(wp, work.list(wp, { kind: 'assignment', employeeId })).find(a => active.has(a.state)) ?? null;
  const status = readEmployeeFile(wp.org, employeeId, 'status.md').trim();
  const { state, reason } = stateWithReason(wp, employeeId);
  return {
    employee: { ...e, state, ...(reason ? { stateReason: reason } : {}) },
    charters: e.charterIds.map(id => wp.org.charters.get(id)).filter((c): c is NonNullable<typeof c> => !!c).map(summarise),
    currentWork: current,
    lastReport: humanizeIds(wp, lastReport.get(employeeId) ?? (status || undefined)) ?? null,
    session: open ? runs.getRunAgent(open.agentId) ?? null : null,
    spendTodayInr: spend.summary(wp).byEmployee[employeeId] ?? 0,
    needsYou: needsYouItems(wp, employeeId).length,
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
    // Subscription usage: free, tracked for visibility (HLD D9b).
    spend.recordUsage(wp, { employeeId: session.employeeId, sessionId: session.agentId, model, ...delta, ...(session.ownerTalk ? { tag: 'owner-talk' as const } : {}) });
  }
}

/* ---------- the Workplace's own tools, served in-process ---------- */

export const HANDBACK_IN_REVIEW = 'The story is in review; post progress as a comment (item_comment) instead of handing it back.';

/**
 * In review, or its PR is open and was pushed for review with no send-back since (dry run #19: Tara
 * handed a story back to Asha while it was In review with Dev, which pulled it out of review).
 */
export function awaitingReview(w: WorkItem | undefined): boolean {
  if (!w) return false;
  if (w.status === 'in-review') return true;
  const pr = w.pr;
  if (!pr || pr.merged || w.status === 'done') return false;
  return !pr.sendBack || pr.sendBack.at < pr.pushedAt;
}

export function workplaceTools(wp: Workplace, employeeId: string, session: () => Session) {
  const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
  return createSdkMcpServer({
    name: 'workplace',
    version: '1.0.0',
    tools: [
      tool('report_status', 'Write your status file: three short lines, doing / done / blocked. Do this before you stop.',
        { doing: z.string(), done: z.string(), blocked: z.string() },
        async ({ doing, done, blocked }) => {
          if (session().probe) return ok('This is a probe session; the status file is not written.');
          const body = `doing: ${doing}\ndone: ${done}\nblocked: ${blocked}\n`;
          writeEmployeeFile(wp.org, employeeId, 'status.md', body);
          lastReport.set(employeeId, body.trim());
          wp.emit({ type: 'office.updated', card: card(wp, employeeId) });
          return ok('Status written.');
        }),
      tool('write_handoff', 'Write your handoff: what the next session needs to continue this work.',
        { handoff: z.string() },
        async ({ handoff }) => {
          if (session().probe) return ok('This is a probe session; the handoff is not written.');
          writeEmployeeFile(wp.org, employeeId, 'handoff.md', `${handoff.trim()}\n`);
          return ok('Handoff written.');
        }),
      tool('report_done', 'Report an assignment as done, with evidence. It goes to review; a verifier marks it done. With pull requests on, run scripts/pre-pr.sh on your latest commit first: its results for that commit are workplace/tests, and without them the report is refused.',
        {
          assignmentId: z.string().optional(),
          testsPassed: z.number().int().min(0), testsFailed: z.number().int().min(0), testCommand: z.string().optional(),
          commits: z.array(z.string()), liveVerified: z.array(z.string()), notVerified: z.array(z.string()), notes: z.string().optional(),
        },
        async (args) => {
          const id = args.assignmentId ?? currentStory(session());
          if (!id) return ok('No assignment is attached to this session; say what you did in your handoff instead.');
          // 7 Oct (B9): Neel submitted while the story was assigned to Mira mid hand-off, and the push took
          // the ASSIGNEE's branch (Mira's docstring) as the PR. Only the assignee submits their story.
          const owner = work.get(wp, id)?.employeeId;
          if (owner && owner !== employeeId) return ok(`Not recorded: ${id} is assigned to ${employee(wp, owner).name}, not you, so a submit would push their branch. Ask Asha to hand it back to you first, then report_done.`);
          const evidence: Evidence = { tests: { passed: args.testsPassed, failed: args.testsFailed, ...(args.testCommand ? { command: args.testCommand } : {}) }, commits: args.commits, liveVerified: args.liveVerified, notVerified: args.notVerified, ...(args.notes ? { notes: args.notes } : {}) };
          // Before a commit counts as evidence: every changed file must be owned by one of the employee's charters.
          const wt = session().worktree;
          if (wt) {
            const foreign = foreignChanges(wp, employee(wp, employeeId), wt);
            if (foreign.length) {
              // Say which are only in the worktree (5 Oct: Dev chased committed files while 18 untracked build outputs were the cause).
              const loose = new Set(uncommittedFiles(wt.path));
              const local = foreign.filter(f => loose.has(f));
              const hint = local.length ? ` ${local.length} of them are uncommitted or untracked in your worktree (e.g. ${local[0]}): remove them (git checkout / git clean on those paths) if they are build leftovers.` : '';
              return ok(`Not recorded: your branch changes files outside your charters: ${foreign.slice(0, 10).join(', ')}.${hint} Revert them or route them through their owner.`);
            }
            const real = commitsSince(wt.path, wt.base);
            if (evidence.commits.length && real.length === 0) return ok('Not recorded: no commits on your branch since the base; commit your work first.');
            if (real.length) evidence.commits = [...new Set([...evidence.commits, ...real.map(c => c.split(' ')[0]!)])];
          }
          // Results belong to a commit: scripts/pre-pr.sh must have passed on the branch head (shadow/on).
          const gate = githubFlow.prePrGate(wp, id);
          if (gate) return ok(`Not recorded: ${gate}`);
          try {
            const warning = work.get(wp, id) ? work.planWarning(work.get(wp, id)!) : null;
            const item = work.reportDone(wp, id, evidence, employeeId);
            lastReport.set(employeeId, `Reported ${item.title}: ${evidence.tests.passed} passed / ${evidence.tests.failed} failed; ${evidence.commits.length} commits; live: ${evidence.liveVerified.join(', ') || 'none'}; not verified: ${evidence.notVerified.join(', ') || 'none'}`);
            const nudge = warning ? ` Warning (on the item): ${warning}. The handbook asks for "## Plan" first, then the build: post your plan before you start next time.` : '';
            // The server pushes the branch and opens the PR (shadow/on); local: nothing, and no text.
            const gh = await githubFlow.onReview(wp, id, employeeId).catch(err => ({ message: `GitHub: ${err instanceof Error ? err.message : String(err)}` }));
            return ok(`Recorded. ${item.id} is in review; it becomes done when a verifier confirms it.${nudge}${gh.message ? ` ${gh.message}` : ''}`);
          } catch (err) {
            return ok(`Not recorded: ${err instanceof Error ? err.message : String(err)}`);
          }
        }),
      tool('ask_owner', 'Raise a real decision to the owner\'s Inbox, with your recommendation (required: one of the options, or what you would do). Use it only for what the handbook says needs the owner.',
        { title: z.string(), body: z.string(), options: z.array(z.string()).optional(), recommendation: z.string().optional(), itemId: z.string().optional().describe('The work item this decision is about (default: your current assignment). One open ask per item reaches the owner.') },
        async ({ title, body, options, recommendation, itemId }) => {
          if (!recommendation?.trim()) return ok('Not filed: give your recommendation (one of the options, or what you would do). The owner decides faster with one.');
          const about = itemId?.trim() || session().assignmentId;
          const { item, reused } = inbox.raiseOrReuse(wp, { kind: 'decision', title, body, raisedBy: employeeId, recommendation, ...(about && rawGet(wp, about) ? { context: { itemId: about } } : {}), ...(options?.length ? { options: options.map(o => ({ id: o.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label: o })) } : {}) });
          if (reused) return ok(`Not filed: ${item.id} is already in the owner's Inbox about ${about}. Add to it with inbox_reply; don't raise a second one.`);
          setState(wp, employeeId, 'needs-owner');
          return ok(`Filed as ${item.id}. Continue with other work; the answer arrives in your next session's context.`);
        }),
      tool('request_review', 'Nudge the reviewer of a story that is already in review; it never submits one (report_done does). With pull requests on, run scripts/pre-pr.sh on your latest commit first, or the request is refused.',
        { assignmentId: z.string(), note: z.string().optional() },
        async ({ assignmentId, note }) => {
          const item = work.get(wp, assignmentId);
          if (!item) return ok(`No assignment ${assignmentId}.`);
          // It pings the reviewer of a story already in review; it never submits one (Rohan, 5 Oct).
          if (item.status !== 'in-review') return ok(`Not requested: ${assignmentId} is ${item.status}, not in review. request_review only nudges the reviewer of a story already in review; to submit it, call report_done.`);
          const gate = githubFlow.prePrGate(wp, assignmentId);
          if (gate) return ok(`Not requested: ${gate}`);
          // The reviewer is a different identity (lead, or QA for a lead), never the owner (HOWTO
          // "State a feature once"; the §0 table has no owner row for a review): this is routine,
          // not an owner decision, so it never reaches his Inbox — only the reviewer's/Asha's page.
          inbox.raise(wp, { kind: 'question', title: `Review requested: ${item.title}`, body: note ?? 'Please verify.', raisedBy: employeeId, context: { assignmentId }, dedupeKey: `review:${assignmentId}`, ownerFacing: false });
          const gh = await githubFlow.onReview(wp, assignmentId, employeeId).catch(err => ({ message: `GitHub: ${err instanceof Error ? err.message : String(err)}` }));
          return ok(`Review requested.${gh.message ? ` ${gh.message}` : ''}`);
        }),
      // The GitHub flow's two approvals (docs/HLD-github-flow.md D4): in local mode they answer "review as before".
      tool('review_approve', 'Reviewers only: approve a story in review. Approval 1 of 2 is the developer approver\'s (a lead who is not the author); approval 2 of 2 is QA\'s, only after the developer approval, and needs qaDoc: the edge cases where the change might break, each checked, and a report. QA\'s approval marks the story done, and the Workplace merges it once the tests check is green (blockers go to the COO). Any new commit resets both approvals.',
        { itemId: z.string(), note: z.string().optional(), qaDoc: z.string().optional().describe(`QA only, required for approval 2 of 2: ${qaDocFormat}`) },
        async ({ itemId, note, qaDoc }) => {
          try { return ok((await githubFlow.approve(wp, itemId, employeeId, note, qaDoc)).message); } catch (err) { return ok(`Not approved: ${err instanceof Error ? err.message : String(err)}`); }
        }),
      tool('review_send_back', 'Reviewers only (the developer approver or QA): send a story in review back to its author with exactly what to change; QA adds the root cause (what failed, where, and why). It resets both approvals.',
        { itemId: z.string(), note: z.string() },
        async ({ itemId, note }) => {
          try { await githubFlow.sendBack(wp, itemId, employeeId, note); return ok('Sent back to its author with your reason. Both approvals are reset: the story comes back through the developer approver, then QA.'); } catch (err) { return ok(`Not sent back: ${err instanceof Error ? err.message : String(err)}`); }
        }),
      tool('review_dispute', 'Authors only, once per QA send-back: dispute it with your reason. Asha decides; if she can\'t, the COO; then the owner.',
        { itemId: z.string(), reason: z.string() },
        async ({ itemId, reason }) => {
          try { await githubFlow.dispute(wp, itemId, employeeId, reason); return ok('Dispute sent to Asha with your reason. Asha decides; if she can\'t, the COO; then the owner. Wait for the answer on the item.'); } catch (err) { return ok(`Not sent: ${err instanceof Error ? err.message : String(err)}`); }
        }),
      // The robot suite on the Mac against staging (docs/HLD-evidence.md); handbook "A story's life", step 4.
      tool('run_evidence', 'Run the robot suite on the Mac\'s simulators against the staging server, for your story branch\'s head commit, with the platforms and features your change touches (for example platforms "android,ios", features "memory"). ' +
        'It returns at once with its place in the queue and links a report with screenshots to your story. Never wait for it: the summary comes back to you and onto the story when it finishes; open screenshots only for failures. ' +
        'Platforms: android, ios. Features: ' + evidenceRuns.RUNNER_FEATURES.join(', ') + ' (or all); setup always runs (install, sign-in), so don\'t name it. ' +
        'Evidence belongs to one commit: a new commit makes it stale, so run it again. Mac desktop features run only in a live window the COO opens (ask on the item); Windows evidence is a cloud run QA schedules.',
        { itemId: z.string().optional(), platforms: z.string(), features: z.string() },
        async ({ itemId, platforms, features }) => {
          const id = itemId ?? currentStory(session());
          if (!id) return ok(evidenceRuns.platformRefusal(platforms) ?? 'Name the story: no story is attached to this session, so call run_evidence again with its itemId.');
          const r = evidenceRuns.request(wp, { itemId: id, by: employeeId, platforms, features });
          return ok(r.ok ? `${id} (${rawGet(wp, id)?.title ?? ''}): ${r.message}` : `Not queued for ${id}: ${r.message}`);
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
              try { assign(wp, a.id); started.push(a.charterId ?? a.id); } catch (err) { if (work.get(wp, a.id)?.state !== 'blocked') work.transition(wp, a.id, { to: 'blocked', by: 'workplace', note: err instanceof Error ? err.message : String(err) }); }
            }
            const r = result.route;
            return ok(`Routed to ${r.primaries.map(h => h.charterId).join(', ')}${r.consulted.length ? ` (consult ${r.consulted.join(', ')})` : ''}; sessions started for ${started.join(', ') || 'nobody new'}.` + (r.unresolved.length ? ` Unresolved: ${r.unresolved.map(t => `${t.kind}:${t.key}`).join(', ')}.` : ''));
          } catch (err) {
            return ok(`Not decomposed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }),
      tool('record_spend', 'Record real money this session caused: an Anthropic API call on a key (e.g. through Iris\'s llm-gateway during a test), AWS work, or a paid third-party API. Give the provider\'s own units when it reported them; then the row is metered, otherwise reported.',
        // No z.record(): it makes the MCP SDK fail to list every tool of this server (27 Sep). Units come as a JSON string.
        { source: z.enum(['anthropic-api', 'aws', 'third-party']), what: z.string(), inr: z.number().min(0).optional(), usd: z.number().min(0).optional(), unitsJson: z.string().optional() },
        async ({ source, what, inr, usd, unitsJson }) => {
          const amount = inr ?? (usd !== undefined ? usd * wp.config.usdInr : undefined);
          if (amount === undefined) return ok('Give inr or usd.');
          let units: Record<string, number> | undefined;
          if (unitsJson) { try { units = JSON.parse(unitsJson) as Record<string, number>; } catch { return ok('unitsJson is not valid JSON.'); } }
          const e = spend.record(wp, { employeeId, sessionId: session().agentId, source, basis: units ? 'metered' : 'reported', what, inr: amount, detail: { ...(usd !== undefined ? { usd } : {}), ...(units ?? {}) } });
          return ok(`Recorded ₹${e.inr} (${e.basis}, ${source}). Real money today: ₹${spend.summary(wp).companyInr} of ₹${spend.capFor(wp)}.`);
        }),
      tool('send_file', 'Send the owner a file in your Talk thread with him (a screenshot, a report, a build log): `path` must be inside your own worktree or ~/iris-workplace/evidence/, at most 20 MB. `caption` is one short line.',
        { path: z.string(), caption: z.string().optional() },
        async ({ path, caption }) => ok(await sendFileTool(wp, employeeId, session().agentId)({ path, ...(caption ? { caption } : {}) }))),
      tool('room_post', `Post in the Team Room: to an existing thread by id, or open a new one with a title. Use it when your work needs another team (an interface, a contract, a handoff, an ownership conflict) instead of editing outside your charter. Mention people with @id. Posts are short (at most ${ROOM_POST_MAX} characters): put the detail on the item or in a doc and link it. \`headline\` is the one line the owner sees for the thread ("Weather source: agreed on open-meteo, Mira to wire it").`,
        { threadId: z.string().optional(), title: z.string().optional(), text: z.string(), charterIds: z.array(z.string()).optional(), headline: z.string().optional() },
        async ({ threadId, title, text, charterIds, headline }) => {
          // Long posts are refused, not cut, so agents learn the habit (owner, 4 Oct).
          if (text.trim().length > ROOM_POST_MAX) return ok(ROOM_POST_TOO_LONG);
          try {
            if (threadId) { const m = room.post(wp, threadId, { text, by: employeeId, ...(headline ? { headline } : {}) }); return ok(`Posted ${m.id} in ${threadId}.`); }
            if (!title) return ok('Give a threadId to reply, or a title to open a thread.');
            const { thread } = room.createThread(wp, { title, text, by: employeeId, ...(charterIds ? { charterIds } : {}), ...(headline ? { headline } : {}) });
            return ok(`Opened thread ${thread.id}: ${thread.title}.`);
          } catch (err) { return ok(`Not posted: ${err instanceof Error ? err.message : String(err)}`); }
        }),
      tool('room_read', 'Read a Team Room thread, or list the open threads that concern you.',
        { threadId: z.string().optional() },
        async ({ threadId }) => {
          if (!threadId) return ok(room.threadsFor(wp, employeeId).map(t => `${t.id}: ${t.title} (${t.messageCount} messages, last ${t.lastAt})`).join('\n') || 'No open threads concern you.');
          const t = room.getThread(wp, threadId);
          if (!t) return ok(`No thread ${threadId}.`);
          return ok(`# ${t.title} [${t.state}]\n` + room.messages(wp, threadId).map(m => `${m.owner ? 'OWNER' : m.by} (${m.at}): ${m.details ?? m.text}`).join('\n'));
        }),
      tool('room_resolve', 'Chief of Staff only: resolve a Team Room topic thread with a summary (written into the relevant charter or contract by you) and optional follow-up assignments. An epic\'s own thread and the room channels (area, General, Releases) are standing channels and cannot be resolved: post a summary in them instead.',
        { threadId: z.string(), summary: z.string(), followUps: z.array(z.object({ employeeId: z.string(), title: z.string(), body: z.string() })).optional() },
        async ({ threadId, summary, followUps }) => {
          const emp = employee(wp, employeeId);
          if (!emp.charterIds.includes('chief-of-staff') && emp.level !== 0) return ok('Only the Chief of Staff resolves threads; post your view with room_post.');
          try { const r = room.resolve(wp, threadId, { summary, by: employeeId, ...(followUps ? { followUps } : {}) }); return ok(`Resolved ${threadId}${r.followUps.length ? `; follow-ups ${r.followUps.join(', ')}` : ''}.`); }
          catch (err) { return ok(`Not resolved: ${err instanceof Error ? err.message : String(err)}`); }
        }),
      tool('escalate', 'Chief of Staff only: escalate a Team Room thread for a decision above your authority, with your recommendation (required). It goes to the COO FIRST (Claude), who answers it or forwards it to the owner\'s Inbox; only when the COO is offline does it go straight to the owner. Never tell the owner it is in his Inbox unless this tool says so.',
        { threadId: z.string(), title: z.string(), body: z.string(), options: z.array(z.string()).optional(), recommendation: z.string().optional() },
        async ({ threadId, title, body, options, recommendation }) => {
          const emp = employee(wp, employeeId);
          if (!emp.charterIds.includes('chief-of-staff') && emp.level !== 0) return ok('Only the Chief of Staff escalates; mention @asha in the thread.');
          if (!recommendation?.trim()) return ok('Not escalated: give your recommendation (one of the options, or what you would do).');
          try { const item = room.escalate(wp, threadId, { title, body, by: employeeId, recommendation, ...(options ? { options } : {}) }); return ok(String(item.id).startsWith('in_') ? `Escalated to the OWNER's Inbox (the COO is offline) as ${item.id}.` : `Escalated to the COO as ${item.id} (not the owner's Inbox). The COO answers it or forwards it to the owner; wait for that answer in this thread.`); }
          catch (err) { return ok(`Not escalated: ${err instanceof Error ? err.message : String(err)}`); }
        }),
      /* ---------- v2: the plan (LLD §19.12) ---------- */
      tool('item_create', 'Create an epic (Chief of Staff only; no parentId, optional targetDate YYYY-MM-DD; the COO decides focus), a story under an epic (Chief of Staff or the epic owner) or a task under a story (the story\'s assignee). One item per outcome: an open item with the same title under the same parent is returned instead of a copy.',
        { level: z.enum(['epic', 'story', 'task']), parentId: z.string().optional(), title: z.string(), body: z.string().optional(), assigneeId: z.string().optional(), points: z.number().int().optional(), acceptance: z.array(z.string()).optional(), targetDate: z.string().optional(), type: z.enum(['bug']).optional().describe('bug: a story-level bug (level story).'), startsAfter: z.string().optional().describe('The item id this one starts after.') },
        async ({ level, parentId, title, body, assigneeId, points, acceptance, targetDate, type, startsAfter }) => {
          const emp = employee(wp, employeeId);
          const isCos = emp.charterIds.includes('chief-of-staff') || (emp.level === 0 && !emp.virtual);
          // Epics (owner, 3 Oct: the team does creation, the COO decides): the Chief of Staff files
          // them directly; focus stays the COO's call.
          if (level === 'epic') {
            if (!isCos) return ok('Only the Chief of Staff creates epics; ask Asha in the Room.');
            try {
              const it = items.create(wp, { level: 'epic', title, ...(body ? { body } : {}), ...(targetDate ? { targetDate } : {}) } as never, employeeId);
              return ok(`Created ${it.id} (epic). Ask the COO to put it in focus if it is launch work.`);
            } catch (err) { return ok(`Not created: ${err instanceof Error ? err.message : String(err)}`); }
          }
          if (!parentId) return ok('A story needs its epic (parentId) and a task its story.');
          const parent = rawGet(wp, parentId);
          if (!parent) return ok(`No item ${parentId}.`);
          if (level === 'story' && !isCos && parent.ownerId !== employeeId) return ok('Only the Chief of Staff or the epic owner creates stories; ask Asha in the Room.');
          if (level === 'task' && !isCos && parent.employeeId !== employeeId) return ok('Only the story\'s assignee (or the Chief of Staff) splits it into tasks.');
          const twin = items.duplicateOf(wp, parentId, title);
          if (twin) return ok(`Already exists as ${twin.id} (${twin.status}); work on that one.`);
          try {
            const it = items.create(wp, { level, parentId, title, ...(type ? { type } : {}), ...(startsAfter ? { startsAfter } : {}), ...(body ? { body } : {}), ...(assigneeId ? { assigneeId } : {}), ...(points ? { points: points as never } : {}), ...(acceptance ? { acceptance } : {}) }, employeeId);
            return ok(`Created ${it.id} (${it.level}, ${it.status}).`);
          } catch (err) { return ok(`Not created: ${err instanceof Error ? err.message : String(err)}`); }
        }),
      tool('item_update', 'Move one of your items (start, block with a reason and who you wait on, send to review with a reviewer), or set its points. You never mark your own work done; the reviewer does. ' +
        'Blocked is only for a wait on the owner (waitingOn owner, with your recommendation), the COO (coo), the release (release), another item (its id), or someone outside the team (external); it always needs blockedReason. ' +
        'startsAfter <itemId> records a dependency: the item starts after that one finishes, and flips to Ready by itself then. While it stays Blocked you can update waitingOn, blockedReason and startsAfter to keep the blocker current. ' +
        'Waiting on a teammate is never Blocked: status blocked with waitingOn a teammate becomes In review with them reviewing when it is a review or sign-off (kind review), ' +
        'or hands the item to them when it is their work (kind work): they work on it and give it back with item_handback.',
        { itemId: z.string(), status: z.enum(['backlog', 'ready', 'in-progress', 'in-review', 'done', 'blocked']).optional(), blockedReason: z.string().optional(), waitingOn: z.string().optional(), startsAfter: z.string().optional().describe('The item id this one starts after; "" clears it.'), hold: z.boolean().optional().describe('Park it (true, with status backlog and a note saying why) so the dispatcher never auto-starts it; false releases it. Chief of Staff only.'), kind: z.enum(['review', 'work']).optional(), recommendation: z.string().optional(), reviewerId: z.string().optional(), points: z.number().int().optional(), note: z.string().optional(), assigneeId: z.string().optional().describe('Chief of Staff only: route the item to this employee.') },
        async ({ itemId, status, blockedReason, waitingOn, startsAfter, hold, kind, recommendation, reviewerId, points, note, assigneeId }) => {
          // A parked item must be held, or the dispatcher restarts it at once (5 Oct: Mira's music story bounced back 4 times).
          if (hold !== undefined && !isChiefOfStaff(wp, employeeId)) return ok('Not changed: only the Chief of Staff parks or releases an item (hold); ask Asha.');
          if (hold && status && status !== 'backlog') return ok('Not changed: a held item sits in backlog; use status backlog with hold true.');
          if (status === 'blocked' && waitingOn === 'owner' && !recommendation?.trim()) return ok('Not changed: blocked on the owner raises a decision in his Inbox; give your recommendation.');
          if (assigneeId && !isChiefOfStaff(wp, employeeId)) return ok('Not changed: only the Chief of Staff routes an item to someone; hand it over with status blocked, waitingOn and kind work instead.');
          try {
            const it = items.update(wp, itemId, { ...(assigneeId ? { assigneeId } : {}), ...(status ? { status } : hold ? { status: 'backlog' as const } : {}), ...(hold !== undefined ? { hold } : {}), ...(startsAfter !== undefined ? { startsAfter } : {}), ...(blockedReason ? { blockedReason } : {}), ...(waitingOn ? { waitingOn } : {}), ...(kind ? { kind } : {}), ...(recommendation ? { recommendation } : {}), ...(reviewerId ? { reviewerId } : {}), ...(points ? { points: points as never } : {}), ...(note ? { note } : {}) }, employeeId);
            if (status === 'blocked' && it.status !== 'blocked') return ok(notBlocked(wp, it));
            return ok(`${it.id} is ${it.trueStatus ? it.trueStatus : it.status}${it.blocker ? `, waiting on ${it.blocker.label} (${it.blocker.status})` : ''}.`);
          } catch (err) { return ok(`Not changed: ${err instanceof Error ? err.message : String(err)}`); }
        }),
      tool('item_comment', 'Comment on an item (a few short lines; mention people with @id). Status and notes about the work go here, not in chat.',
        { itemId: z.string(), text: z.string() },
        async ({ itemId, text }) => {
          try { const c = trail.comment(wp, itemId, { by: employeeId, text }); return ok(`Commented ${c.id}.`); }
          catch (err) { return ok(`Not commented: ${err instanceof Error ? err.message : String(err)}`); }
        }),
      tool('flag_stall', 'Flag your own stall the moment it happens: why you are stuck, and who you are waiting on if anyone. Waiting on the owner, the COO (coo) or someone outside the team (external) marks the item Blocked and the COO hears at once. ' +
        'Waiting on a teammate is not a stall: a review or sign-off puts it In review with them (kind review); their work hands the item to them (kind work) until they give it back with item_handback.',
        { itemId: z.string().optional(), reason: z.string(), waitingOn: z.string().optional(), kind: z.enum(['review', 'work']).optional(), recommendation: z.string().optional() },
        async ({ itemId, reason, waitingOn, kind, recommendation }) => {
          const id = itemId ?? currentStory(session());
          if (!id) return ok('Name the item: no item is attached to this session.');
          if (waitingOn && !isWaitable(wp, waitingOn)) return ok(`waitingOn must be an employee id, an item id, coo, owner, release or external; "${waitingOn}" is none.`);
          if (waitingOn === 'owner' && !recommendation?.trim()) return ok('Not flagged: waiting on the owner raises a decision in his Inbox; give your recommendation.');
          try {
            const before = rawGet(wp, id)?.status;
            const w = watch.flag(wp, id, { by: employeeId, reason, ...(waitingOn ? { waitingOn } : {}), ...(recommendation ? { recommendation } : {}), ...(kind ? { kind } : {}) });
            if (waitingOn && before !== 'blocked' && w.status !== 'blocked') return ok(notBlocked(wp, items.require$(wp, id)));
            return ok(`Flagged ${id}; the COO has it.`);
          } catch (err) { return ok(`Not flagged: ${err instanceof Error ? err.message : String(err)}`); }
        }),
      tool('item_handback', 'Give back an item a teammate handed you (because they were waiting on your work), with a short note of what you did. It goes back to them, In progress, and they are woken.',
        { itemId: z.string().optional(), note: z.string() },
        async ({ itemId, note }) => {
          const id = itemId ?? currentStory(session());
          if (!id) return ok('Name the item: no item is attached to this session.');
          if (awaitingReview(rawGet(wp, id))) return ok(`Not handed back: ${HANDBACK_IN_REVIEW}`);
          try { const it = items.handback(wp, id, note, employeeId); return ok(`Handed ${it.id} back to ${nameOf(wp, it.assigneeId)}.`); }
          catch (err) { return ok(`Not handed back: ${err instanceof Error ? err.message : String(err)}`); }
        }),
      tool('inbox_reply', 'Answer in an Inbox item\'s thread (when the owner replied to something you raised). Keep it to a few short lines.',
        { inboxId: z.string(), text: z.string() },
        async ({ inboxId, text }) => {
          try { inbox.reply(wp, inboxId, { by: employeeId, text }); return ok(`Replied in ${inboxId}.`); }
          catch (err) { return ok(`Not replied: ${err instanceof Error ? err.message : String(err)}`); }
        }),
      tool('status_of', 'The status of anything in the plan (an item, a person, an area), answered from the plan with links. Use it before answering "what is the status of X?".',
        { q: z.string() },
        async ({ q }) => {
          const a = statusAnswers.answer(wp, q);
          // Each match carries its id, so the agent can act on it (item_update, item_comment) or ask again by id.
          const lines = a.matches.slice(0, 8).map(m => `${m.line} [${m.item.id}]`);
          return ok((a.matches.length && a.line === a.matches[0]!.line ? lines : [a.line, ...lines]).join('\n'));
        }),
      /* ---------- read-only: the evidence behind an item (LLD §19.13) ---------- */
      tool('item_read', 'Read one item in full before you judge it: title, status, assignee, reviewer, acceptance criteria, body, its children, every comment (author, time, text, details), the last 30 activity entries and the Inbox items linked to it. ' +
        'Reviewing? Read the item first: evidence for no-code, doc and decision stories is often in its comments, activity or a linked Inbox decision (inbox_read). Takes an id (as_…/ft_…), an id inside text, or a merged id (shows the item it was merged into). Read-only.',
        { itemId: z.string() },
        async ({ itemId }) => ok(readTools.readItem(wp, itemId))),
      tool('inbox_read', 'Read the Inbox, read-only: with no itemId, the open items and those answered in the last 7 days (state: open, answered, expired or all); with an Inbox id (in_…), that item with its thread messages, its options, its recommendation and the owner\'s answer; with a work item id, the Inbox items about it. ' +
        'You never answer the owner\'s decisions: only he does. Use it to verify that a decision was filed or answered.',
        { itemId: z.string().optional(), state: z.enum(['open', 'answered', 'expired', 'all']).optional() },
        async ({ itemId, state }) => ok(readTools.readInbox(wp, { ...(itemId ? { itemId } : {}), ...(state ? { state } : {}) }))),
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

/** The reply when a block on a teammate became a review or a handoff (LLD §19.6c). */
function notBlocked(wp: Workplace, it: Item): string {
  return it.status === 'in-review'
    ? `Not blocked: waiting on a teammate's review is a review. ${it.id} is In review with ${nameOf(wp, it.reviewerId)}, who has been asked to review it.`
    : it.handoff
      ? `Not blocked: ${it.id} is handed to ${nameOf(wp, it.assigneeId)}, who works on it now; it comes back to ${nameOf(wp, it.handoff.fromId)} when they call item_handback.`
      : `Not blocked: ${it.id} is with ${nameOf(wp, it.assigneeId)} now.`;
}

/* ---------- send_file (docs/LLD-app-fixes.md §6) ---------- */

export const ROOM_POST_MAX = 600;
export const ROOM_POST_TOO_LONG = 'Not posted: Room posts are short: put the detail on the item or in a doc and link it.';

/**
 * The send_file tool's body: the file must resolve (symlinks followed) inside the agent's own
 * worktree or the Workplace's evidence folder; it is copied into the owner's thread with the agent.
 */
export function sendFileTool(wp: Workplace, employeeId: string, agentId: string): (args: { path: string; caption?: string }) => Promise<string> {
  return async ({ path, caption }) => {
    const s = sessions.get(agentId) ?? openSession(employeeId);
    const roots = [wp.config.evidence.dir, ...(s?.worktree?.path ? [s.worktree.path] : [])];
    try {
      const m = talkStore.sendFileFromAgent(wp, employeeId, { path, ...(caption ? { caption } : {}), allowedRoots: roots, agentId });
      return `Sent ${m.attachments[0]!.name} to the owner's Talk with you.`;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
}
