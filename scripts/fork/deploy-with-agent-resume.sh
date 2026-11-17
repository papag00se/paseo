#!/usr/bin/env bash
# Deploy the fork's `agent` branch to the installed Paseo app and wake the agents that were working.
#
# Launch it as an EXTERNAL process so it survives the app and daemon restart:
#   systemd-run --user --unit=paseo-deploy --collect ~/src/paseo/scripts/fork/deploy-with-agent-resume.sh
#   systemd-run --user --unit=paseo-deploy-dry --collect --wait ~/src/paseo/scripts/fork/deploy-with-agent-resume.sh --dry-run
# Follow it with: tail -f /var/tmp/paseo-deploy/deploy.log
#
# Steps: 1 record running and idle-but-open agents -> 2 merge agent into main -> 3 build, stage and
# swap the app -> 4 wait for the new daemon -> 5 message each agent that was running -> 6 check plugins.
# --dry-run does step 1, the merge check of step 2 (nothing is merged) and step 6, plus preflight checks.
# Exit codes: 0 done, 1 failed after the app was touched or the build failed (see the log), 2 merge
# conflict (nothing changed), 3 preflight failed (nothing changed).
set -uo pipefail

REPO="${PASEO_REPO:-$HOME/src/paseo}"
OPT="${PASEO_OPT:-$HOME/.local/opt/paseo}"
STATE_DIR="${PASEO_DEPLOY_DIR:-/var/tmp/paseo-deploy}"
LOG="$STATE_DIR/deploy.log"
RESUME_MESSAGE="Paseo was restarted for a planned update while you were working. Resume exactly where you left off."
DAEMON_WAIT_SECONDS=240
SETTLE_SECONDS=10
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/lock"
flock -n 9 || { echo "Another deploy is running (lock $STATE_DIR/lock)" >&2; exit 3; }
exec > >(tee -a "$LOG") 2>&1

export PATH="$HOME/.local/bin:$(ls -d "$HOME"/.local/share/mise/installs/node/22.* 2>/dev/null | sort -V | tail -1)/bin:$PATH"

log() { echo "$(date '+%F %T') $*"; }
fail() { local code=$1; shift; log "FAILED: $*"; exit "$code"; }
mode() { [ "$DRY_RUN" = 1 ] && echo "dry-run" || echo "deploy"; }

STATE="$STATE_DIR/state.json"
[ "$DRY_RUN" = 1 ] && STATE="$STATE_DIR/state.dry-run.json"

# ---- step 1: record who is working and who holds an open runtime --------------------------------
snapshot() { # $1 = file to write
  local raw="$STATE_DIR/ls.json.tmp"
  paseo ls --json > "$raw" 2>&1 || { log "paseo ls failed: $(head -c 300 "$raw")"; return 1; }
  python3 - "$raw" "$1" <<'PY'
import datetime, json, sys
agents = json.load(open(sys.argv[1]))
pick = lambda status: [{"id": a["id"], "name": a.get("name")} for a in agents if a.get("status") == status]
state = {"takenAt": datetime.datetime.now().isoformat(), "running": pick("running"), "idle": pick("idle")}
json.dump(state, open(sys.argv[2], "w"), indent=2)
print(f"{len(state['running'])} running, {len(state['idle'])} idle with an open runtime")
for a in state["running"]:
    print(f"  running: {a['id'][:8]} {a['name']}")
PY
}

log "== Paseo deploy ($(mode)) started =="
log "Step 1: recording agents -> $STATE"
snapshot "$STATE" || fail 3 "could not list agents; is the daemon running?"
[ "$DRY_RUN" = 1 ] || cp "$STATE" "$STATE_DIR/state.initial.json"

# ---- preflight ----------------------------------------------------------------------------------
cd "$REPO" || fail 3 "no repository at $REPO"
ORIGINAL_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git rev-parse --verify -q agent >/dev/null || fail 3 "branch 'agent' does not exist"
git rev-parse --verify -q main >/dev/null || fail 3 "branch 'main' does not exist"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail 3 "the working tree has uncommitted changes; commit or stash them first"
[ -x "$OPT/swap-in-new-build.sh" ] || fail 3 "$OPT/swap-in-new-build.sh is missing"
[ -d "$OPT/app" ] || fail 3 "$OPT/app is missing"
if [ "$DRY_RUN" = 0 ]; then
  [ ! -e "$OPT/app.new" ] || fail 3 "$OPT/app.new already exists (another staged build); inspect it and remove it first"
fi
command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || fail 3 "node 22 or newer is required for the build (found: $(node -v 2>&1))"
log "Preflight ok: on '$ORIGINAL_BRANCH', node $(node -v)"

# ---- step 2: merge check / merge ----------------------------------------------------------------
OLD_MAIN=$(git rev-parse main)
if git merge-base --is-ancestor agent main; then
  log "Step 2: main already contains agent; nothing to merge"
  NEEDS_MERGE=0
else
  NEEDS_MERGE=1
  if ! CONFLICTS=$(git merge-tree --write-tree --name-only main agent 2>&1); then
    log "Step 2: merging agent into main would conflict:"; echo "$CONFLICTS"
    fail 2 "merge conflict. Resolve it on the agent branch (git merge main), then rerun. Nothing was changed."
  fi
  log "Step 2: agent merges into main cleanly ($(git rev-list --count main..agent) commits)"
fi

check_plugins() { # lists plugins; returns 0 when every enabled plugin is running
  local raw="$STATE_DIR/plugins.json.tmp"
  paseo plugin ls --json > "$raw" 2>&1 || { log "paseo plugin ls failed: $(head -c 300 "$raw")"; return 1; }
  python3 - "$raw" <<'PY'
import json, sys
plugins = json.load(open(sys.argv[1]))
bad = [p for p in plugins if p.get("enabled") and p.get("status") != "running"]
for p in plugins:
    print(f"  {p['id']}: {p.get('status')}{'' if p.get('enabled') else ' (disabled)'}")
sys.exit(1 if bad else 0)
PY
}

if [ "$DRY_RUN" = 1 ]; then
  log "Step 6: plugin status"
  check_plugins && log "All enabled plugins are running" || log "WARNING: some enabled plugins are not running"
  log "== Dry run finished. Nothing was merged, built or restarted. State: $STATE =="
  exit 0
fi

# ---- step 2 (real): merge ----------------------------------------------------------------------
restore_main() { # undo the merge when the build fails, leaving the working tree on its original branch
  git checkout -q "$ORIGINAL_BRANCH" 2>/dev/null || true
  if [ "$NEEDS_MERGE" = 1 ]; then
    git update-ref refs/heads/main "$OLD_MAIN" && log "main restored to $OLD_MAIN"
  fi
}
if [ "$NEEDS_MERGE" = 1 ]; then
  git checkout -q main || fail 3 "cannot check out main"
  if ! git merge --no-ff agent -m "Merge branch 'agent': deploy $(date +%F)" >/dev/null; then
    git merge --abort 2>/dev/null
    git checkout -q "$ORIGINAL_BRANCH"
    fail 2 "merge failed unexpectedly and was aborted. Nothing was changed."
  fi
  log "Merged agent into main ($(git rev-parse --short main))"
else
  git checkout -q main || fail 3 "cannot check out main"
fi

# ---- step 3a: build and stage ------------------------------------------------------------------
log "Step 3: building the desktop app (this takes a while)"
if ! npm run build:desktop -- --linux dir; then
  rm -rf "$OPT/app.new"
  restore_main
  fail 1 "build failed. The running app was not touched. Fix the build on the agent branch and rerun."
fi
[ -d packages/desktop/release/linux-unpacked ] || { restore_main; fail 1 "build produced no packages/desktop/release/linux-unpacked"; }
cp -a packages/desktop/release/linux-unpacked "$OPT/app.new" || { rm -rf "$OPT/app.new"; restore_main; fail 1 "could not stage the build at $OPT/app.new"; }
NEW_MAIN=$(git rev-parse main)
git checkout -q "$ORIGINAL_BRANCH"
[ "$ORIGINAL_BRANCH" = agent ] && git merge --ff-only -q main && log "agent fast-forwarded to main"
log "Build staged at $OPT/app.new (main $NEW_MAIN)"

# ---- step 3b: swap ------------------------------------------------------------------------------
log "Re-recording agents right before the restart"
snapshot "$STATE" || log "WARNING: could not re-record agents; using the initial record"

rollback() {
  log "Rolling back to the previous build"
  for pid in $(for p in /proc/[0-9]*; do exe=$(readlink "$p/exe" 2>/dev/null || true); case "$exe" in "$OPT/app/"*) echo "${p#/proc/}";; esac; done); do kill -TERM "$pid" 2>/dev/null; done
  sleep 10
  if [ -d "$OPT/app.old" ]; then
    mv -T "$OPT/app" "$OPT/app.new" && mv -T "$OPT/app.old" "$OPT/app"
    systemd-run --user --quiet --scope --slice=app.slice --unit="app-Paseo-rollback-$(date +%s).scope" -- setsid -f "$OPT/app/Paseo" >/dev/null 2>&1 < /dev/null 9>&-
    log "Previous build restored; the failed build is at $OPT/app.new"
  else
    log "No $OPT/app.old to restore; restore the build by hand"
  fi
}

wait_for_daemon() {
  local deadline=$((SECONDS + DAEMON_WAIT_SECONDS))
  while [ $SECONDS -lt "$deadline" ]; do
    timeout 15 paseo ls --json >/dev/null 2>&1 && return 0
    sleep 3
  done
  return 1
}

log "Step 3: swapping in the new build; Paseo and the daemon restart now, which ends every running agent"
if ! PASEO_SWAP_SCOPE=1 "$OPT/swap-in-new-build.sh" 9>&-; then
  fail 1 "the swap script failed before replacing the app (the old build is still in place). Quit Paseo from its menu, then rerun this script; the staged build is at $OPT/app.new."
fi

# ---- step 4: wait for the new daemon ------------------------------------------------------------
log "Step 4: waiting up to ${DAEMON_WAIT_SECONDS}s for the new daemon"
if ! wait_for_daemon; then
  log "The new daemon did not answer."
  rollback
  wait_for_daemon && log "Previous build is answering" || log "Neither build answers. Start Paseo by hand and check ~/.paseo/daemon.log"
  fail 1 "new build failed to start; rolled back. Agents that were running (listed in $STATE) were NOT resumed. Read ~/.paseo/daemon.log for why."
fi
log "New daemon is answering: $(paseo --version 2>&1 | head -1)"

# ---- step 5: resume the agents that were running ------------------------------------------------
MESSAGE_FILE="$STATE_DIR/resume-message.txt"
printf '%s\n' "$RESUME_MESSAGE" > "$MESSAGE_FILE"
agent_status() { paseo agent inspect "$1" --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("Status",""))' 2>/dev/null; }
send_resume() { paseo send --no-wait --prompt-file "$MESSAGE_FILE" "$1" >/dev/null 2>&1; }

resume_agent() { # $1 id, $2 name
  local id=$1 name=$2
  if send_resume "$id"; then
    sleep "$SETTLE_SECONDS"
    case "$(agent_status "$id")" in error|"") ;; *) log "  resumed $id $name"; return 0;; esac
  fi
  log "  $id $name did not take the message; reloading it and trying once more"
  paseo agent reload "$id" >/dev/null 2>&1
  if send_resume "$id"; then
    sleep "$SETTLE_SECONDS"
    case "$(agent_status "$id")" in error|"") ;; *) log "  resumed $id $name after a reload"; return 0;; esac
  fi
  log "  COULD NOT RESUME $id $name: reload it and send a message by hand"
  return 1
}

log "Step 5: resuming agents that were running"
RESUME_FAILURES=0
while IFS=$'\t' read -r id name; do
  [ -n "$id" ] || continue
  resume_agent "$id" "$name" || RESUME_FAILURES=$((RESUME_FAILURES + 1))
done < <(python3 -c '
import json
for a in json.load(open("'"$STATE"'"))["running"]:
    print(a["id"] + "\t" + str(a.get("name") or ""))')
log "Idle agents with an open runtime were left alone; they resume on their next prompt"

# ---- step 6: plugins ----------------------------------------------------------------------------
log "Step 6: plugin status"
PLUGIN_STATUS=0
check_plugins || PLUGIN_STATUS=1
[ "$PLUGIN_STATUS" = 0 ] && log "All enabled plugins are running" || log "WARNING: some enabled plugins are not running; run 'paseo plugin ls' and 'paseo plugin reload <id>'"

if [ "$RESUME_FAILURES" -gt 0 ] || [ "$PLUGIN_STATUS" -ne 0 ]; then
  fail 1 "deployed, but $RESUME_FAILURES agent(s) were not resumed and/or plugins are not all running (see above). The previous build is kept at $OPT/app.old."
fi
log "== Deploy finished. Previous build kept at $OPT/app.old (rollback: quit Paseo, mv -T $OPT/app $OPT/app.new && mv -T $OPT/app.old $OPT/app) =="
