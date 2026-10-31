#!/bin/zsh
# The theme screens (docs/THEMES.md §8): every main screen of one app build, deterministic enough to
# diff pixel for pixel. Needs a mock with no scripted stream:
#   node mock/server.mjs --port 4413 --reusable-code --quiet --no-live
# Usage:
#   scripts/shots-themes.sh <app> <outdir> <light|dark> [theme] [port] [sim] [only-screen]
# theme: default | scifi (passed as WORKPLACE_THEME; a build without themes ignores it).
# Each shot starts from a fresh install and a reset mock, with the status bar pinned to 9:41.
set -e
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
APP=$1; OUT=$2; LOOK=${3:-light}; THEME=${4:-default}; PORT=${5:-4413}; SIM=${6:-iPhone 17}; ONLY=${7:-}
BUNDLE=com.irisforu.workplace
mkdir -p "$OUT"
xcrun simctl boot "$SIM" 2>/dev/null || true
xcrun simctl ui "$SIM" appearance $LOOK
xcrun simctl status_bar "$SIM" override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100 >/dev/null
MOCK=(WORKPLACE_URL=127.0.0.1:$PORT WORKPLACE_TOKEN=mock-token-0123456789abcdef WORKPLACE_NO_NOTIF_PROMPT=1 WORKPLACE_NO_DEVICE_AUTH=1)
shot() {  # name wait [ENV=VAL ...]
  local name=$1 wait=$2; shift 2
  [[ -n "$ONLY" && "$ONLY" != "$name" ]] && return 0
  curl -s -X POST 127.0.0.1:$PORT/api/_reset >/dev/null
  xcrun simctl terminate "$SIM" $BUNDLE 2>/dev/null || true
  xcrun simctl uninstall "$SIM" $BUNDLE 2>/dev/null || true
  xcrun simctl install "$SIM" "$APP"
  local envs=(SIMCTL_CHILD_WORKPLACE_THEME=$THEME)
  for kv in "$@"; do envs+=("SIMCTL_CHILD_$kv"); done
  env "${envs[@]}" xcrun simctl launch "$SIM" $BUNDLE >/dev/null
  sleep $wait
  xcrun simctl io "$SIM" screenshot "$OUT/$name-$LOOK.png" >/dev/null 2>&1 && echo "$OUT/$name-$LOOK.png"
}
shot 01-plan 6 $MOCK
shot 02-plan-board 6 $MOCK WORKPLACE_BOARD=1
shot 03-inbox 6 $MOCK WORKPLACE_TAB=inbox
shot 04-inbox-item 6 $MOCK WORKPLACE_INBOX_ITEM=in_muqel76q1h1i1
shot 05-talk-list 6 $MOCK WORKPLACE_TAB=talk
shot 06-talk-thread 7 $MOCK WORKPLACE_TALK=mira
shot 07-talk-coo 7 $MOCK WORKPLACE_TALK=coo
shot 08-room 6 $MOCK WORKPLACE_ROOM=list
shot 09-room-thread 7 $MOCK WORKPLACE_ROOM=th_epic_ft_mummakwyuew19
shot 10-dashboard 6 $MOCK WORKPLACE_TAB=dashboard
shot 11-updates 6 $MOCK WORKPLACE_TAB=updates
shot 12-settings 6 $MOCK WORKPLACE_SETTINGS=1
shot 13-item-epic 6 $MOCK WORKPLACE_ITEM=ft_mummakwyuew19
shot 14-item-story 6 $MOCK WORKPLACE_ITEM=as_muqecr89jhjst
shot 15-signin 5 WORKPLACE_RELAY_URL=127.0.0.1:$PORT WORKPLACE_FORGET=1 WORKPLACE_NO_NOTIF_PROMPT=1
shot 16-session-ended 7 WORKPLACE_RELAY_URL=127.0.0.1:$PORT WORKPLACE_TOKEN=not-a-session WORKPLACE_NO_NOTIF_PROMPT=1 WORKPLACE_NO_DEVICE_AUTH=1
xcrun simctl status_bar "$SIM" clear
