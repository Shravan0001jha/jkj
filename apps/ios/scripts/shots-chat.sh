#!/bin/zsh
# Chat notifications screens (docs/CHAT-NOTIFY-CONTRACT.md §6): the Talk list with a muted row,
# the chat header, the profile (employee and COO) and a room thread (rooms are muted by default).
# Needs a mock with Talk threads and no scripted stream:
#   node mock/server.mjs --port 4433 --talk-threads --reusable-code --quiet --no-live
# Usage: scripts/shots-chat.sh <app> <outdir> <light|dark> [theme] [port] [sim]
set -e
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
APP=$1; OUT=$2; LOOK=${3:-light}; THEME=${4:-default}; PORT=${5:-4433}; SIM=${6:-iPhone 18 Pro}
BUNDLE=com.irisforu.workplace
mkdir -p "$OUT"
xcrun simctl boot "$SIM" 2>/dev/null || true
xcrun simctl ui "$SIM" appearance $LOOK
xcrun simctl status_bar "$SIM" override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100 >/dev/null
MOCK=(WORKPLACE_URL=127.0.0.1:$PORT WORKPLACE_TOKEN=mock-token-0123456789abcdef WORKPLACE_NO_NOTIF_PROMPT=1 WORKPLACE_NO_DEVICE_AUTH=1)
shot() {  # name wait [ENV=VAL ...]
  local name=$1 wait=$2; shift 2
  curl -s -X POST 127.0.0.1:$PORT/api/_reset >/dev/null
  # Asha muted forever, the COO for 8 hours.
  curl -s -X POST -d '{"threadId":"asha","muted":true}' 127.0.0.1:$PORT/api/_chat/prefs >/dev/null
  curl -s -X POST -d "{\"threadId\":\"coo\",\"muted\":true,\"mutedUntil\":\"$(date -u -v+8H +%Y-%m-%dT%H:%M:%S.000Z)\"}" 127.0.0.1:$PORT/api/_chat/prefs >/dev/null
  xcrun simctl terminate "$SIM" $BUNDLE 2>/dev/null || true
  xcrun simctl uninstall "$SIM" $BUNDLE 2>/dev/null || true
  xcrun simctl install "$SIM" "$APP"
  local envs=(SIMCTL_CHILD_WORKPLACE_THEME=$THEME)
  for kv in "$@"; do envs+=("SIMCTL_CHILD_$kv"); done
  env "${envs[@]}" xcrun simctl launch "$SIM" $BUNDLE >/dev/null
  sleep $wait
  xcrun simctl io "$SIM" screenshot "$OUT/$name-$THEME-$LOOK.png" >/dev/null 2>&1 && echo "$OUT/$name-$THEME-$LOOK.png"
}
shot 01-talk-list 7 $MOCK WORKPLACE_TAB=talk
shot 02-chat-header 7 $MOCK WORKPLACE_TALK=asha
shot 03-profile-asha 8 $MOCK WORKPLACE_CHAT_PROFILE=asha
shot 04-profile-coo 8 $MOCK WORKPLACE_CHAT_PROFILE=coo
shot 05-room-thread 7 $MOCK WORKPLACE_ROOM=th_epic_ft_mummakwyuew19
xcrun simctl status_bar "$SIM" clear
