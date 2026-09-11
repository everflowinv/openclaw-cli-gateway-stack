# Antigravity CLI Gateway

Local OpenAI-compatible gateway that runs each request through the Antigravity
CLI (`agy`) in headless print mode, using the logged-in Google account's
subscription quota. Same architecture as `claude-cli-gateway` next door; the
Antigravity-specific differences are listed below.

The gateway accepts OpenClaw/OpenAI-compatible chat requests. agy receives
OpenClaw's system prompt (wrapped in a `<system_instructions>` block, since agy
has no `--append-system-prompt` equivalent) plus the conversation history, then
executes OpenClaw tools through the `openclaw` MCP proxy
(`~/.gemini/config/mcp_config.json`, registered with
`agy mcp add openclaw ...`) before returning the final answer.

Endpoints:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`

The service binds to `127.0.0.1:4569` by default. OpenClaw registers this
endpoint as the `antigravity-cli-gateway` provider.

A sibling service in this folder, **`websearch-service.mjs`**, exposes the
same subscription-grounded search as a standalone web-search endpoint — see
[Web Search Service](#web-search-service) below.

## Differences vs claude-cli-gateway

- **Text-only input.** agy's stream-json input rejects image blocks
  ("only text"), so the gateway 400s image requests and the OpenClaw model
  catalog declares `input: ["text"]`; route image requests to a multimodal
  provider.
- **Step-granularity streaming.** agy emits one `step_update.text_delta` per
  completed agent step (not per token) and nothing while tools run. The
  reasoning_content heartbeat mechanism keeps OpenClaw's stuck-session watchdog
  satisfied during tool loops.
- **Reasoning effort passthrough.** One catalog entry per base model
  (`gemini-3.8-flash`); OpenClaw's thinking level arrives as OpenAI
  `reasoning_effort` and maps to agy's `--effort low|medium|high` flag:
  `none`/`minimal`/`off` → low, `low`/`medium`/`high` pass through,
  `xhigh`/`max` → high, absent → `AGY_CLI_GATEWAY_DEFAULT_EFFORT` (low). The
  openclaw.json model entry declares
  `compat.supportedReasoningEfforts: [low, medium, high]` (so OpenClaw clamps
  its global `thinkingDefault: xhigh` down to high) plus a model-level
  `thinkingLevelMap` that gives `off`/`minimal` an explicit `low` landing
  spot — without it OpenClaw silently falls back to the global default.
  Explicitly requesting an unsupported level (`--thinking xhigh`) is rejected
  client-side by OpenClaw. Legacy suffixed ids like `gemini-3.8-flash-high`
  are still accepted and pin their effort unless the request overrides it.
- **Permissions.** agy is spawned with `--dangerously-skip-permissions`
  (`always-proceed`) because headless permission prompts fail outright. Unlike
  the claude gateway (which restricts claude to `mcp__openclaw__*` only), agy's
  built-in tools (file/shell/browser) stay enabled — mitigations: the gateway
  runs agy in the dedicated empty `cwd/` directory in this folder, and MCP
  `exec`/`process` calls remain capped by `OPENCLAW_MCP_LOCAL_TOOL_MAX_TIMEOUT_MS`.
- **Input schema.** stream-json input lines use agy's shape:
  `{"event":"user","message":{"role":"user","content":[{"type":"text","text":...}]}}`
  (claude uses `type` instead of `event`).
- **Fixed overhead.** Every request carries agy's own system prompt; a trivial
  prompt costs ~13.7k input tokens before OpenClaw's system prompt is added.
- **Conversations.** Each request is a fresh agy conversation; agy stores
  summaries under `~/.gemini/antigravity-cli/` (watch for growth).

## Model catalog

`agy models` lists what the account can use. Currently exposed here: base
`gemini-3.8-flash` (effort via `--effort`). The catalog also has
`gemini-3.1-pro` (high/low only), `claude-sonnet-4-6`, `claude-opus-4-6-thinking`,
and `gpt-oss-120b-medium` if you want to add entries — use the base id in
`MODELS` (add a suffix-accepting entry only for models with uneven effort
support like `gemini-3.1-pro`, which lacks medium), and update the provider
models in openclaw.json.

## Service operations

- Health: `curl -s http://127.0.0.1:4569/health`
- Restart: `launchctl kickstart -k gui/$UID/ai.openclaw.antigravity-cli-gateway`
- Logs: `~/.openclaw/logs/antigravity-cli-gateway.{stdout,stderr}.log`
  (structured `[AGYGW]` events: start/init/text/tool/tool_done/tool_error/
  done/error/cancel; tool events carry unwrapped MCP names like
  `openclaw.exec`, the call arguments, per-call duration, and the output
  summary agy reports)
- Live viewer: `http://127.0.0.1:8765` (shared with the claude gateway; the
  "Antigravity CLI" tab shows this gateway's events in the same format)

## Environment controls

- `AGY_CLI_GATEWAY_PORT` (default `4569`)
- `AGY_CLI_GATEWAY_MAX_CONCURRENT` (default `4`; LaunchAgent sets `6`)
- `AGY_CLI_GATEWAY_QUEUE_TIMEOUT_SECONDS` (default `120`; LaunchAgent sets `600`)
- `AGY_CLI_GATEWAY_TIMEOUT_SECONDS` (default `3600`; LaunchAgent sets `3900`)
- agy **1.1.28+** fixed the upstream exit hangs / silent headless failures
  this gateway was defending against (verified on 1.2.0: prompt exit, same
  event schema, MCP registration intact). The defenses below are kept as
  insurance against future regressions — they are inert when the CLI behaves.
- `AGY_CLI_GATEWAY_STALL_SECONDS` (default `600`). Stream-stall watchdog:
  agy 1.1.26 can silently lose the model connection mid-response (long-lived
  SSE through a local proxy gets dropped; agy keeps running background polls
  forever while emitting nothing). If agy produces no stdout for this long,
  the gateway kills it with `AGY_CLI_STALL` so OpenClaw can fail over in
  minutes instead of waiting for the full timeout. Success also resolves on
  the `result` event (newer agy lingers or hangs after it); the child is
  reaped after a 10s grace (`linger_kill` log event).
- **Degraded-success salvage**: when agy returns `result` with an error
  ("The stream was interrupted") but the response text is present — or a
  timeout/stall happens after text already streamed — the gateway returns
  the text as a normal 200 instead of discarding a finished answer. Logged
  as a `degraded` event (reason/chars/source) in the live log.
- `AGY_CLI_GATEWAY_EXEC_MAX_TIMEOUT_MS` (default `600000`, openclaw exec cap)
- `AGY_CLI_GATEWAY_HEARTBEAT_SECONDS` (default `120`; `0` disables idle timer)
- `AGY_CLI_GATEWAY_MAX_BODY_MB` (default `64`)
- `AGY_CLI_GATEWAY_MAX_PROMPT_BYTES` (default `190000`). Measures the complete
  assembled prompt with `Buffer.byteLength(prompt, "utf8")` and rejects oversized
  input with HTTP 413 before spawning agy. This includes system text, conversation
  history, and gateway framing. `/health` reports `maxPromptBytes`.
- `AGY_CLI_GATEWAY_MAX_PROMPT_CHARS` is a deprecated fallback alias. Its value
  is now interpreted as **bytes**, not JavaScript characters; the new byte setting
  takes precedence. Character counting was unsafe for Chinese and emoji input.
  Six live probes of agy **1.2.0** confirmed model-facing truncation near 192,000
  UTF-8 bytes while stream-json still reports SUCCESS/exit 0 with no truncation
  warning. Splitting into multiple text blocks does not help. See the
  [verification report](../docs/agy-long-context-2026-09-10.md) before changing
  the limit. The default leaves headroom for CLI-added message framing.
- `AGY_CLI_GATEWAY_API_KEY` (optional local bearer token)
- `AGY_CLI_BIN` (default `$HOME/.local/bin/agy`)
- `AGY_CLI_GATEWAY_CWD` (default `<this dir>/cwd`)
- `AGY_CLI_GATEWAY_DEFAULT_EFFORT` (default `low`; used when the request
  carries no `reasoning_effort`)

## Troubleshooting

- **`AGY_CLI_ERROR: Eligibility check failed ... EOF` / `authentication failed
  or timed out`**: agy could not reach Google. This machine reaches Google via
  a local Clash Verge TUN proxy (127.0.0.1:7897); if the node serving
  `daily-cloudcode-pa.googleapis.com` (agy's model backend) is down, requests
  fail while other Google endpoints may still work. Check the proxy node, then
  verify with
  `curl -s -o /dev/null -w '%{http_code}' https://daily-cloudcode-pa.googleapis.com/`
  (any HTTP status means reachable; 000 = broken). Prolonged network failures
  can also lapse agy's OAuth session — re-login interactively by running `agy`
  in a terminal and visiting the URL it prints.
- The gateway itself survives agy failures (child stdio EPIPE is swallowed;
  failures return as HTTP 5xx so OpenClaw can fail over to fallback models).

## OpenClaw registration

Provider `antigravity-cli-gateway` in `openclaw.json`
(`models.providers` + `agents.defaults.models`), api `openai-completions`,
`input: ["text"]`. Test with:

```sh
openclaw agent --agent main --session-key agy-gateway-test \
  --model antigravity-cli-gateway/gemini-3.8-flash-low \
  --message 'ping'
```

## Web Search Service

`websearch-service.mjs` turns agy's built-in `search_web` tool (Google Search
grounding on the Antigravity subscription — same Vertex grounding backend as
the Gemini API) into a standalone local HTTP service with an OpenClaw
**gemini-provider-shaped contract**: it accepts exactly the parameters the
bundled gemini web-search provider accepts, returns exactly the payload shape
that provider returns, and translates everything in between. Not yet wired
into OpenClaw; intended as the backend for a future webSearch provider plugin
or for the Dalton web-search broker path.

- `GET /health`
- `POST /v1/web-search` — body `{"query", "count", "freshness",
  "date_after", "date_before"}` (country/language are rejected with the
  gemini provider's exact `unsupported_*` errors), response is the gemini
  provider's payload (`query`, `provider`, `model`, `tookMs`,
  `externalContent`, `content` with the `EXTERNAL_UNTRUSTED_CONTENT` envelope,
  `citations` with grounding redirect URLs already resolved to direct URLs;
  `cached: true` on cache hits). Parameter and transport errors return the
  provider's `{error, message, docs}` shapes over HTTP 200. Payload fidelity
  was verified against the OpenClaw 2026.9.3 dist.
- Binds `127.0.0.1:4570`; optional bearer auth via `AGY_SEARCH_API_KEY`.

Setup: install the bundled minimal search agent (one-time; uses agy 1.2.1's
`excludeDefaultComponents` to keep the per-search envelope at ~1.5k input
tokens instead of ~14.2k) and start the service:

```sh
node websearch-service.mjs --install-agent   # copies websearch-agent.md
                                              # to ~/.gemini/config/agents/
node websearch-service.mjs                   # or run under launchd like the gateway

curl -s -X POST http://127.0.0.1:4570/v1/web-search \
  -H 'Content-Type: application/json' \
  -d '{"query": "openclaw cli gateway", "freshness": "week"}'
```

How the translation works:

- `freshness: "day"` appends the gemini provider's exact 24-hour recency
  instruction to the query text (soft filter, same as gemini).
- `freshness: week/month/year` and `date_after`/`date_before` become a
  time-range instruction in the query text. **Soft only**: agy's `search_web`
  schema (`query`, optional `domain`, UI metadata) has no timeRangeFilter
  parameter, so these cannot be enforced server-side like the gemini
  provider's hard `timeRangeFilter`. If hard date filtering matters, keep the
  Gemini API path for those calls or route by parameter.
- Every result must come from an actual `search_web` invocation: a turn that
  completes without calling the tool (e.g. a missing/fallback agent) fails
  with `agy_search_ungrounded` instead of returning chat text as results.
- `model` in the payload reports the resolved tier id (default
  `gemini-3.8-flash-low`); the init event's agent is verified so a silently
  fallback default agent can never serve searches.

Cost profile (measured, 2026-09-11, agy 1.2.1): ~5k input + ~1.5k output
tokens per search on the subscription; 8–15s end to end per search (agy turn
~7–11s plus citation redirect HEAD requests). A 15-minute response cache
(matching OpenClaw's default) absorbs repeats; TTL 0 disables.

Env controls: `AGY_SEARCH_PORT` (4570), `AGY_SEARCH_API_KEY`, `AGY_CLI_BIN`,
`AGY_SEARCH_AGENT` (websearch), `AGY_SEARCH_MODEL` (gemini-3.8-flash),
`AGY_SEARCH_EFFORT` (low), `AGY_SEARCH_PROVIDER_ID` (gemini — set to e.g.
`antigravity` when registering this as a distinct provider; the Dalton broker
pins the provider id, so leaving `gemini` keeps that path drop-in),
`AGY_SEARCH_TIMEOUT_MS` (90000), `AGY_SEARCH_STALL_MS` (60000),
`AGY_SEARCH_MAX_CONCURRENT` (8), `AGY_SEARCH_QUEUE_TIMEOUT_MS` (60000; when all slots stay busy past this wait the service
  responds with a `Gemini API error (429): rate limit exceeded …` shaped message, so
  downstream rate-limit classification and retry behavior match the native gemini
  provider being throttled),
`AGY_SEARCH_CACHE_TTL_MS` (900000), `AGY_SEARCH_CWD` (`./websearch-cwd`).
Logs are `[AGYWS]` JSON lines on stdout (query truncated to 120 chars;
answers never logged).

Known deviations from the gemini provider: `count` validation errors use the
code `invalid_count`; transport failures surface as `agy_*` error codes;
citation redirect resolution batches 16 at a time (gemini uses 10) and uses a
strict SSRF guard without the fake-IP proxy allowance. Soft time ranges (see
above) are the only behavioral difference in results.
