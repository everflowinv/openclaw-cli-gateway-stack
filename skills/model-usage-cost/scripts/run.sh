#!/usr/bin/env bash
# run.sh - Auto-bootstrap wrapper (lightweight, reliable)

set -euo pipefail

# Best-effort shell profile loading (do not fail if missing)
set +e
[ -f ~/.bash_profile ] && source ~/.bash_profile >/dev/null 2>&1
[ -f ~/.bashrc ] && source ~/.bashrc >/dev/null 2>&1
[ -f ~/.zprofile ] && source ~/.zprofile >/dev/null 2>&1
[ -f ~/.zshrc ] && source ~/.zshrc >/dev/null 2>&1
set -e

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$SKILL_DIR/venv"
REQ_FILE="$SKILL_DIR/scripts/requirements.txt"
REQ_HASH_FILE="$VENV_DIR/.requirements.sha256"
SCRIPT_FILE="$SKILL_DIR/scripts/model_usage_cost_cli.py"

get_best_python() {
  for prefix in "/opt/homebrew/bin" "/usr/local/bin" "/usr/bin" "$HOME/.local/bin"; do
    if [ -d "$prefix" ]; then
      local best_py
      best_py=$(ls -1 "$prefix"/python3.* 2>/dev/null | grep -E "^$prefix/python3\.[0-9]+$" | sort -V | tail -n 1)
      if [ -n "$best_py" ] && [ -x "$best_py" ]; then
        echo "$best_py"
        return 0
      fi
    fi
  done
  echo "python3"
}

hash_file() {
  local f="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print $1}'
  else
    stat -f "%m:%z" "$f" 2>/dev/null || stat -c "%Y:%s" "$f"
  fi
}

ensure_env() {
  if [ ! -d "$VENV_DIR" ]; then
    local base_python
    base_python=$(get_best_python)
    echo "[bootstrap] Initializing virtualenv using: $base_python" >&2
    "$base_python" -m venv "$VENV_DIR"
    "$VENV_DIR/bin/pip" install --upgrade pip --quiet
  fi

  if [ -f "$REQ_FILE" ]; then
    local current_hash old_hash
    current_hash=$(hash_file "$REQ_FILE")
    old_hash=""
    [ -f "$REQ_HASH_FILE" ] && old_hash="$(cat "$REQ_HASH_FILE")"

    if [ "$current_hash" != "$old_hash" ]; then
      echo "[bootstrap] Installing/updating dependencies..." >&2
      "$VENV_DIR/bin/pip" install -r "$REQ_FILE" --quiet
      echo "$current_hash" > "$REQ_HASH_FILE"
    fi
  fi
}

if [ ! -f "$SCRIPT_FILE" ]; then
  echo "ERROR: CLI script not found: $SCRIPT_FILE" >&2
  echo "Hint: scripts/model_usage_cost_cli.py is part of this skill under scripts/; re-apply the proposal or restore the file." >&2
  exit 1
fi

ensure_env

# Optional warning control (default = keep warnings)
PY_WARNINGS_FLAG=()
if [ "${SKILL_WARNINGS:-default}" = "ignore" ]; then
  PY_WARNINGS_FLAG=(-W ignore)
fi

if [ ${#PY_WARNINGS_FLAG[@]} -gt 0 ]; then
  exec "$VENV_DIR/bin/python" "${PY_WARNINGS_FLAG[@]}" "$SCRIPT_FILE" "$@"
else
  exec "$VENV_DIR/bin/python" "$SCRIPT_FILE" "$@"
fi
