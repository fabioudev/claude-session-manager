import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { type FSWatcher, watch } from 'chokidar'
import type { ActivityEvent, PendingQuestion, TodoItem } from '../../shared/types.js'
import { now } from '../util.js'
import {
  createTranscriptState,
  parseTranscriptLines,
  pendingQuestionFromState,
  type TokenTotals,
  type TranscriptParseState,
} from './parse.js'
import {
  readInitialTranscript,
  readSlice,
  scanLines,
  splitBufferLines,
  statTranscript,
} from './reader.js'

export interface TranscriptView {
  sessionId: string
  path: string
  projectDir: string
  cwd: string | null
  gitBranch: string | null
  version: string | null
  model: string | null
  slug: string | null
  summary: string | null
  firstPrompt: string | null
  lastPrompt: string | null
  lastPromptAt: number | null
  lastAssistantText: string | null
  lastAssistantAt: number | null
  lastUserAt: number | null
  lastToolName: string | null
  lastToolText: string | null
  lastToolAt: number | null
  lastActivityAt: number | null
  startedAt: number | null
  promptCount: number
  messageCount: number
  todos: TodoItem[]
  tokens: TokenTotals
  contextUsed: number | null
  contextWindow: number | null
  pendingQuestion: PendingQuestion | null
  openToolUses: number
  lastError: { text: string; at: number } | null
  interruptedAt: number | null
  compactedAt: number | null
  lastEventType: 'user' | 'assistant' | 'system' | null
  activities: ActivityEvent[]
  mtimeMs: number
  size: number
  loaded: boolean
}

interface Entry {
  sessionId: string
  file: string
  projectDir: string
  state: TranscriptParseState | null
  offset: number
  remainder: Buffer
  ino: number | null
  size: number
  mtimeMs: number
  loaded: boolean
  loading: Promise<void> | null
  timer: NodeJS.Timeout | null
  lastAccess: number
  resolvedQuestions: string[]
}

export interface TranscriptStoreOptions {
  projectsDir: string
  /** Files modified within this window are eligible for listing. */
  retentionMs?: number
  /** How many sessions to parse during startup. */
  eagerLimit?: number
  onUpdate?: (sessionId: string) => void
  onError?: (error: unknown) => void
}

const DAY = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 600
const MAX_LOADED = 150
const REFRESH_DEBOUNCE_MS = 250

function emptyView(entry: Entry): TranscriptView {
  return {
    sessionId: entry.sessionId,
    path: entry.file,
    projectDir: entry.projectDir,
    cwd: null,
    gitBranch: null,
    version: null,
    model: null,
    slug: null,
    summary: null,
    firstPrompt: null,
    lastPrompt: null,
    lastPromptAt: null,
    lastAssistantText: null,
    lastAssistantAt: null,
    lastUserAt: null,
    lastToolName: null,
    lastToolText: null,
    lastToolAt: null,
    lastActivityAt: entry.mtimeMs || null,
    startedAt: null,
    promptCount: 0,
    messageCount: 0,
    todos: [],
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    contextUsed: null,
    contextWindow: null,
    pendingQuestion: null,
    openToolUses: 0,
    lastError: null,
    interruptedAt: null,
    compactedAt: null,
    lastEventType: null,
    activities: [],
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    loaded: false,
  }
}

export function viewFromState(entry: Entry): TranscriptView {
  if (!entry.state) return emptyView(entry)
  const state = entry.state
  return {
    sessionId: entry.sessionId,
    path: entry.file,
    projectDir: entry.projectDir,
    cwd: state.cwd,
    gitBranch: state.gitBranch,
    version: state.version,
    model: state.model,
    slug: state.slug,
    summary: state.summary,
    firstPrompt: state.firstPrompt,
    lastPrompt: state.lastPrompt,
    lastPromptAt: state.lastPromptAt,
    lastAssistantText: state.lastAssistantText,
    lastAssistantAt: state.lastAssistantAt,
    lastUserAt: state.lastUserAt,
    lastToolName: state.lastToolName,
    lastToolText: state.lastToolText,
    lastToolAt: state.lastToolAt,
    lastActivityAt: state.lastActivityAt,
    startedAt: state.startedAt,
    promptCount: state.promptCount,
    messageCount: state.promptCount + state.assistantCount,
    todos: state.todos,
    tokens: { ...state.tokens },
    contextUsed: state.contextUsed,
    contextWindow: state.contextWindow,
    pendingQuestion: pendingQuestionFromState(state, entry.sessionId, 'terminal'),
    openToolUses: state.openToolUses.size,
    lastError: state.lastError,
    interruptedAt: state.interruptedAt,
    compactedAt: state.compactedAt,
    lastEventType: state.lastEventType,
    activities: state.activities.slice(),
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    loaded: true,
  }
}

async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      const item = items[index]
      if (item !== undefined) await worker(item)
    }
  })
  await Promise.all(runners)
}

/**
 * Discovers Claude Code transcripts and keeps a parsed, incrementally updated view of
 * each one. Transcripts can be hundreds of megabytes, so the reader only ever touches
 * a small head, a bounded tail, and the bytes appended since the last poll.
 */
export class TranscriptStore {
  private readonly projectsDir: string
  private readonly retentionMs: number
  private readonly eagerLimit: number
  private readonly onUpdate: ((sessionId: string) => void) | undefined
  private readonly onError: ((error: unknown) => void) | undefined
  private readonly entries = new Map<string, Entry>()
  private watcher: FSWatcher | null = null
  private closed = false

  constructor(options: TranscriptStoreOptions) {
    this.projectsDir = options.projectsDir
    this.retentionMs = options.retentionMs ?? 30 * DAY
    this.eagerLimit = options.eagerLimit ?? 60
    this.onUpdate = options.onUpdate
    this.onError = options.onError
  }

  async init(): Promise<void> {
    await this.discover()
    const eager = [...this.entries.values()]
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, this.eagerLimit)
    await runPool(eager, 4, async (entry) => {
      await this.loadEntry(entry, true)
    })
    if (!this.closed) this.startWatching()
  }

  async discover(): Promise<void> {
    let projectDirs: Dirent[]
    try {
      projectDirs = await readdir(this.projectsDir, { withFileTypes: true })
    } catch {
      return
    }
    const cutoff = now() - this.retentionMs
    const found: Entry[] = []
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue
      const dir = path.join(this.projectsDir, projectDir.name)
      let files: Dirent[]
      try {
        files = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
        if (file.name.startsWith('agent-')) continue
        const full = path.join(dir, file.name)
        const info = await statTranscript(full)
        if (!info || info.mtimeMs < cutoff) continue
        const sessionId = file.name.slice(0, -'.jsonl'.length)
        found.push({
          sessionId,
          file: full,
          projectDir: dir,
          state: null,
          offset: 0,
          remainder: Buffer.alloc(0),
          ino: info.ino,
          size: info.size,
          mtimeMs: info.mtimeMs,
          loaded: false,
          loading: null,
          timer: null,
          lastAccess: 0,
          resolvedQuestions: [],
        })
      }
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const entry of found.slice(0, MAX_ENTRIES)) {
      const existing = this.entries.get(entry.sessionId)
      if (existing) {
        existing.mtimeMs = entry.mtimeMs
        existing.size = entry.size
        existing.file = entry.file
        existing.projectDir = entry.projectDir
      } else {
        this.entries.set(entry.sessionId, entry)
      }
    }
  }

  private loadEntry(entry: Entry, eager: boolean): Promise<void> {
    if (entry.loading) return entry.loading
    entry.loading = this.doLoad(entry, eager).finally(() => {
      entry.loading = null
    })
    return entry.loading
  }

  private async doLoad(entry: Entry, eager: boolean): Promise<void> {
    const info = await statTranscript(entry.file)
    if (!info) return
    const headBytes = eager ? 131_072 : 65_536
    const tailBytes = eager ? 1_048_576 : 262_144
    const read = await readInitialTranscript(entry.file, info, { headBytes, tailBytes })
    const state = createTranscriptState()
    const headLines = read.lines.slice(0, read.headLineCount)
    const resolved = parseTranscriptLines(state, headLines)
    if (read.headLineCount < read.lines.length && !state.firstPrompt) {
      // The head held only slash commands or similar; the original ask may sit
      // between the head and the tail. Look ahead before the tail parser makes
      // the first *recent* prompt look like the session's mission.
      await this.fillFirstPrompt(entry.file, info.size, read.headEnd, state)
    }
    resolved.push(...parseTranscriptLines(state, read.lines.slice(read.headLineCount)))
    entry.state = state
    entry.offset = read.offset
    entry.remainder = read.remainder
    entry.ino = info.ino
    entry.size = info.size
    entry.mtimeMs = info.mtimeMs
    entry.loaded = true
    entry.lastAccess = now()
    if (resolved.length) entry.resolvedQuestions.push(...resolved)
    this.evictIfNeeded()
    this.onUpdate?.(entry.sessionId)
  }

  /**
   * Find the session's first real prompt when the head window did not contain it.
   * The probe state is thrown away; only the prompt itself is carried over.
   */
  private async fillFirstPrompt(
    file: string,
    size: number,
    from: number,
    state: TranscriptParseState,
  ): Promise<void> {
    const probe = createTranscriptState()
    const found = await scanLines(file, from, size, (lines) => {
      parseTranscriptLines(probe, lines)
      return probe.firstPrompt !== null
    })
    if (found) {
      state.firstPrompt = probe.firstPrompt
      state.firstPromptAt = probe.firstPromptAt
    }
  }

  private async refresh(entry: Entry): Promise<void> {
    if (this.closed) return
    try {
      const info = await statTranscript(entry.file)
      if (!info) return
      if (!entry.loaded || !entry.state) {
        await this.loadEntry(entry, false)
        return
      }
      const replaced =
        (info.ino != null && entry.ino != null && info.ino !== entry.ino) ||
        info.size < entry.offset
      if (replaced) {
        entry.state = null
        entry.offset = 0
        entry.remainder = Buffer.alloc(0)
        entry.loaded = false
        await this.loadEntry(entry, false)
        return
      }
      entry.mtimeMs = info.mtimeMs
      entry.size = info.size
      entry.lastAccess = now()
      if (info.size === entry.offset && entry.remainder.length === 0) return

      let consumed = 0
      while (entry.offset < info.size && consumed < 32 * 1024 * 1024) {
        const end = Math.min(info.size, entry.offset + 4 * 1024 * 1024)
        const slice = await readSlice(entry.file, entry.offset, end)
        const combined = Buffer.concat([entry.remainder, slice])
        const split = splitBufferLines(combined, false)
        entry.remainder = split.remainder
        entry.offset = end
        consumed += slice.length
        if (split.lines.length) {
          parseTranscriptLines(entry.state, split.lines)
        }
      }
      entry.size = Math.max(entry.size, entry.offset)
      this.onUpdate?.(entry.sessionId)
      if (entry.offset < info.size) {
        this.scheduleRefresh(entry, 500)
      }
    } catch (error) {
      this.onError?.(error)
    }
  }

  private startWatching(): void {
    try {
      this.watcher = watch(this.projectsDir, {
        depth: 2,
        ignoreInitial: true,
        persistent: true,
        awaitWriteFinish: false,
      })
    } catch (error) {
      this.onError?.(error)
      return
    }
    this.watcher.on('add', (file) => void this.handleFileEvent(file, true))
    this.watcher.on('change', (file) => void this.handleFileEvent(file, false))
    this.watcher.on('error', (error) => this.onError?.(error))
  }

  private async handleFileEvent(file: string, added: boolean): Promise<void> {
    if (this.closed) return
    if (!file.endsWith('.jsonl')) return
    const relative = path.relative(this.projectsDir, file)
    if (relative.startsWith('..')) return
    if (relative.split(path.sep).length !== 2) return
    if (path.basename(file).startsWith('agent-')) return
    const sessionId = path.basename(file, '.jsonl')
    let entry = this.entries.get(sessionId)
    if (!entry) {
      const info = await statTranscript(file)
      if (!info) return
      entry = {
        sessionId,
        file,
        projectDir: path.dirname(file),
        state: null,
        offset: 0,
        remainder: Buffer.alloc(0),
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        loaded: false,
        loading: null,
        timer: null,
        lastAccess: now(),
        resolvedQuestions: [],
      }
      this.entries.set(sessionId, entry)
    }
    entry.file = file
    entry.mtimeMs = Math.max(entry.mtimeMs, now())
    if (added && !entry.loaded) {
      await this.loadEntry(entry, true)
    }
    this.scheduleRefresh(entry)
  }

  private scheduleRefresh(entry: Entry, delay = REFRESH_DEBOUNCE_MS): void {
    if (this.closed) return
    if (entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      void this.refresh(entry)
    }, delay)
    entry.timer.unref?.()
  }

  private evictIfNeeded(): void {
    const loaded = [...this.entries.values()].filter((entry) => entry.loaded && entry.state)
    if (loaded.length <= MAX_LOADED) return
    loaded.sort((a, b) => a.lastAccess - b.lastAccess)
    const excess = loaded.length - MAX_LOADED
    const activeCutoff = now() - 5 * 60_000
    let evicted = 0
    for (const entry of loaded) {
      if (evicted >= excess) break
      if (entry.lastAccess >= activeCutoff) continue
      entry.state = null
      entry.loaded = false
      entry.offset = 0
      entry.remainder = Buffer.alloc(0)
      evicted += 1
    }
  }

  views(): TranscriptView[] {
    return [...this.entries.values()].map(viewFromState)
  }

  view(sessionId: string): TranscriptView | null {
    const entry = this.entries.get(sessionId)
    return entry ? viewFromState(entry) : null
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId)
  }

  pathFor(sessionId: string): string | null {
    return this.entries.get(sessionId)?.file ?? null
  }

  async ensureLoaded(sessionId: string): Promise<TranscriptView | null> {
    const entry = this.entries.get(sessionId)
    if (!entry) {
      // A session mentioned by a hook may not have been discovered yet.
      await this.discover()
      const rediscovered = this.entries.get(sessionId)
      if (!rediscovered) return null
      await this.loadEntry(rediscovered, false)
      return viewFromState(rediscovered)
    }
    entry.lastAccess = now()
    if (!entry.loaded && !entry.loading) {
      await this.loadEntry(entry, false)
    } else if (entry.loading) {
      await entry.loading
    }
    return viewFromState(entry)
  }

  takeResolvedQuestions(sessionId: string): string[] {
    const entry = this.entries.get(sessionId)
    if (!entry?.resolvedQuestions.length) return []
    const resolved = entry.resolvedQuestions
    entry.resolvedQuestions = []
    return resolved
  }

  async close(): Promise<void> {
    this.closed = true
    for (const entry of this.entries.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
    }
    await this.watcher?.close()
    this.watcher = null
  }
}
