# Public repository safeguards

This repository is public and the primary checkout is also used by local services.

- Develop in an isolated Git worktree. Do not overwrite unrelated changes or restart services unless the task calls for it.
- Inspect staged changes before committing. Never publish real credentials, `.env` files, machine-local MCP/OpenClaw configuration, production logs, session databases, private prompts or unredacted tool output. Sanitize examples and fixtures.
- Run a redacted secret scan before publishing. Investigate findings instead of adding broad allowlists or bypassing protection. Do not print secret values in tool output, issues or PRs.
- Preserve loopback defaults and existing tool allowlists. Do not introduce public listeners or weaken authentication, tool policy or repository security settings.
- Keep CI permissions minimal, pin Actions to full commit SHAs, and do not expose secrets or self-hosted runners to untrusted PR code.
- Follow SECURITY.md for vulnerabilities. Rotate leaked credentials before discussing history cleanup; never rewrite public history without explicit authorization.
