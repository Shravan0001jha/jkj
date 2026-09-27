import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
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
}

export interface GuardDecision {
  decision: 'allow' | 'deny';
  reason?: string;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Commands that leave the worktree, the branch, or the machine. */
export const FORBIDDEN_COMMANDS: { pattern: RegExp; why: string }[] = [
  { pattern: /\bgit\s+(push|merge|rebase|filter-repo|remote|worktree|reflog\s+expire|gc\s+--prune)\b/i, why: 'employees never push, merge, rebase or rewrite; the lead merges' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, why: 'no history rewrite' },
  { pattern: /\bgit\s+branch\s+(-D|-d|--delete)\b/i, why: 'no branch deletion' },
  { pattern: /\bgit\s+(checkout|switch)\s+(feat\/|main\b|deploy\/|site\/|local\/)/i, why: 'stay on your own emp/ branch' },
  { pattern: /release-iris|deploy-api|deploy-agent|deploy-web|deploy-workplace-relay|testflight\.sh|rollback-iris|ssh-window/i, why: 'release and deploy run only through an approved Inbox item' },
  { pattern: /(^|[\s;&|])(ssh|scp|sftp|rsync\s+[^\s]*:|aws|gh|xcrun\s+devicectl|sudo|electron-builder\s+--publish|npm\s+publish)\b/i, why: 'nothing leaves this machine or touches the owner\'s devices without the owner' },
  { pattern: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, why: 'no recursive force delete' },
  { pattern: /curl[^|;]*-X\s*(POST|PUT|DELETE)[^|;]*\/api\/(releases|proposals|inbox)/i, why: 'the Workplace API is driven by the owner, not by employees' },
];

export function guardTool(tool: string, input: Record<string, unknown>, ctx: GuardContext): GuardDecision {
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
  if (!ctx.charterIds.includes(owner.primary)) {
    return { decision: 'deny', reason: `${rel} is owned by ${owner.primary}; changes go through that charter's holder (your charters: ${ctx.charterIds.join(', ')})` };
  }
  return { decision: 'allow' };
}

export function guardCommand(command: string, ctx: GuardContext): GuardDecision {
  for (const rule of FORBIDDEN_COMMANDS) {
    if (rule.pattern.test(command)) return { decision: 'deny', reason: `"${command.slice(0, 80)}": ${rule.why}` };
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
