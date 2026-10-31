#!/bin/zsh
# Frames of the Sci-fi animations (docs/THEMES.md §2.4) for the evidence folder: the boot sequence,
# a chat message arriving (typing waveform, then the transmission effect) and a tab switch.
#   scripts/anim-frames.sh <app> <outdir> [talk-mock-port] [sim]
# Needs a Talk-threads mock: node mock/server.mjs --port 4414 --talk-threads --reusable-code --quiet --no-live
set -e
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
APP=$1; OUT=$2; PORT=${3:-4414}; SIM=${4:-iPhone 17}
BUNDLE=com.irisforu.workplace
mkdir -p "$OUT"
snap() { xcrun simctl io "$SIM" screenshot "$OUT/$1.png" >/dev/null 2>&1 && echo "$OUT/$1.png"; }
ENV=(SIMCTL_CHILD_WORKPLACE_THEME=scifi SIMCTL_CHILD_WORKPLACE_URL=127.0.0.1:$PORT SIMCTL_CHILD_WORKPLACE_TOKEN=mock-token-0123456789abcdef
     SIMCTL_CHILD_WORKPLACE_NO_NOTIF_PROMPT=1 SIMCTL_CHILD_WORKPLACE_NO_DEVICE_AUTH=1)
fresh() { curl -s -X POST 127.0.0.1:$PORT/api/_reset >/dev/null; xcrun simctl terminate "$SIM" $BUNDLE 2>/dev/null || true
          xcrun simctl uninstall "$SIM" $BUNDLE 2>/dev/null || true; xcrun simctl install "$SIM" "$APP"; }

# 1. Boot: frames as fast as simctl can take them after a cold launch.
fresh
env $ENV xcrun simctl launch "$SIM" $BUNDLE >/dev/null
for i in 1 2 3 4; do snap boot-$i; done

# 2. A message arrives in an open chat: send as the owner, the mock types at 1.6 s and replies at 4 s.
fresh
env $ENV SIMCTL_CHILD_WORKPLACE_TALK=asha xcrun simctl launch "$SIM" $BUNDLE >/dev/null
sleep 6
curl -s -X POST -H 'content-type: application/json' -d '{"text":"Status on the errands?"}' 127.0.0.1:$PORT/api/talk/threads/asha/messages >/dev/null
sleep 2.2; snap chat-1-typing
sleep 1.7; for i in 2 3 4; do snap chat-$i-arrival; done
sleep 1; snap chat-5-settled

# 3. Tab switch: the dock glow slides to the new tab.
fresh
env $ENV xcrun simctl launch "$SIM" $BUNDLE >/dev/null
sleep 5; snap tab-1-plan
xcrun simctl openurl "$SIM" "irisworkplace://inbox" >/dev/null 2>&1 || true
snap tab-2-moving; sleep 0.8; snap tab-3-inbox
