# Mac-side resilience — status (29 Sep, 02:10 IST)

Branch `iris-workplace-resilience` (worktree `~/jkj-resilience`), merged up to `babaec5` (the pid
lock, D17). Design: `docs/RESILIENCE-workplace.md`. **The manual server in `~/jkj` is untouched;
the cutover is the lead's one coordinated restart.**

## Ready

- Tunnel hardening, boot history, watchdog, `/api/health.resilience` — `RESILIENCE-workplace.md`
  §3–§5.
- launchd agent: `scripts/com.irisforu.workplace.plist.template`, `scripts/workplace-run.sh`,
  `scripts/workplace-service.sh install|uninstall|start|stop|restart|status|logs|render` — §2.
- HOWTO section "Keeping it up when nobody is at the Mac".

## Test results

- `npm test`: **142 pass, 1 fail** — `money.test.ts` "real money is recorded by source and basis"
  fails identically on the builder's own tree (`~/jkj`, `babaec5` + its uncommitted work), so it is
  pre-existing and not from this branch. The other 142 include the 20 new ones: tunnel scenarios 7,
  watchdog 9, boots 3, health 1.
- `tunnel.test.ts` (pre-existing) is load-sensitive: it failed twice while the launchd trial was
  booting a full server alongside, then passed 8 runs in a row on an idle machine. Its 20–30 ms
  sleeps and 3 s frame wait are the reason; not changed here.
- **Live launchd trial** (own label `com.irisforu.workplace.trial`, port 4318, temp data and ops
  dirs; the live server was never touched — checked before and after): a live pid holding the lock →
  the wrapper logs "waiting" and polls; holder exits → node starts within 15 s with launchd (pid 1)
  as parent, `caffeinate -i -s -w <pid>` alongside, the lock held by node's pid, `/api/health`
  answering; `kill -9` → launchd restarts it in 10 s, the old caffeinate is gone, a new one is tied
  to the new pid, boots total 2; `status` prints every section (and flags a manual start: "parent
  <pid>: a manual start, NOT launchd"); `uninstall` → SIGTERM → node gone, lock released,
  caffeinate gone, plist removed. Log lines from the trial are in `~/Library/Logs/IrisWorkplace/
  workplace.log` (02:07–02:09 IST).

## Cutover plan (one coordinated restart, the lead schedules it)

1. Builder integrates the branch; `cd ~/jkj && npm run build && npm test` (expect only the money test red).
2. `~/jkj/scripts/workplace-service.sh install` — renders, lints, loads. The wrapper sees pid
   93992 in `~/iris-workplace/workplace.lock` and waits, polling every 15 s. Nothing else changes yet.
3. Lead: `kill 93992` (the manual `node packages/server/dist/cli.js --no-open`; it stops within 20 s
   and releases the lock) and `kill 64845` (the ad-hoc `caffeinate -dimsu`).
4. Within 15 s the agent starts node. Verify: `scripts/workplace-service.sh status` → launchd
   `state = running`, node's parent is launchd, lock held by that pid, `caffeinate -i -s -w <pid>`,
   `published: connected`, watchdog quiet; the phone reaches https://work.irisforu.com.
5. `kill <node pid>` once → back within 30 s; `status` shows `boots: 2 in 24 h`, tunnel `connects ≥ 1`
   again, watchdog still quiet (the gap is under 5 min, so no ping goes to the owner).

Rollback: `scripts/workplace-service.sh uninstall`; `cd ~/jkj && npm start -- --no-open &`;
`caffeinate -dimsu &`.

## Owner's settings checklist

`RESILIENCE-workplace.md` §6. The short form: lid open, on AC; **Prevent automatic sleeping on
power adapter when the display is off → ON**; Wake for network access → ON (already); automatic
macOS updates → OFF; **after any reboot someone must log in** (FileVault on, no auto-login) — or
decide to change that.

## Residual

If the process is dead and launchd cannot restart it (no node, no build), nobody alerts; a
relay-side "Mac offline > 10 min" ping is the follow-up. `tunnel.test.ts` could use longer waits.
