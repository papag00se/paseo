#!/usr/bin/env bash
# Swap the staged Paseo build (app.new) into place and relaunch.
# Run AFTER quitting Paseo (or let it ask Paseo to quit). Rollback: see bottom.
set -euo pipefail
OPT="$HOME/.local/opt"
DIR="$OPT/paseo"

[ -d "$DIR/app.new" ] || { echo "No staged build at $DIR/app.new"; exit 1; }

paseo_pids() {
  for p in /proc/[0-9]*; do
    exe=$(readlink "$p/exe" 2>/dev/null || true)
    case "$exe" in "$DIR/app/"*) echo "${p#/proc/}";; esac
  done
}

if [ -n "$(paseo_pids)" ]; then
  echo "Asking Paseo to quit..."
  kill -TERM $(paseo_pids) 2>/dev/null || true
fi
for _ in $(seq 1 60); do
  [ -z "$(paseo_pids)" ] && break
  sleep 1
done
if [ -n "$(paseo_pids)" ]; then
  echo "Paseo is still running after 60s (pids: $(paseo_pids | tr '\n' ' ')). Quit it from the app menu, then rerun." >&2
  exit 1
fi

rm -rf "$DIR/app.old"
mv -T "$DIR/app" "$DIR/app.old"
mv -T "$DIR/app.new" "$DIR/app"
# Compatibility link for the old install path is no longer needed once nothing runs from it.
[ -L "$OPT/paseo-crossnote-2c3ab1d10" ] && rm "$OPT/paseo-crossnote-2c3ab1d10"

echo "Swapped. Relaunching Paseo..."
setsid -f "$DIR/app/Paseo" >/dev/null 2>&1 < /dev/null
echo "Done. Previous build kept at $DIR/app.old"
echo "Rollback: quit Paseo, then: mv -T $DIR/app $DIR/app.new && mv -T $DIR/app.old $DIR/app"
