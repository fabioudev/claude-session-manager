import { readFile, rename } from 'node:fs/promises'
import path from 'node:path'
import type {
  ActivityEvent,
  FileClaim,
  FileTouch,
  Overlap,
  SessionMessage,
  SettingsPatch,
} from '../shared/types.js'
import { atomicWriteFile, ensureDir, now } from './util.js'

export interface Settings {
  questionMode: 'auto' | 'web' | 'terminal'
  questionTimeoutSeconds: number
  launchEnabled: boolean
}

export interface SessionMeta {
  id: string
  customTitle: string | null
  pinned: boolean
  archived: boolean
  firstSeenAt: number
  lastSeenAt: number
  lastActivityAt: number
  endedAt: number | null
  activities: ActivityEvent[]
}

interface PersistedState {
  version: 1
  settings: Settings
  sessions: Record<string, SessionMeta>
  messages: SessionMessage[]
  claims: FileClaim[]
  fileTouches: Record<string, FileTouch[]>
}

export const DEFAULT_SETTINGS: Settings = {
  questionMode: 'auto',
  questionTimeoutSeconds: 90,
  launchEnabled: true,
}

const MAX_ACTIVITIES_PER_SESSION = 160
const MAX_TOUCHES_PER_SESSION = 400
const MAX_MESSAGES = 1000
const ENDED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const SAVE_DEBOUNCE_MS = 350
const TOUCH_WINDOW_MS = 2 * 60 * 60 * 1000

function emptyState(): PersistedState {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    sessions: {},
    messages: [],
    claims: [],
    fileTouches: {},
  }
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function sanitizeActivity(value: unknown): ActivityEvent | null {
  if (!value || typeof value !== 'object') return null
  const event = value as Partial<ActivityEvent>
  if (typeof event.id !== 'string' || typeof event.title !== 'string') return null
  return {
    id: event.id,
    at: asNumber(event.at, 0),
    kind: event.kind ?? 'status',
    title: event.title,
    detail: typeof event.detail === 'string' ? event.detail : undefined,
    tool: typeof event.tool === 'string' ? event.tool : undefined,
    file: typeof event.file === 'string' ? event.file : undefined,
    status: event.status,
  }
}

function sanitizeSession(id: string, value: unknown): SessionMeta | null {
  if (!value || typeof value !== 'object') return null
  const meta = value as Partial<SessionMeta>
  const activities = Array.isArray(meta.activities)
    ? meta.activities.map(sanitizeActivity).filter((event): event is ActivityEvent => !!event)
    : []
  const lastActivityAt = asNumber(meta.lastActivityAt, asNumber(meta.lastSeenAt, 0))
  return {
    id,
    customTitle: typeof meta.customTitle === 'string' ? meta.customTitle : null,
    pinned: asBoolean(meta.pinned, false),
    archived: asBoolean(meta.archived, false),
    firstSeenAt: asNumber(meta.firstSeenAt, lastActivityAt),
    lastSeenAt: asNumber(meta.lastSeenAt, lastActivityAt),
    lastActivityAt,
    endedAt: typeof meta.endedAt === 'number' ? meta.endedAt : null,
    activities: activities.slice(-MAX_ACTIVITIES_PER_SESSION),
  }
}

function sanitizeMessage(value: unknown): SessionMessage | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Partial<SessionMessage>
  if (typeof message.id !== 'string' || typeof message.body !== 'string') return null
  return {
    id: message.id,
    fromSessionId: message.fromSessionId ?? null,
    fromName: typeof message.fromName === 'string' ? message.fromName : 'unknown',
    toSessionId: message.toSessionId ?? null,
    toName: message.toName ?? null,
    body: message.body,
    kind: message.kind ?? 'note',
    createdAt: asNumber(message.createdAt, 0),
    deliveries:
      message.deliveries && typeof message.deliveries === 'object' ? message.deliveries : {},
    readBy: message.readBy && typeof message.readBy === 'object' ? message.readBy : {},
  }
}

function sanitizeClaim(value: unknown): FileClaim | null {
  if (!value || typeof value !== 'object') return null
  const claim = value as Partial<FileClaim>
  if (typeof claim.id !== 'string' || !Array.isArray(claim.paths)) return null
  return {
    id: claim.id,
    sessionId: typeof claim.sessionId === 'string' ? claim.sessionId : 'unknown',
    paths: claim.paths.filter((item): item is string => typeof item === 'string'),
    note: typeof claim.note === 'string' ? claim.note : null,
    createdAt: asNumber(claim.createdAt, 0),
    expiresAt: asNumber(claim.expiresAt, 0),
  }
}

function sanitizeTouch(value: unknown): FileTouch | null {
  if (!value || typeof value !== 'object') return null
  const touch = value as Partial<FileTouch>
  if (typeof touch.path !== 'string' || typeof touch.sessionId !== 'string') return null
  return {
    sessionId: touch.sessionId,
    path: touch.path,
    at: asNumber(touch.at, 0),
    tool: typeof touch.tool === 'string' ? touch.tool : 'unknown',
    projectPath: typeof touch.projectPath === 'string' ? touch.projectPath : '',
  }
}

function sanitizeState(raw: unknown): PersistedState {
  const state = emptyState()
  if (!raw || typeof raw !== 'object') return state
  const input = raw as Partial<PersistedState>

  const settings = input.settings
  if (settings && typeof settings === 'object') {
    if (settings.questionMode === 'auto' || settings.questionMode === 'web') {
      state.settings.questionMode = settings.questionMode
    } else if (settings.questionMode === 'terminal') {
      state.settings.questionMode = 'terminal'
    }
    state.settings.questionTimeoutSeconds = Math.min(
      600,
      Math.max(
        5,
        asNumber(settings.questionTimeoutSeconds, DEFAULT_SETTINGS.questionTimeoutSeconds),
      ),
    )
    state.settings.launchEnabled = asBoolean(settings.launchEnabled, DEFAULT_SETTINGS.launchEnabled)
  }

  if (input.sessions && typeof input.sessions === 'object') {
    for (const [id, value] of Object.entries(input.sessions)) {
      const meta = sanitizeSession(id, value)
      if (meta) state.sessions[id] = meta
    }
  }
  if (Array.isArray(input.messages)) {
    state.messages = input.messages
      .map(sanitizeMessage)
      .filter((message): message is SessionMessage => !!message)
  }
  if (Array.isArray(input.claims)) {
    state.claims = input.claims.map(sanitizeClaim).filter((claim): claim is FileClaim => !!claim)
  }
  if (input.fileTouches && typeof input.fileTouches === 'object') {
    for (const [sessionId, touches] of Object.entries(input.fileTouches)) {
      if (!Array.isArray(touches)) continue
      state.fileTouches[sessionId] = touches
        .map(sanitizeTouch)
        .filter((touch): touch is FileTouch => !!touch)
        .slice(-MAX_TOUCHES_PER_SESSION)
    }
  }
  return state
}

/**
 * Durable, single-process state. Everything mutable is held in memory and written
 * atomically after a short debounce; `flush()` is awaited during shutdown.
 */
export class StateStore {
  private readonly file: string
  private state: PersistedState = emptyState()
  private saveTimer: NodeJS.Timeout | null = null
  private saveChain: Promise<void> = Promise.resolve()
  private dirty = false

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'state.json')
  }

  async init(): Promise<void> {
    await ensureDir(path.dirname(this.file))
    try {
      const text = await readFile(this.file, 'utf8')
      this.state = sanitizeState(JSON.parse(text))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        // Never destroy a state file we failed to understand. Rename it aside so a
        // human can inspect it, then continue with defaults.
        const backup = `${this.file}.corrupt-${Date.now()}`
        await rename(this.file, backup).catch(() => undefined)
      }
      this.state = emptyState()
    }
    this.prune()
    this.scheduleSave()
  }

  getSettings(): Settings {
    return { ...this.state.settings }
  }

  updateSettings(patch: SettingsPatch): Settings {
    if (patch.questionMode) this.state.settings.questionMode = patch.questionMode
    if (typeof patch.questionTimeoutSeconds === 'number') {
      this.state.settings.questionTimeoutSeconds = Math.min(
        600,
        Math.max(5, Math.round(patch.questionTimeoutSeconds)),
      )
    }
    if (typeof patch.launchEnabled === 'boolean') {
      this.state.settings.launchEnabled = patch.launchEnabled
    }
    this.touch()
    return this.getSettings()
  }

  getSessionMeta(id: string): SessionMeta | undefined {
    return this.state.sessions[id]
  }

  allSessionMeta(): SessionMeta[] {
    return Object.values(this.state.sessions)
  }

  ensureSession(id: string, at = now()): SessionMeta {
    let meta = this.state.sessions[id]
    if (!meta) {
      meta = {
        id,
        customTitle: null,
        pinned: false,
        archived: false,
        firstSeenAt: at,
        lastSeenAt: at,
        lastActivityAt: at,
        endedAt: null,
        activities: [],
      }
      this.state.sessions[id] = meta
      this.touch()
    }
    return meta
  }

  touchSession(id: string, at = now()): void {
    const meta = this.ensureSession(id, at)
    meta.lastSeenAt = Math.max(meta.lastSeenAt, at)
    this.touch()
  }

  patchSession(
    id: string,
    patch: { title?: string | null; pinned?: boolean; archived?: boolean },
  ): SessionMeta {
    const meta = this.ensureSession(id)
    if (patch.title !== undefined) {
      const title = patch.title?.replace(/\s+/g, ' ').trim() ?? ''
      meta.customTitle = title ? title.slice(0, 200) : null
    }
    if (typeof patch.pinned === 'boolean') meta.pinned = patch.pinned
    if (typeof patch.archived === 'boolean') meta.archived = patch.archived
    this.touch()
    return meta
  }

  setEnded(id: string, at = now()): void {
    const meta = this.ensureSession(id, at)
    meta.endedAt = at
    meta.lastSeenAt = Math.max(meta.lastSeenAt, at)
    this.touch()
  }

  clearEnded(id: string): void {
    const meta = this.state.sessions[id]
    if (meta?.endedAt != null) {
      meta.endedAt = null
      this.touch()
    }
  }

  /**
   * Merge activity events into a session's ring buffer. Returns only the events that
   * were new, so callers can decide to broadcast them.
   */
  recordActivities(id: string, events: ActivityEvent[]): ActivityEvent[] {
    if (!events.length) return []
    const meta = this.ensureSession(id)
    const seen = new Set(meta.activities.map((event) => event.id))
    const fresh: ActivityEvent[] = []
    for (const event of events) {
      if (seen.has(event.id)) continue
      seen.add(event.id)
      fresh.push(event)
      meta.activities.push(event)
    }
    if (!fresh.length) return []
    meta.activities.sort((a, b) => a.at - b.at)
    if (meta.activities.length > MAX_ACTIVITIES_PER_SESSION) {
      meta.activities.splice(0, meta.activities.length - MAX_ACTIVITIES_PER_SESSION)
    }
    const latest = Math.max(...fresh.map((event) => event.at))
    meta.lastActivityAt = Math.max(meta.lastActivityAt, latest)
    meta.lastSeenAt = Math.max(meta.lastSeenAt, latest)
    this.touch()
    return fresh
  }

  activitiesFor(id: string): ActivityEvent[] {
    return this.state.sessions[id]?.activities ?? []
  }

  addMessage(message: SessionMessage): SessionMessage {
    this.state.messages.push(message)
    if (this.state.messages.length > MAX_MESSAGES) {
      this.state.messages.splice(0, this.state.messages.length - MAX_MESSAGES)
    }
    this.touch()
    return message
  }

  listMessages(limit = 200): SessionMessage[] {
    return this.state.messages.slice(-limit)
  }

  messagesForSession(id: string, limit = 200): SessionMessage[] {
    return this.state.messages
      .filter((message) => message.toSessionId === id || message.toSessionId === null)
      .slice(-limit)
  }

  getMessage(id: string): SessionMessage | undefined {
    return this.state.messages.find((message) => message.id === id)
  }

  /** Messages that should travel to a session on its next prompt. */
  pendingDeliveries(sessionId: string): SessionMessage[] {
    return this.state.messages.filter(
      (message) =>
        message.fromSessionId !== sessionId &&
        (message.toSessionId === null || message.toSessionId === sessionId) &&
        message.deliveries[sessionId] === undefined,
    )
  }

  markDelivered(sessionId: string, ids: string[]): void {
    if (!ids.length) return
    const set = new Set(ids)
    for (const message of this.state.messages) {
      if (set.has(message.id) && message.deliveries[sessionId] === undefined) {
        message.deliveries[sessionId] = now()
      }
    }
    this.touch()
  }

  markRead(sessionId: string, ids: string[]): void {
    if (!ids.length) return
    const set = new Set(ids)
    for (const message of this.state.messages) {
      if (set.has(message.id)) {
        message.deliveries[sessionId] ??= now()
        message.readBy[sessionId] ??= now()
      }
    }
    this.touch()
  }

  unreadCount(sessionId: string): number {
    return this.state.messages.filter(
      (message) =>
        message.fromSessionId !== sessionId &&
        (message.toSessionId === null || message.toSessionId === sessionId) &&
        message.readBy[sessionId] === undefined,
    ).length
  }

  messageCountFor(sessionId: string): number {
    return this.state.messages.filter(
      (message) => message.fromSessionId === sessionId || message.toSessionId === sessionId,
    ).length
  }

  addClaim(claim: FileClaim): FileClaim {
    // A session holds at most one claim per path: replace older ones.
    const paths = new Set(claim.paths)
    this.state.claims = this.state.claims.filter(
      (existing) =>
        existing.sessionId !== claim.sessionId || !existing.paths.some((p) => paths.has(p)),
    )
    this.state.claims.push(claim)
    this.touch()
    return claim
  }

  releaseClaims(sessionId: string, paths?: string[]): number {
    const before = this.state.claims.length
    const wanted = paths ? new Set(paths) : null
    this.state.claims = this.state.claims.filter((claim) => {
      if (claim.sessionId !== sessionId) return true
      if (!wanted) return false
      return !claim.paths.some((item) => wanted.has(item))
    })
    const removed = before - this.state.claims.length
    if (removed) this.touch()
    return removed
  }

  activeClaims(at = now()): FileClaim[] {
    this.state.claims = this.state.claims.filter((claim) => claim.expiresAt > at)
    return this.state.claims.slice()
  }

  claimsFor(sessionId: string): FileClaim[] {
    return this.activeClaims().filter((claim) => claim.sessionId === sessionId)
  }

  claimsConflictingWith(sessionId: string, paths: string[]): FileClaim[] {
    const wanted = new Set(paths)
    return this.activeClaims().filter(
      (claim) => claim.sessionId !== sessionId && claim.paths.some((item) => wanted.has(item)),
    )
  }

  addFileTouches(touches: FileTouch[]): void {
    if (!touches.length) return
    for (const touch of touches) {
      const list = this.state.fileTouches[touch.sessionId] ?? []
      const previous = list.findIndex((item) => item.path === touch.path)
      if (previous >= 0) list.splice(previous, 1)
      list.push(touch)
      if (list.length > MAX_TOUCHES_PER_SESSION) {
        list.splice(0, list.length - MAX_TOUCHES_PER_SESSION)
      }
      this.state.fileTouches[touch.sessionId] = list
    }
    this.touch()
  }

  fileTouches(windowMs = TOUCH_WINDOW_MS, at = now()): FileTouch[] {
    const cutoff = at - windowMs
    return Object.values(this.state.fileTouches)
      .flat()
      .filter((touch) => touch.at >= cutoff)
      .sort((a, b) => b.at - a.at)
  }

  overlaps(windowMs = TOUCH_WINDOW_MS, at = now()): Overlap[] {
    const claims = this.activeClaims(at)
    const byPath = new Map<string, Overlap>()
    for (const touch of this.fileTouches(windowMs, at)) {
      const entry = byPath.get(touch.path) ?? {
        path: touch.path,
        sessionIds: [],
        lastAt: 0,
        claimedBy: [],
      }
      if (!entry.sessionIds.includes(touch.sessionId)) entry.sessionIds.push(touch.sessionId)
      entry.lastAt = Math.max(entry.lastAt, touch.at)
      byPath.set(touch.path, entry)
    }
    for (const claim of claims) {
      for (const file of claim.paths) {
        const entry = byPath.get(file) ?? {
          path: file,
          sessionIds: [],
          lastAt: claim.createdAt,
          claimedBy: [],
        }
        if (!entry.claimedBy.includes(claim.sessionId)) entry.claimedBy.push(claim.sessionId)
        entry.lastAt = Math.max(entry.lastAt, claim.createdAt)
        byPath.set(file, entry)
      }
    }
    const overlaps: Overlap[] = []
    for (const entry of byPath.values()) {
      const conflictingClaim =
        entry.claimedBy.length > 1 ||
        (entry.claimedBy.length === 1 && entry.sessionIds.some((id) => id !== entry.claimedBy[0]))
      if (entry.sessionIds.length >= 2 || conflictingClaim) overlaps.push(entry)
    }
    return overlaps.sort((a, b) => b.lastAt - a.lastAt)
  }

  /** Drop stale sessions, empty claims and old activities. */
  prune(at = now()): void {
    for (const [id, meta] of Object.entries(this.state.sessions)) {
      const endedLongAgo = meta.endedAt != null && at - meta.endedAt > ENDED_RETENTION_MS
      const silentLongAgo = meta.lastSeenAt > 0 && at - meta.lastSeenAt > ENDED_RETENTION_MS
      if ((endedLongAgo || silentLongAgo) && !meta.pinned) {
        delete this.state.sessions[id]
        delete this.state.fileTouches[id]
      }
    }
    this.state.claims = this.state.claims.filter((claim) => claim.expiresAt > at)
    this.state.messages = this.state.messages.filter(
      (message) => at - message.createdAt < ENDED_RETENTION_MS,
    )
    this.dirty = true
  }

  private touch(): void {
    this.dirty = true
    this.scheduleSave()
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, SAVE_DEBOUNCE_MS)
    this.saveTimer.unref?.()
  }

  async flush(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`
    this.saveChain = this.saveChain
      .then(() => atomicWriteFile(this.file, snapshot))
      .catch((error) => {
        // Losing a write should not take the daemon down; the next mutation retries.
        console.error('[csm] failed to persist state:', error)
        this.dirty = true
      })
    await this.saveChain
  }

  async close(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.dirty = true
    await this.flush()
  }
}
