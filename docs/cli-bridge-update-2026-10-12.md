# CLI bridge update — 2026-10-12

Follow-up to the October 9 bridge review, after the downstream CLIs moved
to Claude Code **2.1.296**, Antigravity CLI **1.3.3** (auto-updated to
**1.3.4** during the day; the suffixed-id smokes below ran on 1.3.4), and
Muse Code **1.4.7**. Goal: every lane behaves like a normal
OpenAI-compatible model provider — same request surface, same error
classes, maximum downstream permission — without weakening the October 9
context contracts.

## Probes (live, this machine)

- `agy models` on 1.3.3 lists only suffixed ids: `gemini-3.8-flash-*`,
  `claude-opus-5-5-*`, `claude-sonnet-5-5-*` (low/medium/high) and
  `gpt-oss-120b-medium`. `gemini-3.1-pro-low` is rejected as "not
  recognized as a known model". `--help` advertises effort xhigh/max, but
  the live catalog tops out at high. The gateway log already contained
  two `--effort is not supported for model "gemini-3.8-flash"` rejections
  (Sep 5 and Oct 12) under the old `--model <base> --effort <x>` form;
  the suffixed form succeeds in stream-json.
- AGY long-context guard re-probed on 1.3.3 with six random UUID markers:
  ~185KB kept 6/6, ~260KB kept only the first 4, still SUCCESS. The
  190,000-byte guard stays.
- Claude 2.1.296 accepts `--autocompact 1000000` and `--json-schema` in
  `-p` stream-json mode; the result carries both a JSON-string `result`
  and parsed `structured_output`.
- Muse 1.4.7 `exec` accepts the compaction thresholds, tool-output cap,
  `--disable-reminders` and `--yolo` together (echo-provider parse check);
  its Meta provider rejects non-strict output schemas with
  `'additionalProperties' is required to be supplied and to be false`
  (found by live smoke, fixed by strictifying — see below).
- AGY `--json-schema` works, but the free-form `response` text carries
  extra `toolAction`/`toolSummary` fields; `structured_output` is clean.

## Changes

**One provider surface on all lanes** (shared `lib/openai-request.mjs`):
`response_format` → each CLI's native structured output, replying with
`structured_output`; per-request `tools`/`tool_choice` narrow the OpenClaw
MCP set via the proxy allowlist (absent `tools` = full set); unknown
models/efforts/format types stay hard 400s; quota/rate failures return
429, Claude context overflow returns 413 with the CLI message verbatim;
agy's structured `AGY_ERROR` line is parsed. `max_tokens` remains
unenforceable on every CLI (no native flag) and stays documented as
`outputTokenLimitEnforced: false`.

**Maximum permission everywhere** (operator decision): Claude and AGY run
`--dangerously-skip-permissions`, Muse runs `--yolo`. Tool *availability*
still follows the request: an explicit `tools` list bounds the run to that
MCP subset, and an empty list / `tool_choice: "none"` disables tools
(Claude `--tools ""` with no MCP config; Muse no MCP plus
`--disable-write/--disable-shell/--disable-web-tools`; AGY MCP sentinel —
its native tools have no disable flag).

**Antigravity**: suffixed model transport; `gemini-3.1-pro(-preview)`
removed from gateway, OpenClaw registration, allowlists and Dalton broker
profiles; `gpt-oss-120b` added (131,072 window, medium only); Claude-via-
AGY context windows corrected to the native 1,000,000. Web-search service
selects its model the same suffixed way.

**Claude**: `--autocompact` pinned to the full 1M window by default
(`CLAUDE_CLI_GATEWAY_AUTOCOMPACT`), so in-run compaction cannot silently
summarize what OpenClaw still accounts as present; OpenClaw's 950k target
keeps owning cross-turn sizing. The retired isolated Opus 5.5 lane is
fully removed (4572 template and the model-allowlist code) — one 4568
gateway serves every Claude model.

**Muse**: compaction thresholds pinned (soft 0.9 / hard 0.98) so the
byte-capped first input is never summarized before inference (journal
verification still fails closed at 413); `--max-tool-output-bytes`
262,144; reminder agents disabled (one live sample showed ~30% of prompt
tokens were background calls); native `none..ultra` efforts pass through
(registration `off → none`); caller schemas are strictified
(`additionalProperties: false` recursively) for the Meta provider, and
free-form `json_object` degrades to an explicit one-JSON-object
instruction since it cannot be expressed strictly. Follow-up probes on
October 13 completed on all four models: approximately 1.9MB of English,
six recovered markers and verified journal input bytes (~337k reported
prompt tokens); Contributor also passed 1.4MB of Chinese (~308k tokens).
The byte cap is now **1,900,000**, including gateway framing. The safe
window stays **384,000 tokens**: the CLI estimator's 501,760-token hard
threshold rejected the 2.09MB and larger English probes, and byte count
does not guarantee a token budget for arbitrary content. See the
[sanitized probe evidence](muse-context-probes-2026-10-13.json).

Explicit estimator/context overflow returns 413 `MUSE_CONTEXT_LIMIT`.
A dense-text live probe also returned the provider's generic
invalid-parameters 400. A narrowly scoped compatibility heuristic treats
that exact error signature as possible overflow only for large (at least
1MB), text-only, tool-free, schema-free requests. Other API 400s retain
502 `MUSE_TURN_FAILED`; prompt size alone must not hide schema/image/tool
parameter errors.

**Deployment**: `install.sh` defaults to the deployed `ai.openclaw.*`
labels (re-running used to create duplicate services on the same ports),
installs the Muse lane from a new template verified identical to
`muse-cli-gateway/install.py`'s spec, and health-checks 4571. AGY's MCP
bridge now uses the managed Node 26 like every other client. The usage
collector's workspace path is a symlink to this repo's single copy.
Rendered plists match the installed ones except harmless PATH ordering.

## Verification

Synthetic, no model spend: `lib` units (incl. new `openai-request`
suite), Muse gateway suite (14 tests), Claude/AGY/WebSearch HTTP
integration, parsers self-test, MCP proxy suite (43 tests), log-viewer
test, and the OpenClaw serialization matrix — now 96 cases (12 models ×
8 levels) against the updated `openclaw.json`, which `openclaw config
validate` accepts.

Live, after restarting each service only at zero active/queued requests:
health on 4568/4569/4570/4571 reports the new fields
(`structuredOutput`, `permissionMode`, `autocompact`, compaction pins);
per-lane provider smokes pass for model list, chat, streaming (delta-
joined), structured output and dead-model 400; the web-search service
returns a grounded answer on `gemini-3.8-flash-low`; end-to-end
`openclaw agent` turns return the exact markers through
`muse-cli-gateway/muse-spark-1.3-contributor` and the newly registered
`antigravity-cli-gateway/gpt-oss-120b` (execution trace: winner
gpt-oss-120b, no fallback). No gateway wrote to stderr across restarts.

### October 13 closeout

The final regression run passed 45 gateway/shared-library tests, all 43
MCP tests in the local workspace, parser self-tests and 96 OpenClaw
serialization cases. OpenClaw config validation and all five rendered
LaunchAgent plists passed. The independent MCP changes that predated
this bridge session remain local and are not part of this update.

The larger HTTP-body regression exposed a keep-alive bug: resuming a
rejected request from inside its async iterator could leave the remainder
paused after iterator cleanup. The gateway now drains after cleanup;
a regression explicitly reuses the same socket after the 413.

After restarting only the idle Muse service, live checks passed for the
four-model catalog, the 1.9MB prompt guard, Contributor chat, structured
SSE and reported usage. The long-context evidence above comes from the
original session's completed probes; it was retained rather than rerun.

## Not done / residual risks

- Muse probes justify the larger byte cap, not a larger `SAFE_CONTEXT`.
  Generic provider 400 lacks a definitive overflow signal; the limited
  compatibility mapping above remains a heuristic.
- Claude `--exclude-dynamic-system-prompt-sections` was evaluated and
  skipped (single-machine prompt caching already hits ~100%).
- Per the final user instruction, further AGY image/cache investigations
  were cancelled. AGY headless image input remains unproven on 1.3.4; the lane still
  rejects images so OpenClaw fails over to a multimodal provider.
- AGY usage counters occasionally report `cache_read_tokens` larger than
  the prompt (multi-step sums); first-call context reporting is
  unaffected and billing stays an estimate, as before.
- Under maximum permission, a compromised prompt can act through the
  CLIs' native tools, not only the audited MCP bridge. That is the
  operator's chosen posture for this loopback-only deployment.
