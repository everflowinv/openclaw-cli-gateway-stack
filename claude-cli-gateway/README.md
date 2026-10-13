# Claude CLI Gateway

Local OpenAI-compatible gateway that runs each request through the official
Claude CLI subscription path. Claude receives OpenClaw's system prompt and
conversation, then executes OpenClaw tools through the existing `openclaw` MCP
proxy before returning the final answer.

The gateway accepts OpenClaw/OpenAI-compatible multimodal user content. Image
parts are expected as `image_url` data URIs (the format emitted by OpenClaw's
`openai-completions` transport) and are converted in memory to Claude CLI
`stream-json` base64 image blocks. Text and images retain their order, including
images referenced in earlier conversation turns. Supported image MIME types are
PNG, JPEG, GIF, and WebP. Remote HTTP image URLs are intentionally rejected;
OpenClaw downloads and inlines image attachments before provider transport.

Claude's final model response remains OpenAI-compatible text/SSE, including
normal multimodal analysis answers. Claude models do not emit native image
blocks, and OpenClaw's `openai-completions` transport does not consume image
blocks in assistant deltas. Generated or tool-produced media therefore returns
through OpenClaw's existing MCP messaging/media tools rather than the provider
response body.

Endpoints:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`

The service binds to `127.0.0.1:4568` by default. Requests run at maximum
permission (`--dangerously-skip-permissions`): a headless provider cannot
answer permission prompts. The tool surface follows the request — with no
`tools` field the CLI keeps its full native set plus the `mcp__openclaw__*`
bridge; an explicit `tools` list bounds the run to that MCP subset (reached
through `ToolSearch`, narrowed again by the proxy allowlist); an empty list
or `tool_choice: "none"` runs with no tools at all.

OpenClaw registers this endpoint as the separate `claude-cli-gateway`
provider.

Since 2026-09-05 the gateway also:

- passes OpenAI `reasoning_effort` through to `claude -p --effort`
  (low/medium/high/xhigh/max; `none`/`off`/`minimal` map to `low` and
  `ultra` to `max`; anything else is a 400 with the valid list), and
- reports usage with a real cache split (`prompt_tokens_details.cached_tokens`
  + `cache_creation_input_tokens`, OpenAI-style) so OpenClaw prices cache
  reads at the cache rate instead of full input price. Keep that id distinct from OpenClaw's auto-discovered native
`claude-cli` model catalog.

Service operations:

- Health: `curl -s http://127.0.0.1:4568/health`
- Restart: `launchctl kickstart -k gui/$UID/ai.openclaw.claude-cli-gateway`
- Logs: `~/.openclaw/logs/claude-cli-gateway.{stdout,stderr}.log`
- Live viewer: `http://127.0.0.1:8765` (structured `[CLIGW]` request,
  thinking, text, tool, completion, cancellation, and error events are written
  to the stdout log)

Environment controls:

- `CLAUDE_CLI_GATEWAY_AUTOCOMPACT` (default `1000000`, or `auto`): pins the
  CLI's in-run auto-compact window. The default keeps the full native 1M
  context inside a run — OpenClaw's 950k context target owns cross-turn
  sizing, and the CLI's own threshold must not silently summarize early
  tool results mid-turn.
- `CLAUDE_CLI_GATEWAY_WORKSPACE` / `OPENCLAW_WORKSPACE` (default
  `~/.openclaw/workspace`) — workspace dir passed as the CLI cwd
- `CLAUDE_CLI_GATEWAY_PORT` (default `4568`)
- `CLAUDE_CLI_GATEWAY_MAX_CONCURRENT` (default `4`)
- `CLAUDE_CLI_GATEWAY_QUEUE_TIMEOUT_SECONDS` (default `120`)
- `CLAUDE_CLI_GATEWAY_TIMEOUT_SECONDS` (default `3600`)
- `CLAUDE_CLI_GATEWAY_STALL_SECONDS` (default `1200`): terminate a request
  after 20 minutes without CLI stdout. Gateway SSE heartbeats do not count as
  CLI progress. Cancellation/stall/timeout sends SIGTERM to the CLI process
  group, escalates to SIGKILL after 5 seconds, then releases the request within
  another second even if inherited output pipes never close. Terminal errors
  trigger cleanup immediately; a successful result gets 10 seconds to exit.
  `/health` exposes the stall timeout and cleanup deadline.
- `CLAUDE_CLI_GATEWAY_MAX_TURNS` (default `200`)
- `CLAUDE_CLI_GATEWAY_EXEC_MAX_TIMEOUT_MS` (default `600000` = 10 min; per-call
  ceiling passed to the openclaw MCP proxy as
  `OPENCLAW_MCP_LOCAL_TOOL_MAX_TIMEOUT_MS`, capping `exec`/`process` even when
  the model requests a larger `timeoutMs`. Timing out returns a tool error with
  partial output so the model can retry or move the work to a background
  `process` session)
- `CLAUDE_CLI_GATEWAY_MAX_BODY_MB` (default `64`, encoded HTTP request)
- `CLAUDE_CLI_GATEWAY_MAX_IMAGES` (default `20`)
- `CLAUDE_CLI_GATEWAY_MAX_IMAGE_MB` (default `10` per image)
- `CLAUDE_CLI_GATEWAY_MAX_TOTAL_IMAGE_MB` (default `20` decoded total)
- `CLAUDE_CLI_GATEWAY_API_KEY` (optional local bearer token)

## Opus 5.5 接入（2026-09-22）

已验证官方 CLI 2.1.280 可使用 `claude-opus-5-5`；2.1.273 会被服务端明确拒绝。API 刊例为输入 $4、缓存读取 $0.20、5分钟缓存写入 $5、输出 $20，均为每百万 tokens；1小时缓存写入另为 $8。CLI实测模型元数据为1M context、128K max output。

最初为保留原入口正在执行的任务，曾使用同一份 `server.mjs` 另开仅允许
Opus 5.5 的 `4572` 入口。它使用同一个官方 CLI 登录，不代表模型或 CLI
只能运行两个并发请求。

2026-10-10：移除 OpenClaw 中 Opus 5.5 的单模型 `baseUrl` 覆盖，统一继承
Claude provider 的 `http://127.0.0.1:4568/v1`。Opus、Sonnet、Fable 和 Haiku
共享该入口的 6 个并发槽位。旧 `4572` 入口在现有请求排空后停用，其
LaunchAgent 从自动加载目录移出。2026-10-12 起独立入口的 launchd 模板与
`CLAUDE_CLI_GATEWAY_MODEL_ALLOWLIST` 代码一并删除：所有 Claude 型号只走
同一个 4568 网关，不再维护单模型隔离通道。

## Haiku 5.5 接入（2026-10-07）

`claude-haiku-5-5` 需要官方 CLI 2.1.293 或更新版本。2.1.286 会报 `unrecognized_model`，并把上下文按 200k 处理；2.1.293 的内置模型表为 1M 原生上下文、128K 默认输出，effort 支持 low 到 max。本机 CLI 已于当天升级到 2.1.293，4568 已重启加载新模型。

API 刊例按单次请求的 prompt 长度分两档（每百万 tokens）：不超过 100,000 tokens 时，输入 $0.10、缓存读取 $0.01、1 小时缓存写入 $0.20、输出 $0.50；超过 100,000 tokens 时整单改为 $0.50、$0.05、$1、$2.50。CLI 只写 1 小时缓存，OpenClaw 的 `cacheWrite` 按 1 小时价登记，并用 `tieredPricing` 的 `[0, 100001)` 和 `[100001]` 两档表示。

同日 Sonnet 5.5 的缓存读取价按官方价表更正为 $0.10（基础输入价的 5%），此前误登记为 $0.20。

经网关实测，Haiku 5.5 和 Sonnet 5.5 都能处理约 961k prompt tokens 的单次请求，并找回首尾两个暗号；约 1.026M 的请求被 CLI 以 `Prompt is too long ... (limit 1000000)` 拒绝。OpenClaw 沿用 `contextTokens 950000 / contextWindow 1000000 / maxTokens 128000`。

## Bridge contract review (2026-10-09)

All four advertised Claude models support low/medium/high/xhigh/max. Explicitly
set `compat.supportsReasoningEffort` and `compat.supportedReasoningEfforts` in
OpenClaw for every model on this custom endpoint; otherwise OpenClaw can omit
the requested effort entirely. `off`/`none`/`minimal` map to `low` because these
models cannot disable reasoning; `ultra` maps to `max`. An explicit request also
sets the child process effort environment so inherited settings cannot override it.

`max_tokens`/`max_completion_tokens` are not exact native CLI output limits.
`/health` reports `outputTokenLimitEnforced: false`. Size the outer provider
request deadline above the gateway queue plus execution timeout; Dalton's
separate 600-second budget is an intentional earlier cancellation boundary.

## Provider-surface update (2026-10-12, Claude Code 2.1.296)

- Structured output: `response_format` (`json_schema` / `json_object`) is
  passed to the CLI's native `--json-schema`; the reply is the CLI's
  `structured_output`, never surrounding prose. Unknown format types are a
  400 instead of being silently ignored.
- Terminal failures classify provider-style with the CLI message verbatim:
  prompt/context overflow → `413 CLAUDE_CLI_CONTEXT_TOO_LONG`,
  quota/rate/overload → `429 CLAUDE_CLI_QUOTA`, other CLI failures → 502.
- `--autocompact` is pinned (see Environment controls) so a long native
  tool loop cannot compact away context OpenClaw still accounts as present.
