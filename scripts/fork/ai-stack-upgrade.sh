#!/usr/bin/env bash
# Upgrade the AI stack in one pass and show which OpenAI models each tool now offers.
#
#   ChatGPT desktop  openai-codex-desktop (Omarchy repo) -> via `omarchy update` only (no partial upgrades)
#   Claude desktop   claude-desktop (Omarchy repo)       -> same
#   Codex, Pi, Claude CLIs  mise-managed "latest"        -> mise upgrade
#   Pi               extensions + model catalogs         -> pi update --extensions / --models
#   Model choices    newest of each Claude/Codex family -> curated Paseo lists, without a restart
#   Defaults         Claude/Pi: Opus; Codex: Sol        -> refreshed from full catalogs
#   Codex            live model list from OpenAI         -> codex debug models (also refreshes its cache)
#   OmniRoute        patched Docker image                -> ~/Work/omniroute/update-patched-omniroute.sh
#   Paseo            curated lists are hot-reloaded; its custom build is not replaced here.
#
# Each step runs even if an earlier one fails; failures are listed at the end.
set -uo pipefail

CURATE_MODELS="$(dirname "$(readlink -f "$0")")/curate-models.mjs"
if [[ ${1:-} == --models-only ]]; then
  exec "$CURATE_MODELS" --apply
elif (( $# )); then
  printf 'Usage: ai-stack-upgrade [--models-only]\n' >&2
  exit 2
fi

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/ai-stack-upgrade"
MODELS_FILE="$STATE_DIR/models.txt"
OMNIROUTE_UPDATE="$HOME/Work/omniroute/update-patched-omniroute.sh"
CODEX_CONFIG="$HOME/.codex/config.toml"
mkdir -p "$STATE_DIR"

failed=()
notes=()

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
run() { # run <label> <command...>
  local label=$1; shift
  if ! "$@"; then
    warn "!! $label failed"
    failed+=("$label")
    return 1
  fi
}

# --- Desktop apps (Omarchy repo) ---------------------------------------------
step "Desktop apps (ChatGPT, Claude)"
declare -A DESKTOP_PROC=(
  [openai-codex-desktop]='^/usr/lib/chatgpt/ChatGPT( |$)'
  [claude-desktop]='^/usr/lib/claude-desktop/claude-desktop( |$)'
)
declare -A desktop_before=()
updates=$(checkupdates 2>/dev/null || true)
pending=()
for pkg in "${!DESKTOP_PROC[@]}"; do
  desktop_before[$pkg]=$(pacman -Q "$pkg" 2>/dev/null | awk '{print $2}')
  if [[ -z ${desktop_before[$pkg]} ]]; then
    warn "$pkg is not installed (Omarchy menu > Install > AI)."
  elif line=$(grep -E "^$pkg " <<<"$updates") && [[ -n $line ]]; then
    echo "Update available: $line"; pending+=("$line")
  else
    echo "Up to date: $pkg ${desktop_before[$pkg]}"
  fi
done
if (( ${#pending[@]} )); then
  echo "Arch has no safe single-package upgrade; this runs the full 'omarchy update'."
  read -rp "Run omarchy update now? [Y/n] " ans </dev/tty || ans=n
  if [[ ${ans:-Y} =~ ^[Yy]$ ]]; then
    run "omarchy update" omarchy update
    for pkg in "${!DESKTOP_PROC[@]}"; do
      [[ -n ${desktop_before[$pkg]} ]] || continue
      [[ $(pacman -Q "$pkg" 2>/dev/null | awk '{print $2}') != "${desktop_before[$pkg]}" ]] || continue
      pgrep -f "${DESKTOP_PROC[$pkg]}" >/dev/null &&
        notes+=("$pkg was updated while running: quit it (Ctrl+Q) and relaunch to use the new version")
    done
  else
    notes+=("Desktop app updates skipped: ${pending[*]}")
  fi
fi
if aur=$(yay -Qua 2>/dev/null | grep -E '^codex-app-bin ') && [[ -n $aur ]]; then
  notes+=("AUR codex-app-bin has an update ($aur); not auto-installed: yay -S codex-app-bin")
fi

# --- Codex CLI + Pi binaries -------------------------------------------------
step "Codex, Pi and Claude CLIs (mise)"
versions() { echo "codex $(codex --version 2>/dev/null | awk '{print $NF}'), pi $(pi --version 2>/dev/null), claude $(claude --version 2>/dev/null | awk '{print $1}')"; }
echo "Before: $(versions)"
run "mise upgrade codex pi claude" mise upgrade codex pi claude
hash -r
echo "After:  $(versions)"

# --- Pi extensions + model catalogs -----------------------------------------
step "Pi extensions and model catalogs"
run "pi update --extensions" pi update --extensions
run "pi update --models" pi update --models

# --- Codex config guard + live model list ------------------------------------
step "Codex model list"
if grep -qE '^[[:space:]]*(model_catalog_json|model)[[:space:]]*=' "$CODEX_CONFIG" 2>/dev/null; then
  warn "$CODEX_CONFIG pins the model list or model again:"
  grep -nE '^[[:space:]]*(model_catalog_json|model)[[:space:]]*=' "$CODEX_CONFIG"
  notes+=("Codex config has a model/catalog pin; new models may be hidden (see above)")
fi
codex_models=$(codex debug models 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
for m in d.get("models", d) if isinstance(d, dict) else d:
    if m.get("slug"): print(m["slug"])' 2>/dev/null) || codex_models=""
[[ -z $codex_models ]] && failed+=("codex debug models")

pi_models=$(pi --list-models openai-codex 2>/dev/null | awk '$1 == "openai-codex" {print $2}')
[[ -z $pi_models ]] && failed+=("pi --list-models")

# --- Curated model choices and defaults --------------------------------------
step "Newest model per family (Claude/Pi: Opus; Codex: Sol)"
run "refresh curated models" "$CURATE_MODELS" --apply

# --- OmniRoute ---------------------------------------------------------------
step "OmniRoute (patched image)"
if [[ -x $OMNIROUTE_UPDATE ]]; then
  run "OmniRoute update" "$OMNIROUTE_UPDATE"
else
  warn "Missing $OMNIROUTE_UPDATE"
  failed+=("OmniRoute update (script missing)")
fi

# --- Summary -----------------------------------------------------------------
step "OpenAI models now available"
current=$( { sed 's/^/codex:/' <<<"$codex_models"; sed 's/^/pi:/' <<<"$pi_models"; } | grep -vE ':$' | sort -u)
previous=$(cat "$MODELS_FILE" 2>/dev/null || true)
show() { # show <prefix> <title>
  local p=$1 title=$2 line
  printf '%s\n' "$title"
  while IFS= read -r line; do
    [[ -z $line ]] && continue
    if [[ -n $previous ]] && ! grep -qxF "$line" <<<"$previous"; then
      printf '  \033[1;32m%s  (NEW)\033[0m\n' "${line#"$p":}"
    else
      printf '  %s\n' "${line#"$p":}"
    fi
  done < <(grep "^$p:" <<<"$current")
}
show codex "Codex (desktop app Codex + CLI):"
show pi "Pi's full OpenAI catalog (Paseo shows only curated choices):"
echo "Pi default model: $(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.pi/agent/settings.json"))).get("defaultModel","(none)"))' 2>/dev/null)"
echo "ChatGPT and Claude desktop model pickers come from OpenAI/Anthropic servers (Chat often gets new models after Work/Codex)."
[[ -n $current ]] && printf '%s\n' "$current" >"$MODELS_FILE"

for n in "${notes[@]}"; do warn "Note: $n"; done
if (( ${#failed[@]} )); then
  printf '\n\033[1;31mFailed steps:\033[0m\n'; printf '  - %s\n' "${failed[@]}"
  exit 1
fi
printf '\n\033[1;32mAI stack is up to date.\033[0m\n'
