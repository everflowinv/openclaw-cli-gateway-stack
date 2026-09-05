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

NODE_BIN="$(command -v node || true)"
PYTHON3_BIN="$(command -v python3 || true)"
[ -n "$NODE_BIN" ] || { echo "ERROR: node not found in PATH"; exit 1; }
[ -n "$PYTHON3_BIN" ] || { echo "ERROR: python3 not found in PATH"; exit 1; }
NODE_BIN_DIR="$(dirname "$NODE_BIN")"

mkdir -p "$OPENCLAW_LOG_DIR" "$LAUNCH_AGENTS"

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

install_service() { # install_service <plist-name> <label>
  local plist="$1" label="$2"
  render "$plist.template" "$plist" "$label"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS/$plist"
  echo "started $label"
}

install_service "ai.openclaw.claude-cli-gateway.plist"      "$LABEL_PREFIX.claude-cli-gateway"
install_service "ai.openclaw.antigravity-cli-gateway.plist" "$LABEL_PREFIX.antigravity-cli-gateway"
install_service "ai.openclaw.log-viewer.plist"              "$LABEL_PREFIX.log-viewer"

echo
echo "health checks:"
sleep 2
curl -s --max-time 10 http://127.0.0.1:4568/health && echo
curl -s --max-time 10 http://127.0.0.1:4569/health && echo
echo "log viewer: http://127.0.0.1:8765"
