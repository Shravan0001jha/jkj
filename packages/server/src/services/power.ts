import { execFile } from 'node:child_process';

/**
 * Is the Mac on the power adapter? (B2, 29 Sep: it spent a night on battery, where nothing can hold
 * it awake, and the tunnel flapped with every DarkWake.) Read from `pmset -g batt` once a minute
 * and shown on /api/health, so the phone can tell "the tunnel is down" from "the laptop is
 * unplugged". Never changes anything.
 */

export interface PowerState {
  source: 'ac' | 'battery' | 'unknown';
  percent: number | null;
  charging: boolean | null;
  readAt: string | null;
}

export function parsePmset(text: string): PowerState {
  const source = /drawing from 'AC Power'/i.test(text) ? 'ac' : /drawing from 'Battery Power'/i.test(text) ? 'battery' : 'unknown';
  const pct = /(\d{1,3})%/.exec(text);
  const charging = /;\s*(charging|discharging|charged|finishing charge|AC attached; not charging)/i.exec(text);
  return {
    source,
    percent: pct ? Number(pct[1]) : null,
    charging: charging ? /^charging|^charged|^finishing/i.test(charging[1]!) : null,
    readAt: new Date().toISOString(),
  };
}

export class PowerMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private _state: PowerState = { source: 'unknown', percent: null, charging: null, readAt: null };

  constructor(private readonly read: () => Promise<string> = pmsetBatt) {}

  get state(): PowerState {
    return this._state;
  }

  start(intervalMs = 60_000): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<PowerState> {
    try { this._state = parsePmset(await this.read()); } catch { /* not a Mac, or pmset missing: stays unknown */ }
    return this._state;
  }
}

function pmsetBatt(): Promise<string> {
  if (process.platform !== 'darwin') return Promise.resolve('');
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/pmset', ['-g', 'batt'], { timeout: 5_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}
