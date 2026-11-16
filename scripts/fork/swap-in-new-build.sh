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

echo "Swapped. Relaunching Paseo..."
if [ "${PASEO_SWAP_SCOPE:-}" = 1 ] && command -v systemd-run >/dev/null; then
  # Launched from a transient unit (deploy-with-agent-resume.sh): start Paseo in its own scope so it
  # is not killed when that unit finishes.
  systemd-run --user --quiet --scope --slice=app.slice --unit="app-Paseo-swap-$(date +%s).scope" \
    -- setsid -f "$DIR/app/Paseo" >/dev/null 2>&1 < /dev/null
else
  setsid -f "$DIR/app/Paseo" >/dev/null 2>&1 < /dev/null
fi
echo "Done. Previous build kept at $DIR/app.old"
echo "Rollback: quit Paseo, then: mv -T $DIR/app $DIR/app.new && mv -T $DIR/app.old $DIR/app"
