#!/usr/bin/env bash
# Run ONE Paseo agent, and everything it starts, in its own systemd user scope.
#
# Why: every agent used to live in the desktop app's single scope, so one agent's runaway test
# run (Jest/Vitest default to one worker per CPU thread: 31 here) or leftover server pushed the
# whole app into memory pressure and took every agent down with it (2026-10-31). Per agent:
#   * memory: throttled above PASEO_AGENT_MEMORY_HIGH, killed inside its own scope above
#     PASEO_AGENT_MEMORY_MAX. OOMPolicy=continue keeps the agent alive when only a child dies.
#   * CPUs: a rotating window of PASEO_AGENT_CPUS threads (taskset). Node's
#     os.availableParallelism() follows it, so Jest/Vitest size their worker pools to it.
#   * TMPDIR: a private directory on disk under /var/tmp, not the RAM-backed /tmp.
# Detached jobs an agent starts stay in its scope (cgroup membership survives setsid/nohup), so
# they keep running after the agent exits and remain visible: systemctl --user list-units 'paseo-agent-*'.
set -euo pipefail

: "${PASEO_AGENT_CPUS:=4}"
: "${PASEO_AGENT_MEMORY_HIGH:=8G}"
: "${PASEO_AGENT_MEMORY_MAX:=12G}"
: "${PASEO_AGENT_SWAP_MAX:=4G}"
: "${PASEO_AGENT_TMP_ROOT:=/var/tmp/paseo-agents}"

if [ "$#" -eq 0 ]; then
  echo "usage: agent-scope.sh COMMAND [ARGS...]" >&2
  exit 64
fi

total=$(nproc --all)
cpus=$(( PASEO_AGENT_CPUS < total ? PASEO_AGENT_CPUS : total ))
state="${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is required}/paseo-agent-scope"
mkdir -p "$state"
{
  flock 9
  n=$(cat "$state/counter" 2>/dev/null || echo 0)
  echo $(( (n + 1) % total )) > "$state/counter"
} 9>"$state/lock"

first=$(( (n * cpus) % total ))
cpulist=$(for ((i = 0; i < cpus; i++)); do echo $(( (first + i) % total )); done | paste -sd,)

unit="paseo-agent-$(date +%s%N)-$$"
export TMPDIR="$PASEO_AGENT_TMP_ROOT/$unit"
mkdir -p -m 700 "$TMPDIR"

# --expand-environment=no: systemd-run would otherwise rewrite `$VAR`/`$$` inside the agent's own argv.
exec systemd-run --user --scope --quiet --collect --expand-environment=no --unit="$unit" --slice=app-paseoagents.slice \
  -p MemoryHigh="$PASEO_AGENT_MEMORY_HIGH" -p MemoryMax="$PASEO_AGENT_MEMORY_MAX" \
  -p MemorySwapMax="$PASEO_AGENT_SWAP_MAX" -p OOMPolicy=continue \
  -- taskset -c "$cpulist" "$@"
