import { execFile } from 'node:child_process';
import type { Workplace } from './workplace.js';
import * as spend from './spend.js';
import { log } from '../util/logger.js';

/**
 * AWS actuals, once a day (HLD D9b). Cost Explorer is itself billed per request (about ₹1), so
 * this runs at most once per day for the previous IST day, records its own cost, and replaces
 * that day's AWS estimates with the metered figure, labelled "unattributed": AWS does not know
 * which employee's deploy caused a byte of transfer.
 */

export type CostFetcher = (start: string, end: string) => Promise<number>;

/** `aws ce get-cost-and-usage` through the CLI the ops scripts already use. Returns USD. */
export const cliFetcher: CostFetcher = (start, end) => new Promise((resolve, reject) => {
  execFile('aws', ['ce', 'get-cost-and-usage', '--time-period', `Start=${start},End=${end}`, '--granularity', 'DAILY', '--metrics', 'UnblendedCost', '--output', 'json'],
    { timeout: 30_000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const data = JSON.parse(String(stdout)) as { ResultsByTime?: { Total?: { UnblendedCost?: { Amount?: string } } }[] };
        resolve(Number(data.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount ?? 0));
      } catch (e) { reject(e); }
    });
});

/** Fetch yesterday's actual if it has not been fetched. Returns the ₹ recorded, or null. */
export async function reconcileYesterday(wp: Workplace, fetcher: CostFetcher = cliFetcher, today = spend.dayOf()): Promise<number | null> {
  const yesterday = new Date(new Date(`${today}T00:00:00+05:30`).getTime() - 24 * 3600 * 1000);
  const day = spend.dayOf(yesterday);
  if (wp.db.prepare('select 1 from settings where key = ?').get(`aws-actual:${day}`)) return null;
  const end = today;
  let usd: number;
  try {
    usd = await fetcher(day, end);
  } catch (err) {
    log.warn('aws-cost', `could not fetch ${day}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
  const inr = usd * wp.config.usdInr;
  spend.reconcile(wp, day, 'aws', inr, `AWS actual ${day} (unattributed; Cost Explorer)`);
  // The lookup itself costs money; say so.
  spend.record(wp, { employeeId: 'workplace', source: 'aws', basis: 'metered', what: 'Cost Explorer request', inr: 0.01 * wp.config.usdInr, detail: { usd: 0.01 } });
  wp.db.prepare('insert into settings (key, value) values (?, ?)').run(`aws-actual:${day}`, String(inr));
  log.info('aws-cost', `${day}: $${usd.toFixed(2)} = ₹${inr.toFixed(0)} recorded as the day's AWS actual`);
  return inr;
}
