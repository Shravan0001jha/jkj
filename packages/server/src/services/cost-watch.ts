import { execFile } from 'node:child_process';
import type { Workplace } from './workplace.js';
import * as inbox from './inbox.js';
import { istParts } from './rhythm.js';
import { underTest } from './test-guard.js';
import { log } from '../util/logger.js';

/**
 * The GitHub cost watcher (HLD §2 Services, LLD §W6.3; owner, 10 Oct: "track GitHub only for now").
 *
 * Once a day from 09:00 IST (the rhythm timer) it reads the org's GitHub billing usage for yesterday
 * and stores it as `cost:github:<day>` (USD) in settings, filling in any of the 7 days before that
 * are missing so the average is real from the first run. It raises one owner Inbox `cap` item for the
 * day when yesterday is more than 2× the 7-day average and over $1, or when the month to date is
 * ahead of the ₹5,000/month cap's pace ($84 × day/30). No email for now. Deterministic, no model.
 */

export const GITHUB_ORG = 'shravan0001jha-iris-hq';
export const RUN_AT = 9 * 60;            // 09:00 IST
export const RETRY_MS = 60 * 60_000;     // a failed fetch is tried again an hour later
export const SPIKE_FACTOR = 2;
export const SPIKE_MIN_USD = 1;
/** ₹5,000 a month (owner, 10 Oct) in dollars. */
export const MONTH_CAP_USD = 84;

export interface GitHubBillingPort {
  /** Net billed USD for the day, or for the whole month when `day` is absent. */
  usageUsd(q: { year: number; month: number; day?: number }): Promise<number>;
}

export type GhRunner = (args: string[]) => Promise<string>;

const ghCli: GhRunner = args => new Promise((resolve, reject) => {
  execFile('gh', args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) return reject(new Error(`gh ${args[0]} failed: ${String(stderr || err.message).split('\n')[0]!.slice(0, 200)}`));
    resolve(String(stdout));
  });
});

/** `gh api /organizations/<org>/settings/billing/usage?year=&month=&day=`, summing the usage items' net amount. */
export function ghBillingPort(org = GITHUB_ORG, gh: GhRunner = ghCli): GitHubBillingPort {
  return {
    async usageUsd({ year, month, day }) {
      const q = `year=${year}&month=${month}${day ? `&day=${day}` : ''}`;
      const out = await gh(['api', `/organizations/${org}/settings/billing/usage?${q}`]);
      const data = JSON.parse(out) as { usageItems?: { netAmount?: unknown }[] };
      const sum = (data.usageItems ?? []).reduce((n, i) => n + (typeof i.netAmount === 'number' ? i.netAmount : 0), 0);
      return Math.round(sum * 10_000) / 10_000;
    },
  };
}

let port: GitHubBillingPort | null = null;

/** Swap the billing port (tests); returns the restore. */
export function usePort(p: GitHubBillingPort): () => void {
  const prev = port;
  port = p;
  return () => { port = prev; };
}

/** The port in use; null under a test with no fake installed (never a real `gh` call from a test). */
function currentPort(): GitHubBillingPort | null {
  if (port) return port;
  if (underTest()) return null;
  port = ghBillingPort();
  return port;
}

const DAY_MS = 24 * 60 * 60_000;
const key = (day: string): string => `cost:github:${day}`;
const getSetting = (wp: Workplace, k: string): string | undefined => (wp.db.prepare('select value from settings where key = ?').get(k) as { value: string } | undefined)?.value;
const setSetting = (wp: Workplace, k: string, v: string): void => { wp.db.prepare('insert or replace into settings (key, value) values (?, ?)').run(k, v); };
const parts = (day: string): { year: number; month: number; day: number } => { const [y, m, d] = day.split('-').map(Number); return { year: y!, month: m!, day: d! }; };
const dayBefore = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);
const usd = (n: number): string => `$${n.toFixed(2)}`;

async function dayUsd(wp: Workplace, p: GitHubBillingPort, day: string): Promise<number> {
  const stored = getSetting(wp, key(day));
  if (stored !== undefined && Number.isFinite(Number(stored))) return Number(stored);
  const v = await p.usageUsd(parts(day));
  setSetting(wp, key(day), String(v));
  return v;
}

export interface CostCheck {
  /** Yesterday, IST. */
  day: string;
  yesterdayUsd: number;
  avgUsd: number;
  monthUsd: number;
  /** The Inbox item raised (or the one already raised today). */
  raised?: string;
}

/** Fetch, store and judge yesterday's GitHub spend. Throws when the billing API cannot be read. */
export async function check(wp: Workplace, nowMs: number, p: GitHubBillingPort): Promise<CostCheck> {
  const today = istParts(nowMs).day;
  const day = dayBefore(today, 1);
  const yesterdayUsd = await dayUsd(wp, p, day);
  const prior: number[] = [];
  for (let n = 1; n <= 7; n++) prior.push(await dayUsd(wp, p, dayBefore(day, n)));
  const avgUsd = Math.round((prior.reduce((a, b) => a + b, 0) / prior.length) * 10_000) / 10_000;
  const { year, month, day: dom } = parts(day);
  const monthUsd = await p.usageUsd({ year, month });
  setSetting(wp, `cost:github:month:${day.slice(0, 7)}`, String(monthUsd));

  const spike = yesterdayUsd > SPIKE_FACTOR * avgUsd && yesterdayUsd > SPIKE_MIN_USD;
  const pace = MONTH_CAP_USD * (dom / 30);
  const overPace = monthUsd > pace;
  const out: CostCheck = { day, yesterdayUsd, avgUsd, monthUsd };
  if (!spike && !overPace) return out;

  // One item a day, even after the owner answered it (a restart or a retry the same day says nothing new).
  const raisedKey = `cost-watch:raised:${day}`;
  const already = getSetting(wp, raisedKey);
  if (already) return { ...out, raised: already };
  const title = spike
    ? `GitHub spend jumped: ${usd(yesterdayUsd)} yesterday vs ${usd(avgUsd)} avg.`
    : `GitHub spend this month: ${usd(monthUsd)} by the ${dom}th, ahead of the ${usd(MONTH_CAP_USD)}/month pace (${usd(pace)}).`;
  const body = [
    spike ? `GitHub billed ${usd(yesterdayUsd)} on ${day}, against a 7-day average of ${usd(avgUsd)}.` : `GitHub billed ${usd(yesterdayUsd)} on ${day}.`,
    `Month to date: ${usd(monthUsd)}; the ₹5,000/month cap's pace for day ${dom} is ${usd(pace)}${overPace ? ', so the month is ahead of it' : ''}.`,
    'Actions minutes and storage are the usual causes: a new workflow, a trigger that fires on every push, or a job stuck retrying.',
  ].join(' ');
  const item = inbox.raise(wp, {
    kind: 'cap', title, body, raisedBy: 'workplace',
    context: { source: 'github', costDay: day, yesterdayUsd, avgUsd, monthUsd },
    dedupeKey: `cost:github:${day}`,
    options: [{ id: 'seen', label: 'Seen' }],
    onApprove: 'nothing is paused; the alert is closed',
    onDeny: 'nothing is paused; the alert is closed',
    summary: title,
  });
  setSetting(wp, raisedKey, item.id);
  log.info('cost-watch', title);
  return { ...out, raised: item.id };
}

/**
 * Called every minute by the rhythm timer: from 09:00 IST, once per IST day. A failed fetch (gh not
 * signed in, the API down) is logged and tried again an hour later. Returns the check when one ran.
 */
export async function maybeRun(wp: Workplace, nowMs = Date.now(), given?: GitHubBillingPort): Promise<CostCheck | null> {
  const { day, minutes } = istParts(nowMs);
  if (minutes < RUN_AT) return null;
  if (getSetting(wp, `cost-watch:done:${day}`)) return null;
  const last = Number(getSetting(wp, 'cost-watch:attempt') ?? NaN);
  if (Number.isFinite(last) && nowMs - last < RETRY_MS && nowMs >= last) return null;
  const p = given ?? currentPort();
  if (!p) return null;
  setSetting(wp, 'cost-watch:attempt', String(nowMs));
  try {
    const r = await check(wp, nowMs, p);
    setSetting(wp, `cost-watch:done:${day}`, new Date(nowMs).toISOString());
    return r;
  } catch (err) {
    log.warn('cost-watch', `GitHub billing not read: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
