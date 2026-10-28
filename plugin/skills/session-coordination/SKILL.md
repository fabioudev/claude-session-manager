---
name: session-coordination
description: Use when other Claude Code sessions may be working on the same machine or repository, before broad edits another session could conflict with, when a peer message or file claim appears, or when asked to check on parallel sessions. Also applies when an AskUserQuestion call is denied with answers supplied by the session manager.
---

# Working beside other Claude sessions

This machine runs a Claude Session Manager daemon. The `csm` MCP server shows the other Claude Code sessions, carries messages between them, and tracks which files each session is changing. The human watches all of it on a local web board.

You are not alone in this checkout. Assume a peer may be editing the same files until you check.

## When to look

Call `list_sessions` when:

- the human mentions another session, a parallel agent, or the board;
- you are about to start a broad refactor, rename, dependency bump, or formatting sweep;
- a file you need is already modified and you cannot explain why;
- a peer message arrives and you need context on the sender.

Skip it for small, local edits in a repository you know is not shared. The tool is cheap, but a board dump on every prompt is noise.

## Before editing shared files

1. Call `shared_changes`. It lists files other sessions touched in the last six hours, overlapping paths, and active claims.
2. If another session claims a file you need, do not overwrite it. Send that session a message and wait, or ask the human to decide.
3. If two sessions touched the same file, read the actual diff (`git status`, `git diff`) before choosing a version. Recent timestamps alone do not tell you whose change is correct.
4. For a multi-file or risky change, call `claim_files` with the paths and a short note. Release them with `release_files` when the work is committed or abandoned.

Claims are advisory, not locks. They exist so a peer can avoid colliding with you, and the web board shows them to the human.

## Messages

- `send_message` delivers on the recipient's next prompt, not instantly. Keep messages short and actionable: what changed, which files, what you need.
- `read_inbox` marks messages read. Messages are also injected automatically at the start of each prompt, so do not poll.
- When you receive a message, act on it or reply. Do not silently ignore a review request.

## Questions from the human

The human can answer your `AskUserQuestion` prompts from the web board, even when you are running in a terminal.

When that happens, the tool call returns as denied and the denial reason contains the selected answers. Treat those answers as the human's decision, continue the task with them, and do not ask the same question again. If the reason asks you to stop, stop.

If the question is not answerable from the board (for example, it requires seeing a file), the terminal prompt proceeds normally. Answer it there.

## Etiquette

- Another session's uncommitted changes are not yours to revert, stash, or reformat.
- Announce substantial changes that affect shared files before making them, not after.
- If you finish work a peer is waiting on, message them with the commit or file paths.
- The board is read-only context for the human; do not use it to spy on unrelated sessions or to route around a permission decision.
