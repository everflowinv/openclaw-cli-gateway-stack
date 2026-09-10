#!/usr/bin/env bash
# Render the launchd templates with this machine's paths, install them into
# ~/Library/LaunchAgents, and start the services. Re-running updates in place.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="$HOME"
LABEL_PREFIX="local.cli-gateway"          # e.g. local.cli-gateway.claude
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME_DIR/.openclaw}"
OPENCLAW_LOG_DIR="${OPENCLAW_LOG_DIR:-$OPENCLAW_HOME/logs}"
OPENCLAW_WORKSPACE="${OPENCLAW_WORKSPACE:-$OPENCLAW_HOME/workspace}"
LAUNCH_AGENTS="$HOME_DIR/Library/LaunchAgents"
RENDER_ONLY=0
if [ "${1:-}" = "--render-only" ] && [ "$#" -eq 2 ]; then
  RENDER_ONLY=1
  LAUNCH_AGENTS="$2"
elif [ "$#" -ne 0 ]; then
  echo "Usage: bash launchd/install.sh [--render-only OUTPUT_DIR]" >&2
  exit 2
fi

if [ -z "${NODE_BIN:-}" ]; then
  if [ -x "$OPENCLAW_HOME/tools/node/bin/node" ]; then
    NODE_BIN="$OPENCLAW_HOME/tools/node/bin/node"
  else
    NODE_BIN="$(command -v node || true)"
  fi
fi
PYTHON3_BIN="$(command -v python3 || true)"
[ -x "$NODE_BIN" ] || { echo "ERROR: node executable not found"; exit 1; }
[ -n "$PYTHON3_BIN" ] || { echo "ERROR: python3 not found in PATH"; exit 1; }
NODE_BIN_DIR="$(dirname "$NODE_BIN")"

mkdir -p "$LAUNCH_AGENTS"
if [ "$RENDER_ONLY" -eq 0 ]; then
  mkdir -p "$OPENCLAW_LOG_DIR"
fi

render() { # render <template> <out.plist> <label>
  local src="$REPO/launchd/$1" dst="$LAUNCH_AGENTS/$2" label="$3"
  sed -e "s|__HOME__|$HOME_DIR|g" \
      -e "s|__REPO__|$REPO|g" \
      -e "s|__LABEL__|$label|g" \
      -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" \
      -e "s|__NODE_BIN__|$NODE_BIN|g" \
      -e "s|__PYTHON3__|$PYTHON3_BIN|g" \
      -e "s|__OPENCLAW_LOG_DIR__|$OPENCLAW_LOG_DIR|g" \
      -e "s|__OPENCLAW_WORKSPACE__|$OPENCLAW_WORKSPACE|g" \
      "$src" > "$dst"
  echo "rendered $dst"
}

install_service() { # install_service <component>
  local component="$1" label="$LABEL_PREFIX.$1"
  local plist="$label.plist"
  render "$component.plist.template" "$plist" "$label"
  if [ "$RENDER_ONLY" -eq 1 ]; then return; fi
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS/$plist"
  echo "started $label"
}

install_service "claude-cli-gateway"
install_service "antigravity-cli-gateway"
install_service "log-viewer"

if [ "$RENDER_ONLY" -eq 1 ]; then exit 0; fi

echo
echo "health checks:"
sleep 2
curl -s --max-time 10 http://127.0.0.1:4568/health && echo
curl -s --max-time 10 http://127.0.0.1:4569/health && echo
echo "log viewer: http://127.0.0.1:8765"
