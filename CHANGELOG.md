# Changelog

## 2026.10.15

- Restore deferred tools on OpenClaw Tool Search runs. Since 10-13 the
  per-request allowlist kept only directly sent tools, and OpenClaw (Tool
  Search on by default) sends just its core tools plus `tool_search` /
  `tool_describe` / `tool_call`, so Claude, AGY and Muse lanes lost
  `web_search`, `message`, `researchdata__*` and every other deferred tool.
  When `tool_call` is present the gateways now rebuild the deferred catalog
  from OpenClaw's system-prompt directory (listed OpenClaw names; bridged MCP
  catalogs only when the directory reports unlisted entries). The proxy
  allowlist accepts `<server>__*` for one bridged catalog. No directory keeps
  the direct set. Claude CLI still defers the schemas through its ToolSearch.

## 2026.10.13

- Audit 451 AGY request totals against native conversation databases: all
  matched; cached input and reasoning are counted once. Capture Claude final
  streamed message usage, preserve it across stale assistant replays, and
  disclose unreconciled historical partial observations as lower bounds.
- Fold viewer accounting by default; merge tool arguments/results into
  expandable rows across all CLI tabs. Deduplicate message usage and replace
  it with final request totals; label price estimates separately from charges.
- Bind MCP requester identity to its transport, isolate unbound clients, and
  return exact spawned-run terminal replies through `sessions_yield`. Default
  hidden runs to quiet completion; retain pending runs on observation timeout.
  Regenerate schemas from installed OpenClaw 2026.9.9 without unsupported
  HTTP thread/session overlays. Preserve native MCP errors and image content.
- Preserve and validate pending upstream tool selection / ResearchData stdio
  changes. See `docs/cli-accounting-routing-2026-10-13.md` for evidence.

- Finish the interrupted Muse bridge update: raise the complete prompt's
  UTF-8 cap from 1,400,000 to 1,900,000 bytes after four-model marker and
  journal-preservation probes; keep the 384,000-token safe context.
- Return 413 for explicit Muse context/compaction overflow. Limit the
  generic invalid-parameters 400 fallback to the observed large-text,
  tool-free, schema-free, image-free case; preserve other parameter errors.
- Add exact byte-boundary, Unicode, HTTP/SSE error and parameter-error
  regressions; retain sanitized live-probe evidence in
  `docs/muse-context-probes-2026-10-13.json`.
- Drain oversized HTTP request bodies after iterator cleanup so a 413
  does not strand the next request on the same keep-alive connection.

## 2026.10.12

- Re-verify the bridge against Claude Code 2.1.296, Antigravity CLI 1.3.3
  and Muse Code 1.4.7; see `docs/cli-bridge-update-2026-10-12.md`.
- Antigravity: select models by agy's canonical suffixed ids
  (`--model <base>-<effort>`, no `--effort` flag; the old form is
  intermittently rejected upstream). Remove `gemini-3.1-pro` (no longer
  recognized by the CLI) from the gateway and OpenClaw registration; add
  `gpt-oss-120b` (medium only). Web-search service uses the same suffixed
  selection. The 190,000-byte prompt guard was re-probed on 1.3.3 and stays.
- All lanes present one provider surface: `response_format` passes to each
  CLI's native structured output and returns its `structured_output`;
  per-request `tools`/`tool_choice` narrow the OpenClaw MCP tool set
  (shared `lib/openai-request.mjs`); quota/rate failures return 429 and
  Claude context overflow 413 with the CLI message verbatim; agy's
  structured `AGY_ERROR` line is parsed.
- Maximum-permission posture everywhere, by operator decision: Claude and
  AGY `--dangerously-skip-permissions`, Muse `--yolo`. Claude keeps its
  full native tool set on unrestricted requests (an explicit `tools` list
  still bounds the run to the MCP bridge; `tool_choice: "none"` disables
  all tools). Muse keeps native tools in its private workspace.
- Claude: pin `--autocompact` (default the full 1M window) so the CLI
  cannot silently compact mid-run; remove the retired isolated Opus 5.5
  lane (4572 template and `CLAUDE_CLI_GATEWAY_MODEL_ALLOWLIST`) — every
  Claude model shares the single 4568 gateway.
- Muse: pin context-compaction thresholds (soft 0.9 / hard 0.98) and a
  per-tool output cap; disable reminder agents; pass the native
  none..ultra effort range through; an absent `tools` field now means the
  proxy's full set, matching the sibling gateways.
- Deployment: `install.sh` now defaults to the deployed `ai.openclaw.*`
  labels (re-running updates in place instead of duplicating services),
  installs the Muse lane from a new template that matches
  `muse-cli-gateway/install.py`, and checks port 4571. Point agy's MCP
  bridge at the managed Node 26 like every other client. The usage
  collector's workspace path is now a symlink to this repo's copy.

## 2026.09.10

- Repair usage accounting: deduplicate Codex status counters and Claude message
  chunks; include native OpenAI, Claude subagents, SQLite import archives, agy
  conversation DBs and Dalton invocations. Add an idempotent evidence ledger,
  broker collector, explicit coverage gaps, provider-qualified cost estimates,
  full totals with `--top`, and 32 accounting regressions.
- Fix agy thinking double counting in both gateway and parser: output_tokens
  already includes thinking. Log agy conversation IDs and Claude per-message
  usage for request reconciliation and failed-run recovery. See the accounting
  audit in `docs/usage-accounting-repair-2026-09-10.md`.

- Preserve object-shaped Antigravity tool diagnostics, with bounded fallback
  formatting for Error, circular objects, BigInt and custom toJSON failures.
- Normalize malformed CLI token counters in both gateways and raw agy usage,
  preserving existing cache accounting and explicit zero fields. Add helper
  tests and real HTTP/fake-CLI regression coverage.

- Sync the Antigravity gateway's local prompt-length guard: inputs longer than
  190,000 UTF-8 bytes return HTTP 413 before starting the CLI, with error wording
  that OpenClaw can recognize as context overflow. The byte limit fixes the old character-based guard for Chinese and emoji.
  The legacy MAX_PROMPT_CHARS environment variable remains a fallback alias.
- Six direct agy 1.2.0 probes confirm truncation still occurs near 192 KB in
  stream-json mode without a caller-visible warning; retain the guard. See
  docs/agy-long-context-2026-09-10.md and the sanitized JSON evidence.
- Keep portable home-directory defaults and support `OPENCLAW_WORKSPACE` in the
  Antigravity gateway. Claude's gateway behavior already matches the local copy.
- Fix launchd installation to use the template filenames actually in this repo
  and install plists under their `local.cli-gateway.*` labels.
- Prefer the managed OpenClaw Node runtime during installation, support an
  explicit `NODE_BIN`, and include native Claude's `~/.local/bin` in service PATH.
- Add `--render-only OUTPUT_DIR` for checking generated service definitions
  without changing running services, and regression coverage for prompt limits.
- Validate on Node 26.8.2, Claude Code 2.1.263, and Antigravity CLI 1.2.0.
  Vendor CLI binaries and local account data are not part of the source package.
