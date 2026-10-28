import type { SessionStatus, SessionTimeline } from '@shared/types'
import { clockTime } from '../lib/format'

interface SignalTraceProps {
  timeline: SessionTimeline
  status: SessionStatus
  large?: boolean
}

const BUCKETS = 30
const BUCKET_WIDTH = 2
const BUCKET_GAP = 2
const VIEW_WIDTH = BUCKETS * (BUCKET_WIDTH + BUCKET_GAP) - BUCKET_GAP
const VIEW_HEIGHT = 24

function normalize(values: number[], length: number): number[] {
  if (values.length >= length) return values.slice(values.length - length)
  return [...Array.from({ length: length - values.length }, () => 0), ...values]
}

export function SignalTrace({ timeline, status, large = false }: SignalTraceProps) {
  const counts = normalize(timeline.counts, BUCKETS)
  const waiting = normalize(timeline.waiting, BUCKETS)
  const max = Math.max(1, ...counts)
  const total = counts.reduce((sum, value) => sum + value, 0)
  const waitingMinutes = waiting.reduce((sum, value) => sum + value, 0)
  const start = timeline.end - BUCKETS * timeline.bucketMs
  const recentFrom = BUCKETS - 5

  const description =
    total === 0
      ? 'No recorded activity in the last 30 minutes.'
      : `Activity in the last 30 minutes: ${total} events across ${counts.filter((value) => value > 0).length} minutes${
          waitingMinutes > 0
            ? `, waiting in ${waitingMinutes} minute${waitingMinutes === 1 ? '' : 's'}`
            : ''
        }.`

  return (
    <svg
      className={large ? 'trace trace-lg' : 'trace'}
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={description}
    >
      <title>{description}</title>
      <line className="baseline" x1="0" y1={VIEW_HEIGHT - 1} x2={VIEW_WIDTH} y2={VIEW_HEIGHT - 1} />
      {counts.map((count, index) => {
        const x = index * (BUCKET_WIDTH + BUCKET_GAP)
        const activityHeight = count === 0 ? 0 : Math.max(2, (count / max) * (VIEW_HEIGHT - 4))
        const waitMinutes = waiting[index] ?? 0
        const waitHeight =
          waitMinutes > 0
            ? Math.min(VIEW_HEIGHT - 1, 2 + (waitMinutes / 60) * (VIEW_HEIGHT - 3))
            : 0
        const at = start + index * timeline.bucketMs
        const bucketClass = status === 'ended' ? 'ended' : index >= recentFrom ? 'recent' : ''
        return (
          <g key={at}>
            {activityHeight > 0 ? (
              <rect
                className={`bar ${bucketClass}`.trim()}
                x={x}
                y={VIEW_HEIGHT - activityHeight - 1}
                width={BUCKET_WIDTH}
                height={activityHeight}
                rx="0.7"
              >
                <title>
                  {clockTime(at)} — {count} event{count === 1 ? '' : 's'}
                </title>
              </rect>
            ) : null}
            {waitHeight > 0 ? (
              <rect
                className="bar waiting"
                x={x}
                y={VIEW_HEIGHT - waitHeight - 1}
                width={BUCKET_WIDTH}
                height={waitHeight}
                rx="0.7"
              >
                <title>{clockTime(at)} — waiting</title>
              </rect>
            ) : null}
          </g>
        )
      })}
    </svg>
  )
}
