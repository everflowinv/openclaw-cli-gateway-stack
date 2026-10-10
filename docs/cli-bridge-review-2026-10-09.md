# CLI bridge review — 2026-10-09

This review covers the local OpenClaw → CLI gateways → native runtimes and
Dalton Research OS model-broker configuration. It used installed Claude Code
2.1.293, Antigravity CLI 1.3.2 and Muse Code 1.4.4 (1.4.4-R5419.1), actual
OpenClaw request serialization, synthetic failure tests and bounded native
model probes. These are observed versions, not latest-version claims.

## Effective contracts

| Lane | Upstream context retained | Native effort mapping | Input boundary |
|---|---:|---|---|
| Claude Opus/Sonnet/Haiku 5.5, Fable 5.1 | 1,000,000; existing 950,000 context target | low/medium/high/xhigh/max; off/none/minimal → low; ultra → max | Native 1M; existing Oct 7 Sonnet/Haiku tests accepted ~961k and rejected ~1.026M prompt tokens |
| AGY Gemini 3.8 Flash | 1,048,576 | low/medium/high; off/none/minimal → low; xhigh/max/ultra → high | Separate 190,000 UTF-8 byte guard |
| AGY Gemini 3.1 Pro | 1,048,576 | low/high; medium → low; xhigh/max/ultra → high | Same byte guard; suffix `-high` now honored |
| Muse Spark 1.3 / Contributor | 384,000 safe window | minimal/low/medium/high/xhigh/max; off/none → minimal; ultra → max | 1,400,000 UTF-8 bytes plus per-request first-model-input journal verification |

Context metadata, transmitted bytes, current context occupancy and cumulative
billable usage are separate quantities. None of these CLI wrappers enforces an
exact per-request `max_tokens` or `max_completion_tokens` cap. Health endpoints
now report `outputTokenLimitEnforced: false`. Dalton's CLI profiles already
allow output overruns and do not qualify for controlled proof endpoints.

## Why AGY must retain the 1M declaration

Historical fixes `2184c23` (AGY) and `aaac776` (Claude), both September 23,
separated repeated tool-loop input usage from context occupancy. One AGY
15-step example had first-call input 13,081 versus accumulated input 271,130.
Reducing the upstream context declaration to match a byte cap would recreate
premature OpenClaw compaction without improving native input preservation.

The installed OpenClaw compaction implementation was exercised directly with
its default 16,384-token reserve: accumulated usage 1,405,000 triggers compaction
at a 1,048,576 window; context-oriented usage 18,081 does not. A hypothetical
50,000 window also prematurely compacts an 80,000-token conversation.

Native AGY 1.3.2 probes used six random markers distributed through synthetic
input. At approximately 180 KB, all six were preserved. At approximately
264 KB, the sixth marker was absent from the actual model-request record and
that record contained a truncation marker, even though the CLI reported
SUCCESS. The gateway's 190,000-byte guard therefore remains necessary.
Checking only the model's answer is insufficient: predictable endpoint labels
can be guessed after truncation. The observed 180 KB success is not a universal
proof that every prompt below the configured guard is preserved.

## Muse visibility and accounting

The former gateway discarded live text callbacks, logged only a tool call ID,
and never read tool arguments from the journal. The viewer consequently had no
content to display. It now records stdout text and tool results, and incrementally
reads tool arguments from the same foreground run's session journal. Mirror
records are deduplicated; background traffic, prompts and encrypted reasoning
are excluded. Nonempty plaintext reasoning is displayed when supplied by Muse.
`MUSE_CLI_GATEWAY_LOG_CONTENT=0` disables content events.

The log viewer also fixes a concurrent queue-drain race, startup tail gaps,
fragmented UTF-8/JSON records, invalid tail counts, rotation/truncation handling,
and unbounded slow-client queues. Terminal text that differs from live text is
shown as an explicit final event.

Muse HTTP/SSE usage now uses first foreground input plus cumulative foreground
output, matching the sibling gateways' context-oriented convention. Log usage
still includes all reported foreground and background calls; `usage_reported`
records the HTTP values. This is an estimate suitable for the existing host
compaction contract, not a measurement of every hidden native context lane.
Dalton consumes the HTTP values, so its token/cost observations cannot substitute
for complete multi-call billing totals; the gateway usage logs retain those.
API list-price estimates are not subscription charges.

A real Muse MCP read produced visible tool arguments, tool output and final
text. Its HTTP prompt usage was 22,060 while all-call logged prompt usage was
51,827. A separate Muse 1.4.4 probe sent 1,382,736 bytes, recovered all six random
markers, reported 310,041 foreground prompt tokens, and passed journal input
verification. This supports retaining the conservative 384,000/1.4 MB limits;
it does not establish a full native 1M safe limit for Muse 1.4.4.

## OpenClaw and Dalton configuration repairs

Actual `runtime.llm.complete` requests were captured against an isolated fake
HTTP endpoint: eight model registrations × seven thinking levels plus default
= 64 combinations. Previously Sonnet, Fable and Haiku omitted `reasoning_effort`
for every requested level. Their custom-endpoint configuration lacked explicit
`compat.supportsReasoningEffort` and `supportedReasoningEfforts`.

All Claude model registrations now supply compatibility and mapping explicitly.
All 64 combinations pass. The gateway also sets an explicitly requested Claude
effort in the child environment, preventing inherited effort from overriding it.
Dalton profiles that previously relied on the CLI default now pin Fable high,
Sonnet medium and Haiku medium. This preserves their prior default behavior
while allowing explicit upstream thinking levels to reach the runtime.

Provider deadlines now cover queue plus runtime plus transport margin:
Claude/AGY 4,620 seconds (600 + 3,900 + 120), Muse 2,040 (120 + 1,800 + 120).
Dalton's separate 600-second job deadline remains intentional and unchanged.
No context window, fallback chain or global thinking default was lowered.
Machine-specific configuration is backed up outside Git, contains credentials,
and is deliberately not included in this report.

## Other repairs

- Claude/AGY disconnected queued calls no longer start native processes later;
  listener cleanup and the post-acquisition cancellation race are covered.
- All three model gateways return a structured HTTP 413 on excessive bodies
  without destroying the response socket first.
- Claude/AGY decode fragmented stdout with a UTF-8 StringDecoder.
- AGY unknown efforts and malformed model identifiers fail as client errors.
  Requester session identity is read only from system instructions.
- AGY ERROR/interrupted/timeout prose is diagnostic, never a successful terminal
  answer. SSE errors do not emit a successful stop; the standalone parser agrees.
- Version probes are asynchronous, coalesced and refreshed after 60 seconds,
  fixing event-loop blocking and the stale Muse 1.3.0 health version.
- The dedicated AGY web-search service retains its separate Flash/low,
  1,000-character query and 90-second runtime contract. It now handles native
  spawn errors without crashing, preserves fragmented Unicode, rejects terminal
  error fields, and uses the same asynchronous health probe. No generic chat
  context declaration is applied to this specialized service.

## Reproduction and results

```sh
node --test lib/*.test.mjs muse-cli-gateway/*.test.mjs
node claude-cli-gateway/server.integration.test.mjs
node antigravity-cli-gateway/server.integration.test.mjs
node antigravity-cli-gateway/websearch.integration.test.mjs
node parsers/self-test.mjs
python3 live-log-viewer/test_server.py
python3 live-log-viewer/test_dashboard.py \
  --browser-executable '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --screenshot /tmp/cli-review-dashboard.png
node lib/openclaw-bridge.integration.mjs OPENCLAW_INSTALL_ROOT OPENCLAW_CONFIG_PATH
```

The focused Node suite passed 28 tests. Both chat gateway integration suites,
the web-search regression, 13 parser assertions, the Python SSE regression,
and the real Chrome dashboard checks passed. The host bridge matrix passed
64 cases, and `openclaw config validate` accepted the candidate configuration.
The baseline run including the unchanged MCP proxy passed 58 tests.
Browser verification includes visible Muse Unicode text/tool arguments/results,
usage deduplication, filters, download, clearing, tab switching and live SSE.

Native evidence is intentionally summarized rather than checking private
session journals, credentials or raw logs into Git. Long-context samples probe
specific versions and payloads, not every possible conversation or tool loop.

## Runtime references

- [Claude model configuration](https://code.claude.com/docs/en/model-config)
- [Muse reasoning](https://dev.meta.ai/docs/reasoning)
- [Muse Code configuration](https://dev.meta.ai/docs/muse-code/configuration)
- [AGY headless protocol](https://www.agy.dev/docs/cli/headless/)

Local runtime/model-catalog evidence takes precedence over broader API capability
claims when defining this CLI bridge's safe behavior.
