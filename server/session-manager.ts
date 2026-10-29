import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  ActivityEvent,
  FileClaim,
  HookEnvelope,
  HookReply,
  LaunchSessionInput,
  LaunchSessionResult,
  MessageInput,
  PendingQuestion,
  PublicConfig,
  QuestionAnswerInput,
  ServerEvent,
  SessionDetail,
  SessionMessage,
  SessionPatch,
  SessionStatus,
  SessionSummary,
  SessionTimeline,
  SettingsPatch,
  StopSessionResult,
  TokenUsage,
} from '../shared/types.js'
import type { AppConfig } from './config.js'
import { buildInjectedContext, claimConflictNote, overlapNote } from './coordination.js'
import { estimatedCostUsd, pricingForModel } from './pricing.js'
import { QuestionBroker, type QuestionResolution } from './questions.js'
import { type BackgroundJob, ClaudeRegistry, type LiveSession } from './registry.js'
import type { StateStore } from './state-store.js'
import { describeToolCall, questionsFromToolInput } from './transcript/parse.js'
import { TranscriptStore, type TranscriptView } from './transcript/store.js'
import {
  cleanPrompt,
  expandHome,
  getGitInfo,
  hashString,
  isoAt,
  missionHeadline,
  now,
  oneLine,
  projectLabel,
  shortId,
  truncate,
} from './util.js'
import { VERSION } from './version.js'

const execFileAsync = promisify(execFile)

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const DAY = 24 * 60 * 60 * 1000
const MINUTE = 60 * 1000
const RECENT_WINDOW_MS = 14 * DAY
const LIVE_HOOK_WINDOW_MS = 30 * MINUTE
const OVERLAP_NOTE_TTL_MS = 6 * 60 * MINUTE

interface NotificationState {
  message: string
  type: string | null
  at: number
}

interface Runtime {
  sessionId: string
  cwd: string | null
  lastHookAt: number
  lastEventAt: number
  lastEvent: string
  working: boolean
  prompt: string | null
  promptAt: number | null
  promptCount: number
  toolName: string | null
  toolText: string | null
  toolAt: number | null
  stopAt: number | null
  notification: NotificationState | null
  endedAt: number | null
  endReason: string | null
  compactingAt: number | null
  client: HookEnvelope['client'] | null
  pluginVersion: string | null
  awaitingAnswerAt: number | null
  terminalQuestionAt: number | null
  sessionStartedAt: number | null
  permissionMode: string | null
}

export interface SessionManagerOptions {
  claudeBin?: string
}

function newRuntime(sessionId: string, at: number): Runtime {
  return {
    sessionId,
    cwd: null,
    lastHookAt: at,
    lastEventAt: at,
    lastEvent: 'unknown',
    working: false,
    prompt: null,
    promptAt: null,
    promptCount: 0,
    toolName: null,
    toolText: null,
    toolAt: null,
    stopAt: null,
    notification: null,
    endedAt: null,
    endReason: null,
    compactingAt: null,
    client: null,
    pluginVersion: null,
    awaitingAnswerAt: null,
    terminalQuestionAt: null,
    sessionStartedAt: null,
    permissionMode: null,
  }
}

function questionHash(question: PendingQuestion): string {
  return hashString(
    question.prompts.map((prompt) => `${prompt.header}\u0000${prompt.question}`).join('\u0001'),
  )
}

function questionPromptsKey(sessionId: string, question: PendingQuestion): string {
  return `${sessionId}:hash:${questionHash(question)}`
}

function buildTimeline(
  activities: ActivityEvent[],
  question: PendingQuestion | null,
  notification: NotificationState | null,
  job: BackgroundJob | null,
  at: number,
): SessionTimeline {
  const bucketMs = MINUTE
  const bucketCount = 30
  const end = Math.ceil(at / bucketMs) * bucketMs
  const start = end - bucketCount * bucketMs
  const counts = new Array<number>(bucketCount).fill(0)
  const waiting = new Array<number>(bucketCount).fill(0)
  const mark = (from: number, to: number): void => {
    const first = Math.max(0, Math.floor((from - start) / bucketMs))
    const last = Math.min(bucketCount - 1, Math.floor((to - start) / bucketMs))
    for (let index = first; index <= last; index += 1) waiting[index] = 1
  }
  for (const activity of activities) {
    if (activity.at < start || activity.at >= end) continue
    const index = Math.floor((activity.at - start) / bucketMs)
    counts[index] = (counts[index] ?? 0) + 1
  }
  if (question) mark(question.createdAt, at)
  if (notification) mark(notification.at, at)
  if (job?.state === 'blocked') mark(job.updatedAt ?? at - 10 * MINUTE, at)
  return {
    start,
    end,
    bucketMs,
    counts,
    waiting,
  }
}

function statusRank(status: SessionStatus): number {
  if (status === 'waiting') return 0
  if (status === 'working') return 1
  if (status === 'idle') return 2
  if (status === 'unknown') return 3
  return 4
}

/**
 * Merges hook reports, transcripts, Claude Code's registries and background job
 * state into one live view of every session, and owns all mutations the UI can do.
 */
export class SessionManager {
  private readonly config: AppConfig
  private readonly store: StateStore
  private readonly onEvent: (event: ServerEvent) => void
  private readonly claudeBin: string
  readonly startedAt = now()

  readonly transcripts: TranscriptStore
  readonly registry: ClaudeRegistry
  readonly broker: QuestionBroker

  private readonly runtimes = new Map<string, Runtime>()
  private readonly summaries = new Map<string, SessionSummary>()
  private readonly previousSerialized = new Map<string, string>()
  private readonly publishedQuestions = new Set<string>()
  private readonly questionResolutions = new Map<string, QuestionResolution>()
  private readonly suppressedQuestions = new Map<string, number>()
  private readonly overlapNotes = new Map<string, number>()
  private readonly claimNotes = new Map<string, number>()

  private recomputeTimer: NodeJS.Timeout | null = null
  private intervalTimer: NodeJS.Timeout | null = null
  private recomputing = false
  private recomputeAgain = false
  private closed = false
  private lastHookAt = 0

  constructor(
    config: AppConfig,
    store: StateStore,
    onEvent: (event: ServerEvent) => void,
    options: SessionManagerOptions = {},
  ) {
    this.config = config
    this.store = store
    this.onEvent = onEvent
    this.claudeBin = options.claudeBin ?? process.env.CSM_CLAUDE_BIN ?? 'claude'
    this.transcripts = new TranscriptStore({
      projectsDir: config.projectsDir,
      eagerLimit: 80,
      onUpdate: (sessionId) => this.handleTranscriptUpdate(sessionId),
      onError: (error) => console.error('[csm] transcript watcher:', error),
    })
    this.registry = new ClaudeRegistry({
      sessionsDir: config.sessionsDir,
      jobsDir: config.jobsDir,
      onChange: () => this.scheduleRecompute(200),
    })
    this.broker = new QuestionBroker({
      getTimeoutSeconds: () => this.store.getSettings().questionTimeoutSeconds,
      onQuestion: () => this.scheduleRecompute(0),
      onResolved: (question, resolution) => this.handleQuestionResolved(question, resolution),
    })
    this.recompute = this.recompute.bind(this)
  }

  async init(): Promise<void> {
    await this.transcripts.init()
    await this.registry.refresh()
    await this.recompute()
    this.registry.start(3000)
    this.intervalTimer = setInterval(() => this.scheduleRecompute(0), 4000)
    this.intervalTimer.unref?.()
  }

  getPublicConfig(): PublicConfig {
    const settings = this.store.getSettings()
    return {
      version: VERSION,
      questionMode: settings.questionMode,
      questionTimeoutSeconds: settings.questionTimeoutSeconds,
      pluginConnected: this.lastHookAt > 0 && now() - this.lastHookAt < 60 * MINUTE,
      claudeDir: this.config.claudeDir,
      dataDir: this.config.dataDir,
      readOnly: this.config.readOnly,
      authRequired: Boolean(this.config.token),
      launchEnabled: settings.launchEnabled && !this.config.readOnly,
      serverStartedAt: this.startedAt,
      serverUrl: this.config.localUrl,
    }
  }

  updateSettings(patch: SettingsPatch): PublicConfig {
    const settings = this.store.updateSettings(patch)
    if (settings.questionMode === 'terminal') {
      for (const question of this.broker.pendingQuestions()) {
        this.broker.dismiss(question.id)
      }
    }
    const config = this.getPublicConfig()
    this.onEvent({ type: 'config', config })
    this.scheduleRecompute(0)
    return config
  }

  getSessions(): SessionSummary[] {
    return [...this.summaries.values()]
  }

  getSession(id: string): SessionSummary | null {
    return this.summaries.get(id) ?? null
  }

  hasSession(id: string): boolean {
    return (
      this.summaries.has(id) || this.transcripts.has(id) || Boolean(this.store.getSessionMeta(id))
    )
  }

  getQuestions(): PendingQuestion[] {
    return [...this.summaries.values()]
      .map((session) => session.question)
      .filter((question): question is PendingQuestion => !!question)
  }

  patchSession(id: string, patch: SessionPatch): SessionSummary | null {
    this.store.patchSession(id, patch)
    this.scheduleRecompute(0)
    return this.summaries.get(id) ?? null
  }

  async getDetail(id: string): Promise<SessionDetail | null> {
    let view = this.transcripts.view(id)
    if (view && !view.loaded) {
      view = await this.transcripts.ensureLoaded(id)
    }
    if (!view) {
      const loaded = await this.transcripts.ensureLoaded(id)
      if (!loaded) return null
      view = loaded
    }
    let summary = this.summaries.get(id)
    if (!summary) {
      await this.recompute()
      summary = this.summaries.get(id)
    }
    if (!summary) {
      const overlaps = this.store.overlaps()
      summary = await this.buildSummary(
        id,
        view,
        this.liveSession(id),
        this.jobFor(id),
        this.runtimes.get(id) ?? null,
        now(),
        overlaps,
      )
    } else if (summary.projectPath) {
      // Refresh repository metadata on demand so detail views can link to the remote.
      await getGitInfo(summary.projectPath)
      await this.recompute()
      summary = this.summaries.get(id) ?? summary
    }
    return {
      session: summary,
      activities: view?.activities ?? this.store.activitiesFor(id),
      messages: this.store.messagesForSession(id, 200),
      claims: this.store.claimsFor(id),
      transcriptPath: this.transcripts.pathFor(id),
    }
  }

  getCoordination(): {
    sessions: SessionSummary[]
    messages: SessionMessage[]
    claims: FileClaim[]
    fileTouches: ReturnType<StateStore['fileTouches']>
    overlaps: ReturnType<StateStore['overlaps']>
  } {
    return {
      sessions: this.getSessions(),
      messages: this.store.listMessages(100),
      claims: this.store.activeClaims(),
      fileTouches: this.store.fileTouches(6 * 60 * MINUTE),
      overlaps: this.store.overlaps(),
    }
  }

  async handleHook(envelope: HookEnvelope): Promise<HookReply> {
    const sessionId = envelope.sessionId?.trim()
    if (!sessionId) return { output: null }
    const receivedAt = now()
    const clientAt =
      typeof envelope.timestamp === 'number' &&
      Math.abs(envelope.timestamp - receivedAt) < 5 * MINUTE
        ? envelope.timestamp
        : receivedAt
    const event = envelope.event || 'Unknown'
    const runtime = this.ensureRuntime(sessionId, receivedAt)
    runtime.lastHookAt = receivedAt
    runtime.lastEventAt = clientAt
    runtime.lastEvent = event
    if (envelope.cwd) runtime.cwd = envelope.cwd
    if (envelope.client) runtime.client = envelope.client
    if (envelope.pluginVersion) runtime.pluginVersion = envelope.pluginVersion
    if (envelope.permissionMode) runtime.permissionMode = envelope.permissionMode
    this.lastHookAt = receivedAt

    switch (event) {
      case 'SessionStart': {
        runtime.endedAt = null
        runtime.endReason = null
        runtime.working = false
        runtime.stopAt = null
        runtime.notification = null
        runtime.awaitingAnswerAt = null
        runtime.terminalQuestionAt = null
        runtime.sessionStartedAt = clientAt
        this.store.clearEnded(sessionId)
        this.store.touchSession(sessionId, clientAt)
        void this.transcripts.ensureLoaded(sessionId).then(() => this.scheduleRecompute(100))
        const context = this.buildContext(sessionId, 'start')
        this.scheduleRecompute(0)
        return context
          ? {
              output: {
                hookSpecificOutput: {
                  hookEventName: 'SessionStart',
                  additionalContext: context,
                },
              },
            }
          : { output: null }
      }

      case 'UserPromptSubmit': {
        runtime.working = true
        runtime.stopAt = null
        runtime.notification = null
        runtime.awaitingAnswerAt = null
        runtime.terminalQuestionAt = null
        runtime.endedAt = null
        if (envelope.prompt) {
          const prompt = cleanPrompt(envelope.prompt)
          if (prompt.length >= 2) {
            runtime.prompt = truncate(prompt, 8000)
            runtime.promptAt = clientAt
            runtime.promptCount += 1
          }
        }
        this.store.touchSession(sessionId, clientAt)
        const context = this.buildContext(sessionId, 'prompt')
        this.scheduleRecompute(0)
        return context
          ? {
              output: {
                hookSpecificOutput: {
                  hookEventName: 'UserPromptSubmit',
                  additionalContext: context,
                },
              },
            }
          : { output: null }
      }

      case 'PreToolUse': {
        runtime.working = true
        runtime.stopAt = null
        runtime.notification = null
        runtime.toolName = envelope.toolName ?? null
        runtime.toolAt = clientAt
        const description = envelope.toolName
          ? describeToolCall(envelope.toolName, envelope.toolInput)
          : null
        runtime.toolText = description?.title ?? null
        this.store.touchSession(sessionId, clientAt)
        this.scheduleRecompute(0)

        if (envelope.toolName === 'AskUserQuestion') {
          return this.bridgeQuestion(sessionId, runtime, envelope.toolInput, clientAt)
        }
        return { output: null }
      }

      case 'PostToolUse': {
        runtime.working = true
        runtime.stopAt = null
        runtime.notification = null
        runtime.toolName = null
        runtime.toolText = null
        runtime.awaitingAnswerAt = null
        runtime.terminalQuestionAt = null
        if (envelope.toolName === 'AskUserQuestion') {
          this.broker.cancelForSession(sessionId, 'terminal')
        }
        if (envelope.toolName && EDIT_TOOLS.has(envelope.toolName)) {
          this.recordFileTouch(sessionId, envelope.toolName, envelope.toolInput, clientAt)
        }
        this.store.touchSession(sessionId, clientAt)
        this.scheduleRecompute(0)
        return { output: null }
      }

      case 'Notification': {
        const type = envelope.notificationType ?? null
        const message = oneLine(envelope.message ?? 'Claude needs your attention', 500)
        runtime.notification = { message, type, at: clientAt }
        if (!type || /permission|idle|elicitation|waiting|input/i.test(type)) {
          runtime.working = false
        }
        this.scheduleRecompute(0)
        return { output: null }
      }

      case 'Stop': {
        runtime.working = false
        runtime.stopAt = clientAt
        runtime.notification = null
        runtime.toolName = null
        runtime.toolText = null
        runtime.awaitingAnswerAt = null
        this.broker.cancelForSession(sessionId, 'terminal')
        this.store.touchSession(sessionId, clientAt)
        this.scheduleRecompute(0)
        return { output: null }
      }

      case 'SubagentStop': {
        runtime.working = true
        runtime.notification = null
        this.scheduleRecompute(0)
        return { output: null }
      }

      case 'PreCompact': {
        runtime.working = true
        runtime.compactingAt = clientAt
        runtime.notification = null
        this.scheduleRecompute(0)
        return { output: null }
      }

      case 'SessionEnd': {
        runtime.endedAt = clientAt
        runtime.endReason = envelope.reason ?? envelope.source ?? null
        runtime.working = false
        runtime.notification = null
        runtime.awaitingAnswerAt = null
        this.broker.cancelForSession(sessionId, 'terminal')
        this.store.setEnded(sessionId, clientAt)
        this.scheduleRecompute(0)
        return { output: null }
      }

      default: {
        this.scheduleRecompute(0)
        return { output: null }
      }
    }
  }

  private async bridgeQuestion(
    sessionId: string,
    runtime: Runtime,
    toolInput: unknown,
    at: number,
  ): Promise<HookReply> {
    const prompts = questionsFromToolInput(toolInput)
    if (!prompts.length) return { output: null }
    const settings = this.store.getSettings()
    if (this.config.readOnly || settings.questionMode === 'terminal') {
      runtime.working = false
      runtime.terminalQuestionAt = at
      this.scheduleRecompute(0)
      return { output: null }
    }
    runtime.working = false
    runtime.awaitingAnswerAt = at
    const { reply } = this.broker.create(sessionId, null, prompts)
    this.scheduleRecompute(0)
    const result = await reply
    runtime.awaitingAnswerAt = null
    if (result.output) {
      runtime.working = true
    } else {
      runtime.working = false
      runtime.terminalQuestionAt = at
    }
    this.scheduleRecompute(0)
    return result
  }

  answerQuestion(id: string, input: QuestionAnswerInput): { ok: boolean; error?: string } {
    if (this.config.readOnly) return { ok: false, error: 'read-only mode' }
    if (this.store.getSettings().questionMode === 'terminal') {
      return { ok: false, error: 'questions are answered in the terminal' }
    }
    const result = this.broker.answer(id, input)
    if (!result.ok) return { ok: false, error: result.error }
    this.scheduleRecompute(0)
    return { ok: true }
  }

  dismissQuestion(id: string): boolean {
    if (this.config.readOnly) return false
    const dismissed = this.broker.dismiss(id)
    if (dismissed) this.scheduleRecompute(0)
    return dismissed
  }

  sendMessage(
    input: MessageInput,
    sender?: { sessionId: string | null; name?: string | null },
  ): SessionMessage {
    const body = input.body?.trim()
    if (!body) throw new Error('Message body must not be empty')
    if (body.length > 8000) throw new Error('Message body is too long (max 8000 characters)')
    const kind = input.kind === 'question' || input.kind === 'answer' ? input.kind : 'note'
    const fromSessionId = sender?.sessionId ?? null
    const toSessionId = input.toSessionId ?? null
    if (fromSessionId && toSessionId === fromSessionId) {
      throw new Error('A session cannot message itself')
    }
    if (toSessionId && !this.summaries.has(toSessionId) && !this.transcripts.has(toSessionId)) {
      throw new Error('Unknown session')
    }
    const target = toSessionId ? this.summaries.get(toSessionId) : null
    const from = fromSessionId ? this.summaries.get(fromSessionId) : null
    const message: SessionMessage = {
      id: `m_${randomUUID()}`,
      fromSessionId,
      fromName:
        sender?.name ??
        (from?.name || from?.title) ??
        (fromSessionId ? shortId(fromSessionId) : 'You'),
      toSessionId,
      toName: target ? target.name || target.title : null,
      body,
      kind,
      createdAt: now(),
      deliveries: {},
      readBy: {},
    }
    this.store.addMessage(message)
    this.onEvent({ type: 'message', message })
    this.scheduleRecompute(0)
    return message
  }

  getInbox(sessionId: string): { messages: SessionMessage[] } {
    const messages = this.store
      .messagesForSession(sessionId, 200)
      .filter(
        (message) => message.fromSessionId !== sessionId && message.readBy[sessionId] === undefined,
      )
    this.store.markRead(
      sessionId,
      messages.map((message) => message.id),
    )
    this.scheduleRecompute(0)
    return { messages }
  }

  claimFiles(
    sessionId: string,
    input: { paths: string[]; note?: string | null; ttlMinutes?: number; release?: boolean },
  ): { claim: FileClaim | null; released: number; conflicts: FileClaim[] } {
    if (this.config.readOnly) throw new Error('read-only mode')
    const summary = this.summaries.get(sessionId)
    const cwd = summary?.projectPath || this.transcripts.view(sessionId)?.cwd || null
    const rawPaths = Array.isArray(input.paths) ? input.paths : []
    if (!rawPaths.length) throw new Error('paths must contain at least one file or directory')
    if (rawPaths.length > 50) throw new Error('Too many paths (max 50)')
    const paths = [
      ...new Set(
        rawPaths
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter(Boolean)
          .map((item) => {
            const expanded = expandHome(item)
            if (path.isAbsolute(expanded)) return path.normalize(expanded)
            if (!cwd)
              throw new Error(`Cannot resolve relative path without a project directory: ${item}`)
            return path.normalize(path.resolve(cwd, expanded))
          }),
      ),
    ]

    if (input.release) {
      const released = this.store.releaseClaims(sessionId, paths)
      this.scheduleRecompute(0)
      return { claim: null, released, conflicts: [] }
    }

    const conflicts = this.store.claimsConflictingWith(sessionId, paths)
    const ttlMinutes = Math.min(1440, Math.max(5, Math.round(input.ttlMinutes ?? 120)))
    const at = now()
    const claim: FileClaim = {
      id: `c_${randomUUID()}`,
      sessionId,
      paths,
      note: input.note?.trim().slice(0, 500) || null,
      createdAt: at,
      expiresAt: at + ttlMinutes * MINUTE,
    }
    this.store.addClaim(claim)
    this.scheduleRecompute(0)
    return { claim, released: 0, conflicts }
  }

  releaseAllClaims(sessionId: string): number {
    if (this.config.readOnly) return 0
    const released = this.store.releaseClaims(sessionId)
    this.scheduleRecompute(0)
    return released
  }

  async launchSession(input: LaunchSessionInput): Promise<LaunchSessionResult> {
    const settings = this.store.getSettings()
    if (this.config.readOnly) return { ok: false, error: 'read-only mode' }
    if (!settings.launchEnabled) return { ok: false, error: 'Launching sessions is disabled' }
    const prompt = input.prompt?.trim()
    if (!prompt) return { ok: false, error: 'Prompt must not be empty' }
    if (prompt.length > 40_000) return { ok: false, error: 'Prompt is too long' }
    const cwd = path.resolve(expandHome(input.cwd?.trim() || process.cwd()))
    try {
      const info = await stat(cwd)
      if (!info.isDirectory()) return { ok: false, error: 'Working directory is not a directory' }
    } catch {
      return { ok: false, error: 'Working directory does not exist' }
    }
    const allowedModes = new Set([
      'acceptEdits',
      'auto',
      'bypassPermissions',
      'manual',
      'dontAsk',
      'plan',
    ])
    if (input.permissionMode && !allowedModes.has(input.permissionMode)) {
      return { ok: false, error: 'Unknown permission mode' }
    }
    if (input.resumeSessionId && !/^[0-9a-zA-Z_-]{8,80}$/.test(input.resumeSessionId)) {
      return { ok: false, error: 'Invalid session id' }
    }

    const args: string[] = ['--bg']
    if (input.resumeSessionId) args.push('--resume', input.resumeSessionId)
    if (input.name?.trim()) args.push('--name', input.name.trim().slice(0, 80))
    if (input.model?.trim()) args.push('--model', input.model.trim().slice(0, 120))
    if (input.permissionMode) args.push('--permission-mode', input.permissionMode)
    args.push(prompt)

    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (
        key === 'CLAUDECODE' ||
        key.startsWith('CLAUDE_CODE_') ||
        key === 'CLAUDE_PLUGIN_ROOT' ||
        key === 'CLAUDE_PROJECT_DIR'
      ) {
        delete env[key]
      }
    }

    const startedAt = now()
    try {
      const { stdout, stderr } = await execFileAsync(this.claudeBin, args, {
        cwd,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        env,
        windowsHide: true,
      })
      const output = `${stdout ?? ''}${stderr ?? ''}`.trim()
      const idMatch = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
      const shortMatch = output.match(/\b[0-9a-f]{8}\b/i)
      const jobId = idMatch?.[0] ?? shortMatch?.[0] ?? null
      await new Promise((resolve) => setTimeout(resolve, 900))
      await this.registry.refresh()
      const job = this.registry
        .getSnapshot()
        .jobs.find(
          (candidate) =>
            (jobId && (candidate.jobId === jobId || candidate.sessionId === jobId)) ||
            ((candidate.updatedAt ?? 0) >= startedAt - 5000 &&
              candidate.cwd === cwd &&
              (!input.name || candidate.name === input.name.trim())),
        )
      this.scheduleRecompute(0)
      return {
        ok: true,
        jobId: job?.jobId ?? jobId ?? undefined,
        sessionId: job?.sessionId ?? undefined,
        output: truncate(output, 2000),
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
      const detail = truncate(
        `${err.stderr ?? ''}${err.stdout ?? ''}`.trim() || err.message || 'Failed to launch',
        2000,
      )
      return { ok: false, error: detail }
    }
  }

  async stopSession(id: string): Promise<StopSessionResult> {
    if (this.config.readOnly) return { ok: false, error: 'read-only mode' }
    const job =
      this.registry.getSnapshot().jobs.find((candidate) => candidate.sessionId === id) ?? null
    if (!job) {
      return {
        ok: false,
        error:
          'Only background jobs can be stopped from the session manager. Close interactive sessions in their terminal.',
      }
    }
    try {
      const { stdout, stderr } = await execFileAsync(this.claudeBin, ['stop', job.jobId], {
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      })
      await new Promise((resolve) => setTimeout(resolve, 700))
      await this.registry.refresh()
      this.scheduleRecompute(0)
      return {
        ok: true,
        output: truncate(`${stdout ?? ''}${stderr ?? ''}`.trim(), 1000),
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stderr?: string }
      return {
        ok: false,
        error: truncate(err.stderr?.trim() || err.message || 'Failed to stop session', 1000),
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.recomputeTimer) {
      clearTimeout(this.recomputeTimer)
      this.recomputeTimer = null
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = null
    }
    for (const question of this.broker.pendingQuestions()) {
      this.broker.cancelForSession(question.sessionId, 'terminal')
    }
    this.registry.stop()
    await this.transcripts.close()
  }

  private ensureRuntime(sessionId: string, at: number): Runtime {
    let runtime = this.runtimes.get(sessionId)
    if (!runtime) {
      runtime = newRuntime(sessionId, at)
      this.runtimes.set(sessionId, runtime)
    }
    return runtime
  }

  private handleTranscriptUpdate(sessionId: string): void {
    this.transcripts.takeResolvedQuestions(sessionId)
    this.scheduleRecompute(120)
  }

  private handleQuestionResolved(question: PendingQuestion, resolution: QuestionResolution): void {
    this.questionResolutions.set(question.id, resolution)
    const expiry = now() + 20 * MINUTE
    this.suppressedQuestions.set(questionPromptsKey(question.sessionId, question), expiry)
    if (question.toolUseId) {
      this.suppressedQuestions.set(`${question.sessionId}:${question.toolUseId}`, expiry)
    }
    this.scheduleRecompute(0)
  }

  private isSuppressed(sessionId: string, question: PendingQuestion): boolean {
    const at = now()
    const byTool = question.toolUseId
      ? this.suppressedQuestions.get(`${sessionId}:${question.toolUseId}`)
      : undefined
    if (byTool && byTool > at) return true
    const byHash = this.suppressedQuestions.get(questionPromptsKey(sessionId, question))
    return Boolean(byHash && byHash > at)
  }

  private scheduleRecompute(delayMs = 100): void {
    if (this.closed) return
    if (this.recomputeTimer) return
    this.recomputeTimer = setTimeout(() => {
      this.recomputeTimer = null
      void this.recompute()
    }, delayMs)
    this.recomputeTimer.unref?.()
  }

  private async recompute(): Promise<void> {
    if (this.closed) return
    if (this.recomputing) {
      this.recomputeAgain = true
      return
    }
    this.recomputing = true
    try {
      await this.doRecompute()
    } catch (error) {
      console.error('[csm] recompute failed:', error)
    } finally {
      this.recomputing = false
      if (this.recomputeAgain) {
        this.recomputeAgain = false
        this.scheduleRecompute(50)
      }
    }
  }

  private async doRecompute(): Promise<void> {
    const at = now()
    const snapshot = this.registry.getSnapshot()
    const views = new Map<string, TranscriptView>()
    for (const view of this.transcripts.views()) views.set(view.sessionId, view)
    const liveBySession = new Map<string, LiveSession>()
    for (const live of snapshot.sessions) liveBySession.set(live.sessionId, live)
    const jobsBySession = new Map<string, BackgroundJob>()
    const jobRank = (job: BackgroundJob): number => {
      if (job.state === 'working') return 3
      if (job.state === 'blocked') return 2
      if (job.state === 'done') return 1
      return 0
    }
    for (const job of snapshot.jobs) {
      if (!job.sessionId) continue
      const existing = jobsBySession.get(job.sessionId)
      if (
        !existing ||
        jobRank(job) > jobRank(existing) ||
        (jobRank(job) === jobRank(existing) && (job.updatedAt ?? 0) > (existing.updatedAt ?? 0))
      ) {
        jobsBySession.set(job.sessionId, job)
      }
    }

    const ids = new Set<string>()
    for (const [id, runtime] of this.runtimes) {
      if (at - runtime.lastHookAt < 7 * DAY) ids.add(id)
    }
    for (const id of liveBySession.keys()) ids.add(id)
    for (const [id, job] of jobsBySession) {
      if ((job.updatedAt ?? 0) > at - RECENT_WINDOW_MS) ids.add(id)
    }
    for (const [id, view] of views) {
      if (
        view.mtimeMs > at - RECENT_WINDOW_MS ||
        (view.lastActivityAt ?? 0) > at - RECENT_WINDOW_MS
      ) {
        ids.add(id)
        if (!view.loaded) {
          void this.transcripts.ensureLoaded(id).then(() => this.scheduleRecompute(100))
        }
      }
    }
    for (const meta of this.store.allSessionMeta()) {
      if (meta.pinned || meta.archived || meta.lastActivityAt > at - RECENT_WINDOW_MS)
        ids.add(meta.id)
    }

    const overlaps = this.store.overlaps(2 * 60 * MINUTE, at)
    const next = new Map<string, SessionSummary>()
    for (const id of ids) {
      const view = views.get(id) ?? null
      const live = liveBySession.get(id) ?? null
      const job = jobsBySession.get(id) ?? null
      const runtime = this.runtimes.get(id) ?? null
      if (!view && !live && !job && !runtime) continue
      if (runtime && at - runtime.lastHookAt >= 7 * DAY) continue
      const summary = await this.buildSummary(id, view, live, job, runtime, at, overlaps)
      next.set(id, summary)
    }

    const ordered = [...next.values()].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      if (a.archived !== b.archived) return a.archived ? 1 : -1
      const rank = statusRank(a.status) - statusRank(b.status)
      if (rank !== 0) return rank
      return b.lastActivityAt - a.lastActivityAt
    })

    this.summaries.clear()
    for (const summary of ordered) this.summaries.set(summary.id, summary)

    for (const summary of ordered) {
      const previous = this.previousSerialized.get(summary.id)
      const serialized = JSON.stringify(summary)
      if (serialized !== previous) {
        this.previousSerialized.set(summary.id, serialized)
        this.onEvent({ type: 'session', session: summary })
      }
    }
    for (const id of [...this.previousSerialized.keys()]) {
      if (!next.has(id)) {
        this.previousSerialized.delete(id)
        this.onEvent({ type: 'session.removed', id })
      }
    }

    const currentQuestions = new Map<string, PendingQuestion>()
    for (const summary of ordered) {
      if (summary.question) currentQuestions.set(summary.question.id, summary.question)
    }
    for (const [id, question] of currentQuestions) {
      if (this.publishedQuestions.has(id)) continue
      this.publishedQuestions.add(id)
      this.onEvent({ type: 'question', question })
    }
    for (const id of [...this.publishedQuestions]) {
      if (currentQuestions.has(id)) continue
      this.publishedQuestions.delete(id)
      const resolution = this.questionResolutions.get(id) ?? 'terminal'
      this.questionResolutions.delete(id)
      this.onEvent({ type: 'question.resolved', id, resolution })
    }

    const suppressionCutoff = at
    for (const [key, expiry] of this.suppressedQuestions) {
      if (expiry <= suppressionCutoff) this.suppressedQuestions.delete(key)
    }
  }

  private liveSession(id: string): LiveSession | null {
    return this.registry.getSnapshot().sessions.find((session) => session.sessionId === id) ?? null
  }

  private jobFor(id: string): BackgroundJob | null {
    return this.registry.getSnapshot().jobs.find((job) => job.sessionId === id) ?? null
  }

  private async buildSummary(
    id: string,
    view: TranscriptView | null,
    live: LiveSession | null,
    job: BackgroundJob | null,
    runtime: Runtime | null,
    at: number,
    overlaps: ReturnType<StateStore['overlaps']>,
  ): Promise<SessionSummary> {
    const meta = this.store.getSessionMeta(id)
    const projectPath = runtime?.cwd ?? view?.cwd ?? live?.cwd ?? job?.cwd ?? ''
    const projectName = projectPath ? path.basename(projectPath) : 'unknown'
    const project = projectLabel(projectPath)
    const hookFresh = runtime ? at - runtime.lastHookAt < LIVE_HOOK_WINDOW_MS : false
    const lastActivityAt = Math.max(
      view?.lastActivityAt ?? 0,
      runtime?.lastEventAt ?? 0,
      job?.updatedAt ?? 0,
      live?.statusUpdatedAt ?? 0,
      live?.startedAt ?? 0,
      meta?.lastActivityAt ?? 0,
      view?.mtimeMs ?? 0,
      view?.startedAt ?? 0,
    )

    const brokerQuestion = this.broker.forSession(id)
    const transcriptQuestion = view?.pendingQuestion ?? null
    const visibleTranscriptQuestion =
      transcriptQuestion && !this.isSuppressed(id, transcriptQuestion) ? transcriptQuestion : null
    const questionBase = brokerQuestion ?? visibleTranscriptQuestion
    const question: PendingQuestion | null = questionBase
      ? { ...questionBase, answerable: questionBase.answerable && !this.config.readOnly }
      : null

    const jobWorking = job?.state === 'working'
    const jobBlocked = job?.state === 'blocked'
    const jobFinished = job?.state === 'done' || job?.state === 'failed' || job?.state === 'stopped'
    const liveFlag = Boolean(live) || jobWorking
    const notificationWaiting = Boolean(runtime?.notification) && !runtime?.working

    let status: SessionStatus
    if (
      runtime?.endedAt ||
      (meta?.endedAt && !liveFlag && !jobWorking) ||
      (jobFinished && !liveFlag)
    ) {
      status = 'ended'
    } else if (question) {
      status = 'waiting'
    } else if (notificationWaiting) {
      status = 'waiting'
    } else if (jobBlocked) {
      status = 'waiting'
    } else if (live?.status === 'waiting') {
      status = 'waiting'
    } else if (runtime?.working && hookFresh) {
      status = 'working'
    } else if (live?.status === 'busy') {
      status = 'working'
    } else if (jobWorking) {
      status = 'working'
    } else if (live?.status === 'idle') {
      status = 'idle'
    } else if (runtime?.stopAt && hookFresh) {
      status = 'idle'
    } else if (this.transcriptLooksWorking(view, at)) {
      status = 'working'
    } else if (live) {
      status = 'idle'
    } else if (view && at - lastActivityAt < 15 * MINUTE) {
      status = 'idle'
    } else if (view || jobFinished) {
      status = 'ended'
    } else {
      status = 'unknown'
    }

    const model = view?.model ?? job?.model ?? null
    const git =
      projectPath && (Boolean(live) || at - lastActivityAt < 2 * 60 * MINUTE)
        ? await getGitInfo(projectPath)
        : null

    const titleCandidate = this.pickTitle(id, view, live, job, meta?.customTitle ?? null)
    const mission = this.sessionMission(id, view, live, job, meta?.customTitle ?? null)
    const task =
      runtime?.prompt ??
      view?.lastPrompt ??
      (job?.intent ? cleanPrompt(job.intent) : null) ??
      view?.summary ??
      null

    const tokens = this.tokenUsage(view, model)
    const notification = runtime?.notification ?? null
    const currentActivity = this.currentActivity(
      status,
      runtime,
      view,
      question,
      notification,
      job,
      live,
    )
    const statusDetail = this.statusDetail(status, runtime, view, question, notification, job, live)
    let endedAt: number | null = null
    if (status === 'ended') {
      endedAt = runtime?.endedAt ?? meta?.endedAt ?? null
      if (endedAt == null && jobFinished) endedAt = job?.updatedAt ?? null
      if (endedAt == null) endedAt = view?.lastActivityAt ?? lastActivityAt
    }

    return {
      id,
      shortId: shortId(id),
      name: live?.name ?? job?.name ?? null,
      title: titleCandidate.title,
      titleSource: titleCandidate.source,
      mission,
      projectPath,
      projectName,
      project,
      repoRoot: git?.repoRoot ?? (projectPath || null),
      repoName: git?.repoName ?? (projectPath ? projectName : null),
      gitBranch:
        (view?.gitBranch && view.gitBranch !== 'HEAD' ? view.gitBranch : null) ??
        git?.branch ??
        null,
      gitRemoteUrl: git?.remoteUrl ?? null,
      kind: live?.kind ?? (job ? 'background' : 'unknown'),
      status,
      statusDetail,
      task: task ? truncate(task, 2000) : null,
      todos: view?.todos ?? [],
      activity: currentActivity,
      question,
      startedAt: live?.startedAt ?? view?.startedAt ?? job?.createdAt ?? meta?.firstSeenAt ?? null,
      lastActivityAt: lastActivityAt || at,
      endedAt,
      model,
      version: live?.version ?? view?.version ?? null,
      tokens,
      live: liveFlag,
      pid: live?.pid ?? null,
      tmux: live?.tmux ?? null,
      backgroundState: job?.state ?? null,
      needs: job?.needs ?? null,
      jobId: job?.jobId ?? null,
      unreadMessages: this.store.unreadCount(id),
      overlapCount: overlaps.filter(
        (overlap) => overlap.sessionIds.includes(id) || overlap.claimedBy.includes(id),
      ).length,
      pinned: meta?.pinned ?? false,
      archived: meta?.archived ?? false,
      timeline: buildTimeline(view?.activities ?? [], question, notification, job, at),
      messageCount: view?.messageCount ?? 0,
      source: runtime && hookFresh ? 'hook' : live ? 'registry' : job ? 'background' : 'transcript',
    }
  }

  private sessionMission(
    id: string,
    view: TranscriptView | null,
    live: LiveSession | null,
    job: BackgroundJob | null,
    customTitle: string | null,
  ): string {
    if (customTitle?.trim()) return oneLine(customTitle, 120)
    // The first prompt is the mission and stays stable while the session works;
    // the last prompt, a background intent and the terminal name are fallbacks
    // for transcripts that start with a compaction preamble or hold no text.
    const candidates = [
      view?.firstPrompt,
      view?.lastPrompt,
      job?.intent ? cleanPrompt(job.intent) : null,
      live?.name,
    ]
    for (const candidate of candidates) {
      const headline = missionHeadline(candidate)
      if (headline) return headline
    }
    return `Session ${shortId(id)}`
  }

  private pickTitle(
    id: string,
    view: TranscriptView | null,
    live: LiveSession | null,
    job: BackgroundJob | null,
    customTitle: string | null,
  ): { title: string; source: SessionSummary['titleSource'] } {
    if (customTitle) return { title: customTitle, source: 'custom' }
    if (live?.name) return { title: live.name, source: 'name' }
    if (view?.slug) return { title: view.slug, source: 'summary' }
    if (view?.firstPrompt) return { title: oneLine(view.firstPrompt, 120), source: 'prompt' }
    if (view?.summary) return { title: oneLine(view.summary, 120), source: 'summary' }
    if (job?.name) return { title: job.name, source: 'name' }
    if (job?.intent) return { title: oneLine(cleanPrompt(job.intent), 120), source: 'prompt' }
    return { title: `Session ${shortId(id)}`, source: 'id' }
  }

  private tokenUsage(view: TranscriptView | null, model: string | null): TokenUsage | null {
    if (!view?.loaded) return null
    const total =
      view.tokens.inputTokens +
      view.tokens.outputTokens +
      view.tokens.cacheReadTokens +
      view.tokens.cacheCreationTokens
    if (!total && view.contextUsed == null) return null
    const pricing = pricingForModel(model)
    const contextWindow = view.contextWindow ?? pricing?.contextWindow ?? null
    const contextUsed = view.contextUsed ?? null
    return {
      inputTokens: view.tokens.inputTokens,
      outputTokens: view.tokens.outputTokens,
      cacheReadTokens: view.tokens.cacheReadTokens,
      cacheCreationTokens: view.tokens.cacheCreationTokens,
      totalTokens: total,
      costUsd: estimatedCostUsd(model, view.tokens),
      contextUsed,
      contextWindow,
      contextPct:
        contextUsed != null && contextWindow
          ? Math.min(100, Math.round((contextUsed / contextWindow) * 1000) / 10)
          : null,
    }
  }

  private transcriptLooksWorking(view: TranscriptView | null, at: number): boolean {
    if (!view) return false
    const last = view.lastActivityAt ?? view.lastPromptAt ?? 0
    if (!last || at - last > 3 * MINUTE) return false
    if (view.openToolUses > 0) return true
    if (view.lastEventType === 'user') return at - last < 90_000
    if (view.lastEventType === 'assistant') return at - last < 7000
    return false
  }

  private currentActivity(
    status: SessionStatus,
    runtime: Runtime | null,
    view: TranscriptView | null,
    question: PendingQuestion | null,
    notification: NotificationState | null,
    job: BackgroundJob | null,
    live: LiveSession | null,
  ): SessionSummary['activity'] {
    if (question) {
      return {
        kind: 'waiting',
        text: question.prompts[0]?.question ?? 'Waiting for your answer',
        at: question.createdAt,
      }
    }
    if (status === 'waiting') {
      return {
        kind: 'waiting',
        text: notification?.message ?? job?.needs ?? live?.waitingFor ?? 'Waiting for input',
        at: notification?.at ?? job?.updatedAt ?? live?.statusUpdatedAt ?? now(),
      }
    }
    if (status === 'working') {
      if (runtime?.toolName) {
        return {
          kind: 'tool',
          tool: runtime.toolName,
          text: runtime.toolText ?? runtime.toolName,
          at: runtime.toolAt ?? runtime.lastEventAt,
        }
      }
      if (view?.openToolUses && view.lastToolName) {
        return {
          kind: 'tool',
          tool: view.lastToolName,
          text: view.lastToolText ?? view.lastToolName,
          at: view.lastToolAt ?? view.lastActivityAt ?? now(),
        }
      }
      return {
        kind: 'thinking',
        text: oneLine(view?.lastAssistantText ?? 'Working…', 180),
        at: runtime?.lastEventAt ?? view?.lastActivityAt ?? now(),
      }
    }
    if (status === 'idle') {
      return {
        kind: 'response',
        text: oneLine(view?.lastAssistantText ?? 'Ready for the next prompt', 180),
        at: view?.lastAssistantAt ?? runtime?.stopAt ?? view?.lastActivityAt ?? now(),
      }
    }
    if (status === 'ended') {
      return {
        kind: 'event',
        text: runtime?.endReason ? `Session ended (${runtime.endReason})` : 'Session ended',
        at: runtime?.endedAt ?? view?.lastActivityAt ?? now(),
      }
    }
    return {
      kind: 'event',
      text: 'No live signal yet',
      at: view?.lastActivityAt ?? now(),
    }
  }

  private statusDetail(
    status: SessionStatus,
    runtime: Runtime | null,
    view: TranscriptView | null,
    question: PendingQuestion | null,
    notification: NotificationState | null,
    job: BackgroundJob | null,
    live: LiveSession | null,
  ): string {
    if (status === 'waiting') {
      if (question) {
        return question.answerable
          ? 'Waiting for your answer'
          : question.source === 'hook'
            ? 'Question moved to the terminal'
            : 'Answer this question in the terminal'
      }
      if (notification) return notification.message
      if (job?.needs) return job.needs
      if (live?.waitingFor) {
        return live.waitingFor === 'permission prompt'
          ? 'Permission prompt — answer in the terminal'
          : `Waiting for ${live.waitingFor}`
      }
      if (job?.detail) return job.detail
      return 'Waiting for input'
    }
    if (status === 'working') {
      if (runtime?.toolName) {
        return runtime.toolText
          ? `${runtime.toolName}: ${oneLine(runtime.toolText, 80)}`
          : `Running ${runtime.toolName}`
      }
      if (view?.openToolUses && view.lastToolName) {
        return `Running ${view.lastToolName}`
      }
      if (runtime?.compactingAt && runtime.lastEventAt === runtime.compactingAt) {
        return 'Compacting context'
      }
      if (live && runtime?.working) return 'Working'
      return 'Working'
    }
    if (status === 'idle') {
      if (runtime?.stopAt) return 'Turn finished — ready for the next prompt'
      return 'Ready for the next prompt'
    }
    if (status === 'ended') {
      if (runtime?.endReason) return `Session ended (${runtime.endReason})`
      if (job?.state === 'done') return 'Background task finished'
      if (job?.state === 'failed') return 'Background task failed'
      if (job?.state === 'stopped') return 'Background task stopped'
      return 'Session closed'
    }
    return 'No live signal'
  }

  private recordFileTouch(sessionId: string, tool: string, input: unknown, at: number): void {
    const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : null
    const raw =
      typeof record?.file_path === 'string'
        ? record.file_path
        : typeof record?.notebook_path === 'string'
          ? record.notebook_path
          : null
    if (!raw) return
    const summary = this.summaries.get(sessionId)
    const cwd = summary?.projectPath || this.runtimes.get(sessionId)?.cwd || null
    const file = path.isAbsolute(raw)
      ? path.normalize(raw)
      : cwd
        ? path.normalize(path.resolve(cwd, raw))
        : null
    if (!file) return
    this.store.addFileTouches([
      { sessionId, path: file, at, tool, projectPath: summary?.projectPath ?? cwd ?? '' },
    ])

    const overlaps = this.store
      .overlaps(2 * 60 * MINUTE, at)
      .filter((overlap) => overlap.sessionIds.includes(sessionId))
    let notes = 0
    for (const overlap of overlaps) {
      if (notes >= 3) break
      const other = overlap.sessionIds.find((candidate) => candidate !== sessionId)
      if (!other) continue
      const key = `${sessionId}:${other}:${overlap.path}`
      if ((this.overlapNotes.get(key) ?? 0) > at) continue
      this.overlapNotes.set(key, at + OVERLAP_NOTE_TTL_MS)
      this.createSystemMessage(
        sessionId,
        overlapNote(overlap, this.summaries.get(other), sessionId),
        'note',
      )
      notes += 1
    }

    for (const claim of this.store.claimsConflictingWith(sessionId, [file])) {
      const key = `${sessionId}:${claim.sessionId}:${file}`
      if ((this.claimNotes.get(key) ?? 0) > at) continue
      this.claimNotes.set(key, at + OVERLAP_NOTE_TTL_MS)
      this.createSystemMessage(
        sessionId,
        claimConflictNote(file, claim, this.summaries.get(claim.sessionId)),
        'note',
      )
      notes += 1
      if (notes >= 4) break
    }
  }

  private createSystemMessage(
    toSessionId: string,
    body: string,
    kind: SessionMessage['kind'],
  ): SessionMessage {
    const message: SessionMessage = {
      id: `m_${randomUUID()}`,
      fromSessionId: null,
      fromName: 'Session manager',
      toSessionId,
      toName: this.summaries.get(toSessionId)?.title ?? null,
      body,
      kind,
      createdAt: now(),
      deliveries: {},
      readBy: {},
    }
    this.store.addMessage(message)
    this.onEvent({ type: 'message', message })
    this.scheduleRecompute(100)
    return message
  }

  private buildContext(sessionId: string, reason: 'start' | 'prompt'): string | null {
    const pending = this.store.pendingDeliveries(sessionId)
    const self = this.summaries.get(sessionId)
    const overlaps = this.store
      .overlaps(2 * 60 * MINUTE)
      .filter(
        (overlap) =>
          overlap.sessionIds.includes(sessionId) || overlap.claimedBy.includes(sessionId),
      )
    const claims = this.store.activeClaims()
    const context = buildInjectedContext({
      selfSessionId: sessionId,
      selfProjectPath: self?.projectPath ?? this.runtimes.get(sessionId)?.cwd ?? null,
      sessions: this.getSessions(),
      messages: pending,
      overlaps,
      claims,
      reason,
      pluginTools: true,
    })
    if (pending.length) {
      this.store.markDelivered(
        sessionId,
        pending.map((message) => message.id),
      )
      this.scheduleRecompute(150)
    }
    return context
  }

  /** Used by the doctor command and tests. */
  describeStatus(id: string): string {
    const summary = this.summaries.get(id)
    if (!summary) return 'unknown'
    const bits = [
      summary.status,
      summary.live ? 'live' : 'not live',
      summary.statusDetail,
      isoAt(summary.lastActivityAt),
    ]
    return bits.filter(Boolean).join(' · ')
  }
}
