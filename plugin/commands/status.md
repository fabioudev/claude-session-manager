---
description: Show every Claude Code session on this machine and what it is doing
---

Call the `list_sessions` tool from the `csm` MCP server.

Present the result as a compact board for the human, in this order:

1. Sessions that need them: pending questions or `waiting` status. Say what each one is waiting for.
2. Sessions that are working: name, repository, and a one-line task summary.
3. Idle and ended sessions, compressed to a count unless one is relevant.

Keep session ids short. If a session has unread messages, say so. Do not call `send_message` or change anything just because you listed the board.
