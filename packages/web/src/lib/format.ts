import type { RequestStage, AgentStatus, EmployeeState, Usage, WorkState } from '@jkj/shared';

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

/** Rupees, whole numbers: the cap is a whole number and the ledger is an estimate. */
export const inr = (n: number): string => `₹${Math.round(n).toLocaleString('en-IN')}`;

export const pct = (part: number, total: number): number => (total > 0 ? Math.round((part / total) * 100) : 0);

/** Which pill a session status wears. Ended sessions take the quiet one. */
export const statusTone = (status: AgentStatus): string =>
  status === 'done' ? 'idle' : status;

/**
 * Employee states reuse the four session colours: working is the running
 * teal, needs-you the amber, blocked the red, idle and paused the quiet grey.
 */
export const stateTone = (state: EmployeeState): string => ({
  idle: 'idle',
  working: 'running',
  blocked: 'error',
  'needs-owner': 'waiting',
  paused: 'idle',
} as Record<EmployeeState, string>)[state] ?? 'idle';

export const stateLabel = (state: EmployeeState): string =>
  state === 'needs-owner' ? 'needs you' : state;

export const workTone = (state: WorkState): string => ({
  stated: 'idle', specced: 'idle', decomposed: 'running', 'in-progress': 'running', built: 'done', released: 'done',
  proposed: 'idle', planned: 'running', building: 'running', review: 'waiting', done: 'done', blocked: 'error', rejected: 'error',
} as Record<WorkState, string>)[state] ?? 'idle';

export const firstLines = (text: string, n = 2): string =>
  text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, n).join(' · ');

export const uid = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

/** A request stage's tone (D16 status lines): blocked is an error, waiting stages wait, building runs. */
export const stageTone = (stage: RequestStage): string => ({
  'with-asha': 'waiting', specced: 'waiting', routed: 'idle', building: 'running', review: 'waiting', blocked: 'error', built: 'done', released: 'done',
}[stage]);
