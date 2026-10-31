#!/bin/zsh
# The UI suite under each theme (docs/THEMES.md §4), from one built test bundle (build/dd-ui,
# xcodebuild -scheme IrisWorkplaceUI build-for-testing). Optionally the baseline app first.
#   scripts/ui-themes.sh [baseline.app] [sim]     (mocks: 4415, and 4416 with --talk-threads)
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
BASE=$1; SIM=${2:-iPhone 17}
RUN=$(ls build/dd-ui/Build/Products/*.xctestrun | head -1)
one() {  # name xctestrun theme
  rm -rf build/ui-$1.xcresult
  xcrun simctl ui "$SIM" appearance light
  TEST_RUNNER_MOCK_PORT=4415 TEST_RUNNER_TALK_MOCK_PORT=4416 TEST_RUNNER_THEME=$3 \
    xcodebuild test-without-building -xctestrun $2 -destination "platform=iOS Simulator,name=$SIM" \
    -skip-testing:IrisWorkplaceUITests/DeviceVerifyUITests -skip-testing:IrisWorkplaceUITests/DeviceShotsUITests \
    -resultBundlePath build/ui-$1.xcresult > build/ui-$1.log 2>&1
  echo "$1: $(grep -cE "Test Case .* passed" build/ui-$1.log) passed, $(grep -cE "Test Case .* failed" build/ui-$1.log) failed"
  grep -E "Test Case .* failed" build/ui-$1.log | sed -E 's/.*UITests\.//; s/\].*//' | sed 's/^/   /'
}
if [[ -n "$BASE" ]]; then
  rm -rf build/dd-ui-base && mkdir -p build/dd-ui-base && cp -R build/dd-ui/Build/Products/* build/dd-ui-base/
  rm -rf build/dd-ui-base/Debug-iphonesimulator/IrisWorkplace.app && cp -R "$BASE" build/dd-ui-base/Debug-iphonesimulator/
  one base build/dd-ui-base/$(basename $RUN) default
fi
one default $RUN default
one scifi $RUN scifi
