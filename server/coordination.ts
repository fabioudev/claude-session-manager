import path from 'node:path'
import type { FileClaim, Overlap, SessionMessage, SessionSummary } from '../shared/types.js'
import { relativeTime, truncate } from './util.js'

export interface InjectedContextInput {
  selfSessionId: string
  selfProjectPath: string | null
  sessions: SessionSummary[]
  messages: SessionMessage[]
  overlaps: Overlap[]
  claims: FileClaim[]
  reason: 'start' | 'prompt'
  pluginTools: boolean
}

const GUIDANCE = `You are one of several Claude Code sessions running on this machine. The others are real concurrent sessions, and a human watches all of you in the Claude Session Manager web UI.

Coordination tools (MCP server "csm"):
- list_sessions: what every other session is doing right now
- get_session(session_id): details for one session
- send_message(body, to_session_id?): leave a message for another session, or for everyone
- read_inbox: read messages addressed to you
- shared_changes: files other sessions changed recently, overlaps and claims
- claim_files(paths, note?): announce files you are about to change; release_files to clear

Working agreements:
- Before editing files, check shared_changes. If another session touched the same file recently, review its changes first (git status / git diff) and do not overwrite uncommitted work.
- Claim files before multi-file or risky edits. Claims expire automatically.
- Messages arrive on your next prompt. Keep them short and actionable.
- The human can answer your AskUserQuestion prompts from the web UI; those answers arrive as a denied tool call whose reason contains them.`

export function peerLine(session: SessionSummary): string {
  const label = session.name || session.title
  const bits = [
    `${label} (${session.shortId})`,
    `in ${session.repoName ?? session.projectName}`,
    session.gitBranch ? `on ${session.gitBranch}` : null,
    session.status,
  ].filter(Boolean)
  const task = session.task ? ` — "${truncate(session.task.replace(/\s+/g, ' '), 160)}"` : ''
  return `- ${bits.join(' ')}${task}`
}

function messageLine(message: SessionMessage, max = 500): string {
  const who = message.fromName || message.fromSessionId?.slice(0, 8) || 'someone'
  const age = relativeTime(message.createdAt)
  const kind = message.kind === 'note' ? '' : ` [${message.kind}]`
  return `- from ${who}${kind} (${age}, id ${message.id}): ${truncate(message.body.replace(/\s+/g, ' '), max)}`
}

function relativePath(file: string, projectPath: string | null): string {
  if (!projectPath) return file
  const relative = path.relative(projectPath, file)
  return relative && !relative.startsWith('..') ? relative : file
}

/**
 * The text injected into a session's context. On SessionStart it teaches the
 * session that peers exist and how to reach them; on each prompt it is a compact
 * digest of new messages, overlaps and claims.
 */
export function buildInjectedContext(input: InjectedContextInput): string | null {
  const peers = input.sessions
    .filter((session) => session.id !== input.selfSessionId && !session.archived)
    .sort((a, b) => Number(b.live) - Number(a.live) || b.lastActivityAt - a.lastActivityAt)
    .slice(0, 6)

  const messages = input.messages.slice(-12)
  const overlaps = input.overlaps.slice(0, 6)
  const claims = input.claims.filter((claim) => claim.sessionId !== input.selfSessionId).slice(0, 6)

  const sections: string[] = []
  if (input.reason === 'start') {
    sections.push('[claude-session-manager]')
    sections.push(GUIDANCE)
    sections.push('')
    if (peers.length) {
      sections.push('Other sessions right now:')
      sections.push(...peers.map((peer) => peerLine(peer)))
    } else {
      sections.push(
        'There are no other active sessions right now. You can still use the csm tools.',
      )
    }
  } else {
    if (peers.length) {
      sections.push(
        `[claude-session-manager] Other sessions: ${peers
          .map((peer) => `${peer.name || peer.shortId} (${partner(peer)})`)
          .join(', ')}.`,
      )
    }
    if (overlaps.length) {
      sections.push('Shared files changed by more than one session recently:')
      for (const overlap of overlaps) {
        sections.push(
          `- ${relativePath(overlap.path, input.selfProjectPath)} — ${overlap.sessionIds
            .map((id) => (id === input.selfSessionId ? 'you' : sessionName(input.sessions, id)))
            .join(', ')}`,
        )
      }
      sections.push('Review those changes (git diff) before editing the same files.')
    }
    if (claims.length) {
      sections.push('Active file claims:')
      for (const claim of claims) {
        const name = sessionName(input.sessions, claim.sessionId)
        const note = claim.note ? ` — ${truncate(claim.note, 100)}` : ''
        sections.push(
          `- ${name} claims ${claim.paths
            .slice(0, 4)
            .map((file) => relativePath(file, input.selfProjectPath))
            .join(', ')}${claim.paths.length > 4 ? ', …' : ''}${note}`,
        )
      }
    }
  }

  if (messages.length) {
    sections.push('')
    sections.push('Messages for you (also available via read_inbox):')
    sections.push(...messages.map((message) => messageLine(message)))
  }

  if (!sections.length) return null
  sections.push('[/claude-session-manager]')
  return sections.join('\n')
}

function partner(session: SessionSummary): string {
  return session.repoName ?? session.projectName
}

function sessionName(sessions: SessionSummary[], id: string): string {
  const found = sessions.find((session) => session.id === id)
  return found ? found.name || found.shortId : id.slice(0, 8)
}

export function overlapNote(
  overlap: Overlap,
  otherSession: SessionSummary | undefined,
  selfSessionId: string,
): string {
  const name =
    otherSession?.name ||
    otherSession?.title ||
    overlap.sessionIds.find((id) => id !== selfSessionId)?.slice(0, 8) ||
    'another session'
  return `Heads up from the session manager: ${name} also touched ${overlap.path} recently. Check their changes (git diff / git status) before you overwrite the file.`
}

export function claimConflictNote(
  file: string,
  claim: FileClaim,
  claimant: SessionSummary | undefined,
): string {
  const name = claimant?.name || claimant?.title || claim.sessionId.slice(0, 8)
  return `Heads up from the session manager: ${name} claimed ${file} for editing (${claim.note ?? 'no note'}). Coordinate before changing it.`
}
