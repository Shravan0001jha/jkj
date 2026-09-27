import type { TunnelStatus } from './tunnel.js';
import type { BootMarks } from './boots.js';
import { isCrashLoop } from './boots.js';
import { log } from '../util/logger.js';

/**
 * The watchdog (docs/RESILIENCE-workplace.md §4). It watches two things the owner cannot see from
 * the phone once the laptop is at home: the tunnel to the relay, and whether the process keeps
 * dying. Each is reported through the Workplace's own Telegram path, as an automatic health ping:
 * one message when the incident is real (the tunnel down for more than five minutes; three starts
 * in ten minutes), one when it is over. Never a third. A ping that cannot leave the Mac (no
 * internet at all) is retried once a minute until it can; it still counts as the one ping.
 */

export type Link = TunnelStatus | 'not-configured';

export interface Incident {
  since: string;
  alertedAt: string | null;
  recoveredAt: string | null;
}

export interface WatchdogState {
  link: Link;
  downSince: string | null;
  /** The open incident, once the outage has lasted long enough to be one. */
  incident: Incident | null;
  /** The last closed incident. */
  last: Incident | null;
  incidents: number;
  crashLoop: { alertedAt: string | null; stableAt: string | null };
}

export interface WatchdogDeps {
  link: () => Link;
  /** Sends one Telegram message; resolves false when it could not be sent. */
  notify: (text: string) => Promise<boolean>;
  now?: () => number;
  /** The tunnel must be away from 'connected' this long before it is an incident. */
  downAfterMs?: number;
  /** An undelivered ping is tried again after this long. */
  retryMs?: number;
  /** Boot history and the crash-loop mark; without it only the tunnel is watched. */
  boots?: BootMarks;
  /** After a crash-loop ping, this long up without dying is "stable". */
  stableAfterMs?: number;
  bootedAt?: number;
}

export const DOWN_AFTER_MS = 5 * 60_000;
export const RETRY_MS = 60_000;
export const STABLE_AFTER_MS = 15 * 60_000;
export const TICK_MS = 30_000;

export class Watchdog {
  private readonly now: () => number;
  private readonly downAfterMs: number;
  private readonly retryMs: number;
  private readonly stableAfterMs: number;
  private readonly bootedAt: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;

  private link: Link = 'not-configured';
  private downSince: number | null = null;
  private incident: (Incident & { lastTry: number | null; recoveredNeedsPing: boolean }) | null = null;
  private last: Incident | null = null;
  private incidents = 0;
  private crash: { alertedAt: string | null; stableAt: string | null; lastTry: number | null; stablePending: boolean; checked: boolean } =
    { alertedAt: null, stableAt: null, lastTry: null, stablePending: false, checked: false };

  constructor(private readonly deps: WatchdogDeps) {
    this.now = deps.now ?? Date.now;
    this.downAfterMs = deps.downAfterMs ?? DOWN_AFTER_MS;
    this.retryMs = deps.retryMs ?? RETRY_MS;
    this.stableAfterMs = deps.stableAfterMs ?? STABLE_AFTER_MS;
    this.bootedAt = deps.bootedAt ?? this.now();
  }

  get state(): WatchdogState {
    const strip = (i: typeof this.incident): Incident | null => (i ? { since: i.since, alertedAt: i.alertedAt, recoveredAt: i.recoveredAt } : null);
    return {
      link: this.link,
      downSince: this.downSince === null ? null : iso(this.downSince),
      incident: strip(this.incident),
      last: this.last,
      incidents: this.incidents,
      crashLoop: { alertedAt: this.crash.alertedAt, stableAt: this.crash.stableAt },
    };
  }

  start(intervalMs = TICK_MS): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One look at the world. Safe to call from a timer and from a test; never overlaps itself. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.run().catch(err => log.warn('watchdog', String(err))).finally(() => { this.ticking = null; });
    return this.ticking;
  }

  private async run(): Promise<void> {
    const now = this.now();
    await this.watchTunnel(now);
    await this.watchBoots(now);
  }

  private async watchTunnel(now: number): Promise<void> {
    this.link = this.deps.link();
    // Nothing published, or the owner switched it off: not an outage. An open incident ends quietly.
    if (this.link === 'not-configured' || this.link === 'off') {
      this.downSince = null;
      if (this.incident) { this.incident.recoveredAt = iso(now); this.close(); }
      return;
    }

    if (this.link !== 'connected') {
      this.downSince ??= now;
      if (this.incident?.recoveredAt) {
        // Down again while the "back" ping was still undelivered: the same incident continues.
        this.incident.recoveredAt = null;
        this.incident.recoveredNeedsPing = false;
      }
      if (!this.incident && now - this.downSince >= this.downAfterMs) {
        this.incident = { since: iso(this.downSince), alertedAt: null, recoveredAt: null, lastTry: null, recoveredNeedsPing: false };
        log.warn('watchdog', `tunnel down since ${this.incident.since}`);
      }
      if (this.incident && !this.incident.alertedAt && this.due(this.incident.lastTry, now)) {
        this.incident.lastTry = now;
        const minutes = Math.round((now - this.downSince) / 60_000);
        if (await this.deps.notify(`Iris Workplace · tunnel down\nThe Mac has not reached the relay for ${minutes} min (since ${clock(this.downSince)} IST). The phone shows "Mac offline" until it reconnects.`)) {
          this.incident.alertedAt = iso(now);
        }
      }
      return;
    }

    // Connected.
    const wasDownSince = this.downSince;
    this.downSince = null;
    if (!this.incident) return;
    if (!this.incident.recoveredAt) {
      this.incident.recoveredAt = iso(now);
      this.incident.recoveredNeedsPing = true;
      this.incident.lastTry = null;
      log.info('watchdog', `tunnel back after ${Math.round((now - Date.parse(this.incident.since)) / 60_000)} min`);
    }
    if (this.incident.recoveredNeedsPing && this.due(this.incident.lastTry, now)) {
      this.incident.lastTry = now;
      const since = Date.parse(this.incident.since);
      const minutes = Math.round((Date.parse(this.incident.recoveredAt) - since) / 60_000);
      const text = this.incident.alertedAt
        ? `Iris Workplace · tunnel back\nReconnected after ${minutes} min down (since ${clock(since)} IST).`
        : `Iris Workplace · tunnel was down\nDown ${minutes} min (${clock(since)}–${clock(Date.parse(this.incident.recoveredAt))} IST), reconnected on its own.`;
      if (await this.deps.notify(text)) this.close();
    }
    void wasDownSince;
  }

  private close(): void {
    if (!this.incident) return;
    this.last = { since: this.incident.since, alertedAt: this.incident.alertedAt, recoveredAt: this.incident.recoveredAt };
    this.incident = null;
    this.incidents += 1;
  }

  private async watchBoots(now: number): Promise<void> {
    const boots = this.deps.boots;
    if (!boots) return;
    if (!this.crash.checked) {
      this.crash.checked = true;
      const history = boots.history();
      const alerted = boots.crashLoopAlertedAt();
      const alertedRecently = alerted !== null && now - Date.parse(alerted) <= 60 * 60_000;
      if (alertedRecently) {
        // An earlier process in this loop already pinged: this one only reports if it lives.
        this.crash.alertedAt = alerted;
        this.crash.stablePending = true;
      } else if (isCrashLoop(history, now)) {
        this.crash.stablePending = true;
        this.crash.alertedAt = null;
        log.warn('watchdog', `crash loop: ${history.recent.length} recent starts`);
      } else {
        return;
      }
    }
    if (this.crash.stablePending && !this.crash.alertedAt && this.due(this.crash.lastTry, now)) {
      this.crash.lastTry = now;
      const starts = boots.history().recent.filter(t => now - Date.parse(t) <= 10 * 60_000).length;
      if (await this.deps.notify(`Iris Workplace · restarting repeatedly\n${starts} starts in the last 10 min; launchd keeps bringing it back. On the Mac: scripts/workplace-service.sh status, then logs.`)) {
        this.crash.alertedAt = iso(now);
        boots.markCrashLoop(this.crash.alertedAt);
        this.crash.lastTry = null;
      }
    }
    if (this.crash.stablePending && this.crash.alertedAt && now - this.bootedAt >= this.stableAfterMs && this.due(this.crash.lastTry, now)) {
      this.crash.lastTry = now;
      if (await this.deps.notify(`Iris Workplace · stable again\nUp for ${Math.round(this.stableAfterMs / 60_000)} min without a restart.`)) {
        this.crash.stableAt = iso(now);
        this.crash.stablePending = false;
        boots.markCrashLoop(null);
      }
    }
  }

  private due(lastTry: number | null, now: number): boolean {
    return lastTry === null || now - lastTry >= this.retryMs;
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
}
