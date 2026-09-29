# Mac-side resilience — the Workplace stays up with nobody at the Mac

The owner leaves the laptop at home and runs everything from the phone through
https://work.irisforu.com. So the Workplace on the Mac must start itself, keep only one copy
running, keep the Mac awake, survive every network change, tell the owner when it cannot, and show
the phone how it is doing. HLD, LLD and the tests in one note; the owner's settings and the cutover
at the end.

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| R1 | A **launchd user agent** (`~/Library/LaunchAgents/com.irisforu.workplace.plist`), `KeepAlive`, `ThrottleInterval` 30 s. No daemon, no sudo. | Restart-on-crash and start-at-login are launchd's job; a user agent needs no privileges and runs in the owner's session, where the Claude Code state and the Keychain are. |
| R2 | launchd runs a **wrapper** that `exec`s node, so node has the job's pid. | SIGTERM from launchd reaches node directly: a clean stop closes sessions and releases the pid lock. |
| R3 | The wrapper **waits** while another live pid holds `workplace.lock`; it does not exit. | A second copy would exit 1 and launchd would restart it every 30 s for as long as the first lives. Waiting is quiet, and takes over the moment the other exits (the cutover). |
| R4 | **Awake** = `caffeinate -i -s -w <node pid>` started by the wrapper: no idle sleep, no system sleep on AC, for exactly as long as node lives. The display may sleep. | One assertion tied to the process, gone when it is. Today's ad-hoc `caffeinate -dimsu` keeps the screen lit all day and outlives everything. |
| R5 | Logs in `~/Library/Logs/IrisWorkplace/`, **copy-truncate** rotation at 10 MB, five kept, checked at start and hourly. | The file stays open in node with O_APPEND; copying it aside and emptying it in place is the only rotation that needs no signal and no sudo (`newsyslog` is root's). |
| R6 | Tunnel: backoff **1 s → 30 s cap**, handshake timeout 15 s, silence > 45 s = half-open socket → drop, one logged error per attempt, DNS resolver made per attempt. | Every state a laptop goes through (sleep/wake, Wi-Fi change, DNS not there yet, relay restart) ends in one of: refused, hung, silent. Each has a bounded recovery. |
| R7 | **Watchdog inside the process**: tunnel not connected > 5 min → one Telegram ping; one "back" ping; crash loop (3 starts in 10 min) → one ping, one "stable" ping. Through `telegram.notify` (the Workplace's own automatic path). | The only thing the owner cannot see from the phone is *why* the phone says "Mac offline". One message per incident, never a stream. |
| R8 | **Health**: `/api/health.resilience` = startedAt, uptime, boots (total, last 24 h, recent), tunnel stats, watchdog state. Boot history in the settings table. | The phone can show it; nothing new to store or secure. |
| R9 | We **never change a macOS setting**; the owner's list is §6. | Not ours to change; some (FileVault, auto-login) are security decisions. |

Residual: if the process is fully dead and launchd cannot bring it back (no node, no build), nobody
alerts, because the watchdog lives in the process. A relay-side "Mac offline > 10 min" ping would
cover it; the relay has no Telegram of its own today. Follow-up.

## 2. The launchd agent (`scripts/`)

- `com.irisforu.workplace.plist.template` → rendered by `workplace-service.sh install` with the repo
  path, `$HOME`, port, data and ops directories. `RunAtLoad`, `KeepAlive` (any exit → restart),
  `ThrottleInterval 30`, `ExitTimeOut 25` (SIGTERM, then SIGKILL; the CLI exits by itself 20 s after a
  stop that hangs), `ProcessType Interactive` (not `Background`, which is CPU/IO-throttled and this
  process drives agents). `EnvironmentVariables`: `HOME`, `PATH`
  (`/opt/homebrew/bin:/usr/local/bin:~/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`), `WORKPLACE_PORT`,
  `IRIS_WORKPLACE_DIR`, `IRIS_OPS_DIR`. `StandardOut/ErrorPath` → `launchd.log`, only for what happens
  before the wrapper can write its own log.
- `workplace-run.sh` (the wrapper): sets the same environment, **`unset ANTHROPIC_API_KEY`** (the
  subscription token file `~/iris-ops/workplace/claude-oauth.env` is read by `employees.ts`; a key
  would turn free usage into billed usage), rotates, `exec >> workplace.log`, checks node and the
  build (sleeps 60 s and exits 1 otherwise, so launchd's throttle is the retry), warns if the token
  file is missing, waits on the lock (R3, 15 s poll), starts the hourly rotation loop and
  `caffeinate -i -s -w $$`, then `exec node packages/server/dist/cli.js --no-open --port $PORT`.
- `workplace-service.sh install [--no-load] | uninstall | start | stop | restart | status | logs [-f]
  | render`. `status` prints: launchd state/pid/last exit, every `dist/cli.js` process and whether its
  parent is launchd (a manual start is flagged), the lock holder and whether it is alive, caffeinate
  processes and the sleep assertions, a one-line reading of `/api/health.resilience`, the last five
  log lines. Exit 1 when not loaded, not running or not answering, so it can be scripted.
  Overrides for a trial copy: `WORKPLACE_LABEL`, `WORKPLACE_PORT`, `IRIS_WORKPLACE_DIR`, `IRIS_OPS_DIR`.
- Only one copy: `services/lock.ts` (D17, the builder's) refuses a start while a live pid holds
  `<workplaceDir>/workplace.lock`; the wrapper waits instead of tripping it. A launchd copy and a
  manual `npm start` cannot coexist, by design.

## 3. The tunnel (`services/tunnel.ts`)

| Situation | What the Mac sees | Recovery |
|---|---|---|
| Relay restart / deploy | socket closed, then ECONNREFUSED | `close` → schedule; retries 1, 2, 4, 8, 16, 30, 30… s; connects when the relay is back |
| Sleep → wake, Wi-Fi change | socket "open" but nothing arrives (half-open) | liveness every 15 s: no frame for 45 s → `terminate()` → reconnect. Counted in `stats.reconnects.halfOpen` |
| DNS failure (new network, resolver not ready, negative cache) | ENOTFOUND | direct query to the nameservers with an OS fallback; the `Resolver` is made per attempt so new nameservers are used; retried with the same backoff; logged once per run of the same error |
| Network up, nothing answers (captive portal, black hole) | handshake never completes | `handshakeTimeout` 15 s → error → reconnect |
| Long outage | hours of refused connects | backoff stays at the cap (30 s); one log line per attempt; `stats.attempts` counts |
| Owner's `off` | — | not a failure: no reconnect, no alert |

Errors: `ws` emits a second error ("closed before the connection was established") for the abort
that follows the first; one error per attempt is recorded and logged. `stats`: `attempts`,
`connects`, `lastConnectedAt`, `lastDisconnectedAt`, `lastError` (null once connected),
`downForSeconds`, `backoffMs`, `reconnects.halfOpen`. Options for tests: `pongTimeoutMs`,
`livenessIntervalMs`, `handshakeTimeoutMs`, `lookup`, `logger`, `onAttempt`.

## 4. The watchdog (`services/watchdog.ts`)

Ticks every 30 s (first tick at boot). State: `link` (tunnel status or `not-configured`),
`downSince`, `incident {since, alertedAt, recoveredAt}`, `last`, `incidents`, `crashLoop`.

Tunnel: away from `connected` for 5 min → incident opens → "tunnel down" ping. A ping that
`notify` could not deliver (the Mac has no internet at all) is retried once a minute until it is;
it is still the one ping. Connected again → "tunnel back after N min" ping, or, if the down ping
never got out, one combined "was down N min" ping; the incident closes when that ping is delivered.
Down again before the recovery ping went out → the same incident continues. `off` and
`not-configured` are never incidents; an open one ends quietly.

Crash loop: at the first tick, `boots.isCrashLoop` (≥ 3 starts in 10 min) → "restarting repeatedly"
ping; `crashloop-alerted-at` is written to the settings table so the *next* process in the same loop
(within an hour) stays quiet. The process that stays up 15 min sends "stable again" and clears the
mark. A mark older than an hour does not suppress a new loop.

Both go through `telegram.notify`, 3–5 lines, which is the Workplace's own automatic alert path.

## 5. Boots and health (`services/boots.ts`, `/api/health`)

`recordBoot` at every `start()`: `boots-total`, `boots-recent` (newest 50) in `settings`.
`/api/health` gains `resilience: { startedAt, uptimeSeconds, boots: { total, last24h, recent[5] },
tunnel: TunnelStats | null, watchdog: WatchdogState }`. Nothing in it is a path or a secret, so it is
fine off loopback through the relay.

## 6. The owner's macOS settings (read from `pmset -g` on 28 Sep; we change none of them)

- **FileVault is on, no auto-login.** A user agent runs only once someone is logged in: after any
  reboot (power cut, macOS update) the Mac waits at the login screen and nothing starts until a
  person signs in. Options: *Users & Groups → Automatic login* (macOS refuses it while FileVault is
  on; turning FileVault off is a real security trade-off for a laptop), or accept that a reboot
  needs a person. Our recommendation: keep FileVault, accept the reboot rule, and turn off automatic
  macOS updates so reboots are rare and chosen.
- *Battery / Energy*: **Prevent automatic sleeping on power adapter when the display is off → ON**
  (today `sleep 1`: the Mac sleeps after one idle minute; only caffeinate holds it up).
  **Wake for network access → ON** (already `womp 1`). Low Power Mode off (`lowpowermode 0`, fine).
- **The lid stays open.** This is a laptop with only the built-in display; closing the lid sleeps it
  and no assertion prevents that. Let the display sleep (it does, under `-i -s`). Clamshell needs
  power + an external display + a keyboard or mouse.
- *General → Software Update → Automatic Updates*: **Install macOS updates → OFF** (they reboot).
- *Lock Screen*: "Require password after sleep" may stay on; the agent runs behind the lock screen.
- Wi-Fi: a saved network the Mac rejoins by itself; the tunnel handles the rest.

## 7. Cutover (the lead schedules it; one coordinated restart)

1. Builder merges `iris-workplace-resilience`; `npm run build` in `~/jkj`; `npm test` green.
2. `scripts/workplace-service.sh install` — renders, lints and loads the agent. It starts, sees the
   manual server's pid in the lock, logs "waiting", and polls every 15 s.
3. The lead stops the manual server (`kill <pid of node packages/server/dist/cli.js>`; it exits
   within 20 s and releases the lock) and the ad-hoc `caffeinate -dimsu`.
4. Within 15 s the agent's wrapper takes the lock and starts node; `status` shows launchd as the
   parent, the lock held by that pid, `caffeinate -i -s -w`, `/api/health` answering, the tunnel
   connected; the phone reaches https://work.irisforu.com.
5. Verify: `kill <node pid>` once → launchd restarts it (immediately, or within the 30 s throttle);
   the tunnel reconnects; the watchdog stays quiet (no incident: the gap is under 5 min).

Rollback: `scripts/workplace-service.sh uninstall`, then `cd ~/jkj && npm start -- --no-open` and the
old `caffeinate -dimsu &`.

## 8. Tests (`packages/server/test/`)

- `tunnel-resilience.test.ts` — a fake relay on a fixed port that can restart, go silent, or be
  replaced by a TCP black hole: relay restart; half-open socket; DNS failure then recovery (injected
  `lookup`, the error logged once); long outage with capped backoff and return; hung handshake
  abandoned and retried; the exact backoff sequence 1, 2, 4, 8, 16, 30, 30, 30 s; `stop()` during an
  outage leaves nothing running.
- `watchdog.test.ts` — fake clock and fake `notify`: a blip under 5 min is silent; one down ping,
  silence for an hour, one back ping, a second incident is a second pair; undelivered pings retried
  once a minute and counted once; recovered before delivery → one combined ping; `off` and
  `not-configured` never alert and close an incident quietly; crash loop → one ping, the next restart
  quiet, stable after 15 min → one ping; two starts or three spread over a day are not a loop; a
  stale mark does not suppress a new loop; the state shape the health check shows.
- `boots.test.ts` — count and the newest-50 list; boots within a window; the crash-loop rule; the
  mark persists and clears.
- `resilience-health.test.ts` — the real server over HTTP: boots, start time, tunnel and watchdog
  in `/api/health`; a restart of the same organisation is boot #2.
- The scripts are exercised live: an isolated trial agent (`WORKPLACE_LABEL=…trial`, port 4318,
  temp data and ops dirs) proves lock-wait, takeover, kill → restart, caffeinate, and clean
  uninstall without touching the live server. Recorded in `RESILIENCE-status.md`.

## 9. B2 — the tunnel flapped every 15–18 min (RCA, 29 Sep)

**What QA saw** (`/private/tmp/workplace-server.log`, 28–29 Sep): `no pong for 45 s; reconnecting`
at 21:17, 21:35, 21:53, 22:10, 22:30, 22:45, 23:04, 23:13, 23:30 …; back in 1–2 s, except
22:10:05 → 22:18:08 and 00:52:46 → 00:59:51 fully offline.

**What the relay does:** `app.py keepalive()` pings every 15 s; `tunnel.py drop_stale()` closes a Mac
that has not answered for 45 s. The Mac (7a3b916, in the live build) counts any relay frame as
life and drops the socket after 45 s of silence. The two rules match; the relay is not the cause.

**What actually happened:** `pmset -g log` shows the Mac on **battery** from 28 Sep 01:00 until
"USB-C_plug … Using AC" at 01:45 on 29 Sep, in a sleep cycle: a DarkWake every ~16 min
(`dasd SleepService`, 2–150 s each), otherwise asleep with TCP keepalive offloaded. Every flap is a
wake: 21:35:11, 21:53:32, 22:10:01, 22:30:39, 22:45:54, 23:04:34, 23:13:50 … On each wake node's
liveness interval fires, sees > 45 s since the last frame (the relay had already dropped the socket),
logs "no pong" and reconnects in 1–2 s; then the Mac sleeps again. The two long outages are sleep
stretches with no wake at all: the reconnect timer scheduled at 22:10:05 ("in 1 s") fired at
22:18:08, because the process was frozen. `caffeinate -s` is inert on battery, and `-i` cannot stop
a Mac that is already in its sleep cycle, so no software could have held it up.

**Fix (this branch):**
- `services/suspend.ts` — a tick every 5 s; a tick 15 s or more late is a resume. Count, last time,
  last and total seconds on `/api/health.resilience.sleeps`.
- `tunnel.wake(gapMs)` — after a sleep longer than the relay's limit the socket is dropped and
  reconnected **at once** (instead of up to 15 s later, when the liveness interval would notice), the
  backoff starts over, and the log says the true cause: "the Mac was asleep 485 s". A pending retry
  runs immediately. Shorter dozes keep the socket. Counted in `tunnel.stats.reconnects.afterSleep`.
- `services/power.ts` — `pmset -g batt` once a minute → `/api/health.resilience.power`
  (`ac | battery | unknown`, percent, charging). The phone can now tell "unplugged" from "down".
- Tests: `suspend.test.ts` (freeze the thread with `Atomics.wait`; a fake clock replays the
  485 s sleep); `tunnel-resilience.test.ts` "B2" (the relay in a worker thread keeps pinging and
  drops the frozen Mac; three sleep/wake cycles → three immediate reconnects, cause logged, backoff
  at the minimum; a short doze keeps the socket; a retry pending across a sleep runs on wake).

**No relay change needed.** Optional nicety for the relay owner: log the drop reason with the
stale age, so its journal shows "stale 493 s" next to the Mac's "asleep 485 s".

**What only the owner can fix:** the Mac must be on the adapter with "Prevent automatic sleeping on
power adapter when the display is off" on (§6). On battery the night repeats, now with the health
check saying so.
