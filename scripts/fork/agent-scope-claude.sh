#!/usr/bin/env bash
# Claude's provider accepts one executable path, not an argv, so this is that path: the real
# `claude` from PATH, run through agent-scope.sh.
set -euo pipefail
here=$(dirname "$(readlink -f "$0")")
exec "$here/agent-scope.sh" claude "$@"
