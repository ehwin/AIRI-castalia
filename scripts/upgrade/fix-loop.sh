#!/usr/bin/env bash
# Build -> "take our version" -> build, until the desktop app compiles.
#
# Why a loop: the vendored upgrade leaves a chain of unresolved imports (each fix
# reveals the next barrel or page that upstream rewrote to use a deleted module).
# Every round prints the files it switched back to the fork's blob, so the report can
# name them; a round that fixes nothing is the signal to stop and look by hand.
#
# Usage: bash scripts/upgrade/fix-loop.sh [max_rounds] [app]
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd -W)"
REPO_U="$(cd "$(dirname "$0")/../.." && pwd)"
ROUNDS="${1:-8}"
APP="${2:-@proj-airi/stage-tamagotchi}"
LOG_DIR="$REPO/.upgrade-logs"
mkdir -p "$LOG_DIR"
# turbo needs `pnpm` on an MSYS-style PATH entry; python helpers need the D:/ form
export PATH="$REPO_U/.cache/bin:$REPO_U/node_modules/.bin:$PATH"

for i in $(seq 1 "$ROUNDS"); do
  LOG="$LOG_DIR/build-round-$i.log"
  ( cd "$REPO" && ./node_modules/.bin/turbo run build -F="$APP" --force --env-mode=loose ) > "$LOG" 2>&1
  code=$?
  if [ "$code" -eq 0 ]; then
    echo "round $i: BUILD OK  ($LOG)"
    exit 0
  fi
  echo "round $i: build failed -- fixing"
  out=$( "C:/Users/1/AppData/Local/Programs/Python/Python313/python.exe" \
         "$REPO/scripts/upgrade/apply-ours-if-clean.py" "$LOG" )
  echo "$out" | sed 's/^/  /'
  if echo "$out" | grep -q "可自动修复: 0 "; then
    echo "round $i: nothing left to fix automatically -- see $LOG"
    exit 1
  fi
done
echo "stopped after $ROUNDS rounds"
exit 1
