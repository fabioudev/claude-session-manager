# Contributing

Thanks for taking a look. This project is small on purpose: one Node process, a React board and a
Claude Code plugin. Changes that keep it that way are easier to review.

## Setup

```bash
git clone https://github.com/fabioudev/claude-session-manager.git
cd claude-session-manager
npm install
npm run dev
```

Node.js 22 or newer is required. `npm run dev` starts the daemon with `tsx watch` on port 4747 and
Vite on port 5173, proxying `/api` to the daemon. Use `--claude-dir`/`CSM_CLAUDE_DIR` and
`--data-dir`/`CSM_DATA_DIR` to point the daemon at a test fixture instead of your real sessions.

The plugin runs from `plugin/` and talks to the daemon on loopback. To try plugin changes, install
the repository as a plugin marketplace entry and start a new Claude Code session; `CSM_DEBUG=1`
prints hook diagnostics to stderr.

## Checks

Run the same checks as CI before opening a pull request:

```bash
npm run lint       # Biome
npm run typecheck  # server + web
npm test           # Vitest
npm run build      # production bundle
```

Tests use Vitest. Put parser, state and coordination tests in `tests/`. Component tests opt into
jsdom with a `// @vitest-environment jsdom` header. Prefer testing pure functions and the HTTP
surface over snapshotting the whole UI.

## Style

- TypeScript strict mode; no `any` unless it is at a parsed JSON boundary.
- Biome formats and sorts imports. Run `npm run lint:fix` rather than hand-formatting.
- Match the tone of the surrounding code: short comments explain _why_, not _what_.
- Keep the web bundle dependency-light. Icons come from `lucide-react`; everything else is
  hand-written CSS and React.
- The plugin must stay dependency-free and fail soft. A hook that throws or blocks without the
  daemon is a bug.

## Pull requests

- One concern per pull request, with a short description of the user-visible change.
- Add or update tests when behaviour changes.
- Call out changes to the wire format in `shared/types.ts` or to the HTTP API; both the web UI and
  the plugin consume them.
- Do not include screenshots or logs that contain real transcript content, tokens or paths from
  your machine.

Security issues: please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

By contributing you agree that your contribution is licensed under the MIT license.
