#!/usr/bin/env bash
# Render the launchd templates with this machine's paths, install them into
# ~/Library/LaunchAgents, and start the services. Re-running updates in place.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="$HOME"
# Labels default to the deployed ai.openclaw.* set so re-running updates the
# running services in place instead of starting duplicates on the same
# ports. Set CLI_GATEWAY_LABEL_PREFIX to install under "<prefix>.<component>"
# labels instead (the plist filenames follow the label).
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME_DIR/.openclaw}"
OPENCLAW_LOG_DIR="${OPENCLAW_LOG_DIR:-$OPENCLAW_HOME/logs}"
OPENCLAW_WORKSPACE="${OPENCLAW_WORKSPACE:-$OPENCLAW_HOME/workspace}"
LAUNCH_AGENTS="$HOME_DIR/Library/LaunchAgents"
RENDER_ONLY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --render-only)
      [ "$#" -ge 2 ] || { echo "Usage: bash launchd/install.sh [--render-only OUTPUT_DIR]" >&2; exit 2; }
      RENDER_ONLY=1
      LAUNCH_AGENTS="$2"
      shift 2
      ;;
    *)
      echo "Usage: bash launchd/install.sh [--render-only OUTPUT_DIR]" >&2
      exit 2
      ;;
  esac
done

label_for() { # label_for <component>
  if [ -n "${CLI_GATEWAY_LABEL_PREFIX:-}" ]; then
    echo "$CLI_GATEWAY_LABEL_PREFIX.$1"
    return
  fi
  case "$1" in
    log-viewer) echo "com.openclaw.log-viewer" ;;
    *) echo "ai.openclaw.$1" ;;
  esac
}

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
  local component="$1" label plist
  label="$(label_for "$component")"
  plist="$label.plist"
  render "$component.plist.template" "$plist" "$label"
  if [ "$RENDER_ONLY" -eq 1 ]; then return; fi
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS/$plist"
  echo "started $label"
}

install_service "claude-cli-gateway"
install_service "antigravity-cli-gateway"
install_service "antigravity-websearch"
install_service "muse-cli-gateway"
install_service "log-viewer"

if [ "$RENDER_ONLY" -eq 1 ]; then exit 0; fi

echo
echo "health checks:"
sleep 2
curl -s --max-time 10 http://127.0.0.1:4568/health && echo
curl -s --max-time 10 http://127.0.0.1:4569/health && echo
curl -s --max-time 10 http://127.0.0.1:4570/health && echo
curl -s --max-time 10 http://127.0.0.1:4571/health && echo
echo "log viewer: http://127.0.0.1:8765"
