# Security policy

## Supported versions

The latest release and the `main` branch receive fixes. This is a 0.x project; there are no
long-term support branches.

## Reporting

Please report vulnerabilities privately through GitHub Security Advisories:

<https://github.com/fabioudev/claude-session-manager/security/advisories/new>

Do not open a public issue, and do not include real transcripts, tokens or personal paths in a
report. A useful report says what an attacker can do, which command or route is affected, and how
to reproduce it. You can expect an acknowledgement within a few days.

## Threat model

The daemon is a local control plane with broad access:

- It reads Claude Code transcripts under `~/.claude`, which can contain source code, command
  output and secrets.
- It can answer `AskUserQuestion` prompts. An answer is fed back to Claude as a tool result, so a
  malicious answer can influence what the session does next.
- It can send messages to sessions, claim files and, when enabled, start `claude --bg`.
- It never executes arbitrary commands from HTTP input. Launching is limited to `claude` with a
  working directory, prompt, model and permission mode validated by the daemon.

The default configuration binds to `127.0.0.1` and has no API token. That is appropriate for a
single-user workstation. Treat the token as a password: anyone who has it can read session
metadata, answer questions and message sessions.

## Hardening

- Bind to loopback unless you really need remote access. If you bind wider, always set
  `--token <long-random-value>` (the daemon refuses a non-loopback bind without one unless
  `--allow-insecure` is passed).
- Put an HTTPS reverse proxy in front of a remote board. Do not expose the daemon directly to the
  internet. The UI has no user accounts and no rate limiting.
- Use `--read-only` for an observation-only board. It disables answers, messages, claims and
  launching while transcript observation continues.
- Restrict who can reach the port with a firewall or VPN.
- The Docker image runs as the unprivileged `node` user and publishes the port on `127.0.0.1` by
  default. Keep it that way unless a proxy terminates TLS in front of it.
- The plugin's `client.json` contains the token and is written with mode `0600` in a `0700`
  directory. Do not sync or commit the data directory.
- If a token leaks, stop the daemon, rotate it and restart. There is no token revocation list.

## What the app does not do

- No telemetry, analytics or update checks.
- No outbound network requests at runtime. The UI bundles its fonts and loads nothing from a CDN.
- No shell interpolation of session names, paths or messages.
- Security headers on every response: CSP, `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: no-referrer`, restrictive `Permissions-Policy`.
- API responses are `Cache-Control: no-store`. The token is compared in constant time.
