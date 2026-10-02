#!/bin/zsh
# Screenshot every v2 screen on the simulator against the mock (make mock), which serves the plan
# captured from the live Workplace plus mock additions (mock/v2.mjs).
#   scripts/shots-v2.sh ["iPhone 17"] [outdir] [light|dark]
set -e
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
SIM=${1:-iPhone 17}; OUT=${2:-shots/v2}; LOOK=${3:-light}; mkdir -p "$OUT"
BUNDLE=com.irisforu.workplace
APP=build/dd/Build/Products/Debug-iphonesimulator/IrisWorkplace.app
xcrun simctl boot "$SIM" 2>/dev/null || true
xcrun simctl install "$SIM" "$APP"
xcrun simctl ui "$SIM" appearance $LOOK
shot() {  # name wait [ENV=VAL ...]
  local name=$1 wait=$2; shift 2
  xcrun simctl terminate "$SIM" $BUNDLE 2>/dev/null || true
  local envs=()
  for kv in "$@"; do envs+=("SIMCTL_CHILD_$kv"); done
  env "${envs[@]}" xcrun simctl launch "$SIM" $BUNDLE >/dev/null
  sleep $wait
  xcrun simctl io "$SIM" screenshot "$OUT/$name-$LOOK.png" >/dev/null && echo "$OUT/$name-$LOOK.png"
}
curl -s -X POST 127.0.0.1:4399/api/_reset >/dev/null
MOCK="WORKPLACE_URL=127.0.0.1:4399 WORKPLACE_TOKEN=mock-token-0123456789abcdef WORKPLACE_NO_NOTIF_PROMPT=1 WORKPLACE_NO_DEVICE_AUTH=1"
shot v2-01-plan 5 ${=MOCK}
shot v2-02-board 5 ${=MOCK} WORKPLACE_BOARD=1
shot v2-03-epic 5 ${=MOCK} WORKPLACE_ITEM=ft_mummakwyuew19
shot v2-04-story-blocked 5 ${=MOCK} WORKPLACE_ITEM=as_muqecr89jhjst
shot v2-05-story-mine 5 ${=MOCK} WORKPLACE_ITEM=as_mock_owner_test
shot v2-06-inbox 5 ${=MOCK} WORKPLACE_TAB=inbox
shot v2-07-inbox-thread 5 ${=MOCK} WORKPLACE_INBOX_ITEM=in_muqel76q1h1i1
shot v2-08-talk 6 ${=MOCK} WORKPLACE_TALK=mira
shot v2-09-talk-coo 5 ${=MOCK} WORKPLACE_TALK=coo
shot v2-10-rooms 5 ${=MOCK} WORKPLACE_ROOM=list
shot v2-11-epic-thread 5 ${=MOCK} WORKPLACE_ROOM=th_epic_ft_mummakwyuew19
shot v2-12-updates 5 ${=MOCK} WORKPLACE_TAB=updates
shot v2-13-releases 5 ${=MOCK} WORKPLACE_RELEASE_POST=rp_mock_0215
shot v2-14-office 5 ${=MOCK} WORKPLACE_TAB=office
