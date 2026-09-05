import type { AgentStatus, McpHealth, Usage } from '@jkj/shared';

/** Formatting helpers. Pure functions only — no React, no state. */

export const hhmm = (iso: string): string => new Date(iso).toTimeString().slice(0, 8);

export function ago(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 2_592_000) return `${Math.floor(s / 86_400)}d`;
  return `${Math.floor(s / 2_592_000)}mo`;
}

export const totalTokens = (u: Usage): number => u.inputTokens + u.outputTokens;

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export const fmtCost = (usd: number): string => `$${usd.toFixed(2)}`;

/** Rough enough for a budget bar. The server owns the real count. */
export const estimateTokens = (text: string): number => Math.round(text.length / 3.6);

/** Status drives the stripe on a card and the dot in a list. */
export const statusColor: Record<AgentStatus, string> = {
  running: 'var(--run)',
  waiting: 'var(--wait)',
  done: 'var(--done)',
  error: 'var(--err)',
  idle: 'var(--line-strong)',
};

/** MCP health maps onto the same three semantic colours as agent status. */
export const healthPill: Record<McpHealth, { cls: string; label: string }> = {
  healthy: { cls: 'done', label: 'healthy' },
  degraded: { cls: 'waiting', label: 'degraded' },
  unreachable: { cls: 'error', label: 'unreachable' },
  starting: { cls: 'waiting', label: 'starting' },
  // Nothing has connected to it, so nothing is claimed about it.
  unknown: { cls: 'idle', label: 'not probed' },
};

export const slugify = (task: string): string =>
  task.toLowerCase().split(/\s+/).slice(0, 3).join('-').replace(/[^a-z0-9-]/g, '') || 'agent';

export const uid = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
