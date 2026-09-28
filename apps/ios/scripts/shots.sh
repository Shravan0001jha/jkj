#!/bin/zsh
# Screenshot every screen on the simulator against the mock server (make mock).
#   scripts/shots.sh ["iPhone 17"] [outdir]
set -e
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
SIM=${1:-iPhone 17}; OUT=${2:-shots}; mkdir -p "$OUT"
BUNDLE=com.irisforu.workplace
APP=build/dd/Build/Products/Debug-iphonesimulator/IrisWorkplace.app
xcrun simctl boot "$SIM" 2>/dev/null || true
xcrun simctl install "$SIM" "$APP"
xcrun simctl ui "$SIM" appearance light
shot() {  # name wait [ENV=VAL ...]
  local name=$1 wait=$2; shift 2
  xcrun simctl terminate "$SIM" $BUNDLE 2>/dev/null || true
  local envs=()
  for kv in "$@"; do envs+=("SIMCTL_CHILD_$kv"); done
  env "${envs[@]}" xcrun simctl launch "$SIM" $BUNDLE >/dev/null
  sleep $wait
  xcrun simctl io "$SIM" screenshot "$OUT/$name.png" >/dev/null && echo "$OUT/$name.png"
}
MOCK="WORKPLACE_URL=127.0.0.1:4399 WORKPLACE_TOKEN=mock-token-0123456789abcdef WORKPLACE_NO_NOTIF_PROMPT=1 WORKPLACE_NO_DEVICE_AUTH=1"
xcrun simctl uninstall "$SIM" $BUNDLE; xcrun simctl install "$SIM" "$APP"   # fresh: no token → pairing screen
shot 01-signin 3 WORKPLACE_RELAY_URL=127.0.0.1:4399 WORKPLACE_FORGET=1
shot 02-office 4 ${=MOCK}
shot 03-inbox 4 ${=MOCK} WORKPLACE_TAB=inbox
shot 04-inbox-release 4 ${=MOCK} WORKPLACE_INBOX_ITEM=ib-1
shot 05-inbox-cap 4 ${=MOCK} WORKPLACE_INBOX_ITEM=ib-3
shot 06-talk-picker 4 ${=MOCK} WORKPLACE_TAB=talk
shot 07-talk-mira 5 ${=MOCK} WORKPLACE_TALK=mira
shot 08-features 4 ${=MOCK} WORKPLACE_TAB=features
shot 09-feature-errands 5 ${=MOCK} WORKPLACE_FEATURE=f-errands
shot 10-pivot-charter 5 ${=MOCK} WORKPLACE_PIVOT=charter
shot 11-pivot-platform 5 ${=MOCK} WORKPLACE_PIVOT=platform
shot 12-alerts 30 ${=MOCK} WORKPLACE_ALERTS=1
shot 18-room 5 ${=MOCK} WORKPLACE_ROOM=list
shot 19-thread 5 ${=MOCK} WORKPLACE_ROOM=rt-socket
shot 20-spend 5 ${=MOCK} WORKPLACE_SPEND=1
shot 21-employee-needsyou 5 ${=MOCK} WORKPLACE_TALK=kabir
shot 27-requests 5 ${=MOCK} WORKPLACE_FEATURES=requests
shot 28-new-request 4 ${=MOCK} WORKPLACE_NEW_REQUEST=1
shot 29-releases 5 ${=MOCK} WORKPLACE_RELEASES=1
shot 30-talk-asha-default 5 ${=MOCK} WORKPLACE_TAB=talk
shot 31-inbox-orgchange 4 ${=MOCK} WORKPLACE_INBOX_ITEM=ib-4
shot 13-settings 4 ${=MOCK} WORKPLACE_SETTINGS=1
xcrun simctl ui "$SIM" appearance dark
shot 14-office-dark 4 ${=MOCK}
shot 15-talk-dark 5 ${=MOCK} WORKPLACE_TALK=mira
shot 22-room-dark 5 ${=MOCK} WORKPLACE_ROOM=rt-socket
shot 23-spend-dark 5 ${=MOCK} WORKPLACE_SPEND=1
shot 24-inbox-item-dark 4 ${=MOCK} WORKPLACE_INBOX_ITEM=ib-1
xcrun simctl ui "$SIM" appearance light
xcrun simctl ui "$SIM" content_size extra-extra-extra-large
shot 16-office-xxxl 4 ${=MOCK}
shot 17-inbox-release-xxxl 4 ${=MOCK} WORKPLACE_INBOX_ITEM=ib-1
shot 25-room-xxxl 5 ${=MOCK} WORKPLACE_ROOM=rt-socket
shot 26-talk-xxxl 5 ${=MOCK} WORKPLACE_TALK=mira
xcrun simctl ui "$SIM" content_size medium
echo done
