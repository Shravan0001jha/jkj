#!/bin/zsh
# "Default is unchanged" proof (docs/THEMES.md §8): for every screen in scripts/shots-themes.sh,
# light and dark, shoot the baseline build and the new build (theme = default) back to back against
# the same freshly reset mock, then pixel-diff them. A screen that differs is retried (both shots)
# up to 3 times, to separate launch-timing noise from a real change; every attempt is reported.
#   scripts/theme-diff.sh <baseline.app> <new.app> <outdir> [port] [sim] [screens...]
set -e
BASE=$1; NEW=$2; OUT=$3; PORT=${4:-4413}; SIM=${5:-iPhone 17}; shift 5 2>/dev/null || shift $#
SCREENS=("$@")
[[ ${#SCREENS} -eq 0 ]] && SCREENS=($(grep -E '^shot [0-9]' scripts/shots-themes.sh | awk '{print $2}'))
DIFF=build/imagediff
[[ -x $DIFF ]] || swiftc -O scripts/imagediff.swift -o $DIFF
mkdir -p "$OUT/base" "$OUT/new" "$OUT/mask"
REPORT="$OUT/report.txt"; : > "$REPORT"
for LOOK in light dark; do
  for S in $SCREENS; do
    result=""
    for attempt in 1 2 3; do
      scripts/shots-themes.sh "$BASE" "$OUT/base" $LOOK default $PORT "$SIM" $S >/dev/null
      scripts/shots-themes.sh "$NEW" "$OUT/new" $LOOK default $PORT "$SIM" $S >/dev/null
      line=$($DIFF "$OUT/base/$S-$LOOK.png" "$OUT/new/$S-$LOOK.png" --mask "$OUT/mask/$S-$LOOK.png" || true)
      result="$result attempt$attempt: $line;"
      [[ ${line%% *} == 0 ]] && break
    done
    echo "$S-$LOOK $result" | tee -a "$REPORT"
  done
done
