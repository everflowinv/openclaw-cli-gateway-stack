# CLI accounting, viewer, and MCP routing audit — 2026-10-13

## Findings and accounting contract

The retained logs since October 12 contained 451 completed Antigravity gateway
requests with native conversation database evidence. All 451 token vectors
matched. In 69 requests cache-read tokens exceeded **fresh** input tokens;
this is valid, since AGY `input_tokens` excludes cache reads. AGY output already
includes thinking. Neither cached input nor thinking is added a second time.
This audit validates measured token counts, not subscription billing invoices.

All 56 retained completed Claude requests had message observations whose output
sum differed from the final result. Assistant envelopes often replay the small
initial output count. Successful request totals were already correct because
the ledger reconciles against final `result.usage`; interrupted requests could
retain an understated output count. The gateway now observes stream
`message_start` and final `message_delta.usage`, merges by message ID, and never
lets a stale assistant replay reduce counters. Foreground and child lanes are
tracked independently. The ledger preserves completion markers even when token
counts are unchanged, and flags surviving historical partial observations as
`claude_gateway_partial_usage_lower_bound`. Missing final usage cannot be
reconstructed from elapsed time or text length.

Three distinct concepts remain separate:

- Context reporting: the first foreground model call's complete prompt plus
  cumulative foreground output is returned through the OpenAI-compatible API.
  This is the established OpenClaw compaction contract.
- Accounting: final request totals include repeated tool/model round trips;
  Claude model-message observations deduplicate by ID. Muse journal model-call
  IDs deduplicate mirrors, and separately attributed background work remains
  included in billing totals.
- Price: Claude's reported API-equivalent cost or current local model catalog
  rates produce **estimates**, not subscription charges. No catalog rates were
  changed by this audit. Unknown models/rates remain unpriced. A context-tiered
  price is not inferred from a multi-call aggregate; known per-call contexts
  can be priced individually. Existing reports also disclose estimates and
  unknown context tiers. Muse Full remains unpriced.

## Viewer

The default view shows request status, reply text and expandable tool rows.
Usage events update accounting state without adding content rows or splitting
streamed text. A closed-by-default accounting panel contains totals, model
summaries and per-request input/cache/output, reported context and cost details.
Cache writes are included once when displaying total input, despite the legacy
Claude log shape keeping them outside `prompt_tokens`.

Claude tool argument fragments and tool-result bodies are now logged as well
as tool names. All three lanes use the same expandable parameter/result view.
Missing or ambiguous tool identities remain separate rows rather than attaching
results to an arbitrary call. Content absent from a CLI's stream is not invented.
Raw downloaded logs still contain original accounting events.

## MCP requester and child completion

Validated against the locally installed OpenClaw **2026.9.9**. Regeneration
produced 49 gateway tools; local and configured upstream tools are added at
runtime. The HTTP tool factory supports one-shot `mode: run` here; the generator
no longer advertises an unsupported thread-bound persistent-session overlay.
This is the installed runtime surface, not a claim about latest upstream releases.

`OPENCLAW_REQUESTER_SESSION_KEY` binds caller identity. If absent or the bare
`main` alias, a unique `agent:<agentId>:mcp:<uuid>` is created for the MCP process.
Model-supplied requester overrides on `sessions_spawn`, `subagents` and
`sessions_yield` are rejected. Target keys on `sessions_send` and
`sessions_history` retain their normal meaning. Clients requiring continuity
across MCP process restarts must supply a stable transport requester key.

For ordinary hidden child runs the bridge defaults
`expectsCompletionMessage: false`. Explicit native completion choices remain
available. Accepted spawn run IDs and child session keys are stored per requester.
`sessions_yield` observes native `agent.wait` for those exact runs, checks the
matching terminal receipt and reply disposition, and returns the child reply
inside the MCP response. A disappearing subagent-list row is no longer treated
as success. Observation timeout or transport failure retains the pending run;
call `sessions_yield` again without respawning. Default wait is 240 seconds,
maximum 1,800 seconds. Paused/yielded runs are not misreported as final.

Native terminal reply snapshots are limited to 4,096 UTF-16 characters. The
response exposes `replySource`, `replyLimitChars` and `replyMayBeTruncated`;
long replies are not silently claimed complete. Existing Desktop parent
continuation expansion remains intact and separately tested.

Native MCP-shaped results preserve content blocks and `isError` rather than
being wrapped as successful JSON text. HTTP invocations use UUID idempotency
keys. Preexisting ResearchData stdio and upstream include/exclude changes were
preserved and covered by their tests.

## Validation

- AGY native accounting: 451/451 matching completed requests.
- JavaScript shared/MCP regression suite: 62 passed, plus 6 new accounting,
  identity and exact terminal-receipt cases. Gateway, parser and viewer tests
  passed after changes.
- Usage ledger: 68 Python tests passed, including new partial/final evidence cases.
- Installed OpenClaw serializer: 96 synthetic model/effort cases passed.
- Real Chrome viewer test: three tabs, 100 repeated usage events without log
  flooding, accounting deduplication, expandable tool content, filtering,
  downloading, clearing and live SSE updates; no page errors.
- Live MCP smoke: an isolated requester dispatched an AGY child; the exact
  `MCP_CHILD_RETURN_OK` reply returned through `sessions_yield`. The native
  subagent registry confirmed the original isolated requester, matching child
  key, and `expectsCompletionMessage: false`; requester was not `agent:main:main`.

No raw conversation text, credentials, or private tool output is included here.
