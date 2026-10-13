#!/bin/bash
# The Iris Workplace under launchd (docs/RESILIENCE-workplace.md §2).
#
# launchd runs this script; it sets the environment, rotates the log, waits while another live
# Workplace holds the pid lock, keeps the Mac awake for exactly as long as it runs, and then
# becomes node (exec, same pid), so launchd's SIGTERM reaches node directly and a clean stop
# releases the lock. It never needs sudo and never changes a system setting.
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export HOME="${HOME:-/Users/$(id -un)}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG="${LANG:-en_US.UTF-8}"
# Employees run on the subscription token in ~/iris-ops/workplace/claude-oauth.env; a key here would
# turn free usage into billed usage, so it never reaches this process (HOWTO: "never reaches them").
unset ANTHROPIC_API_KEY
export IRIS_OPS_DIR="${IRIS_OPS_DIR:-$HOME/iris-ops}"
export IRIS_WORKPLACE_DIR="${IRIS_WORKPLACE_DIR:-$HOME/iris-workplace}"
export WORKPLACE_PORT="${WORKPLACE_PORT:-4317}"

LOG_DIR="$HOME/Library/Logs/IrisWorkplace"
LOG="$LOG_DIR/workplace.log"
MAX_BYTES=$((10 * 1024 * 1024))
KEEP=5
mkdir -p "$LOG_DIR"

# Copy-truncate rotation: the file stays open (O_APPEND) in node, so it is copied aside and emptied
# in place, never renamed under it. workplace.log.1 is the newest of the kept copies.
rotate() {
  local size
  size=$(stat -f %z "$LOG" 2>/dev/null || echo 0)
  [ "$size" -gt "$MAX_BYTES" ] || return 0
  local i
  for ((i = KEEP - 1; i >= 1; i--)); do [ -f "$LOG.$i" ] && mv -f "$LOG.$i" "$LOG.$((i + 1))"; done
  cp -f "$LOG" "$LOG.1" && : > "$LOG"
}

rotate
exec >> "$LOG" 2>&1
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') launchd  $*"; }

NODE="$(command -v node)" || { say "node is not on PATH ($PATH); nothing to run"; sleep 60; exit 1; }
CLI="$REPO/packages/server/dist/cli.js"
[ -f "$CLI" ] || { say "no build at $CLI (run npm run build in $REPO)"; sleep 60; exit 1; }
[ -f "$IRIS_OPS_DIR/workplace/claude-oauth.env" ] || say "warning: $IRIS_OPS_DIR/workplace/claude-oauth.env is missing; employees cannot sign in"

# One Workplace per organisation (services/lock.ts). A second copy would exit 1 and launchd would
# restart it every 30 s for as long as the first lives; waiting here is quiet, and the moment the
# other one exits (the cutover, or a stray manual start) this one takes over.
LOCK="$IRIS_WORKPLACE_DIR/workplace.lock"
waited=0
while :; do
  holder="$(head -n 1 "$LOCK" 2>/dev/null || true)"
  case "$holder" in ''|*[!0-9]*) break ;; esac
  [ "$holder" = "$$" ] && break
  kill -0 "$holder" 2>/dev/null || break
  if [ "$waited" -eq 0 ]; then say "another Workplace (pid $holder) holds $LOCK; waiting for it to exit"; waited=1; fi
  sleep 15
done
[ "$waited" -eq 1 ] && say "lock released; starting"

# Hourly rotation while running. Dies with the process group when node exits.
( while sleep 3600; do rotate; done ) &

# Awake for as long as this pid lives: no idle sleep (-i), no system sleep on AC (-s). The display
# may sleep; closing the lid is beyond any assertion (docs/RESILIENCE-workplace.md §6).
/usr/bin/caffeinate -s -w $$ &   # AC only: on battery the stay-awake daemon (30% floor) decides; -i drained the battery (12 Oct)

say "starting $NODE ($("$NODE" -v)) pid $$ in $REPO, port $WORKPLACE_PORT"
exec "$NODE" "$CLI" --no-open --port "$WORKPLACE_PORT"
