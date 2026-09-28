# Mac-side resilience — status (29 Sep, 02:35 IST)

Branch `iris-workplace-resilience` (worktree `~/jkj-resilience`). Design and the B2 RCA:
`docs/RESILIENCE-workplace.md`. **Live since 02:18 IST:** the Workplace runs under launchd
(`com.irisforu.workplace`), integrated at `c71036c` in `~/jkj`; the B2 fix below is the successor
and goes live with one launchd restart once the builder integrates it.

## Live (cutover, 29 Sep 02:17–02:20 IST)

- `scripts/workplace-service.sh install` from `~/jkj` → the wrapper waited on pid 93992's lock; the
  lead stopped 93992 and the ad-hoc `caffeinate -dimsu`; the wrapper took over within 15 s.
- Verified on the live service: `kill -9` → launchd restarted node in 1 s (runs = 2), parent pid 1,
  `caffeinate -i -s -w <pid>` alongside, lock held by the new pid, tunnel connected on the first
  attempt, watchdog quiet, `/api/health.resilience.boots` 2 total / 2 in 24 h, `/relay/health`
  mac online.

## B2 — tunnel flaps every 15–18 min: RCA closed, fix in this branch

- **Cause:** the Mac was on **battery** from 28 Sep 01:00 until it was plugged in at 01:45 on 29 Sep,
  in a sleep cycle with a DarkWake every ~16 min; every flap is a wake, the two long outages are
  sleep with no wake (`RESILIENCE-workplace.md` §9). The relay is correct; no relay change.
- **Fix:** `services/suspend.ts` (the process notices it was frozen), `tunnel.wake()` and a
  liveness check that knows it fired late → reconnect at once, log "the Mac was asleep N s" (not
  "no pong"); `services/power.ts` → `/api/health.resilience.power` (`ac | battery`, percent,
  charging) and `.sleeps` (count, last, total seconds).
- **Tests:** `suspend.test.ts` (3), B2 cases in `tunnel-resilience.test.ts` (2; the relay runs in a
  worker thread and drops the frozen Mac; three sleep/wake cycles reconnect at once with the cause
  named; a short doze keeps the socket; a retry pending across a sleep runs on wake). Stable over
  repeated runs once the test timescale was moved well above scheduler jitter (270 ms limit).

## Owner's morning checklist (the short form; §6 has the why)

1. **Plugged in.** `/api/health` → `resilience.power.source` must say `ac`. On battery the night of
   28 Sep repeats: the Mac dozes every 16 min and the phone sees "Mac offline".
2. **Lid open.** Closing it sleeps the Mac; nothing in software prevents that.
3. *Battery/Energy* → **Prevent automatic sleeping on power adapter when the display is off: ON**;
   Wake for network access: ON (already).
4. *Software Update* → automatic macOS updates: **OFF** (they reboot; after a reboot someone must log
   in, FileVault is on and there is no auto-login).
5. Glance at `resilience.sleeps.count` on the phone: it should stay at 0 overnight.

## Residual

If the process is dead and launchd cannot restart it, nobody alerts; a relay-side "Mac offline
> 10 min" ping is the follow-up. `money.test.ts` was red on the builder's tree at `babaec5`; the
builder's integration reports 162/162.
