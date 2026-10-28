# Claude Session Manager plugin

This plugin connects Claude Code to the [Claude Session Manager](../README.md) daemon. It does three things:

- **Reports** each session's work, status and questions to the local board through lifecycle hooks.
- **Bridges questions**: an `AskUserQuestion` prompt can be answered in the browser; the answer is returned to the session as the tool result.
- **Coordinates peers**: an MCP server with tools to list sessions, message them, inspect shared file changes and claim files.

Without a running daemon every hook and tool fails soft. Claude Code behaves exactly as it would without the plugin.

## Install

```bash
# 1. Build and start the daemon (Node.js 22+)
git clone https://github.com/fabioudev/claude-session-manager.git
cd claude-session-manager
npm install
npm run build
npm start
# optional: npm link, then `csm` starts it from anywhere

# 2. In Claude Code, add this repository as a marketplace and install the plugin
/plugin marketplace add fabioudev/claude-session-manager
/plugin install csm@claude-session-manager
```

Restart Claude Code or start a new session so the hooks and MCP server load. The board is at <http://127.0.0.1:4747> unless you configured another port.

If the daemon runs in Docker, the plugin on the host cannot read the container's `client.json`. Pass the daemon URL and token to Claude Code instead:

```bash
export CSM_URL=http://127.0.0.1:4747
export CSM_TOKEN=<the same token as the container>
```

See the [main README](../README.md) for the Docker setup and remote-access notes.

## What gets reported

| Hook               | Used for                                                  |
| ------------------ | --------------------------------------------------------- |
| `SessionStart`     | Registers the session, injects coexistence + peer context |
| `UserPromptSubmit` | Captures the task prompt, injects unread peer messages    |
| `PreToolUse`       | Working status, current tool, AskUserQuestion bridge      |
| `PostToolUse`      | Records changed files, closes answered questions          |
| `Notification`     | Marks the session as waiting for the human                |
| `Stop`             | Marks the turn finished                                   |
| `SubagentStop`     | Refreshes activity                                        |
| `PreCompact`       | Records a context compaction                              |
| `SessionEnd`       | Marks the session ended                                   |

Only tool metadata is sent: file paths, commands, and the full `AskUserQuestion` input. File contents are never read by the bridge. The daemon listens on loopback by default.

## MCP tools

| Tool             | Purpose                                            |
| ---------------- | -------------------------------------------------- |
| `list_sessions`  | All sessions: status, repo, task, pending question |
| `get_session`    | Detail: todos, recent activity, unread messages    |
| `send_message`   | Leave a message for one session or broadcast       |
| `read_inbox`     | Read and clear this session's messages             |
| `shared_changes` | Files other sessions changed, overlaps, claims     |
| `claim_files`    | Announce files this session is about to edit       |
| `release_files`  | Release claims                                     |

Session identity is resolved through the process tree and Claude Code's session registry. If your setup cannot be resolved automatically, export `CSM_SESSION_ID` before starting Claude Code.

## Commands

| Command           | Purpose                                       |
| ----------------- | --------------------------------------------- |
| `/csm:status`     | Board summary grouped by what needs attention |
| `/csm:inbox`      | Read peer messages                            |
| `/csm:coordinate` | Check overlaps before editing                 |
| `/csm:message`    | Send a message to a peer or everyone          |

## Configuration

The hooks and MCP server read the daemon URL and token from `<dataDir>/client.json`, written by the daemon at startup. Set these environment variables to override:

| Variable         | Meaning                                       |
| ---------------- | --------------------------------------------- |
| `CSM_URL`        | Daemon base URL, e.g. `http://127.0.0.1:4747` |
| `CSM_TOKEN`      | Bearer token, when the daemon uses one        |
| `CSM_DATA_DIR`   | Directory that holds `client.json`            |
| `CSM_SESSION_ID` | Force this session's id                       |
| `CSM_CLAUDE_DIR` | Claude Code config dir (default `~/.claude`)  |
| `CSM_DEBUG`      | `1` prints bridge diagnostics to stderr       |

## Disable

Remove or disable the plugin in Claude Code (`/plugin`), or run the daemon with `--read-only` to keep observation without message/claim writes.
