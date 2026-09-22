# OpenClaw CLI Gateway Stack

Turn subscription-backed coding CLIs — **Claude Code** (`claude`),
**Google Antigravity** (`agy`), and **Muse Code** (`muse`) — into local OpenAI-compatible model providers
for [OpenClaw](https://openclaw.ai), plus a live log viewer and a token-usage
cost tracker. Everything binds to `127.0.0.1` only.

```
                       ┌────────────────────────────────────────────┐
   OpenClaw agent ────▶│ antigravity-cli-gateway  127.0.0.1:4569    │
   (openai-completions │   node → agy --input/output-format          │
    provider, any      │   stream-json, --effort passthrough         │
    thinking level,    │        │ tools via MCP ▼                    │
    fallback chains)   │        ▼                                    │
   OpenClaw agent ────▶│ claude-cli-gateway       127.0.0.1:4568    │
                       │   node → claude -p --stream-json            │
                       │        │ tools via MCP ▼                    │
                       │        ▼                                    │
                       │   openclaw-mcp-proxy (this repo)            │
                       │   exposes OpenClaw tools (exec/read/…) over │
                       │   MCP stdio; both CLIs call it as needed    │
                       └────────────────────────────────────────────┘
                       │ [CLIGW]/[AGYGW] JSON events → stdout logs
                       ▼
                       │ live-log-viewer  127.0.0.1:8765             │
                       │   tail -f + SSE, one tab per gateway        │
                       ▼
                       │ skills/model-usage-cost                     │
                       │   token/cost stats from all local sources   │
```

## Why

OpenClaw can use any OpenAI-compatible endpoint as a model provider. Running
the official CLIs behind a tiny local gateway means:

- the model runs on your existing **Claude / Google subscription** quota
  (no per-token API billing),
- the CLI's own agent loop (and its tool calls through your OpenClaw MCP
  bridge) execute the turn, so OpenClaw gets finished answers,
- any OpenClaw feature that takes a provider works: thinking levels,
  fallback chains, subagents, compaction, etc.

## Components

| Path | What | Port |
|---|---|---|
| `claude-cli-gateway/` | OpenAI-compatible façade over `claude -p --stream-json`; concurrency/queue/timeout limits; watchdog heartbeats for OpenClaw's stuck-session detector | 4568 |
| `antigravity-cli-gateway/` | Same idea over `agy` headless print mode; reasoning-effort passthrough (`reasoning_effort` → `--effort`), stall watchdog, degraded-success salvage (an interrupted stream that still carries the full text is returned, not discarded) | 4569 |
| `muse-cli-gateway/` | Official Muse Code device-login path for Muse Spark 1.3; per-request MCP policy, private CLI config, terminal-verified replies and cancellation | 4571 |
| `antigravity-cli-gateway/websearch-service.mjs` + `openclaw-plugin/` | Gemini-provider-shaped web_search over agy's subscription-grounded `search_web` (minimal `excludeDefaultComponents` agent, ~5k input tokens/search); registered in OpenClaw as the `antigravity` web-search provider | 4570 |
| `live-log-viewer/` | Python SSE server + one HTML page with a tab per gateway: per-request blocks, thinking/text, tool calls with arguments/outputs, regex + session filters, follow mode, download | 8765 |
| `openclaw-mcp-proxy/` | The OpenClaw MCP bridge: stdio server exposing OpenClaw's tools (exec/read/write/…) to claude, agy, codex and Claude Code; unit + integration tests, regenerable tool schema | — |
| `parsers/` | Standalone, dependency-free modules that parse each CLI's headless stream-json output (plus fixtures + self-test) — reusable without the gateways, with protocol notes | — |
| `skills/model-usage-cost/` | OpenClaw skill: per-model token usage and list-price cost across 1D/7D/30D windows, reconciling native OpenAI, Codex rollouts, gateway logs, archived trajectories, Claude subagents, agy conversation DBs and Dalton usage | — |
| `lib/` | Shared CLI output normalization and diagnostic formatting; required by both gateways | — |
| `launchd/` | macOS LaunchAgent templates + `install.sh` | — |

Each gateway has its own README with configuration, env vars, and
troubleshooting. Since 2026-09-11 this repo **is the runtime location**: the
launchd services (`ai.openclaw.claude-cli-gateway`,
`ai.openclaw.antigravity-cli-gateway`, `ai.openclaw.antigravity-websearch`,
`com.openclaw.log-viewer`) run straight from this checkout and OpenClaw loads
the web-search plugin from `antigravity-cli-gateway/openclaw-plugin/`, so there
is no deployed duplicate to keep in sync. Keep `main` clean — develop in
worktrees and restart the service after merging. `claude-cli-gateway/mcp.json`
stays gitignored and machine-local. The pre-migration
`~/.openclaw/workspace/scripts/` copies were deleted after verification.

## Prerequisites

- macOS (launchd integration; the servers themselves run anywhere with
  node/python)
- Node.js ≥ 20, Python 3.9+
- OpenClaw installed and initialized (`~/.openclaw/`)
- **Claude Code CLI**, logged in (`claude` on PATH or set `CLAUDE_CLI_BIN`)
- **Antigravity CLI**, logged in (`~/.local/bin/agy` or set `AGY_CLI_BIN`)
- The **OpenClaw MCP bridge** — `openclaw-mcp-proxy/` in this repo: an MCP
  stdio server named `openclaw` exposing OpenClaw's tools (exec/read/write/
  grep/…, 65 tools, schema in `tools-schema.json`, regenerated by
  `regen-tools-schema.mjs` after OpenClaw upgrades). Point each CLI at
  `<repo>/openclaw-mcp-proxy/server.js`: `claude-cli-gateway/mcp.json`
  (gitignored, see `mcp.json.example`), `~/.gemini/config/mcp_config.json`
  (agy), `~/.codex/config.toml` (`[mcp_servers.openclaw]`), and Claude Code's
  own `~/.claude.json` global `mcpServers` entry.

The 2026-09-10 source snapshot was validated with Node.js **26.8.2**, Claude
Code **2.1.263**, and Antigravity CLI **1.2.0**. These are the installed versions
used for validation, not a claim about the vendors' latest releases. CLI
binaries, account credentials, local MCP configuration, and runtime logs are
not included. See [CHANGELOG.md](CHANGELOG.md) for this snapshot's changes.

## Install

```bash
git clone https://github.com/everflowinv/openclaw-cli-gateway-stack.git
cd openclaw-cli-gateway-stack

# 1. gateway MCP config (claude gateway reads ./mcp.json next to server.mjs)
cp claude-cli-gateway/mcp.json.example claude-cli-gateway/mcp.json
#    point it at <repo>/openclaw-mcp-proxy/server.js

# 2. register the same bridge in agy and codex (and Claude Code globals)
agy mcp add openclaw node -- <repo>/openclaw-mcp-proxy/server.js

# 3. install + start the three launchd services (renders templates)
bash launchd/install.sh

# 4. register providers in OpenClaw (~/.openclaw/openclaw.json)
```

The installer prefers `~/.openclaw/tools/node/bin/node` when present, otherwise
the `node` on PATH. Override it with an absolute path using
`NODE_BIN=/absolute/path/to/node bash launchd/install.sh`. Both gateways receive
that runtime's directory in PATH, and the Claude service also includes
`~/.local/bin` for native Claude CLI installs. Use an absolute Node path in
your MCP configuration too, to avoid inheriting an older desktop-app PATH.

Preview generated LaunchAgents without installing or restarting services:

```bash
bash launchd/install.sh --render-only /tmp/cli-gateway-launchd-preview
```

Minimal OpenClaw provider registration:

```jsonc
// ~/.openclaw/openclaw.json → models.providers
"claude-cli-gateway": {
  "baseUrl": "http://127.0.0.1:4568/v1",
  "apiKey": "dummy",
  "api": "openai-completions",
  "models": [{
    "id": "claude-sonnet-5", "name": "claude-sonnet-5 via official Claude CLI",
    "cost": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 },
    "contextWindow": 1000000, "maxTokens": 64000,
    "input": ["text", "image"], "reasoning": true
  }],
  "timeoutSeconds": 3900
},
"antigravity-cli-gateway": {
  "baseUrl": "http://127.0.0.1:4569/v1",
  "apiKey": "dummy",
  "api": "openai-completions",
  "models": [{
    "id": "gemini-3.8-flash", "name": "Gemini 3.8 Flash via Antigravity CLI",
    "cost": { "input": 0.75, "output": 3.75, "cacheRead": 0.075, "cacheWrite": 0 },
    "contextWindow": 1048576, "maxTokens": 65536,
    "input": ["text"], "reasoning": true,
    // let OpenClaw's thinking level pass through as reasoning_effort
    "compat": { "supportsReasoningEffort": true, "supportedReasoningEfforts": ["low", "medium", "high"] },
    "thinkingLevelMap": { "off": "low", "minimal": "low", "xhigh": "high", "max": "high" }
  }],
  "timeoutSeconds": 3900
}
```

Then add e.g. `"antigravity-cli-gateway/gemini-3.8-flash": {}` to
`agents.defaults.models` and test:

```bash
openclaw agent --model antigravity-cli-gateway/gemini-3.8-flash --message 'ping'
```

## Validation

These tests use synthetic CLI output and do not make model requests:

```bash
node --test lib/cli-output.test.mjs
node claude-cli-gateway/server.integration.test.mjs
node antigravity-cli-gateway/server.integration.test.mjs
node --test muse-cli-gateway/gateway.test.mjs
node parsers/self-test.mjs
node --test 'openclaw-mcp-proxy/'.*.test.js   # or: cd openclaw-mcp-proxy && node --test *.test.js
```

## Security notes

- Everything binds to **127.0.0.1** only. Do not port-forward.
- The log viewer dumps prompts/tool traffic; it rejects Tailscale Funnel
  (public) requests by header and sets `X-Robots-Tag` noindex.
- `agy` runs with `--dangerously-skip-permissions` (headless permission
  prompts fail outright); the gateway confines it to an empty working
  directory and MCP `exec` calls stay capped by
  `OPENCLAW_MCP_LOCAL_TOOL_MAX_TIMEOUT_MS`. Review before deploying.
- Optional bearer auth per gateway: `*_GATEWAY_API_KEY`.

## Ops quick reference

```bash
curl -s http://127.0.0.1:4568/health          # claude gateway
curl -s http://127.0.0.1:4569/health          # antigravity gateway
curl -s http://127.0.0.1:4570/health          # antigravity websearch service
open http://127.0.0.1:8765                    # live log viewer
launchctl kickstart -k gui/$UID/local.cli-gateway.claude-cli-gateway
bash skills/model-usage-cost/scripts/run.sh summary
```

The usage skill reports local coverage separately from token totals and current
catalog cost estimates. It persists sanitized observations and keeps unresolved
overlapping aggregates outside totals. See [the accounting repair](docs/usage-accounting-repair-2026-09-10.md).
`launchd/model-usage-collector.py` optionally harvests the bounded Dalton broker
journal every 60 seconds; it expects the main Workshop skill installation and
writes one atomic status JSON. It invokes no model. Local account data, session
files and evidence databases are not included in this repository.

## License

MIT — see [LICENSE](LICENSE).
