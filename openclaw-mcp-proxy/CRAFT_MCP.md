# Craft headless MCP

The proxy bridges the `gridcraft`, `wordcraft`, and `pdfcraft` **stdio** entries
from the owner's `openclaw.json` `mcp.servers`. It does not execute arbitrary
servers from that file. Omitted/disabled entries are skipped.

- Existing Claude Code, Codex, and agy `openclaw` MCP registrations gain
  `gridcraft__*`, `wordcraft__*`, and `pdfcraft__*` tools at the next client start.
- The Claude gateway's strict MCP configuration needs no extra server or wider
  `--allowedTools`: these remain `mcp__openclaw__*` tools.
- Muse gateway only forwards Craft tools explicitly present in the request's
  tool list. Empty tools and `tool_choice: none` remain closed. Native OpenClaw
  MCP names and Codex-style `mcp__<server>__<tool>` names are normalized.
- Restricted remote Desktop mode never launches these servers. Its two-tool
  `sessions_start`/`sessions_send` boundary is unchanged.
- Each proxy owns its own child processes and document state. Calls to one
  server are serialized. A new proxy/run must reopen saved files; unsaved state
  does not survive process exit. Native OpenClaw owns its separate MCP runtime.
- Tool filters intersect with the caller's server-enforced allowlist. Images,
  structured content and tool errors are returned without flattening.
- Timeout/crash closes the affected process; mutations are never auto-retried.

The owner installation uses GridCraft 0.5.0, WordCraft 0.5.0, PdfCraft 0.6.0
under `~/.local/share/craft-tools/<name>/<version>/`, with CLI symlinks in
`~/.local/bin`. `pdfcraft-cli mcp --compact` exposes 17 tools with discovery;
WordCraft uses `WORDCRAFT_NO_PREFS=1`. No GUI or listening HTTP server is needed.
Standalone Muse uses three direct `mcpServers` entries in its global settings.

Keep LibreOffice and the existing Office/PDF tools. Use Craft for controlled
headless editing, not as an unverified replacement for complex Office roundtrips.
GridCraft's tested Chinese PDF export is unsuitable; WordCraft can discard
content controls, and its tracked-edit `get_text` includes deletions. PdfCraft
extraction is not a sole financial-table parser or a Chinese OCR solution.

Verification: `node --test openclaw-mcp-proxy/craft-stdio.test.cjs
muse-cli-gateway/craft-policy.test.mjs`, plus the existing proxy integration and
Muse gateway suites. Machine-level installation probes and readback artifacts
are retained separately in the owner's workspace `temp/`.
