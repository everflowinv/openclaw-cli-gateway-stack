# Changelog

## 2026.09.10

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
