# Parsers — reading Claude Code / Antigravity CLI output

Standalone, dependency-free (node stdlib only) parsers for the two CLIs'
headless streaming output. This is the same logic the gateways use, extracted
so you can consume either CLI's output without running a gateway.

```bash
# claude: pipe stream-json through the parser, human-readable
claude -p --input-format stream-json --output-format stream-json --verbose \
  --no-session-prompt 2>/dev/null \
  <<< '{"type":"user","message":{"role":"user","content":"hi"}}' \
  | node parsers/claude-stream-json.mjs --human

# agy: same idea (note the different input envelope: "event", not "type")
echo '{"event":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}' \
  | agy --input-format stream-json --output-format stream-json \
      --dangerously-skip-permissions --disable-slash-commands \
      --model gemini-3.8-flash --effort low \
  | node parsers/agy-stream-json.mjs --human
```

Default output is normalized NDJSON (one event per line); `--human` prints
answer text to stdout and progress to stderr. As a module:

```js
import { makeAgyStreamParser } from "./parsers/agy-stream-json.mjs";
const parser = makeAgyStreamParser({ onEvent: (e) => console.log(e) });
child.stdout.on("data", (c) => parser.write(c));
```

Self-test against recorded fixtures: `node parsers/self-test.mjs`

## Normalized event shapes

Both parsers emit the same small set of events so downstream code can treat
the CLIs uniformly:

| event | claude source | agy source |
|---|---|---|
| `{type:"init", model, …}` | — (first `system` init message varies by version) | `{"event":"init"}` (model, permission_mode, tool list) |
| `{type:"text", text}` | `stream_event` → `content_block_delta.text_delta` (per token) | `step_update.agent_response.text_delta` (**per finished step**) |
| `{type:"thinking", text}` | `content_block_delta.thinking_delta` | not emitted (agy reports only a thinking token count) |
| `{type:"tool_use", id, name, input}` | `content_block_start.tool_use` | `tool_start` (below) |
| `{type:"tool_start", name, via, args}` | — | `step_update.tool` state=ACTIVE |
| `{type:"tool_done", name, durationMs, output}` | — | `step_update.tool` state=DONE |
| `{type:"tool_result", count}` | `{"type":"user"}` message with tool_result blocks | — (results fold into tool_done.output) |
| `{type:"result", …}` | `{"type":"result"}` | `{"event":"result"}` |

## Protocol notes learned the hard way

**Claude Code CLI**
- Output lines are `{"type": ...}`; streaming deltas arrive as
  `{"type":"stream_event","event":{ ...Anthropic SSE shape... }}`.
- `result.usage`: `input_tokens` **excludes** the cache fields; full prompt =
  `input + cache_creation_input_tokens + cache_read_input_tokens`.
- Without `--include-partial-messages` you only get block-level events, no
  token deltas.
- The CLI can exit before draining stdin (auth/network failure) — attach an
  `error` handler on `child.stdin` or the EPIPE takes your process down.

**Antigravity CLI (`agy`)**
- Output lines are `{"event":"name","name":{...}}` (payload nested under the
  same key as the event name); **input** uses
  `{"event":"user","message":{"role":"user","content":[{"type":"text",...}]}}`
  — claude's envelope with `type` renamed to `event`.
- Input accepts **text blocks only** — image blocks are rejected outright.
- MCP tool calls arrive as a generic `call_mcp_tool` whose `parameters` carry
  `{ServerName, ToolName, Arguments}`; the parser unwraps them to
  `"server.tool"` so logs read `openclaw.exec(command=...)`.
- `usage`: `input_tokens` **excludes** `cache_read_tokens`;
  `output_tokens` already includes `thinking_tokens` (agy 1.2.0 ModelUsageStats).
  Use `input + cache_read + output` for disjoint local token totals; do not add thinking again.
  The raw CLI `total_tokens` can omit cache reads, so it is not used as the accounting sum.
- `result` can be `status:"ERROR"` ("The stream was interrupted...") while
  still carrying the **complete** response text — check
  `hasFullText` before treating it as a failure. This happens when a proxy
  drops the long-lived model stream at its tail.
- 1.1.25+ can fail to exit after the result event (linger or hang); treat
  `result` as authoritative and reap the child yourself.
- While tools run, nothing is emitted — a long silence is normal during
  execution but also the signature of a dead stream; consumers need a stall
  watchdog (the gateway defaults to 600s).
