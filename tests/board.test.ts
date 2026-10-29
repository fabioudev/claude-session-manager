import { describe, expect, it } from 'vitest'
import type { PendingQuestion } from '../shared/types.js'
import { activeCount, boardBuckets } from '../web/src/lib/board.js'
import { makeSession } from './support/session.js'

const question: PendingQuestion = {
  id: 'q1',
  sessionId: 'c',
  toolUseId: null,
  prompts: [{ question: 'Continue?', header: '', multiSelect: false, options: [] }],
  createdAt: 1,
  expiresAt: null,
  answerable: true,
  source: 'transcript',
}

describe('boardBuckets', () => {
  it('keeps a hook-only finished session in finished', () => {
    const session = makeSession({ id: 'hook', status: 'idle', live: false, source: 'hook' })
    expect(boardBuckets([session]).finished).toEqual([session])
  })

  it('treats a transcript-only idle session as finished as well', () => {
    const session = makeSession({ id: 'recent', status: 'idle', source: 'transcript' })
    expect(boardBuckets([session]).finished).toEqual([session])
  })

  it('does not let a stale question on an ended session count as needs you', () => {
    const session = makeSession({ id: 'c', status: 'ended', question })
    const buckets = boardBuckets([session])
    expect(buckets.needs).toEqual([])
    expect(buckets.ended).toEqual([session])
  })

  it('keeps archived sessions out of every active bucket', () => {
    const session = makeSession({ id: 'old', status: 'waiting', archived: true })
    const buckets = boardBuckets([session])
    expect(buckets.needs).toEqual([])
    expect(buckets.archived).toEqual([session])
    expect(activeCount(buckets)).toBe(0)
  })

  it('counts working and finished sessions as active', () => {
    const buckets = boardBuckets([
      makeSession({ id: 'w', status: 'working' }),
      makeSession({ id: 'f', status: 'idle', source: 'registry' }),
      makeSession({ id: 'e', status: 'ended' }),
      makeSession({ id: 'a', status: 'idle', archived: true }),
    ])
    expect(activeCount(buckets)).toBe(2)
  })
})
