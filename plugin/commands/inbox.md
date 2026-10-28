---
description: Read messages other Claude sessions left for this one
---

Call the `read_inbox` tool from the `csm` MCP server.

Summarize each message: who sent it, when, and what they need from this session. If a message asks a question or requests a review, say plainly whether this session can act on it now. Offer to reply with `send_message`, but do not send anything without the human's go-ahead.
