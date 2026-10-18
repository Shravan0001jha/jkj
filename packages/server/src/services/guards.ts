import { homedir, tmpdir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import type { MapEntry } from '@jkj/shared';
import { resolve as resolveOwner } from './ownership.js';

/**
 * What a session may touch, decided before the tool runs (a PreToolUse hook).
 *
 * Edits stay inside the employee's worktree and inside the paths its charters
 * own. Commands never push, merge or rebase, never run release or deploy
 * scripts, never reach a remote machine, and never name a main checkout.
 * Everything outward still goes through the Workplace's gates, not a prompt.
 */

export interface GuardContext {
  worktree: string;
  /** The repo id of the worktree (map keys are "<repoId>:<rel>"). */
  repoId: string;
  charterIds: string[];
  map: MapEntry[];
  /** Absolute roots of every main checkout: never to be touched. */
  mainCheckouts: string[];
  /**
   * Set while the employee is paused by a spend cap and the owner is only talking: reads and
   * answers are fine, edits and commands are not until the owner says "continue".
   */
  readOnly?: string;
  /**
   * The owner's approved live-check window for this employee, as an absolute ms timestamp
   * (POST /api/coo/live-window). While `Date.now()` is before it, a host command that would
   * otherwise be denied as driving the real Mac is allowed instead. Unset (the default) means
   * no window is open: live checks go through the COO, not the session.
   */
  liveWindowUntil?: number;
  /**
   * RCA before code (owner, 10 Oct), from the session's story: `until-rca` for a bug with no RCA yet,
   * `rca-only` for an RCA ticket (never code), `none` otherwise. While not `none`, edits and git
   * commit/add are denied. Read live (a getter at spawn), so an assignment change or a captured RCA
   * applies at once.
   */
  rcaGate?: RcaGate;
}

export type RcaGate = 'none' | 'until-rca' | 'rca-only';

/** The gate for a story: an RCA ticket never writes code; a bug writes code once its RCA is on record. */
export function rcaGateFor(item: { type?: string; rca?: unknown } | undefined): RcaGate {
  if (!item) return 'none';
  if (item.type === 'rca') return 'rca-only';
  if (item.type === 'bug' && !item.rca) return 'until-rca';
  return 'none';
}

export const RCA_FIRST = 'RCA first: post a 5-part "## RCA" comment on the story before changing code';
export const RCA_ONLY = 'This is an RCA ticket: no code changes; post the RCA and report_done';
const GIT_WRITE = /\bgit\s+(-C\s+\S+\s+)?(commit|add)\b/i;

export interface GuardDecision {
  decision: 'allow' | 'deny';
  reason?: string;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * The owner's personal folders: off limits to the Workplace outright, even to read, whatever the
 * charter or the worktree says (found live, 1 Oct: many macOS permission prompts attributed to
 * `node`, the Workplace under launchd, while an employee worked on an unrelated bug). No exception
 * path here on purpose — the live-check window below applies only to host *commands*, never to
 * these paths.
 */
const PROTECTED_RELATIVE = [
  'Documents', 'Desktop', 'Downloads', 'Pictures', 'Movies', 'Music',
  'Library/Mail', 'Library/Messages', 'Library/Calendars',
  'Library/Application Support/AddressBook', 'Library/Containers',
  // Secrets and the owner's own Iris profile (5 Oct: an employee read a long-lived account token from
  // ~/iris-ops/state and wrote it into a /tmp log). Test plumbing secrets stay with the COO.
  'iris-ops', 'Library/Application Support/Iris', '.aws', '.ssh', '.claude',
];

const PROTECTED_ABS = PROTECTED_RELATIVE.map(rel => resolve(homedir(), rel));

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `~/Documents`, `$HOME/Documents`, or the real absolute path, in a shell command. */
const PROTECTED_COMMAND_PATTERN = new RegExp(
  `(~|\\$HOME|${escapeRe(homedir())})/(${PROTECTED_RELATIVE.map(escapeRe).join('|')})(/|\\b)`, 'i',
);

/** The resolved path is inside (or is) one of the owner's personal folders. */
function touchesProtectedFolder(abs: string): string | undefined {
  return PROTECTED_ABS.find(folder => abs === folder || abs.startsWith(folder + sep));
}

/**
 * Commands that drive the owner's real Mac rather than the employee's own sandboxed work: these
 * are denied unless an approved live-check window is open for this employee (POST
 * /api/coo/live-window), because a live check belongs to the COO, not to an unattended session.
 */
export const HOST_COMMANDS: { pattern: RegExp; why: string }[] = [
  { pattern: /(^|[\s;&|])(osascript|afplay|say|screencapture|pmset|caffeinate|killall|launchctl|tccutil|networksetup|automator|security)\b/i,
    why: 'this drives the owner\'s real Mac; use the test fakes, and a live check goes through the COO (POST /api/coo/live-window)' },
  { pattern: /(^|[\s;&|])open\b/i,
    why: 'this launches an app or a URL on the owner\'s real Mac; use the test fakes, and a live check goes through the COO' },
  { pattern: /\bdefaults\s+write\b/i,
    why: 'this changes the owner\'s real Mac settings; use the test fakes, and a live check goes through the COO' },
  { pattern: /\bshortcuts\s+run\b/i,
    why: 'this runs a Shortcut on the owner\'s real Mac; use the test fakes, and a live check goes through the COO' },
  // Only RUNNING a service counts: the binary as the command, or the live server entry point. A path
  // that merely names the folder (`cd services/agent-svc && pytest`, `ls services/agent-svc`) is work.
  { pattern: /(^|[;&|(]|&&|\|\|)\s*(\S*\/)?(iris-agent|agent-svc|memory-svc|llm-gateway)(\s|$|[;&|)])|Iris(Workplace)?\.app/i,
    why: 'this runs the Iris app or an agent binary directly on the owner\'s real Mac; use the test fakes, and a live check goes through the COO' },
  { pattern: /\bpython[\d.]*\s+(-u\s+)?(\S*\/)?app\.py\b|(^|[\s;&|\/])uvicorn\b/i,
    why: 'this starts a live Iris service on the owner\'s real Mac (its ports clash with the running Iris); run the tests instead, and a live check goes through the COO' },
];

/** Commands that leave the worktree, the branch, or the machine. */
export const FORBIDDEN_COMMANDS: { pattern: RegExp; why: string }[] = [
  { pattern: /\bgit\s+(push|merge|rebase|filter-repo|remote|worktree|reflog\s+expire|gc\s+--prune)\b/i, why: 'employees never push, rebase or rewrite, and merge only the trunk (feat/...) into their own branch; the lead merges into the trunk' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, why: 'no history rewrite' },
  { pattern: /\bgit\s+branch\s+(-D|-d|--delete)\b/i, why: 'no branch deletion' },
  { pattern: /\bgit\s+(checkout|switch)\s+(feat\/|main\b|deploy\/|site\/|local\/)/i, why: 'stay on your own emp/ branch' },
  { pattern: /release-iris|deploy-api|deploy-agent|deploy-web|deploy-workplace-relay|testflight\.sh|rollback-iris|ssh-window/i, why: 'release and deploy run only through an approved Inbox item' },
  { pattern: /(^|[\s;&|])(ssh|scp|sftp|rsync\s+[^\s]*:|aws|gh|xcrun\s+devicectl|sudo|electron-builder\s+--publish|npm\s+publish)\b/i, why: 'nothing leaves this machine or touches the owner\'s devices without the owner' },
  { pattern: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, why: 'no recursive force delete' },
  { pattern: /curl[^|;]*-X\s*(POST|PUT|DELETE)[^|;]*\/api\/(releases|proposals|inbox)/i, why: 'the Workplace API is driven by the owner, not by employees' },
];

/**
 * The subagent types an employee may start (owner, 17 Oct: long work goes to the background). The
 * session defines both itself (employees.ts SUBAGENTS), so a repo's own .claude/agents cannot widen
 * them; built-ins like `fork` or a project agent with its own permission mode are refused.
 */
export const SUBAGENT_TYPES = ['general-purpose', 'Explore'] as const;
/** The subagent tool's name, and its older name. */
export const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

/** A subagent runs in the session's own worktree, with the session's guards: never isolated elsewhere. */
export function guardSubagent(input: Record<string, unknown>): GuardDecision {
  if (input['isolation'] !== undefined) return { decision: 'deny', reason: `isolation "${String(input['isolation'])}" would run it outside your worktree; subagents work in your own worktree` };
  const type = input['subagent_type'];
  if (type !== undefined && !(SUBAGENT_TYPES as readonly string[]).includes(String(type))) {
    return { decision: 'deny', reason: `subagent type "${String(type)}" is not one of ${SUBAGENT_TYPES.join(', ')}` };
  }
  return { decision: 'allow' };
}

export function guardTool(tool: string, input: Record<string, unknown>, ctx: GuardContext): GuardDecision {
  if (SUBAGENT_TOOLS.has(tool)) return guardSubagent(input);
  if (ctx.readOnly && (EDIT_TOOLS.has(tool) || tool === 'Bash')) return { decision: 'deny', reason: ctx.readOnly };
  // The gate is read only for a write (it may be a live getter on the session's story).
  if (EDIT_TOOLS.has(tool) || (tool === 'Bash' && GIT_WRITE.test(String(input['command'] ?? '')))) {
    const gate = ctx.rcaGate ?? 'none';
    if (gate !== 'none') return { decision: 'deny', reason: gate === 'rca-only' ? RCA_ONLY : RCA_FIRST };
  }
  // Protected folders are off limits even to read, for every tool that names a file (no exception path).
  if (tool === 'Read' || EDIT_TOOLS.has(tool)) {
    const filePath = String(input['file_path'] ?? input['notebook_path'] ?? '');
    const hit = filePath ? touchesProtectedFolder(resolve(ctx.worktree, filePath)) : undefined;
    if (hit) return { decision: 'deny', reason: `${resolve(ctx.worktree, filePath)} is in ${hit}, a protected folder; off limits to the Workplace even to read` };
  }
  if (EDIT_TOOLS.has(tool)) return guardEdit(String(input['file_path'] ?? input['notebook_path'] ?? ''), ctx);
  if (tool === 'Bash') return guardCommand(String(input['command'] ?? ''), ctx);
  return { decision: 'allow' };
}

export function guardEdit(filePath: string, ctx: GuardContext): GuardDecision {
  if (!filePath) return { decision: 'deny', reason: 'no path given' };
  const abs = resolve(ctx.worktree, filePath);
  if (touchesMain(abs, ctx.mainCheckouts)) return { decision: 'deny', reason: `${abs} is in a main checkout; work only in your worktree ${ctx.worktree}` };
  const rel = relative(resolve(ctx.worktree), abs);
  const inside = rel !== '' && !rel.startsWith('..') && !rel.startsWith('/');
  // Inside the worktree the map decides; outside it only scratch space is free.
  if (!inside) return isScratch(abs) ? { decision: 'allow' } : { decision: 'deny', reason: `${abs} is outside your worktree ${ctx.worktree}` };
  const owner = resolveOwner(ctx.map, { kind: 'path', key: `${ctx.repoId}:${rel}` });
  if (!owner) return { decision: 'deny', reason: `${rel} is owned by nobody in the map; ask the Chief of Staff to add it before changing it` };
  // Contributors edit too (3 Oct: app.py is a shared hub; four stories in a day needed a hand-off
  // only because edit rights stopped at the primary). Consulted charters still only review.
  if (!ctx.charterIds.includes(owner.primary) && !owner.contributors.some(c => ctx.charterIds.includes(c))) {
    return { decision: 'deny', reason: `${rel} is owned by ${owner.primary}; changes go through that charter's holder (your charters: ${ctx.charterIds.join(', ')})` };
  }
  return { decision: 'allow' };
}

/**
 * Bringing the trunk INTO your own emp/ branch is allowed (3 Oct: a branch cut before a trunk merge
 * could not catch up, and that stalled a story). Checking out a trunk is forbidden, so the branch
 * merged into is always the employee's own. Those merges (with ordinary flags, -m, a 2>&1), --abort,
 * --continue and the read-only merge-base are blanked out before the forbidden rules run, so
 * anything else in the same command is still judged.
 */
const TRUNK_MERGE = /\bgit\s+(-C\s+\S+\s+)?merge(\s+(--no-edit|--no-ff|--ff-only|--ff|--no-commit|--stat|-q|--quiet|-m\s+("[^"]*"|'[^']*'|\S+)))*\s+(origin\/)?feat\/[\w.\/-]+(\s+(--no-edit|--no-ff|--no-commit|-m\s+("[^"]*"|'[^']*'|\S+)))*(?=\s*(\d?>&?\d|\d?>\s*\S+)?\s*($|[;&|)]))/gi;
const MERGE_SAFE = /\bgit\s+(-C\s+\S+\s+)?merge(-base\b|\s+--(abort|continue)\b)/gi;
export function withoutTrunkMerges(command: string): string {
  return command.replace(TRUNK_MERGE, 'true').replace(MERGE_SAFE, 'true');
}

/**
 * Editing a deploy/release script is ordinary reviewed work (18 Oct: a one-line fix to deploy-agent.sh
 * could not be committed). The names inside git add/commit/diff/log/show/status/restore/blame
 * arguments (quoted text included) are blanked before the deploy rule runs; running a script is not.
 */
const GIT_NON_EXEC = /\bgit\s+(?:-C\s+\S+\s+)?(?:add|commit|diff|log|show|status|restore|blame|rm|mv|stash)\b(?:"[^"]*"|'[^']*'|[^;&|\n"'])*/gi;
const DEPLOY_WORDS = /release-iris|deploy-api|deploy-agent|deploy-web|deploy-workplace-relay|testflight\.sh|rollback-iris|ssh-window/gi;
export function withoutScriptEdits(command: string): string {
  return command.replace(GIT_NON_EXEC, m => m.replace(/"[^"]*"|'[^']*'/g, '""').replace(DEPLOY_WORDS, 'script'));
}

export function guardCommand(command: string, ctx: GuardContext): GuardDecision {
  if (PROTECTED_COMMAND_PATTERN.test(command)) {
    return { decision: 'deny', reason: `"${command.slice(0, 80)}": a protected folder; off limits to the Workplace even to read` };
  }
  const judged = withoutScriptEdits(withoutTrunkMerges(command));
  for (const rule of FORBIDDEN_COMMANDS) {
    if (rule.pattern.test(judged)) return { decision: 'deny', reason: `"${command.slice(0, 80)}": ${rule.why}` };
  }
  for (const rule of HOST_COMMANDS) {
    if (!rule.pattern.test(command)) continue;
    if (ctx.liveWindowUntil && Date.now() < ctx.liveWindowUntil) return { decision: 'allow' };
    return { decision: 'deny', reason: `"${command.slice(0, 80)}": ${rule.why}` };
  }
  for (const root of ctx.mainCheckouts) {
    if (command.includes(root)) return { decision: 'deny', reason: `the command names ${root}, a main checkout; use your worktree ${ctx.worktree}` };
  }
  return { decision: 'allow' };
}

function touchesMain(abs: string, mains: string[]): boolean {
  return mains.some(root => abs === resolve(root) || abs.startsWith(resolve(root) + '/'));
}

function isScratch(abs: string): boolean {
  const t = resolve(tmpdir());
  return abs.startsWith(t + '/') || abs.startsWith('/tmp/') || abs.startsWith('/private/tmp/');
}
