#!/bin/bash
# Install, remove and inspect the Iris Workplace launchd agent (docs/RESILIENCE-workplace.md §2).
#
#   workplace-service.sh install [--no-load]   render the plist, lint it, load it (unless --no-load)
#   workplace-service.sh uninstall             unload it and remove the plist (the Workplace stops)
#   workplace-service.sh start | stop          load / unload without touching the plist
#   workplace-service.sh restart               stop node; launchd starts it again at once
#   workplace-service.sh status                launchd, process, lock, caffeinate, /api/health, log tail
#   workplace-service.sh logs [-f]             the server log
#
# No sudo anywhere: it is a user agent in ~/Library/LaunchAgents. Overrides for a trial copy:
#   WORKPLACE_LABEL, WORKPLACE_PORT, IRIS_WORKPLACE_DIR, IRIS_OPS_DIR.
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${WORKPLACE_LABEL:-com.irisforu.workplace}"
PORT="${WORKPLACE_PORT:-4317}"
WORKPLACE_DIR="${IRIS_WORKPLACE_DIR:-$HOME/iris-workplace}"
OPS_DIR="${IRIS_OPS_DIR:-$HOME/iris-ops}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/IrisWorkplace"
DOMAIN="gui/$(id -u)"
TEMPLATE="$REPO/scripts/com.irisforu.workplace.plist.template"

usage() { sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2; }

render() {
  sed -e "s|__LABEL__|$LABEL|g" -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" -e "s|__PORT__|$PORT|g" \
      -e "s|__WORKPLACE_DIR__|$WORKPLACE_DIR|g" -e "s|__OPS_DIR__|$OPS_DIR|g" "$TEMPLATE"
}

loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

cmd_install() {
  local load=1
  [ "${1:-}" = "--no-load" ] && load=0
  [ -f "$REPO/packages/server/dist/cli.js" ] || { echo "no build at $REPO/packages/server/dist/cli.js; run: cd $REPO && npm run build" >&2; exit 1; }
  command -v node >/dev/null || { echo "node is not on PATH" >&2; exit 1; }
  mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
  render > "$PLIST"
  plutil -lint "$PLIST" >/dev/null || { echo "rendered plist does not lint: $PLIST" >&2; exit 1; }
  chmod 644 "$PLIST"
  echo "wrote $PLIST"
  if [ "$load" -eq 1 ]; then
    if loaded; then echo "already loaded; reloading (this restarts the Workplace)"; launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null; sleep 1; fi
    launchctl bootstrap "$DOMAIN" "$PLIST" && launchctl enable "$DOMAIN/$LABEL" && echo "loaded $LABEL into $DOMAIN"
  else
    echo "not loaded (--no-load); load with: $0 start"
  fi
}

cmd_uninstall() {
  if loaded; then launchctl bootout "$DOMAIN/$LABEL" && echo "unloaded $LABEL"; fi
  [ -f "$PLIST" ] && rm -f "$PLIST" && echo "removed $PLIST"
  return 0
}

cmd_start() {
  [ -f "$PLIST" ] || { echo "no plist at $PLIST; run: $0 install" >&2; exit 1; }
  loaded && { echo "already loaded"; return 0; }
  launchctl bootstrap "$DOMAIN" "$PLIST" && launchctl enable "$DOMAIN/$LABEL" && echo "loaded $LABEL"
}

cmd_stop() {
  loaded || { echo "not loaded"; return 0; }
  launchctl bootout "$DOMAIN/$LABEL" && echo "unloaded $LABEL (it will not restart until: $0 start)"
}

cmd_restart() {
  loaded || { echo "not loaded; run: $0 start" >&2; exit 1; }
  launchctl kickstart -k "$DOMAIN/$LABEL" && echo "restarted $LABEL"
}

cmd_logs() {
  if [ "${1:-}" = "-f" ]; then tail -n 50 -f "$LOG_DIR/workplace.log"; else tail -n 100 "$LOG_DIR/workplace.log"; fi
}

cmd_status() {
  local rc=0
  echo "== launchd ($DOMAIN/$LABEL)"
  if loaded; then
    launchctl print "$DOMAIN/$LABEL" | awk '/^\tstate = |^\tpid = |^\tlast exit code = |^\truns = /{gsub(/^\t/, "  "); print}'
  else
    echo "  not loaded ($( [ -f "$PLIST" ] && echo "plist present at $PLIST" || echo "no plist" ))"; rc=1
  fi

  echo "== processes (node packages/server/dist/cli.js)"
  local pids; pids="$(pgrep -f 'packages/server/dist/cli.js' || true)"
  if [ -z "$pids" ]; then echo "  none running"; rc=1; else
    for p in $pids; do
      local ppid; ppid="$(ps -o ppid= -p "$p" | tr -d ' ')"
      if [ "$ppid" = "1" ]; then echo "  pid $p (parent launchd) $(ps -o etime= -p "$p" | tr -d ' ') up"; else echo "  pid $p (parent $ppid: a manual start, NOT launchd)"; fi
    done
  fi

  echo "== lock ($WORKPLACE_DIR/workplace.lock)"
  local lock="$WORKPLACE_DIR/workplace.lock"
  if [ -f "$lock" ]; then
    local holder; holder="$(head -n 1 "$lock")"
    if kill -0 "$holder" 2>/dev/null; then echo "  held by pid $holder since $(sed -n 2p "$lock")"; else echo "  stale (pid $holder is dead); the next start takes it"; fi
  else echo "  free"; fi

  echo "== caffeinate"
  local caf; caf="$(pgrep -fl 'caffeinate' || true)"
  if [ -z "$caf" ]; then echo "  none: the Mac may idle-sleep"; else echo "$caf" | sed 's/^/  /'; fi
  pmset -g assertions 2>/dev/null | grep -E '^ *PreventUserIdleSystemSleep|^ *PreventSystemSleep ' | sed 's/^ */  /'

  echo "== /api/health (http://127.0.0.1:$PORT)"
  local body; body="$(curl -s --max-time 4 "http://127.0.0.1:$PORT/api/health" || true)"
  if [ -z "$body" ]; then echo "  no answer on port $PORT"; rc=1; else
    printf '%s' "$body" | node -e '
      let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
        const h = JSON.parse(s); const r = h.resilience ?? {}; const t = r.tunnel; const w = r.watchdog ?? {};
        const ago = iso => iso ? `${Math.round((Date.now() - Date.parse(iso)) / 60000)} min ago` : "never";
        console.log(`  published: ${h.workplace?.published}   uptime: ${Math.round((r.uptimeSeconds ?? h.uptimeSeconds) / 60)} min   boots: ${r.boots?.total ?? "?"} total, ${r.boots?.last24h ?? "?"} in 24 h`);
        if (t) console.log(`  tunnel: ${t.status}, last connect ${ago(t.lastConnectedAt)}, ${t.connects} connects / ${t.attempts} attempts${t.lastError ? `, last error: ${t.lastError}` : ""}`);
        console.log(`  watchdog: ${w.incident ? `INCIDENT since ${w.incident.since} (alerted ${w.incident.alertedAt ?? "not yet"})` : "quiet"}; ${w.incidents ?? 0} incidents this process${w.crashLoop?.alertedAt ? `; crash loop alerted ${w.crashLoop.alertedAt}` : ""}`);
      });'
  fi

  echo "== log ($LOG_DIR/workplace.log)"
  tail -n 5 "$LOG_DIR/workplace.log" 2>/dev/null | sed 's/^/  /' || echo "  none yet"
  return $rc
}

# The cloud server (Linux, 17 Oct): the same verbs over a systemd --user unit, iris-workplace.service
# (unit file: iris-ops/aws/systemd/). Linger is on, so it runs with nobody logged in.
if [ "$(uname -s)" != Darwin ]; then
  U=iris-workplace.service
  case "${1:-}" in
    install) systemctl --user daemon-reload && systemctl --user enable --now "$U" && echo "enabled and started $U" ;;
    uninstall) systemctl --user disable --now "$U" && echo "disabled $U" ;;
    start) systemctl --user start "$U" && echo "started $U" ;;
    stop) systemctl --user stop "$U" && echo "stopped $U (it will not restart until: $0 start)" ;;
    restart) systemctl --user restart "$U" && echo "restarted $U" ;;
    status) systemctl --user --no-pager status "$U" | head -12
            curl -s -m 5 "http://localhost:${WORKPLACE_PORT:-4317}/api/health" >/dev/null && echo "  api: up" || echo "  api: not answering" ;;
    logs) tail -n "${2:-50}" "$HOME/.local/state/iris-workplace/logs/workplace.log" ;;
    *) usage ;;
  esac
  exit $?
fi

case "${1:-}" in
  install) cmd_install "${2:-}" ;;
  uninstall) cmd_uninstall ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  logs) cmd_logs "${2:-}" ;;
  render) render ;;
  *) usage ;;
esac
