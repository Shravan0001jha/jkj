#!/bin/zsh
# Frames of the Sci-fi animations (docs/THEMES.md §2.4) for the evidence folder, cut from screen
# recordings: the boot sequence, a chat message arriving (typing waveform, then the transmission
# effect) and tab switches (the dock glow sliding).
#   scripts/anim-frames.sh <app> <outdir> [talk-mock-port] [mock-port] [sim]
# Mocks: --talk-threads --no-live on talk-mock-port; --no-live on mock-port. Needs ffmpeg and
# build/dd-ui (xcodebuild -scheme IrisWorkplaceUI build-for-testing) for the tab test.
set -e
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
APP=$1; OUT=$2; TPORT=${3:-4414}; PORT=${4:-4413}; SIM=${5:-iPhone 17}
B=com.irisforu.workplace
mkdir -p "$OUT"; TMP=$(mktemp -d)
ENV=(SIMCTL_CHILD_WORKPLACE_THEME=scifi SIMCTL_CHILD_WORKPLACE_TOKEN=mock-token-0123456789abcdef
     SIMCTL_CHILD_WORKPLACE_NO_NOTIF_PROMPT=1 SIMCTL_CHILD_WORKPLACE_NO_DEVICE_AUTH=1)
fresh() { curl -s -X POST 127.0.0.1:$1/api/_reset >/dev/null; xcrun simctl terminate "$SIM" $B 2>/dev/null || true
          xcrun simctl uninstall "$SIM" $B 2>/dev/null || true; xcrun simctl install "$SIM" "$APP"; }
record() { xcrun simctl io "$SIM" recordVideo --codec h264 --force "$TMP/$1.mp4" >/dev/null 2>&1 & echo $!; }
stop() { kill -INT $1; wait $1 2>/dev/null || true; }
frames() {  # video name start step count
  for i in $(seq 0 $(($5 - 1))); do
    t=$(echo "$3 + $i * $4" | bc)
    ffmpeg -loglevel error -y -ss $t -i "$TMP/$1.mp4" -frames:v 1 "$OUT/$2-$(printf %02d $i).png"
  done
}

# 1. Boot: record a cold launch; frames every 0.15 s from when the first UI draws.
fresh $PORT
P=$(record boot); sleep 1
env $ENV SIMCTL_CHILD_WORKPLACE_URL=127.0.0.1:$PORT xcrun simctl launch "$SIM" $B >/dev/null
sleep 8; stop $P
frames boot boot 1.0 0.15 12 2>/dev/null || true

# 2. A message arrives in an open chat: the mock types at 1.6 s and replies at 4 s.
fresh $TPORT
env $ENV SIMCTL_CHILD_WORKPLACE_URL=127.0.0.1:$TPORT SIMCTL_CHILD_WORKPLACE_TALK=asha xcrun simctl launch "$SIM" $B >/dev/null
sleep 6
P=$(record chat); sleep 1
curl -s -X POST -H 'content-type: application/json' -d '{"text":"Status on the errands?"}' 127.0.0.1:$TPORT/api/talk/threads/asha/messages >/dev/null
sleep 9; stop $P
frames chat chat 2.8 0.5 2      # typing waveform
frames chat arrival 4.9 0.08 8  # the reply landing

# 3. Tab switches (a UI test taps the bar while the screen records).
fresh $PORT
P=$(record tabs); sleep 1
TEST_RUNNER_THEME_SHOTS=1 TEST_RUNNER_MOCK_PORT=$PORT TEST_RUNNER_THEME=scifi xcodebuild test-without-building \
  -xctestrun $(ls build/dd-ui/Build/Products/*.xctestrun | head -1) -destination "platform=iOS Simulator,name=$SIM" \
  -only-testing:IrisWorkplaceUITests/ThemeShotsUITests/testTabSwitchesForVideo >/dev/null 2>&1 || true
stop $P
cp "$TMP"/*.mp4 "$OUT/" 2>/dev/null || true
echo "videos and frames in $OUT"
