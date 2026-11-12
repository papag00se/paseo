#!/usr/bin/env bash
# Remove per-launch temp directories of Paseo agents whose systemd scope no longer exists.
# agent-scope.sh creates $PASEO_AGENT_TMP_ROOT/paseo-agent-<id> and then exec()s into systemd-run, so
# it cannot clean up itself. Short-lived helper launches (title/branch-name generation, probes) were
# creating ~1,000 directories per 15 minutes (227G in three days). A directory is removed only when
# its scope unit (named like the directory) is gone, so detached jobs that outlive their agent keep
# their TMPDIR. Directories younger than a couple of minutes are skipped: the scope is not up yet.
set -euo pipefail

: "${PASEO_AGENT_TMP_ROOT:=/var/tmp/paseo-agents}"
: "${PASEO_AGENT_TMP_MIN_AGE_MINUTES:=2}"

[ -d "$PASEO_AGENT_TMP_ROOT" ] || exit 0

live=$(systemctl --user list-units 'paseo-agent-*' --all --plain --no-legend | awk '{print $1}' | sed 's/\.scope$//')

find "$PASEO_AGENT_TMP_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'paseo-agent-*' -mmin "+$PASEO_AGENT_TMP_MIN_AGE_MINUTES" -printf '%f\n' \
  | grep -vxFf <(printf '%s\n' "$live" "") \
  | while IFS= read -r name; do printf '%s\0' "$PASEO_AGENT_TMP_ROOT/$name"; done \
  | xargs -0 -r -n 500 ionice -c3 nice -n19 rm -rf --
