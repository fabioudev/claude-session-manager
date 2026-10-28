import type { SessionStatus } from '@shared/types'
import { statusLabel } from '../lib/format'

export function StatusDot({ status }: { status: SessionStatus }) {
  return <span className={`dot dot-${status}`} aria-hidden="true" />
}

export function StatusBadge({ status }: { status: SessionStatus }) {
  return (
    <span className={`status status-${status}`}>
      <StatusDot status={status} />
      {statusLabel(status)}
    </span>
  )
}
