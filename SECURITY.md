# Security policy

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/everflowinv/openclaw-cli-gateway-stack/security/advisories/new). Do not put credentials, private prompts, tool output, account details, or exploitable security reports in public issues or pull requests. Include a minimal sanitized reproduction and the affected commit.

Security fixes target the latest `main`. There is no guaranteed response SLA.

## Trust boundary

This stack is for a trusted local user on a trusted machine. Gateways run logged-in coding CLIs, and the MCP bridge can expose filesystem access, command execution and other powerful OpenClaw tools. A caller may therefore act with the local user's privileges.

Keep all HTTP services on loopback. Do not set gateway host overrides to external interfaces, publish ports through containers, tunnels or proxies, or expose the log viewer to the internet. The OpenAI-compatible dummy API key in examples is not authentication. Loopback binding is not isolation from other local processes or users. This repository does not provide a multi-user security boundary.

Only connect trusted MCP clients and upstream servers. Use the smallest per-request tool allowlist that serves the task. Review installer scripts before running them and keep CLI credentials in the CLI's own local store.

Logs and usage data can contain private prompts, paths and tool output. Keep them outside Git, restrict local access, and redact them before sharing.

## Before publishing changes

- Review staged changes, including fixtures, generated schemas and documentation. Never commit `.env`, real MCP/OpenClaw configuration, tokens, private keys, session databases, transcripts or raw production logs. Use sanitized `.example` files.
- Run Gitleaks with redaction enabled against the staged changes and Git history. Do not bypass a finding until it has been investigated. The security workflow scans the fetched history on pushes and pull requests; GitHub push protection blocks supported secret patterns before publication. Neither catches every possible secret.
- Keep GitHub Actions permissions read-only by default, pin actions to full commit SHAs, and never execute untrusted pull request code in a privileged `pull_request_target` workflow or on a personal self-hosted runner.
- Keep secret scanning, push protection, Dependabot alerts and private vulnerability reporting enabled. `main` is protected against force pushes and deletion.

If a real credential is exposed, revoke or rotate it first. Deleting a file or making the repository private does not invalidate copies. Coordinate any history rewrite separately; do not force-push away other people's work.
