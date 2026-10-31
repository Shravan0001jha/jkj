#!/bin/zsh
# The Dashboard part of the "Default is unchanged" proof: ThemeShotsUITests scrolls the Dashboard
# and opens a product with momentum-free drags; run it once with the baseline app and once with the
# new app (theme = default) from the same built test bundle, then pixel-diff the screenshots.
#   scripts/theme-diff-dash.sh <baseline.app> <outdir> [port] [sim]
# Needs build/dd-ui from: xcodebuild -scheme IrisWorkplaceUI -derivedDataPath build/dd-ui build-for-testing
# and a mock with --no-live on <port>.
set -e
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
BASE=$1; OUT=$2; PORT=${3:-4413}; SIM=${4:-iPhone 17}
DIFF=build/imagediff
[[ -x $DIFF ]] || swiftc -O scripts/imagediff.swift -o $DIFF
RUN=$(ls build/dd-ui/Build/Products/*.xctestrun | head -1)
rm -rf build/dd-ui-base && mkdir -p build/dd-ui-base && cp -R build/dd-ui/Build/Products/* build/dd-ui-base/
rm -rf build/dd-ui-base/Debug-iphonesimulator/IrisWorkplace.app && cp -R "$BASE" build/dd-ui-base/Debug-iphonesimulator/
mkdir -p "$OUT"; REPORT="$OUT/report.txt"; : > "$REPORT"
xcrun simctl status_bar "$SIM" override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100 >/dev/null
run() {  # name xctestrun look
  local name=$1 xr=$2 look=$3
  xcrun simctl ui "$SIM" appearance $look
  curl -s -X POST 127.0.0.1:$PORT/api/_reset >/dev/null
  rm -rf "$OUT/$name-$look.xcresult" "$OUT/$name-$look"
  TEST_RUNNER_THEME_SHOTS=1 TEST_RUNNER_MOCK_PORT=$PORT TEST_RUNNER_THEME=default \
    xcodebuild test-without-building -xctestrun "$xr" -destination "platform=iOS Simulator,name=$SIM" \
    -only-testing:IrisWorkplaceUITests/ThemeShotsUITests -resultBundlePath "$OUT/$name-$look.xcresult" >/dev/null 2>&1 || echo "$name $look: test failed" | tee -a "$REPORT"
  mkdir -p "$OUT/$name-$look"
  xcrun xcresulttool export attachments --path "$OUT/$name-$look.xcresult" --output-path "$OUT/$name-$look" >/dev/null
  # Name the files by their attachment name (dash-1-top.png …).
  python3 - "$OUT/$name-$look" <<'EOF'
import json, os, sys
d = sys.argv[1]
for t in json.load(open(os.path.join(d, 'manifest.json'))):
    for a in t['attachments']:
        n = a.get('suggestedHumanReadableName', '')
        if n.startswith('dash-'):
            os.rename(os.path.join(d, a['exportedFileName']), os.path.join(d, n.split('_')[0] + '.png'))
EOF
}
BASE_RUN=build/dd-ui-base/$(basename $RUN)
for LOOK in light dark; do
  run base $BASE_RUN $LOOK
  run new $RUN $LOOK
  for f in "$OUT/base-$LOOK"/dash-*.png; do
    n=$(basename $f)
    echo "$n-$LOOK $($DIFF $f "$OUT/new-$LOOK/$n" --ignore-top 160 --mask "$OUT/mask-$LOOK-$n" || true)" | tee -a "$REPORT"
  done
done
xcrun simctl status_bar "$SIM" clear
