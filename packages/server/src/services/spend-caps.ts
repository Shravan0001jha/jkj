import type { Workplace } from './workplace.js';
import type { GitHubPort, WorkflowJob, WorkflowRun } from './github-port.js';
import * as spend from './spend.js';
import * as floor from './floor.js';
import * as inbox from './inbox.js';
import * as coo from './coo.js';
import { now } from './store.js';
import { log } from '../util/logger.js';

/**
 * Hard daily spend limits (owner, 18 Oct 2026), per IST calendar day (spend.dayOf).
 *
 * 1. GitHub Actions, $5/day. Once the day's GitHub spend reaches it, the Workplace starts no GitHub
 *    Actions: every workflow dispatch through its port is refused (github-flow.gitHubPort wraps the
 *    port), run_evidence on GitHub is refused up front, and a PR waiting on mobile checks stays
 *    pending. It lifts by itself the next day, or when the owner lifts it (liftGithub).
 * 2. Agents' work, $10/day: GitHub Actions + AI/API credits (the spend ledger's anthropic-api and
 *    third-party rows). AWS is platform cost and is left out (owner, 18 Oct: the AWS budget alarm covers
 *    it). Reaching it pauses the floor, tells the COO and raises ONE owner decision straight to the
 *    owner ("Resume for today" / "Keep paused"); the next day starts unpaused.
 *
 * GitHub's billing API lags, so today's GitHub spend is the max of the billed figure (cost-watch's
 * `cost:github:<day>`, or its live poll `cost:github:live:<day>`) and an estimate from the Actions
 * minutes of the runs the Workplace itself started (each job rounded up to the minute, priced by
 * runner OS), booked once per run when it is seen completed.
 */

export const GITHUB_CAP_USD = 5;
export const COMBINED_CAP_USD = 10;
/** GitHub-hosted runner list prices, USD per minute. */
export const RATES_USD_PER_MIN = { macos: 0.062, linux: 0.006, windows: 0.010 } as const;

const EST = 'cost:github:est:';
const get = (wp: Workplace, k: string): string | undefined => (wp.db.prepare('select value from settings where key = ?').get(k) as { value: string } | undefined)?.value;
const put = (wp: Workplace, k: string, v: string): void => void wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(k, v);
const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const usd = (n: number): string => `$${n.toFixed(2)}`;
const num = (v: string | undefined): number | null => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);

/* ---------- the GitHub Actions estimate ---------- */

export function osOf(labels: string[]): keyof typeof RATES_USD_PER_MIN {
  const l = labels.join(' ').toLowerCase();
  return /mac/.test(l) ? 'macos' : /windows/.test(l) ? 'windows' : 'linux';
}

/** One job's list-price cost: its minutes rounded up, at its runner OS's rate. A job that never ran costs 0. */
export function jobCostUsd(job: WorkflowJob): number {
  if (!job.startedAt || !job.completedAt) return 0;
  const ms = Date.parse(job.completedAt) - Date.parse(job.startedAt);
  if (!(ms > 0)) return 0;
  return r3(Math.ceil(ms / 60_000) * RATES_USD_PER_MIN[osOf(job.labels)]);
}

/** Book a completed run's estimated cost on the IST day it finished; once per run id. */
export function recordRunCost(wp: Workplace, run: { id: number; workflow: string }, jobs: WorkflowJob[], nowMs = Date.now()): number {
  if (wp.db.prepare('select 1 from settings where key like ?').get(`${EST}%:${run.id}`)) return 0;
  const cost = r3(jobs.reduce((n, j) => n + jobCostUsd(j), 0));
  const ends = jobs.map(j => (j.completedAt ? Date.parse(j.completedAt) : NaN)).filter(Number.isFinite);
  const day = spend.dayOf(new Date(ends.length ? Math.max(...ends) : nowMs));
  put(wp, `${EST}${day}:${run.id}`, JSON.stringify({ usd: cost, workflow: run.workflow, jobs: jobs.length, at: now() }));
  if (cost > 0) log.info('spend-caps', `GitHub run ${run.id} (${run.workflow}): ~${usd(cost)} of Actions minutes on ${day}`);
  evaluate(wp);
  return cost;
}

export interface GithubToday { day: string; billedUsd: number | null; estimatedUsd: number; usd: number }

export function githubToday(wp: Workplace, nowMs = Date.now()): GithubToday {
  const day = spend.dayOf(new Date(nowMs));
  const billedUsd = num(get(wp, `cost:github:${day}`)) ?? num(get(wp, `cost:github:live:${day}`));
  const rows = wp.db.prepare('select value from settings where key like ?').all(`${EST}${day}:%`) as { value: string }[];
  const estimatedUsd = r3(rows.reduce((n, r) => { try { return n + Number((JSON.parse(r.value) as { usd?: number }).usd ?? 0); } catch { return n; } }, 0));
  return { day, billedUsd, estimatedUsd, usd: r3(Math.max(billedUsd ?? 0, estimatedUsd)) };
}

/* ---------- cap 1: GitHub ---------- */

export const GITHUB_PAUSED = 'GitHub Actions paused for today';

/** Null while the Workplace may start GitHub Actions today; otherwise why not, worded for the story. */
export function githubBlock(wp: Workplace, nowMs = Date.now()): { spentUsd: number; message: string } | null {
  const g = githubToday(wp, nowMs);
  if (g.usd < GITHUB_CAP_USD || get(wp, `spend-cap:github-lifted:${g.day}`)) return null;
  return { spentUsd: g.usd, message: `${GITHUB_PAUSED}: ${usd(g.usd)} spent of the ${usd(GITHUB_CAP_USD).replace('.00', '')} daily cap; resumes tomorrow or when the owner lifts it` };
}

export function liftGithub(wp: Workplace, by: string, nowMs = Date.now()): void {
  const day = spend.dayOf(new Date(nowMs));
  put(wp, `spend-cap:github-lifted:${day}`, JSON.stringify({ by, at: now() }));
  wp.db.prepare('insert into events (at, kind, subject, json) values (?, ?, ?, ?)').run(now(), 'github-cap-lifted', 'spend-cap', JSON.stringify({ day, by }));
  log.info('spend-caps', `the GitHub cap is lifted for ${day} by ${by}`);
}

export class GitHubCapError extends Error {}

/**
 * The Workplace's GitHub port with the cap applied: a dispatch past it is refused (GitHubCapError), and
 * a run seen completed is costed from its jobs, once. Every Workplace use of GitHub Actions goes through it.
 */
export function capped(wp: Workplace, port: GitHubPort): GitHubPort {
  return new Proxy(port, {
    get(target, prop, receiver) {
      if (prop === 'dispatchWorkflow') {
        return async (workflow: string, inputs: Record<string, string>): Promise<void> => {
          const b = githubBlock(wp);
          if (b) { log.warn('spend-caps', `refused ${workflow}: ${b.message}`); throw new GitHubCapError(b.message); }
          return target.dispatchWorkflow(workflow, inputs);
        };
      }
      if (prop === 'findWorkflowRun') {
        return async (workflow: string, requestId: string): Promise<WorkflowRun | null> => {
          const run = await target.findWorkflowRun(workflow, requestId);
          if (run?.status === 'completed' && target.runJobs && !wp.db.prepare('select 1 from settings where key like ?').get(`${EST}%:${run.id}`)) {
            try { recordRunCost(wp, { id: run.id, workflow }, await target.runJobs(run.id)); } catch (err) {
              log.warn('spend-caps', `could not cost GitHub run ${run.id}: ${err instanceof Error ? err.message : err}`);
            }
          }
          return run;
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/* ---------- cap 2: the agents' combined spend ---------- */

export interface CombinedUsd { github: number; anthropicApi: number; thirdParty: number; total: number }

/** Today's agents'-work spend in USD: GitHub (max of billed, estimated) + the ledger's AI/API rows. AWS excluded. */
export function combinedToday(wp: Workplace, nowMs = Date.now()): CombinedUsd {
  const day = spend.dayOf(new Date(nowMs));
  const s = spend.summary(wp, day);
  const rate = wp.config.usdInr;
  const github = githubToday(wp, nowMs).usd;
  const anthropicApi = r3((s.bySource['anthropic-api'] ?? 0) / rate);
  const thirdParty = r3((s.bySource['third-party'] ?? 0) / rate);
  return { github, anthropicApi, thirdParty, total: r3(github + anthropicApi + thirdParty) };
}

const BY = 'spend-cap';
const pausedDay = (wp: Workplace): string | undefined => get(wp, 'spend-cap:floor-day');
const ours = (wp: Workplace): boolean => floor.paused(wp) && floor.state(wp).by === BY;

/** Check both caps now. Pauses the floor on a trip; unpauses a spend pause left from an earlier day. Never throws. */
export function evaluate(wp: Workplace, nowMs = Date.now()): void {
  try {
    const day = spend.dayOf(new Date(nowMs));
    // A new day starts unpaused.
    const pd = pausedDay(wp);
    if (pd && pd !== day) {
      wp.db.prepare('delete from settings where key = ?').run('spend-cap:floor-day');
      if (ours(wp)) floor.setPaused(wp, false, `a new day (${day}): the daily spend cap starts again from $0`, BY);
      expireDecisions(wp, day, 'A new day began: the floor resumed on its own.');
    }
    const g = githubBlock(wp, nowMs);
    if (g && !get(wp, `spend-cap:github-told:${day}`)) {
      put(wp, `spend-cap:github-told:${day}`, now());
      coo.notifyStall(wp, { itemId: 'daily-spend-cap', by: 'workplace', title: `GitHub daily cap reached: ${usd(g.spentUsd)} of $5`, body: `${g.message}. Evidence runs and mobile checks on GitHub wait (PRs stay pending). Lift for today: POST /api/coo/spend-today {"liftGithubCap":true}.` });
    }
    const c = combinedToday(wp, nowMs);
    if (c.total < COMBINED_CAP_USD || get(wp, `spend-cap:tripped:${day}`)) return;
    trip(wp, day, c);
  } catch (err) {
    log.warn('spend-caps', `evaluate: ${err instanceof Error ? err.message : err}`);
  }
}

function trip(wp: Workplace, day: string, c: CombinedUsd): void {
  put(wp, `spend-cap:tripped:${day}`, now());
  const parts = `GitHub Actions ${usd(c.github)}, Anthropic API ${usd(c.anthropicApi)}, other AI/API ${usd(c.thirdParty)}`;
  const reason = `daily spend cap: ${usd(c.total)} spent of the $10 daily cap (${parts}); resumes tomorrow or when the owner resumes it`;
  if (!floor.paused(wp)) {
    floor.setPaused(wp, true, reason, BY);
    put(wp, 'spend-cap:floor-day', day);
  }
  wp.db.prepare('insert into events (at, kind, subject, json) values (?, ?, ?, ?)').run(now(), 'spend-cap-trip', 'spend-cap', JSON.stringify({ day, ...c }));
  log.warn('spend-caps', `${day}: ${reason}`);
  try {
    coo.notifyStall(wp, {
      itemId: 'daily-spend-cap', by: 'workplace',
      title: `Daily spend cap reached: ${usd(c.total)} of $10; the floor is paused`,
      body: `Today's agents' spend is ${usd(c.total)} (${parts}; AWS platform cost not counted). Nothing new starts; running turns finish. The owner was asked in his Inbox whether to resume for today. The next day starts unpaused.`,
    });
  } catch (err) { log.warn('spend-caps', `could not tell the COO: ${err instanceof Error ? err.message : err}`); }
  try {
    inbox.raise(wp, {
      kind: 'decision', raisedBy: 'workplace', urgency: 'high', skipCooHold: true,
      title: `Daily spend cap reached (${usd(c.total)} of $10): resume?`,
      body: `Today the team's work has cost ${usd(c.total)}: ${parts}. AWS platform cost is not counted. The floor is paused: nothing new starts, running turns finish, and you can still talk to anyone.\n\nResume for today: work starts again now and the cap does not pause it again today. Keep paused: it stays paused until tomorrow (IST), which starts unpaused.`,
      options: [{ id: 'resume-today', label: 'Resume for today' }, { id: 'keep-paused', label: 'Keep paused' }],
      context: { spendCap: true, day, ...c },
      dedupeKey: `spend-cap:${day}`,
    });
  } catch (err) { log.warn('spend-caps', `could not raise the owner's decision: ${err instanceof Error ? err.message : err}`); }
}

function expireDecisions(wp: Workplace, today: string, why: string): void {
  for (const i of inbox.list(wp, 'open').filter(x => x.context['spendCap'] === true && x.context['day'] !== today)) {
    try { inbox.expire(wp, i.id, why); } catch (err) { log.warn('spend-caps', `expire ${i.id}: ${err instanceof Error ? err.message : err}`); }
  }
}

/** The minute timer (rhythm), and after any real-money ledger row. */
export function tick(wp: Workplace, nowMs = Date.now()): void { evaluate(wp, nowMs); }

spend.onRecord((wp, source) => { if (source === 'anthropic-api' || source === 'third-party') evaluate(wp); });

// "Resume for today": the pause lifts for the rest of the decision's day (it is already tripped, so it stays off).
inbox.onAnswer((wp, item) => {
  if (item.context['spendCap'] !== true || item.answer?.optionId !== 'resume-today') return;
  const day = String(item.context['day'] ?? '');
  if (day !== spend.dayOf()) { log.info('spend-caps', `resume on ${item.id} came after ${day} ended: nothing to lift`); return; }
  wp.db.prepare('delete from settings where key = ?').run('spend-cap:floor-day');
  put(wp, `spend-cap:resumed:${day}`, JSON.stringify({ by: item.answer.by ?? 'owner', at: now() }));
  if (ours(wp)) floor.setPaused(wp, false, `resumed for today by ${item.answer.by === 'coo' ? 'the COO (for the owner)' : 'the owner'} after the daily spend cap`, item.answer.by === 'coo' ? 'coo' : 'owner');
});

export interface SpendToday {
  day: string;
  githubUsd: { billed: number | null; estimated: number; counted: number; capUsd: number };
  combinedUsd: CombinedUsd & { capUsd: number };
  githubBlocked: boolean;
  githubLifted: boolean;
  floorPausedBySpend: boolean;
  resumedForToday: boolean;
}

/** GET /api/coo/spend-today. */
export function today(wp: Workplace, nowMs = Date.now()): SpendToday {
  const day = spend.dayOf(new Date(nowMs));
  const g = githubToday(wp, nowMs);
  return {
    day,
    githubUsd: { billed: g.billedUsd, estimated: g.estimatedUsd, counted: g.usd, capUsd: GITHUB_CAP_USD },
    combinedUsd: { ...combinedToday(wp, nowMs), capUsd: COMBINED_CAP_USD },
    githubBlocked: githubBlock(wp, nowMs) !== null,
    githubLifted: !!get(wp, `spend-cap:github-lifted:${day}`),
    floorPausedBySpend: ours(wp) && pausedDay(wp) === day,
    resumedForToday: !!get(wp, `spend-cap:resumed:${day}`),
  };
}
