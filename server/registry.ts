import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isPidAlive, safeJsonParse } from './util.js'

export interface LiveSession {
  sessionId: string
  pid: number
  cwd: string | null
  name: string | null
  nameSource: string | null
  kind: 'interactive' | 'background' | 'unknown'
  entrypoint: string | null
  status: 'busy' | 'idle' | 'waiting' | null
  waitingFor: string | null
  tmux: string | null
  version: string | null
  startedAt: number | null
  updatedAt: number | null
  statusUpdatedAt: number | null
  messagingSocketPath: string | null
  peerProtocol: number | null
  alive: boolean
}

export interface BackgroundJob {
  jobId: string
  sessionId: string | null
  name: string | null
  state: 'working' | 'blocked' | 'done' | 'failed' | 'stopped' | 'unknown'
  detail: string | null
  needs: string | null
  tokens: number | null
  cwd: string | null
  createdAt: number | null
  updatedAt: number | null
  resumeSessionId: string | null
  intent: string | null
  model: string | null
  permissionMode: string | null
  fan: Array<{ id: string; label: string; done: boolean }>
}

export interface RegistrySnapshot {
  sessions: LiveSession[]
  jobs: BackgroundJob[]
  refreshedAt: number
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isoToMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function parseLiveSession(raw: unknown): LiveSession | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const sessionId = asString(value.sessionId)
  const pid = asNumber(value.pid)
  if (!sessionId || !pid) return null
  const kind = value.kind === 'interactive' || value.kind === 'background' ? value.kind : 'unknown'
  const status =
    value.status === 'busy' || value.status === 'idle' || value.status === 'waiting'
      ? value.status
      : null
  return {
    sessionId,
    pid,
    cwd: asString(value.cwd),
    name: asString(value.name),
    nameSource: asString(value.nameSource),
    kind,
    entrypoint: asString(value.entrypoint),
    status,
    waitingFor: asString(value.waitingFor),
    tmux: asString(value.tmux),
    version: asString(value.version),
    startedAt: asNumber(value.startedAt),
    updatedAt: asNumber(value.updatedAt),
    statusUpdatedAt: asNumber(value.statusUpdatedAt),
    messagingSocketPath: asString(value.messagingSocketPath),
    peerProtocol: asNumber(value.peerProtocol),
    alive: isPidAlive(pid),
  }
}

function parseJob(jobId: string, raw: unknown): BackgroundJob | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const stateValue = asString(value.state)
  const state =
    stateValue === 'working' ||
    stateValue === 'blocked' ||
    stateValue === 'done' ||
    stateValue === 'failed' ||
    stateValue === 'stopped'
      ? stateValue
      : 'unknown'
  const flags = Array.isArray(value.respawnFlags)
    ? value.respawnFlags.filter((flag): flag is string => typeof flag === 'string')
    : []
  const modelIndex = flags.indexOf('--model')
  const permissionIndex = flags.indexOf('--permission-mode')
  const fan = Array.isArray(value.fan)
    ? value.fan
        .map((item) => {
          if (!item || typeof item !== 'object') return null
          const entry = item as Record<string, unknown>
          const label = asString(entry.label)
          if (!label) return null
          return {
            id: asString(entry.id) ?? label,
            label,
            done: (asNumber(entry.doneAt) ?? 0) > 0,
          }
        })
        .filter((item): item is { id: string; label: string; done: boolean } => !!item)
    : []
  return {
    jobId,
    sessionId: asString(value.sessionId) ?? asString(value.resumeSessionId),
    name: asString(value.name),
    state,
    detail: asString(value.detail),
    needs: asString(value.needs),
    tokens: asNumber(value.tokens),
    cwd: asString(value.cwd),
    createdAt: isoToMs(value.createdAt),
    updatedAt: isoToMs(value.updatedAt) ?? isoToMs(value.lastTerminalAt),
    resumeSessionId: asString(value.resumeSessionId),
    intent: asString(value.intent),
    model: modelIndex >= 0 ? (flags[modelIndex + 1] ?? null) : null,
    permissionMode: permissionIndex >= 0 ? (flags[permissionIndex + 1] ?? null) : null,
    fan,
  }
}

/**
 * Reads the registries Claude Code maintains for us: interactive/background
 * sessions in `sessions/<pid>.json`, and background jobs in `jobs/<id>/state.json`.
 * Polling these files is far cheaper and more reliable than shelling out to the CLI.
 */
export class ClaudeRegistry {
  private readonly sessionsDir: string
  private readonly jobsDir: string
  private snapshot: RegistrySnapshot = { sessions: [], jobs: [], refreshedAt: 0 }
  private timer: NodeJS.Timeout | null = null
  private refreshing = false
  private readonly onChange: (() => void) | undefined

  constructor(options: {
    sessionsDir: string
    jobsDir: string
    onChange?: () => void
  }) {
    this.sessionsDir = options.sessionsDir
    this.jobsDir = options.jobsDir
    this.onChange = options.onChange
  }

  getSnapshot(): RegistrySnapshot {
    return this.snapshot
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true
    try {
      const [sessions, jobs] = await Promise.all([this.readSessions(), this.readJobs()])
      const changed =
        JSON.stringify(sessions) !== JSON.stringify(this.snapshot.sessions) ||
        JSON.stringify(jobs) !== JSON.stringify(this.snapshot.jobs)
      this.snapshot = { sessions, jobs, refreshedAt: Date.now() }
      if (changed) this.onChange?.()
    } finally {
      this.refreshing = false
    }
  }

  private async readSessions(): Promise<LiveSession[]> {
    let files: string[]
    try {
      files = await readdir(this.sessionsDir)
    } catch {
      return []
    }
    const sessions: LiveSession[] = []
    await Promise.all(
      files
        .filter((file) => file.endsWith('.json'))
        .map(async (file) => {
          try {
            const text = await readFile(path.join(this.sessionsDir, file), 'utf8')
            const parsed = parseLiveSession(safeJsonParse(text))
            if (parsed?.alive) sessions.push(parsed)
          } catch {
            // A registry file can disappear between readdir and read; ignore.
          }
        }),
    )
    return sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  private async readJobs(): Promise<BackgroundJob[]> {
    let dirs: Dirent[]
    try {
      dirs = await readdir(this.jobsDir, { withFileTypes: true })
    } catch {
      return []
    }
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000
    const jobs: BackgroundJob[] = []
    await Promise.all(
      dirs
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            const text = await readFile(path.join(this.jobsDir, entry.name, 'state.json'), 'utf8')
            const job = parseJob(entry.name, safeJsonParse(text))
            if (!job) return
            // Old blocked/finished jobs stay on disk forever; they are history, not
            // something the board should show every day.
            if ((job.updatedAt ?? 0) < cutoff) return
            jobs.push(job)
          } catch {
            // Missing state.json for a job folder is normal while it is being created.
          }
        }),
    )
    return jobs.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  start(intervalMs = 3000): void {
    if (this.timer) return
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
