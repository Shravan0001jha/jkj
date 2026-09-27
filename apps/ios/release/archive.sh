#!/bin/zsh
# Build a Release archive of Iris Workplace and export it as an App Store Connect .ipa.
# Never uploads: that is release/upload.sh, run only when the owner has approved TestFlight.
#
#   release/archive.sh                 # archive + export -> build/release/IrisWorkplace.ipa
#   release/archive.sh --no-export     # archive only (build/release/IrisWorkplace.xcarchive)
#   BUILD_NUMBER=42 release/archive.sh # pin the build number instead of deriving it
#
# Signing is automatic (team M9YV87TCT9) with cloud-managed signing via the App Store Connect
# API key, so no Apple ID has to be logged in to Xcode on this Mac. The key comes from
# ~/iris-ops/mobile/asc.env (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_FILE); override with ASC_ENV.
#
# Versioning: the marketing version is MARKETING_VERSION in project.yml (0.1.x). The build
# number is derived here on every run: UTC yyyymmddHHMM, bumped past build/release/last-build
# if two archives fall in the same minute, so App Store Connect always sees a new build.
set -euo pipefail
export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}

HERE=${0:A:h}
IOS=${HERE:h}
cd "$IOS"

ASC_ENV=${ASC_ENV:-$HOME/iris-ops/mobile/asc.env}
if [[ ! -f "$ASC_ENV" ]]; then
  echo "archive: $ASC_ENV not found (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_FILE)" >&2; exit 1
fi
set -a; source "$ASC_ENV"; set +a
: "${ASC_KEY_ID:?}" "${ASC_ISSUER_ID:?}" "${ASC_KEY_FILE:?}"
ASC_KEY_FILE=${ASC_KEY_FILE/#\~/$HOME}
[[ "$ASC_KEY_FILE" = /* ]] || ASC_KEY_FILE="${ASC_ENV:h}/$ASC_KEY_FILE"
[[ -f "$ASC_KEY_FILE" ]] || { echo "archive: ASC_KEY_FILE does not exist" >&2; exit 1; }

OUT=build/release
ARCHIVE=$OUT/IrisWorkplace.xcarchive
EXPORT_DIR=$OUT/export
LAST=$OUT/last-build
mkdir -p "$OUT"

# Build number: timestamp, strictly greater than the last one we produced.
BUILD=${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}
if [[ -f "$LAST" ]] && (( BUILD <= $(<"$LAST") )); then BUILD=$(( $(<"$LAST") + 1 )); fi

MARKETING=$(grep -E '^\s*MARKETING_VERSION:' project.yml | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
echo "archive: Iris Workplace $MARKETING ($BUILD)"

xcodegen generate -q
rm -rf "$ARCHIVE" "$EXPORT_DIR"

xcodebuild archive \
  -project IrisWorkplace.xcodeproj -scheme IrisWorkplace -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$ASC_KEY_FILE" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
  CURRENT_PROJECT_VERSION="$BUILD" \
  2>&1 | tee "$OUT/archive.log" | grep -E "error:|warning: .*(icon|privacy|sign)|ARCHIVE (SUCCEEDED|FAILED)" || true
grep -q "ARCHIVE SUCCEEDED" "$OUT/archive.log" || { echo "archive: failed, see $OUT/archive.log" >&2; exit 1; }
echo "$BUILD" > "$LAST"

if [[ "${1:-}" == "--no-export" ]]; then
  echo "archive: $ARCHIVE"; exit 0
fi

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$HERE/ExportOptions.plist" \
  -exportPath "$EXPORT_DIR" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$ASC_KEY_FILE" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
  2>&1 | tee "$OUT/export.log" | grep -E "error:|EXPORT (SUCCEEDED|FAILED)" || true
grep -q "EXPORT SUCCEEDED" "$OUT/export.log" || { echo "archive: export failed, see $OUT/export.log" >&2; exit 1; }

IPA=$(ls "$EXPORT_DIR"/*.ipa | head -1)
cp "$IPA" "$OUT/IrisWorkplace.ipa"
echo "archive: $OUT/IrisWorkplace.ipa  (version $MARKETING build $BUILD)"
