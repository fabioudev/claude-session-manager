import { describe, expect, it } from 'vitest'
import {
  buildInjectedContext,
  claimConflictNote,
  overlapNote,
  peerLine,
} from '../server/coordination.js'
import type { SessionMessage, SessionSummary } from '../shared/types.js'

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    id: overrides.id,
    shortId: overrides.id.slice(0, 8),
    name: null,
    title: 'Session',
    titleSource: 'id',
    projectPath: '/root/project',
    projectName: 'project',
    repoRoot: '/root/project',
    repoName: 'project',
    gitBranch: null,
    gitRemoteUrl: null,
    kind: 'interactive',
    status: 'idle',
    statusDetail: 'Idle',
    task: null,
    todos: [],
    activity: null,
    question: null,
    startedAt: null,
    lastActivityAt: 0,
    endedAt: null,
    model: null,
    version: null,
    tokens: null,
    live: false,
    pid: null,
    tmux: null,
    backgroundState: null,
    needs: null,
    jobId: null,
    unreadMessages: 0,
    overlapCount: 0,
    pinned: false,
    archived: false,
    timeline: { start: 0, end: 0, bucketMs: 60_000, counts: [], waiting: [] },
    messageCount: 0,
    source: 'registry',
    ...overrides,
  }
}

function message(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id: 'm1',
    fromSessionId: 'peer-1',
    fromName: 'Peer',
    toSessionId: null,
    toName: null,
    body: 'Please review the API guard.',
    kind: 'note',
    createdAt: Date.now(),
    deliveries: {},
    readBy: {},
    ...overrides,
  }
}

const baseInput = {
  selfSessionId: 'self-1',
  selfProjectPath: '/root/project',
  sessions: [
    session({ id: 'self-1', name: 'me' }),
    session({
      id: 'peer-1',
      name: 'peer',
      repoName: 'other-repo',
      gitBranch: 'main',
      status: 'working',
      task: 'Building the API',
      live: true,
    }),
    session({ id: 'peer-2', archived: true, name: 'archived peer' }),
  ],
  messages: [] as SessionMessage[],
  overlaps: [],
  claims: [],
  reason: 'start' as const,
  pluginTools: true,
}

describe('buildInjectedContext', () => {
  it('teaches a starting session about peers and the coordination tools', () => {
    const text = buildInjectedContext(baseInput)
    expect(text).toContain('[claude-session-manager]')
    expect(text).toContain('list_sessions')
    expect(text).toContain('send_message')
    expect(text).toContain('peer (peer-1)')
    expect(text).not.toContain('archived peer')
    expect(text).not.toContain('me (self-1)')
    expect(text).toContain('[/claude-session-manager]')
  })

  it('keeps peer awareness on a prompt even when nothing else changed', () => {
    const text = buildInjectedContext({ ...baseInput, reason: 'prompt' })
    expect(text).toContain('Other sessions: peer (other-repo)')
    expect(text).not.toContain('Messages for you')
  })

  it('summarises new messages, overlaps and claims for a prompt', () => {
    const text = buildInjectedContext({
      ...baseInput,
      reason: 'prompt',
      messages: [message()],
      overlaps: [
        {
          path: '/root/project/server/api.ts',
          sessionIds: ['self-1', 'peer-1'],
          lastAt: Date.now(),
          claimedBy: [],
        },
      ],
      claims: [
        {
          id: 'c1',
          sessionId: 'peer-1',
          paths: ['/root/project/server/auth.ts'],
          note: 'refactor',
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      ],
    })
    expect(text).toContain('Other sessions: peer (other-repo)')
    expect(text).toContain('server/api.ts')
    expect(text).toContain('Review those changes')
    expect(text).toContain('peer claims server/auth.ts — refactor')
    expect(text).toContain('Messages for you')
    expect(text).toContain('Please review the API guard.')
  })

  it('labels the current session as "you" in overlaps', () => {
    const text = buildInjectedContext({
      ...baseInput,
      reason: 'prompt',
      overlaps: [
        {
          path: '/root/project/a.ts',
          sessionIds: ['self-1', 'peer-1'],
          lastAt: Date.now(),
          claimedBy: [],
        },
      ],
    })
    expect(text).toContain('a.ts — you, peer')
  })

  it('describes a peer in one line', () => {
    const line = peerLine(
      session({
        id: 'peer-1',
        name: 'peer',
        repoName: 'other-repo',
        gitBranch: 'main',
        status: 'working',
        task: 'Building\n the API',
      }),
    )
    expect(line).toBe('- peer (peer-1) in other-repo on main working — "Building the API"')
  })
})

describe('coordination notes', () => {
  it('names the other session in an overlap note', () => {
    const note = overlapNote(
      { path: '/repo/a.ts', sessionIds: ['self-1', 'peer-1'], lastAt: 0, claimedBy: [] },
      session({ id: 'peer-1', name: 'peer' }),
      'self-1',
    )
    expect(note).toContain('peer also touched /repo/a.ts')
  })

  it('names the claimant and note in a claim conflict', () => {
    const note = claimConflictNote(
      '/repo/a.ts',
      {
        id: 'c1',
        sessionId: 'peer-1',
        paths: ['/repo/a.ts'],
        note: 'refactor',
        createdAt: 0,
        expiresAt: 0,
      },
      session({ id: 'peer-1', name: 'peer' }),
    )
    expect(note).toContain('peer claimed /repo/a.ts')
    expect(note).toContain('refactor')
  })
})
