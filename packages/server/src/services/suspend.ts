/**
 * The process noticing it was frozen (B2, 29 Sep). When the Mac sleeps, node's timers stop with it;
 * on wake the next timer fires late by the length of the sleep. A tick every 5 s that sees itself
 * arriving 15 s or more late is a resume. The tunnel uses it to reconnect at once and to log the
 * true cause ("the Mac was asleep 485 s") instead of "no pong for 45 s", and the health check shows
 * the count so a Mac that keeps dozing (on battery, lid closed) is visible from the phone.
 */

export interface SuspendState {
  count: number;
  lastAt: string | null;
  lastSeconds: number;
  totalSeconds: number;
}

export interface SuspendOptions {
  intervalMs?: number;
  /** A tick this much later than due is a suspend, not scheduler jitter. */
  thresholdMs?: number;
  now?: () => number;
}

export const SUSPEND_INTERVAL_MS = 5_000;
export const SUSPEND_THRESHOLD_MS = 15_000;

export class SuspendDetector {
  private readonly intervalMs: number;
  private readonly thresholdMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private listeners = new Set<(gapMs: number) => void>();
  private count = 0;
  private lastAt: number | null = null;
  private lastMs = 0;
  private totalMs = 0;

  constructor(options: SuspendOptions = {}) {
    this.intervalMs = options.intervalMs ?? SUSPEND_INTERVAL_MS;
    this.thresholdMs = options.thresholdMs ?? SUSPEND_THRESHOLD_MS;
    this.now = options.now ?? Date.now;
  }

  get state(): SuspendState {
    return {
      count: this.count,
      lastAt: this.lastAt === null ? null : new Date(this.lastAt).toISOString(),
      lastSeconds: Math.round(this.lastMs / 1000),
      totalSeconds: Math.round(this.totalMs / 1000),
    };
  }

  /** Called after every resume with how long the process was frozen. */
  onResume(listener: (gapMs: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.timer) return;
    this.lastTick = this.now();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One tick; exposed for tests that drive the clock by hand. */
  tick(): void {
    const now = this.now();
    const late = now - this.lastTick - this.intervalMs;
    this.lastTick = now;
    if (late < this.thresholdMs) return;
    this.count += 1;
    this.lastAt = now;
    this.lastMs = late;
    this.totalMs += late;
    for (const l of this.listeners) { try { l(late); } catch { /* a listener's failure is its own */ } }
  }
}
