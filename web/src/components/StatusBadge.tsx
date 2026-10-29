import type { SessionStatus } from '@shared/types'
import { statusLabel } from '../lib/format'

export function StatusDot({ status }: { status: SessionStatus }) {
  return <span className={`dot dot-${status}`} aria-hidden="true" />
}

export function StatusBadge({ status, className }: { status: SessionStatus; className?: string }) {
  return (
    <span className={`status status-${status}${className ? ` ${className}` : ''}`}>
      <StatusDot status={status} />
      {statusLabel(status)}
    </span>
  )
}
