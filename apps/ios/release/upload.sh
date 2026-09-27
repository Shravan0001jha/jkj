#!/bin/zsh
# Validate or upload the exported .ipa to App Store Connect (TestFlight) with the team API key.
# No Apple ID login: altool authenticates with the ASC key in ~/iris-ops/mobile/asc.env.
#
#   release/upload.sh --validate    # altool --validate-app only; nothing is uploaded (default)
#   release/upload.sh --upload      # the real upload. Only after the owner has approved TestFlight.
#
# Reads build/release/IrisWorkplace.ipa (from release/archive.sh) unless IPA=... is given.
# After --upload, `release/asc.py builds` shows processing; the internal group "Owner" has
# hasAccessToAllBuilds, so the build appears in the owner's TestFlight app once processed.
set -euo pipefail
export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}

HERE=${0:A:h}
IOS=${HERE:h}
cd "$IOS"

MODE=${1:---validate}
case "$MODE" in
  --validate|--dry-run) ACTION=--validate-app ;;
  --upload) ACTION=--upload-app ;;
  *) echo "usage: release/upload.sh [--validate|--upload]" >&2; exit 2 ;;
esac

ASC_ENV=${ASC_ENV:-$HOME/iris-ops/mobile/asc.env}
[[ -f "$ASC_ENV" ]] || { echo "upload: $ASC_ENV not found" >&2; exit 1; }
set -a; source "$ASC_ENV"; set +a
: "${ASC_KEY_ID:?}" "${ASC_ISSUER_ID:?}" "${ASC_KEY_FILE:?}"
ASC_KEY_FILE=${ASC_KEY_FILE/#\~/$HOME}
[[ "$ASC_KEY_FILE" = /* ]] || ASC_KEY_FILE="${ASC_ENV:h}/$ASC_KEY_FILE"
[[ -f "$ASC_KEY_FILE" ]] || { echo "upload: ASC_KEY_FILE does not exist" >&2; exit 1; }

IPA=${IPA:-build/release/IrisWorkplace.ipa}
[[ -f "$IPA" ]] || { echo "upload: $IPA not found; run release/archive.sh first" >&2; exit 1; }

# altool finds AuthKey_<ID>.p8 in $API_PRIVATE_KEYS_DIR; a private temp dir holds a copy for
# the duration of the call so the real key never sits next to the project.
KEYDIR=$(mktemp -d)
trap 'rm -rf "$KEYDIR"' EXIT
cp "$ASC_KEY_FILE" "$KEYDIR/AuthKey_${ASC_KEY_ID}.p8"
chmod 600 "$KEYDIR/AuthKey_${ASC_KEY_ID}.p8"
export API_PRIVATE_KEYS_DIR=$KEYDIR

if [[ "$ACTION" == "--upload-app" && "${CONFIRM_UPLOAD:-}" != "yes" ]]; then
  echo "upload: refusing to upload without CONFIRM_UPLOAD=yes (the owner approves TestFlight first)" >&2
  exit 3
fi

echo "upload: altool $ACTION $IPA"
xcrun altool "$ACTION" --type ios -f "$IPA" \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" \
  --output-format normal 2>&1 | tee "build/release/${ACTION#--}.log" \
  | grep -vE "^\s*$"
