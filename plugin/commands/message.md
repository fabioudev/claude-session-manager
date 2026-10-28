---
description: Send a short message to another Claude session (or all sessions)
argument-hint: "[session-id-or-name | @all] <message>"
---

Send a message through the `csm` MCP server.

Arguments: `$ARGUMENTS`

Parse the arguments as `<target> <message>`. The target may be a session name, short id, full id, or `@all`. When no target is given, use `@all`. When only one token is given, treat it as the message and broadcast it.

If the target is ambiguous, call `list_sessions` and ask the human which session they mean instead of guessing. Keep the message short, specific, and actionable: say what changed or what you need, and name the files involved. Then call `send_message` with the target (omit `to_session_id` for `@all`) and the body.

Confirm what was sent and to whom. Mention that it arrives on the recipient's next prompt, not instantly.
