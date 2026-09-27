# Mac-side resilience — status (28 Sep, end of day)

Branch `iris-workplace-resilience` (worktree `~/jkj-resilience`), merged up to `babaec5` (the pid
lock, D17). **Nothing here is live. The manual server in `~/jkj` is untouched; no cutover tonight.**

## Ready (in code, typechecks)

- **Tunnel hardening** (`packages/server/src/services/tunnel.ts`): backoff 1 s → 30 s cap (pinned by
  a test of the exact sequence); handshake timeout 15 s so a hung connect after wake is abandoned;
  silence > 45 s = half-open socket → drop and reconnect; one error logged per attempt (the abort
  that follows an error is no longer logged as a second error); the direct-DNS resolver is made per
  attempt so a Wi-Fi change (new nameservers) is picked up; injectable `lookup`, `pongTimeoutMs`,
  `handshakeTimeoutMs` for tests; `tunnel.stats` (attempts, connects, lastConnectedAt,
  lastDisconnectedAt, lastError, downForSeconds, backoffMs, half-open count).
- **Boot history** (`services/boots.ts`): every start counted in the settings table; crash-loop rule
  = 3 starts in 10 min; a persisted "already alerted" mark.
- **Watchdog** (`services/watchdog.ts`): tunnel not connected > 5 min → one "tunnel down" ping,
  retried once a minute until delivered; one "tunnel back" ping on recovery (or one combined "was
  down N min" ping if the down ping never got out); the owner's `off` and an unconfigured tunnel are
  not incidents; crash loop → one "restarting repeatedly" ping, one "stable again" after 15 min up;
  the mark stops the next restart from pinging again. Wired in `index.ts` through
  `telegram.notify` (the Workplace's own automatic alert path).
- **Health** (`/api/health` → `resilience`): `startedAt`, `uptimeSeconds`, `boots {total, last24h,
  recent}`, `tunnel` stats, `watchdog` state.

## Tests written, not yet green

- `test/watchdog.test.ts` (9 cases), `test/boots.test.ts` (3), `test/resilience-health.test.ts` (1),
  `test/tunnel-resilience.test.ts` (7: relay restart, half-open socket, DNS failure then recovery,
  long outage with capped backoff, hung handshake, backoff sequence, stop during outage).
- Last run: one watchdog assertion wrong in the *test* (it expects `recoveredAt` at the end of the
  advance, the code records it at the first connected tick — the code is right, the test needs the
  earlier timestamp). The tunnel-resilience run did not finish in five minutes (something holds the
  event loop open; suspect the hung-handshake or long-outage case leaving a socket). Neither has been
  investigated; nothing was committed as passing. `npm test` for the rest of the suite was not run.

## Not started

- launchd user agent (`~/Library/LaunchAgents/com.irisforu.workplace.plist`), the run wrapper
  (`caffeinate -i -s -w $$` then `exec node`, logs to `~/Library/Logs/IrisWorkplace/` with
  copy-truncate rotation, waits while another live pid holds `workplace.lock`), and
  `scripts/workplace-service.sh install|uninstall|status|logs`. Design settled, no file written.
- The design note `docs/RESILIENCE-workplace.md` that the code comments reference.
- HOWTO section.

## Cutover plan (when the lead schedules it)

1. `npm run build` in `~/jkj` after merging this branch; `npm test` green.
2. `scripts/workplace-service.sh install --no-load` renders and lints the plist.
3. Lead stops the manual server (`kill <pid of node packages/server/dist/cli.js>`; it exits within
   20 s and releases `~/iris-workplace/workplace.lock`) and the ad-hoc `caffeinate -dimsu` (pid 64845).
4. `scripts/workplace-service.sh install` bootstraps the agent; `status` shows launchd state, lock
   holder, `/api/health`, caffeinate assertion; the phone reaches https://work.irisforu.com.
5. Kill the process once on purpose and watch launchd bring it back within the 30 s throttle.

The agent and a manual server cannot coexist (the lock refuses the second one; the wrapper waits
rather than crash-looping), so step 3 must come before step 4.

## Owner's macOS settings checklist (never changed by us; read from `pmset -g` today)

- **FileVault is on and there is no auto-login.** A LaunchAgent runs only once the user is logged
  in: after any reboot (power cut, macOS update) the Mac sits at the login screen and nothing
  starts. Decide: enable *Users & Groups → Automatic login* (macOS refuses it while FileVault is on;
  turning FileVault off is a real security trade-off), or accept that a reboot needs a person.
- *System Settings → Battery/Energy*: **Prevent automatic sleeping on power adapter when the display
  is off: ON** (today `sleep 1` — the Mac sleeps after one idle minute; only `caffeinate` is holding
  it up). **Wake for network access: ON** (already `womp 1`). Low Power Mode: off (`lowpowermode 0`,
  fine). Put hard disks to sleep: off.
- *Lid*: this is a laptop with only the built-in display. **Closing the lid sleeps it and no
  caffeinate can stop that.** Leave the lid open, plugged in; let the display sleep (the managed
  `caffeinate -i -s` keeps the system up while the display is off — today's `-dimsu` keeps the screen
  lit all day). Clamshell operation needs power + an external display + a keyboard/mouse.
- *General → Software Update → Automatic updates*: **Install macOS updates: OFF** (they reboot).
- *Lock Screen*: "Require password after sleep or screen saver begins" can stay on; the agent keeps
  running behind the lock screen.
- Keep the Mac on Wi-Fi with a saved network it rejoins by itself; the tunnel handles the rest.

## Known residual

If the process is fully dead and launchd cannot restart it (no node, throttle), nobody alerts: the
watchdog lives inside the process. A relay-side "Mac offline > 10 min" ping would cover it; the relay
has no Telegram of its own today. Follow-up, not in this branch.
