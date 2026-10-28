---
description: Check what other Claude sessions changed and where work overlaps
---

Call the `shared_changes` tool from the `csm` MCP server.

Report, in this order:

1. Another session actively claims a file you are about to edit: stop and warn, naming the session and file.
2. Two or more sessions touched the same file recently: list those files, then inspect the actual diff (`git status`, `git diff`) before deciding whose version to keep.
3. Files only other sessions touched: mention them only if they are relevant to the current task.

Do not edit, revert, or "clean up" another session's changes as part of this command. If a change looks wrong, offer to send that session a message instead.
