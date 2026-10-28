import type { SessionStatus, SessionSummary } from '@shared/types'

export function relativeTime(at: number | null | undefined, now = Date.now()): string {
  if (!at) return 'never'
  const diff = at - now
  if (diff > 0) {
    if (diff < 60_000) return `in ${Math.ceil(diff / 1000)}s`
    if (diff < 3_600_000) return `in ${Math.ceil(diff / 60_000)}m`
    return `in ${Math.ceil(diff / 3_600_000)}h`
  }
  const elapsed = -diff
  if (elapsed < 10_000) return 'now'
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s ago`
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) {
    const hours = Math.floor(elapsed / 3_600_000)
    const minutes = Math.floor((elapsed % 3_600_000) / 60_000)
    return minutes > 0 && hours < 6 ? `${hours}h ${minutes}m ago` : `${hours}h ago`
  }
  const days = Math.floor(elapsed / 86_400_000)
  if (days < 7) return `${days}d ago`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(at)
}

export function clockTime(at: number, seconds = false): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
    hour12: false,
  }).format(at)
}

export function dateTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(at)
}

export function shortDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.floor((ms % 60_000) / 1000)
    return seconds > 0 && minutes < 10 ? `${minutes}m ${seconds}s` : `${minutes}m`
  }
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  return minutes > 0 && hours < 24 ? `${hours}h ${minutes}m` : `${hours}h`
}

export function countdown(ms: number): string {
  if (ms <= 0) return 'expired'
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

export const STATUS_LABEL: Record<SessionStatus, string> = {
  working: 'Working',
  waiting: 'Waiting',
  idle: 'Idle',
  ended: 'Ended',
  unknown: 'No signal',
}

export const STATUS_GLYPH: Record<SessionStatus, string> = {
  working: '●',
  waiting: '◆',
  idle: '○',
  ended: '–',
  unknown: '◌',
}

export function statusLabel(status: SessionStatus): string {
  return STATUS_LABEL[status]
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm
}

export function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (Math.abs(value) < 1000) return String(Math.round(value))
  if (Math.abs(value) < 1_000_000) {
    const scaled = value / 1000
    return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}k`
  }
  const scaled = value / 1_000_000
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}M`
}

export function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value <= 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 10) return `$${value.toFixed(2)}`
  return `$${Math.round(value).toLocaleString()}`
}

export function formatModel(model: string | null | undefined): string {
  if (!model) return 'Unknown model'
  const cleaned = model.replace(/^claude-/, '')
  const match = cleaned.match(/^(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/)
  if (match) {
    const family = match[1]
    const major = match[2]
    const minor = match[3]
    if (family && major) {
      const name = family.charAt(0).toUpperCase() + family.slice(1)
      return minor ? `${name} ${major}.${minor}` : `${name} ${major}`
    }
  }
  return cleaned
}

export function repoLabel(session: SessionSummary): string {
  return session.repoName || session.projectName || 'Unknown project'
}

export function sessionLabel(session: SessionSummary): string {
  return session.name || session.title || session.shortId
}

export function isNeedsYou(session: SessionSummary): boolean {
  return session.status === 'waiting' || Boolean(session.question)
}

export function taskPreview(session: SessionSummary): string {
  const value = session.task || session.statusDetail || ''
  return value.replace(/\s+/g, ' ').trim()
}

export function percent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${Math.round(value)}%`
}
