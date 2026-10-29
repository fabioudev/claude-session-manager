import type { SessionSummary } from '@shared/types'
import { isNeedsYou } from './format'

/** The order the Overview paints its groups in: your turn first. */
export const BOARD_ORDER = ['needs', 'finished', 'working', 'unknown'] as const

export type BoardGroupKey = (typeof BOARD_ORDER)[number]

export interface BoardBuckets {
  needs: SessionSummary[]
  finished: SessionSummary[]
  working: SessionSummary[]
  unknown: SessionSummary[]
  ended: SessionSummary[]
  archived: SessionSummary[]
}

/**
 * One classification used by the groups, the tabs, the hero and the rail.
 * A session belongs to exactly one bucket, and archived wins over everything
 * so an old session cannot keep asking for attention.
 */
export function boardBuckets(sessions: SessionSummary[]): BoardBuckets {
  const buckets: BoardBuckets = {
    needs: [],
    finished: [],
    working: [],
    unknown: [],
    ended: [],
    archived: [],
  }
  for (const session of sessions) {
    if (session.archived) {
      buckets.archived.push(session)
    } else if (session.status === 'ended') {
      buckets.ended.push(session)
    } else if (isNeedsYou(session)) {
      buckets.needs.push(session)
    } else if (session.status === 'working') {
      buckets.working.push(session)
    } else if (session.status === 'idle') {
      buckets.finished.push(session)
    } else {
      buckets.unknown.push(session)
    }
  }
  return buckets
}

/** Sessions that still have a process or a fresh transcript signal. */
export function activeCount(buckets: BoardBuckets): number {
  return (
    buckets.needs.length + buckets.finished.length + buckets.working.length + buckets.unknown.length
  )
}
