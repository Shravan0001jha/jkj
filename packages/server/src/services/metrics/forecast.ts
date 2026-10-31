/** LLD-dashboard §4: a plain pace forecast. No history means no forecast, never a made-up date. */

const DAY = 86_400_000;
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
};
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function forecast(remaining: number, cycleDays: number[], people: number, fixedDays: number, now: number): { p50: string | null; p90: string | null } {
  if (remaining === 0) return { p50: iso(now + fixedDays * DAY), p90: iso(now + fixedDays * DAY) };
  if (!cycleDays.length) return { p50: null, p90: null };
  const n = Math.max(1, people);
  const days = (c: number) => Math.ceil((remaining * c) / n) + fixedDays;
  return { p50: iso(now + days(pct(cycleDays, 0.5)) * DAY), p90: iso(now + days(pct(cycleDays, 0.9)) * DAY) };
}

/**
 * Throughput forecast (owner-facing): remaining stories at the feature's own finish rate over the last 14 days.
 * The worst case assumes 60% of that rate. A feature that finished nothing in 14 days has no forecast: it is stalled.
 */
export function throughputForecast(remaining: number, doneLast14: number, fixedDays: number, now: number): { p50: string | null; p90: string | null } {
  if (remaining === 0) return { p50: iso(now + fixedDays * DAY), p90: iso(now + fixedDays * DAY) };
  if (doneLast14 <= 0) return { p50: null, p90: null };
  const rate = doneLast14 / 14;
  return { p50: iso(now + (Math.ceil(remaining / rate) + fixedDays) * DAY), p90: iso(now + (Math.ceil(remaining / (rate * 0.6)) + fixedDays) * DAY) };
}
