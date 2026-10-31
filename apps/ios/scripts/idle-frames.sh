#!/bin/zsh
# Idle frame drops on a screen: launch with the frame probe, wait, read the probe's log.
#   scripts/idle-frames.sh <app> <theme> [ambient-off] [extra ENV=VAL ...]
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
APP=$1; TH=$2; OFF=$3; shift 3 2>/dev/null
SIM="iPhone 17"; B=com.irisforu.workplace
xcrun simctl install "$SIM" $APP; xcrun simctl terminate "$SIM" $B 2>/dev/null
envs=(SIMCTL_CHILD_WORKPLACE_THEME=$TH SIMCTL_CHILD_WORKPLACE_FRAME_PROBE=1 SIMCTL_CHILD_WORKPLACE_AMBIENT_OFF=$OFF SIMCTL_CHILD_WORKPLACE_URL=127.0.0.1:4413
      SIMCTL_CHILD_WORKPLACE_TOKEN=mock-token-0123456789abcdef SIMCTL_CHILD_WORKPLACE_NO_NOTIF_PROMPT=1 SIMCTL_CHILD_WORKPLACE_NO_DEVICE_AUTH=1)
for kv in "$@"; do envs+=("SIMCTL_CHILD_$kv"); done
env $envs xcrun simctl launch "$SIM" $B >/dev/null
/bin/sleep 6; T0=$(date "+%Y-%m-%d %H:%M:%S"); /bin/sleep 21
xcrun simctl spawn "$SIM" log show --start "$T0" --predicate 'eventMessage CONTAINS "FRAMEPROBE frames"' --style compact 2>/dev/null | grep -o "FRAMEPROBE frames.*" |
  awk -v l="$TH off=[$OFF] $*" '{split($2,a,"=");split($3,b,"=");split($4,c,"="); f+=a[2]; s+=b[2]; if(c[2]>w)w=c[2]} END {printf "idle %s: frames=%d slow=%d (%.2f%%) worstMs=%d\n", l, f, s, 100*s/f, w}'
