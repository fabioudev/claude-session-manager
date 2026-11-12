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
  PreviewInput,
  PreviewLink,
  PreviewRegistration,
  PromptResult,
  PublicConfig,
  QuestionAnswerInput,
  RestartSessionResult,
  ResumeSessionResult,
  ServerEvent,
  SessionDetail,
  SessionMessage,
  SessionPatch,
  SessionStatus,
  SessionSummary,
  SessionTimeline,
  SessionUpdate,
  SettingsPatch,
  StopSessionResult,
  TokenUsage,
} from '../shared/types.js'
import type { AppConfig } from './config.js'
import { buildInjectedContext, claimConflictNote, overlapNote } from './coordination.js'
import { dispatchDecision, wakeDecision } from './dispatch.js'
import {
  makePreviewLink,
  normalizePreviewName,
  parsePreviewPort,
  previewUrl,
  resolvePreview,
} from './preview.js'
import { estimatedCostUsd, pricingForModel } from './pricing.js'
import { QuestionBroker, type QuestionResolution } from './questions.js'
import { type BackgroundJob, ClaudeRegistry, type LiveSession } from './registry.js'
import {
  buildRestartCommand,
  dropRootBlockedFlags,
  isDescendant,
  isExpectedForeground,
  isInteractiveShell,
  isShellCommand,
  launcherSpec,
  looksLikeAutoModeNotice,
  looksLikeTrustPrompt,
  processCommandNames,
  processEnvValue,
  readProcess,
  resolveLaunchSpec,
  restartSupported,
  shellQuote,
  transcriptStartDir,
  trustedFolders,
  waitFor,
} from './restart.js'
import type { StateStore } from './state-store.js'
import {
  capturePane,
  killSession,
  newSession,
  paneInfo,
  paneTarget,
  pasteText,
  resumeSessionName,
  sendEnter,
  sendText,
  sessionExists,
} from './tmux.js'
import { describeToolCall, questionsFromToolInput } from './transcript/parse.js'
import { TranscriptStore, type TranscriptView } from './transcript/store.js'
import { installedClaudeVersion, installedPluginVersion, isNewerVersion } from './updates.js'
import {
  cleanPrompt,
  expandHome,
  type GitInfo,
  getGitInfo,
  hashString,
  isoAt,
  MAX_MESSAGE_LENGTH,
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
const VERSION_REFRESH_MS = 5 * MINUTE
const AUTO_RESTART_TICK_MS = 30_000
const AUTO_RESTART_IDLE_MS = 3 * MINUTE
const AUTO_RESTART_SPACING_MS = 30_000
const RESTART_COOLDOWN_MS = 10 * MINUTE
/** Long enough that a notice dismissed twice is a real reappearance. */
const NOTICE_DISMISS_COOLDOWN_MS = 60_000
const RESTART_SHELL_TIMEOUT_MS = 15_000
const RESTART_START_TIMEOUT_MS = 10_000
const RESTART_STABLE_MS = 1_500
const RESUME_NAME_ATTEMPTS = 20
const RESUME_OUTPUT_LINES = 40
/** Long enough for Claude Code to paint either its trust dialog or its input box. */
const TRUST_PROMPT_TIMEOUT_MS = 8_000
const MAX_PROMPT_LENGTH = 20000
/**
 * A commander must dispatch, not execute. Bash would also let it curl the
 * manager API and bypass the plugin's tools, so it is denied as well.
 */
const COMMANDER_DISALLOWED_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task']
/** A tunnel address older than this is likely dead; only rules stay listed. */
const PREVIEW_URL_MAX_AGE_MS = 24 * 60 * MINUTE
const TRUST_PROMPT_NOTE =
  'Claude is waiting at its workspace trust prompt; answer it in the terminal.'

interface NotificationState {
  message: string
  type: string | null
  at: number
}

/**
 * Claude Code fires Notification("idle_prompt", "Claude is waiting for your
 * input") whenever a turn has finished and the terminal sits unattended. That is
 * the normal resting state of a live session — the exact moment a prompt from
 * the board can be typed — so it must not be treated like a permission prompt
 * that only the terminal can answer. Older payloads carry no type, hence the
 * message check as a fallback.
 */
export function isIdleNotification(notification: NotificationState): boolean {
  return notification.type === 'idle_prompt' || /waiting for your input/i.test(notification.message)
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
  orchestration?: {
    contextFor: (sessionId: string, reason: 'start' | 'prompt') => string | null
    /** The session id the command center currently treats as its commander. */
    commanderSessionId: () => string | null
    /** A worker that held open tasks went away; the commander should re-plan. */
    sessionEnded?: (sessionId: string) => void
    /**
     * A wake started a copy under a new session id; ownership has to follow it.
     */
    sessionReplaced?: (from: string, to: string) => void
    /**
     * A background session finished its turn. Messages that arrived while it
     * worked only sit in its inbox, and nothing wakes it again, so whoever
     * queues to it gets a chance to deliver now.
     */
    sessionIdle?: (sessionId: string) => void
  }
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
 * A `--resume` keeps the conversation's own saved options, and Claude Code
 * starts a copy instead as soon as flags arrive beside it. Launchers commonly
 * carry a default model, so those flags are dropped when resuming: the same
 * session id continues, with the model it was started with.
 */
function withoutResumeFlags(args: string[]): string[] {
  const kept: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (arg === '--model' || arg === '--permission-mode') {
      index += 1
      continue
    }
    if (arg.startsWith('--model=') || arg.startsWith('--permission-mode=')) continue
    kept.push(arg)
  }
  return kept
}

/** A launcher that only works with its model flag says so on stderr. */
function needsModelFlag(error: unknown): boolean {
  const err = error as { stderr?: string; stdout?: string; message?: string }
  const detail = `${err.stderr ?? ''}${err.stdout ?? ''}${err.message ?? ''}`
  return /model selection requires an interactive terminal/i.test(detail)
}

/**
 * Merges hook reports, transcripts, Claude Code's registries and background job
 * state into one live view of every session, and owns all mutations the UI can do.
 */
export class SessionManager {
  private readonly config: AppConfig
  private readonly store: StateStore
  private readonly onEvent: (event: ServerEvent) => void
  private readonly orchestration: SessionManagerOptions['orchestration']
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
  private versionTimer: NodeJS.Timeout | null = null
  private autoRestartTimer: NodeJS.Timeout | null = null
  private dialogTimer: NodeJS.Timeout | null = null
  private readonly dismissedNotices = new Map<string, number>()
  private recomputing = false
  private recomputeAgain = false
  private closed = false
  private lastHookAt = 0
  private lastAutoRestartAt = 0
  private installedClaude: string | null = null
  private installedPlugin: string | null = null
  private versionRefresh: Promise<void> | null = null
  private readonly restartCooldown = new Map<string, number>()
  private readonly restarting = new Map<string, Promise<RestartSessionResult>>()
  private readonly autoRestartHistory = new Map<string, { at: number; signature: string }>()
  private readonly resuming = new Set<string>()
  /**
   * Session id -> time it was stopped on purpose to resume it as a copy. Its
   * end is not a session ending: freeing its epics and nudging the commander
   * would be answered by a freshly spawned duplicate while the copy starts.
   */
  private readonly replacing = new Map<string, number>()
  /** session id -> pid whose launch command has already been captured. */
  private readonly launchCapturedFor = new Map<string, number>()

  constructor(
    config: AppConfig,
    store: StateStore,
    onEvent: (event: ServerEvent) => void,
    options: SessionManagerOptions = {},
  ) {
    this.config = config
    this.store = store
    this.onEvent = onEvent
    this.orchestration = options.orchestration
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
    this.versionTimer = setInterval(() => {
      void this.refreshInstalledVersions()
    }, VERSION_REFRESH_MS)
    this.versionTimer.unref?.()
    this.autoRestartTimer = setInterval(() => this.autoRestartTick(), AUTO_RESTART_TICK_MS)
    this.autoRestartTimer.unref?.()
    this.dialogTimer = setInterval(() => void this.dismissNoticesTick(), 15_000)
    this.dialogTimer.unref?.()
    void this.refreshInstalledVersions()
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
      sessionLauncher: settings.sessionLauncher,
      autoRestartSessions: settings.autoRestartSessions,
      previewRules: settings.previewRules,
      previewHosts: settings.previewHosts,
      previewZone: settings.previewZone,
      installedClaudeVersion: this.installedClaude,
      installedPluginVersion: this.installedPlugin,
      restartSupported: restartSupported(),
      serverStartedAt: this.startedAt,
      serverUrl: this.config.localUrl,
    }
  }

  updateSettings(patch: SettingsPatch): PublicConfig {
    const wasAutoRestarting = this.store.getSettings().autoRestartSessions
    const settings = this.store.updateSettings(patch)
    if (settings.questionMode === 'terminal') {
      for (const question of this.broker.pendingQuestions()) {
        this.broker.dismiss(question.id)
      }
    }
    if (patch.autoRestartSessions === true) {
      // Only re-arm the per-version guard when auto restart is switched on.
      // Every settings save carries the current value, so clearing on each
      // save would restart already-updated sessions again and again.
      if (!wasAutoRestarting) this.autoRestartHistory.clear()
      void this.refreshInstalledVersions()
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

  /** The label a session's preview gets when it does not name one. */
  private previewNameBase(id: string): string {
    const live = this.liveSession(id)
    const meta = this.store.getSessionMeta(id)
    const candidates = [
      live?.name,
      meta?.customTitle,
      live?.cwd ? path.basename(live.cwd) : null,
      shortId(id),
    ]
    for (const candidate of candidates) {
      const name = normalizePreviewName(candidate)
      if (name) return name
    }
    return 'preview'
  }

  /**
   * A session announces the port its dev server listens on. The router answers
   * for `<name>.<zone>` until the registration expires; asking again replaces
   * it and extends the deadline.
   */
  registerPreview(sessionId: string, input: PreviewInput): PreviewRegistration {
    if (!this.store.getSettings().previewZone) {
      throw new Error('No preview zone is configured. Set one in Settings first.')
    }
    const port = parsePreviewPort(input.port)
    if (!port) throw new Error('A preview port must be an integer between 1 and 65535.')
    const name = normalizePreviewName(input.name) ?? this.previewNameBase(sessionId)
    const ttlMinutes =
      typeof input.ttlMinutes === 'number' && Number.isFinite(input.ttlMinutes)
        ? input.ttlMinutes
        : undefined
    const registration = this.store.registerPreview(sessionId, {
      name,
      port,
      ttlMinutes,
      routes: input.routes,
    })
    this.scheduleRecompute(0)
    return registration
  }

  removePreview(sessionId: string): boolean {
    const removed = this.store.removePreview(sessionId)
    if (removed) this.scheduleRecompute(0)
    return removed
  }

  listPreviews(): PreviewRegistration[] {
    return this.store.activePreviews()
  }

  getPreviewZone(): string {
    return this.store.getSettings().previewZone
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
      activities: this.mergedActivities(id, view),
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
          if (isIdleNotification(runtime.notification)) void this.flushCommanderQueue(sessionId)
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
        // A worker that still holds open tasks cannot finish them now. Waking
        // the commander here is what makes "the commander handles it" true
        // without the human watching the board. A session the manager stopped
        // only to resume it is not done, though: its roles move to the copy.
        if (!this.isReplacing(sessionId)) this.orchestration?.sessionEnded?.(sessionId)
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
    if (body.length > MAX_MESSAGE_LENGTH)
      throw new Error(`Message body is too long (max ${MAX_MESSAGE_LENGTH} characters)`)
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

  /**
   * Gives a session something to do from the board. A live, idle session gets
   * the text typed into its own pane, so it starts working right away; anything
   * else goes to the inbox, which the session reads on its next turn.
   */
  async sendPrompt(id: string, text: string): Promise<PromptResult> {
    const body = text.trim()
    if (!body) return { ok: false, mode: 'queued', error: 'The task is empty.' }
    if (body.length > MAX_PROMPT_LENGTH) {
      return {
        ok: false,
        mode: 'queued',
        error: `The task is too long (max ${MAX_PROMPT_LENGTH}).`,
      }
    }
    const session = this.summaries.get(id)
    if (!session) return { ok: false, mode: 'queued', error: 'Unknown session.' }

    const queue = (note: string | null): PromptResult => {
      this.sendMessage({ body, toSessionId: id })
      return { ok: true, mode: 'queued', note }
    }
    const decision = dispatchDecision({
      session,
      working: Boolean(this.runtimes.get(id)?.working),
      hasQuestion: Boolean(session.question),
      supported: restartSupported(),
      launchEnabled: this.store.getSettings().launchEnabled,
      readOnly: this.config.readOnly,
    })
    if (decision.mode === 'queued') {
      // A background job never reads the inbox on its own, so queueing to one
      // would strand the message. Wake it instead.
      const woke = await this.wakeBackgroundSession(session, body)
      if (woke) return woke
      return queue(decision.reason)
    }

    const pane = paneTarget(session.tmux)
    if (!pane) return queue('This session has no tmux pane to type into.')
    const current = await paneInfo(pane)
    if (!current?.command || isShellCommand(current.command)) {
      return queue('The pane is at a shell, not in Claude Code.')
    }
    // Same rule as restart: keystrokes reach whatever holds the foreground, so
    // only type when Claude (or its wrapper) owns it.
    const allowed = session.pid ? await processCommandNames(session.pid) : new Set<string>()
    if (!isExpectedForeground(current.command, allowed)) {
      return queue('Another program is in the foreground of this pane.')
    }
    if (!(await pasteText(pane, body)) || !(await sendEnter(pane))) {
      return queue('The text could not be typed into the pane.')
    }
    this.store.recordActivities(id, [
      {
        id: `prompt:${randomUUID()}`,
        at: now(),
        kind: 'status',
        title: 'Task sent from the board',
        detail: truncate(body, 200),
      },
    ])
    this.scheduleRecompute(0)
    return { ok: true, mode: 'typed', tmux: session.tmux }
  }

  /**
   * A background session has no pane: keystrokes cannot reach it, and it never
   * reads its inbox on its own. Resuming it with the text is the way to hand it
   * work. `--bg --resume` keeps the conversation's id only while it is not
   * running, so a blocked job is stopped first; a job that may still be working
   * is left alone rather than copied.
   */
  private async wakeBackgroundSession(
    session: SessionSummary,
    body: string,
  ): Promise<PromptResult | null> {
    const job = this.jobFor(session.id)
    const blocked = Boolean(job?.blocked) || job?.state === 'blocked'
    const decision = wakeDecision({
      session,
      // A job waiting for an answer is stopped and resumed, exactly like one
      // whose state file already says "blocked".
      backgroundState: blocked ? 'blocked' : (job?.state ?? null),
      backgroundExited: job?.exited ?? false,
      hasQuestion: Boolean(session.question),
      // An expired question has no terminal window left: on a background session
      // that window never existed, so the guard must not hold the prompt back.
      questionExpired: Boolean(session.question && !session.question.answerable),
      supported: restartSupported(),
      launchEnabled: this.store.getSettings().launchEnabled,
      readOnly: this.config.readOnly,
    })
    if (!decision.wake || !job) return null
    if (decision.stop) {
      // The kill is ours, not the session's end: keep the epic and task roles
      // where they are so the copy inherits them instead of the commander.
      this.replacing.set(session.id, now())
      const stopped = await this.stopSession(session.id)
      if (!stopped.ok) {
        this.replacing.delete(session.id)
        return null
      }
    }
    const result = await this.launchSession({
      cwd: session.projectPath || session.repoRoot || process.cwd(),
      prompt: body,
      resumeSessionId: session.id,
    })
    if (!result.ok) {
      // Nothing continues this conversation now, so its end is real after all.
      this.replacing.delete(session.id)
      this.scheduleRecompute(0)
      return {
        ok: false,
        mode: 'queued',
        error: result.error ?? 'The background session could not be woken.',
      }
    }
    this.store.recordActivities(session.id, [
      {
        id: `wake:${randomUUID()}`,
        at: now(),
        kind: 'status',
        title: 'Woke the background session',
        detail: truncate(body, 200),
      },
    ])
    this.scheduleRecompute(0)
    const copy = result.sessionId && result.sessionId !== session.id ? result.sessionId : null
    // Claude Code started a copy instead of continuing this conversation, so
    // the copy is where the work now happens. Move the epic/task/commander
    // roles over instead of leaving them on a session nobody is running.
    if (copy) this.orchestration?.sessionReplaced?.(session.id, copy)
    return {
      ok: true,
      mode: 'typed',
      note: copy
        ? `Woke a copy of the background session (${copy}) because the original kept its own options.`
        : 'Woke the background session with this text.',
    }
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
    // An untrusted folder would stop at Claude Code's trust dialog instead of
    // doing the work; start in the nearest trusted parent instead.
    const launchCwd = await this.launchCwd(cwd)
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

    // Start through the configured launcher, so a wrapper that carries auth or
    // a default model (an Ollama launch, an env prefix) works here too.
    const launcher = dropRootBlockedFlags(launcherSpec(settings.sessionLauncher, launchCwd)).spec
      .prefix
    const bin = launcher[0] ?? this.claudeBin
    const launcherArgs = input.resumeSessionId
      ? withoutResumeFlags(launcher.slice(1))
      : launcher.slice(1)
    const strippedFlags =
      input.resumeSessionId !== undefined && launcherArgs.length !== launcher.slice(1).length

    const startedAt = now()
    const execOptions = {
      cwd: launchCwd,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env,
      windowsHide: true,
    }
    // A launcher that picks the model through its own flag (an Ollama launch)
    // refuses to start once that flag is gone. Retry with the full prefix then;
    // the resume becomes a copy, and sessionReplaced moves the roles over.
    const run = async (): Promise<{ stdout: string; stderr: string }> => {
      try {
        return await execFileAsync(bin, [...launcherArgs, ...args], execOptions)
      } catch (error) {
        if (!strippedFlags || !needsModelFlag(error)) throw error
        return execFileAsync(bin, [...launcher.slice(1), ...args], execOptions)
      }
    }
    try {
      const { stdout, stderr } = await run()
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
              candidate.cwd === launchCwd &&
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

  /**
   * A fresh session in a folder Claude Code has not been trusted for stops at
   * its safety prompt and never runs. The parent project is usually trusted
   * and still lets the session work in the subfolder, so walk up to the nearest
   * trusted folder instead of failing the launch.
   */
  private async launchCwd(wanted: string): Promise<string> {
    const trusted = await trustedFolders(this.config.claudeDir)
    if (!trusted) return wanted
    let dir = wanted
    while (!trusted.has(dir)) {
      const parent = path.dirname(dir)
      if (parent === dir) return wanted
      dir = parent
    }
    return dir
  }

  /**
   * The board remembers the project a session last worked in, but Claude Code
   * only works in folders it has been trusted for, and its trust dialog
   * defaults to "No, exit". Resuming there would end the session the moment
   * the first prompt arrives, so an untrusted folder falls back to the one
   * that owns the transcript.
   */
  private async resumeCwd(sessionId: string, wanted: string): Promise<string> {
    const trusted = await trustedFolders(this.config.claudeDir)
    if (!trusted || trusted.has(wanted)) return wanted
    const file = this.transcripts.pathFor(sessionId)
    const owner = file ? await transcriptStartDir(file) : null
    return owner && trusted.has(owner) ? owner : wanted
  }

  /**
   * Launches the commander as an interactive session in its own tmux pane.
   *
   * Background jobs are wrong for this job twice over: they cannot take typed
   * input (an inbox message waits for a turn that never comes), and the daemon
   * that owns them dies with this service's process group. A tmux pane survives
   * both, and `sendPrompt` can type into it like with every other session.
   */
  async launchCommanderSession(input: LaunchSessionInput): Promise<LaunchSessionResult> {
    const settings = this.store.getSettings()
    if (this.config.readOnly) return { ok: false, error: 'read-only mode' }
    if (!settings.launchEnabled) return { ok: false, error: 'Launching sessions is disabled' }
    if (!restartSupported()) {
      return { ok: false, error: 'Launching sessions in tmux is only supported on Linux.' }
    }
    const prompt = input.prompt?.trim()
    if (!prompt) return { ok: false, error: 'Prompt must not be empty' }
    if (prompt.length > 40_000) return { ok: false, error: 'Prompt is too long' }
    if (input.resumeSessionId && !/^[0-9a-zA-Z_-]{8,80}$/.test(input.resumeSessionId)) {
      return { ok: false, error: 'Invalid session id' }
    }
    const wanted = path.resolve(expandHome(input.cwd?.trim() || process.cwd()))
    // A resume must land in a folder Claude Code is allowed to work in, or the
    // trust dialog swallows the first prompt and ends the session.
    const cwd = input.resumeSessionId
      ? await this.resumeCwd(input.resumeSessionId, wanted)
      : await this.launchCwd(wanted)
    try {
      if (!(await stat(cwd)).isDirectory()) {
        return { ok: false, error: 'Working directory is not a directory' }
      }
    } catch {
      return { ok: false, error: 'Working directory does not exist' }
    }

    // Run through the configured launcher, so a wrapper that carries auth or a
    // default model works here too.
    const spec = dropRootBlockedFlags(launcherSpec(settings.sessionLauncher, cwd)).spec
    const argv = [...spec.prefix, ...spec.args]
    if (input.resumeSessionId) argv.push('--resume', input.resumeSessionId)
    else if (input.name?.trim()) argv.push('--name', input.name.trim().slice(0, 80))
    // The commander dispatches and verifies. Denying the tools that execute
    // work keeps it from becoming a second worker: it must delegate instead of
    // editing files, running commands or spawning subagents itself.
    argv.push('--disallowedTools', COMMANDER_DISALLOWED_TOOLS.join(','))
    const command = spec.cwd
      ? `cd ${shellQuote(spec.cwd)} && ${argv.map(shellQuote).join(' ')}`
      : argv.map(shellQuote).join(' ')

    let created: { name: string; pane: string } | null = null
    for (let attempt = 1; attempt <= RESUME_NAME_ATTEMPTS && !created; attempt += 1) {
      const name = input.resumeSessionId
        ? resumeSessionName(input.resumeSessionId.slice(0, 8), attempt)
        : `csm-commander${attempt > 1 ? `-${attempt}` : ''}`
      if (await sessionExists(name)) continue
      const pane = await newSession(name, cwd)
      if (pane) created = { name, pane }
    }
    if (!created) {
      return { ok: false, error: 'Could not create a tmux session for the commander.' }
    }
    const { name, pane } = created
    const fail = async (message: string): Promise<LaunchSessionResult> => {
      const output = await capturePane(pane, RESUME_OUTPUT_LINES)
      await killSession(name)
      const tail = (output ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-3)
        .join(' ')
      return { ok: false, error: tail ? `${message} (${tail})` : message }
    }
    if (!(await sendText(pane, command)) || !(await sendEnter(pane))) {
      return await fail('Could not type the launch command into the new tmux pane.')
    }
    const started = await waitFor(async () => {
      const current = await paneInfo(pane)
      return Boolean(current?.command && !isShellCommand(current.command))
    }, RESTART_START_TIMEOUT_MS)
    if (!started) return await fail('Claude Code did not start in the new tmux pane.')
    await new Promise((resolve) => setTimeout(resolve, RESTART_STABLE_MS))
    const settled = await paneInfo(pane)
    if (!settled?.command || isShellCommand(settled.command)) {
      return await fail('Claude Code exited right after starting.')
    }
    // The trust dialog renders a moment after the process starts. Typing
    // before it is on screen sends the prompt into it, and its default answer
    // ("No, exit") ends the session instead of starting it — so wait for
    // either the dialog or the input box before pasting anything.
    let settling = ''
    const ready = await waitFor(async () => {
      settling = (await capturePane(pane, RESUME_OUTPUT_LINES)) ?? ''
      return looksLikeTrustPrompt(settling) || settling.includes('❯')
    }, TRUST_PROMPT_TIMEOUT_MS)
    if (ready && looksLikeTrustPrompt(settling)) {
      return { ok: true, output: TRUST_PROMPT_NOTE }
    }
    if (!(await this.submitPrompt(pane, prompt))) {
      return await fail('Could not send the command to the commander pane.')
    }

    // A fresh launch registers its session a moment later; find it by its pane.
    let sessionId = input.resumeSessionId ?? null
    const deadline = Date.now() + RESTART_START_TIMEOUT_MS
    while (!sessionId && Date.now() < deadline) {
      await this.registry.refresh()
      sessionId =
        this.registry.getSnapshot().sessions.find((live) => live.tmux?.startsWith(`${name}:`))
          ?.sessionId ?? null
      if (!sessionId) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    this.scheduleRecompute(0)
    return {
      ok: true,
      sessionId: sessionId ?? undefined,
      output: truncate(`tmux ${name}`, 200),
    }
  }

  /**
   * Pastes text into a Claude pane and submits it. A long paste can take a
   * moment to register, so the first Enter may arrive too early and leave the
   * text sitting in the input box; when that happened, press Enter again.
   */
  private async submitPrompt(pane: string, text: string): Promise<boolean> {
    if (!(await pasteText(pane, text))) return false
    await new Promise((resolve) => setTimeout(resolve, 300))
    if (!(await sendEnter(pane))) return false
    await new Promise((resolve) => setTimeout(resolve, 600))
    const output = (await capturePane(pane, 6)) ?? ''
    const lastPrompt = output
      .split('\n')
      .map((line) => line.trim())
      .reverse()
      .find((line) => line.startsWith('❯'))
    if (lastPrompt && lastPrompt !== '❯') await sendEnter(pane)
    return true
  }

  /**
   * Queued prompts wait for a session's next turn, and nothing would ever
   * start one. The commander belongs to this board, so when it comes to rest
   * the board types the queued human commands itself.
   */
  private async flushCommanderQueue(sessionId: string): Promise<void> {
    if (this.orchestration?.commanderSessionId() !== sessionId) return
    const pending = this.store
      .pendingDeliveries(sessionId)
      .filter((message) => message.fromSessionId === null)
    if (!pending.length) return
    const tmux =
      this.summaries.get(sessionId)?.tmux ??
      this.registry.getSnapshot().sessions.find((live) => live.sessionId === sessionId)?.tmux ??
      null
    const pane = paneTarget(tmux)
    if (!pane) return
    const ids = pending.map((message) => message.id)
    // Mark first: the prompt hook would otherwise inject the same text again.
    this.store.markDelivered(sessionId, ids)
    const typed = await this.submitPrompt(pane, pending.map((message) => message.body).join('\n\n'))
    if (!typed) {
      this.store.unmarkDelivered(sessionId, ids)
      return
    }
    this.store.recordActivities(sessionId, [
      {
        id: `flush:${randomUUID()}`,
        at: now(),
        kind: 'status',
        title: 'Delivered queued commands',
        detail: truncate(pending.map((message) => message.body).join(' | '), 200),
      },
    ])
    this.scheduleRecompute(0)
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

  /**
   * Exits an idle interactive session in its tmux pane and starts it again with
   * `--resume`, so the same conversation and session id continue under the
   * newly installed Claude Code and plugin. Nothing is sent to a session that
   * is working, waiting for an answer, or not in a tmux pane.
   */
  async restartSession(
    id: string,
    options: { auto?: boolean } = {},
  ): Promise<RestartSessionResult> {
    const running = this.restarting.get(id)
    if (running) return running
    const auto = options.auto === true
    const task = this.performRestart(id, auto)
      .catch(() => ({
        ok: false,
        error: 'The restart failed unexpectedly. The terminal was not touched further.',
      }))
      .finally(() => {
        this.restarting.delete(id)
      })
    this.restarting.set(id, task)
    return task
  }

  private async performRestart(id: string, auto: boolean): Promise<RestartSessionResult> {
    if (this.config.readOnly) return { ok: false, error: 'Read-only mode.' }
    if (!restartSupported()) {
      return { ok: false, error: 'Restarting sessions in place is only supported on Linux.' }
    }
    const session = this.summaries.get(id)
    if (!session) return { ok: false, error: 'Unknown session.' }
    if (!session.live || !session.pid) {
      return { ok: false, error: 'This session is not attached to a running process.' }
    }
    if (session.kind !== 'interactive') {
      return { ok: false, error: 'Only interactive sessions can be restarted from the board.' }
    }
    if (!session.tmux) {
      return {
        ok: false,
        error: 'This session is not running in tmux. Restart it in its terminal.',
      }
    }
    if (session.question || session.status === 'waiting') {
      return {
        ok: false,
        error: 'The session is waiting for input. Answer or dismiss the prompt first.',
      }
    }
    // The summary map is rebuilt in the background and can lag behind the hook
    // stream; the runtime is updated synchronously in handleHook. Trust it over
    // the summary, otherwise a prompt submitted a moment ago could still be
    // typed over with /exit.
    if (this.runtimes.get(id)?.working) {
      return { ok: false, error: 'The session is mid-turn. Restart it once the turn finishes.' }
    }
    if (session.status !== 'idle') {
      return { ok: false, error: 'The session is mid-turn. Restart it once the turn finishes.' }
    }

    const at = now()
    if ((this.restartCooldown.get(id) ?? 0) > at) {
      return {
        ok: false,
        error: 'This session was restarted moments ago. Give it time to report back.',
      }
    }

    if (auto) {
      const stale =
        isNewerVersion(this.installedClaude, session.version) ||
        isNewerVersion(this.installedPlugin, session.pluginVersion)
      if (!stale) return { ok: false, error: 'No newer version is installed.' }
      if (at - session.lastActivityAt < AUTO_RESTART_IDLE_MS) {
        return { ok: false, error: 'The session was active too recently.' }
      }
      const history = this.autoRestartHistory.get(id)
      const signature = this.updateSignature()
      if (history?.signature === signature) {
        return { ok: false, error: 'This session was already restarted for this version.' }
      }
    }

    // `--resume` fails with "No conversation found" for a session that has not
    // written a transcript yet. Exiting such a session would leave only a
    // shell behind, so refuse before touching the pane.
    if (!this.transcripts.has(id) && !(await this.transcripts.ensureLoaded(id))) {
      return {
        ok: false,
        error: 'This session has no conversation to resume yet. Send a prompt first.',
      }
    }

    const pane = paneTarget(session.tmux)
    if (!pane) return { ok: false, error: 'The tmux pane could not be identified.' }
    const paneState = await paneInfo(pane)
    if (!paneState) return { ok: false, error: 'The tmux pane is no longer reachable.' }
    if (paneState.pid && !(await isDescendant(session.pid, paneState.pid))) {
      return { ok: false, error: 'The tmux pane no longer belongs to this session.' }
    }
    if (isShellCommand(paneState.command)) {
      return { ok: false, error: 'The Claude Code process already exited in this pane.' }
    }
    // The restart types a command into the pane after Claude exits, so a shell
    // has to remain there. A pane that was started with the wrapper as its
    // command would vanish instead.
    const paneProcess = paneState.pid ? await readProcess(paneState.pid) : null
    if (!paneProcess || !isInteractiveShell(paneProcess.argv)) {
      return {
        ok: false,
        error:
          'This tmux pane runs Claude Code without an interactive shell underneath. Start the session from a shell to restart it from here.',
      }
    }
    // Keystrokes reach whatever holds the foreground, not necessarily Claude:
    // a Ctrl-Z'd session with an editor on top would get "/exit" typed into the
    // editor. Only proceed when the session's own process (or its wrapper) owns
    // the foreground.
    const allowedCommands = await processCommandNames(session.pid)
    if (!isExpectedForeground(paneState.command, allowedCommands)) {
      return {
        ok: false,
        error:
          'Another program is in the foreground of this tmux pane. Return to Claude Code and try again.',
      }
    }

    const launch = await resolveLaunchSpec(session.pid, session.projectPath || null)
    if (!launch.spec) {
      return {
        ok: false,
        error: launch.error ?? 'Could not reconstruct the command that started this session.',
      }
    }
    // The pane's shell, not the daemon, decides whether the flag is legal here.
    const sandbox = paneState.pid ? await processEnvValue(paneState.pid, 'IS_SANDBOX') : null
    const rebuilt = dropRootBlockedFlags(launch.spec, {
      ...process.env,
      ...(sandbox !== null ? { IS_SANDBOX: sandbox } : {}),
    })
    const command = buildRestartCommand(rebuilt.spec, session.id)
    const droppedNote = rebuilt.dropped.length
      ? ' Left out --dangerously-skip-permissions, which Claude Code refuses under root.'
      : ''

    // A person may have submitted a prompt while the process was being read.
    const latest = this.summaries.get(id)
    if (this.runtimes.get(id)?.working || latest?.status !== 'idle' || latest.question) {
      return { ok: false, error: 'The session started working. Try again when it is idle.' }
    }

    if (!(await sendText(pane, '/exit'))) {
      return { ok: false, error: 'Could not type into the tmux pane.' }
    }
    if (!(await sendEnter(pane))) {
      return { ok: false, error: 'Could not press Enter in the tmux pane.' }
    }
    const returned = await waitFor(async () => {
      const current = await paneInfo(pane)
      return Boolean(current?.command && isShellCommand(current.command))
    }, RESTART_SHELL_TIMEOUT_MS)
    if (!returned) {
      return {
        ok: false,
        error:
          'The session did not return to a shell. It may be waiting at a prompt; nothing was relaunched.',
      }
    }

    if (!(await sendText(pane, command))) {
      return { ok: false, error: 'Could not type the restart command into the tmux pane.' }
    }
    if (!(await sendEnter(pane))) {
      return { ok: false, error: 'Could not press Enter for the restart command.' }
    }
    const started = await waitFor(async () => {
      const current = await paneInfo(pane)
      return Boolean(current?.command && !isShellCommand(current.command))
    }, RESTART_START_TIMEOUT_MS)
    if (!started) {
      return {
        ok: false,
        error:
          'The restart command was typed but Claude Code did not start. Check the terminal for an error.',
      }
    }
    // A crash on startup also looks like "the process is running" for a moment.
    // Make sure Claude Code stays up before reporting success.
    await new Promise((resolve) => setTimeout(resolve, RESTART_STABLE_MS))
    const settled = await paneInfo(pane)
    if (!settled?.command || isShellCommand(settled.command)) {
      return {
        ok: false,
        error:
          'Claude Code exited right after the restart command. Check the terminal for an error.',
      }
    }

    const finishedAt = now()
    this.restartCooldown.set(id, finishedAt + RESTART_COOLDOWN_MS)
    if (auto) {
      this.autoRestartHistory.set(id, {
        at: finishedAt,
        signature: this.updateSignature(),
      })
    }
    const detail = this.updateDetail(session)
    this.store.recordActivities(id, [
      {
        id: `restart:${randomUUID()}`,
        at: finishedAt,
        kind: 'status',
        title: detail ? 'Restarted to load an installed update' : 'Session restarted',
        detail: detail ?? undefined,
      },
    ])
    this.scheduleRecompute(0)
    return {
      ok: true,
      output: `${detail ? `Restarted. ${detail}.` : 'Restarted the session.'}${droppedNote.trim()}`,
    }
  }

  /**
   * Starts an ended session again in a new tmux session with `--resume`, using
   * the command that originally started it. That command is captured while the
   * session is live, because a wrapper (an Ollama launch, an env prefix) can
   * carry the authentication and model flags a plain `claude` would lack. A
   * session the daemon never saw live reuses the launcher from the settings,
   * which defaults to `claude`.
   */
  async resumeSession(id: string): Promise<ResumeSessionResult> {
    if (this.config.readOnly) return { ok: false, error: 'Read-only mode.' }
    if (!restartSupported()) {
      return { ok: false, error: 'Resuming sessions in tmux is only supported on Linux.' }
    }
    if (!this.store.getSettings().launchEnabled) {
      return { ok: false, error: 'Launching sessions is disabled in the settings.' }
    }
    const session = this.summaries.get(id)
    if (!session) return { ok: false, error: 'Unknown session.' }
    const liveNow = this.registry.getSnapshot().sessions.some((live) => live.sessionId === id)
    if (session.live || liveNow) {
      return { ok: false, error: 'This session is still running. Use Restart to load an update.' }
    }
    if (this.resuming.has(id)) {
      return { ok: false, error: 'This session is already being resumed.' }
    }
    // Prefer the command captured while the session ran: it carries the
    // wrapper, model and auth flags. Sessions the daemon only ever saw in a
    // transcript fall back to the launcher configured in the settings.
    const spec =
      this.store.getLaunchSpec(id) ??
      launcherSpec(
        this.store.getSettings().sessionLauncher,
        session.projectPath || session.repoRoot || null,
      )
    if (!this.transcripts.has(id) && !(await this.transcripts.ensureLoaded(id))) {
      return { ok: false, error: 'This session has no conversation to resume.' }
    }
    const wanted = spec.cwd ?? (session.projectPath || null)
    // Same guard as the commander: a resume in a folder Claude Code has not
    // been trusted for stops at its safety prompt and never runs.
    const cwd = wanted ? await this.resumeCwd(id, wanted) : null

    this.resuming.add(id)
    try {
      let created: { name: string; pane: string } | null = null
      for (let attempt = 1; attempt <= RESUME_NAME_ATTEMPTS && !created; attempt += 1) {
        const name = resumeSessionName(session.shortId, attempt)
        if (await sessionExists(name)) continue
        const pane = await newSession(name, cwd)
        if (pane) created = { name, pane }
      }
      if (!created) {
        return { ok: false, error: 'Could not create a tmux session for the resume.' }
      }
      const { name, pane } = created
      // A new pane inherits the tmux server's env, not the daemon's. That decides
      // whether the captured permission flag is legal here.
      const shellPid = (await paneInfo(pane))?.pid ?? null
      const sandbox = shellPid ? await processEnvValue(shellPid, 'IS_SANDBOX') : null
      const rebuilt = dropRootBlockedFlags(
        { ...spec, cwd },
        {
          ...process.env,
          ...(sandbox !== null ? { IS_SANDBOX: sandbox } : {}),
        },
      )
      const command = buildRestartCommand(rebuilt.spec, id)
      const droppedNote = rebuilt.dropped.length
        ? ' Left out --dangerously-skip-permissions, which Claude Code refuses under root.'
        : ''
      const fail = async (message: string): Promise<ResumeSessionResult> => {
        const output = await capturePane(pane, RESUME_OUTPUT_LINES)
        await killSession(name)
        const tail = (output ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-3)
          .join(' ')
        return { ok: false, error: tail ? `${message} (${tail})` : message }
      }
      if (!(await sendText(pane, command))) {
        return await fail('Could not type the resume command into the new tmux pane.')
      }
      if (!(await sendEnter(pane))) {
        return await fail('Could not press Enter in the new tmux pane.')
      }
      const started = await waitFor(async () => {
        const current = await paneInfo(pane)
        return Boolean(current?.command && !isShellCommand(current.command))
      }, RESTART_START_TIMEOUT_MS)
      if (!started) {
        return await fail('Claude Code did not start in the new tmux pane.')
      }
      await new Promise((resolve) => setTimeout(resolve, RESTART_STABLE_MS))
      const settled = await paneInfo(pane)
      if (!settled?.command || isShellCommand(settled.command)) {
        return await fail('Claude Code exited right after starting.')
      }
      // An untrusted workspace stops Claude at its safety prompt. Only the
      // person can answer that, so say where the session is stuck instead of
      // reporting a clean start.
      const trustPrompt = looksLikeTrustPrompt((await capturePane(pane, RESUME_OUTPUT_LINES)) ?? '')
      const note = trustPrompt ? TRUST_PROMPT_NOTE : undefined

      this.store.recordActivities(id, [
        {
          id: `resume:${randomUUID()}`,
          at: now(),
          kind: 'status',
          title: 'Session resumed in a new tmux session',
          detail: `tmux ${name}${droppedNote}${note ? ` ${note}` : ''}`,
        },
      ])
      void this.registry.refresh().finally(() => this.scheduleRecompute(0))
      this.scheduleRecompute(0)
      return { ok: true, tmux: name, ...(note ? { note } : {}) }
    } finally {
      this.resuming.delete(id)
    }
  }

  /**
   * Remembers how a live session was launched, so it can be resumed after it
   * ends. Reading /proc happens once per process, not on every recompute.
   */
  private captureLaunchSpec(session: SessionSummary): void {
    if (!session.live || !session.pid || session.kind !== 'interactive') return
    if (this.launchCapturedFor.get(session.id) === session.pid) return
    this.launchCapturedFor.set(session.id, session.pid)
    void resolveLaunchSpec(session.pid, session.projectPath || null).then((launch) => {
      if (launch.spec) this.store.setLaunchSpec(session.id, launch.spec)
    })
  }

  private updateSignature(): string {
    return `${this.installedClaude ?? '-'}|${this.installedPlugin ?? '-'}`
  }

  private sessionUpdate(input: {
    version: string | null
    pluginVersion: string | null
    status: SessionStatus
    question: PendingQuestion | null
    live: LiveSession | null
    liveFlag: boolean
    job: BackgroundJob | null
  }): SessionUpdate {
    const claude = isNewerVersion(this.installedClaude, input.version)
    const plugin = isNewerVersion(this.installedPlugin, input.pluginVersion)
    const restartable =
      !this.config.readOnly &&
      restartSupported() &&
      input.liveFlag &&
      input.live?.kind === 'interactive' &&
      Boolean(input.live?.pid) &&
      Boolean(input.live?.tmux) &&
      !input.job &&
      input.status === 'idle' &&
      !input.question
    return { available: claude || plugin, claude, plugin, restartable }
  }

  private updateDetail(session: SessionSummary): string | null {
    const parts: string[] = []
    if (isNewerVersion(this.installedClaude, session.version)) {
      parts.push(`Claude Code ${session.version ?? 'unknown'} → ${this.installedClaude}`)
    }
    if (isNewerVersion(this.installedPlugin, session.pluginVersion)) {
      parts.push(`plugin ${session.pluginVersion ?? 'unknown'} → ${this.installedPlugin}`)
    }
    return parts.join(', ') || null
  }

  private autoRestartTick(): void {
    if (this.closed) return
    const settings = this.store.getSettings()
    if (this.config.readOnly || !settings.autoRestartSessions || !restartSupported()) return
    const at = now()
    if (at - this.lastAutoRestartAt < AUTO_RESTART_SPACING_MS) return
    const signature = this.updateSignature()
    const candidates = [...this.summaries.values()].filter((session) => {
      if (!session.update.available || !session.update.restartable) return false
      if (!session.live || session.kind !== 'interactive' || !session.tmux || !session.pid) {
        return false
      }
      if (session.status !== 'idle' || session.question) return false
      if (this.runtimes.get(session.id)?.working) return false
      if (at - session.lastActivityAt < AUTO_RESTART_IDLE_MS) return false
      if ((this.restartCooldown.get(session.id) ?? 0) > at) return false
      const history = this.autoRestartHistory.get(session.id)
      if (history?.signature === signature) return false
      return true
    })
    if (!candidates.length) return
    candidates.sort((left, right) => left.lastActivityAt - right.lastActivityAt)
    const target = candidates[0]
    if (!target) return
    this.lastAutoRestartAt = at
    void this.restartSession(target.id, { auto: true })
      .then((result) => {
        if (!result.ok) this.restartCooldown.set(target.id, now() + RESTART_COOLDOWN_MS)
      })
      .catch(() => {
        this.restartCooldown.set(target.id, now() + RESTART_COOLDOWN_MS)
      })
  }

  /**
   * Claude Code shows an informational notice on startup (the auto-mode
   * classifier bill) that halts the whole session until Enter is pressed. It is
   * not about the work being done, so the board clears it instead of leaving a
   * session that looks alive but never continues.
   */
  private async dismissNoticesTick(): Promise<void> {
    if (this.closed) return
    if (this.config.readOnly || !restartSupported()) return
    const at = now()
    for (const live of this.registry.getSnapshot().sessions) {
      if (!live.alive || !live.tmux || !live.waitingFor) continue
      if (!/dialog/i.test(live.waitingFor)) continue
      if (at - (this.dismissedNotices.get(live.sessionId) ?? 0) < NOTICE_DISMISS_COOLDOWN_MS)
        continue
      const pane = paneTarget(live.tmux)
      if (!pane) continue
      const text = await capturePane(pane, 40)
      if (!text || !looksLikeAutoModeNotice(text)) continue
      if (!(await sendEnter(pane))) continue
      this.dismissedNotices.set(live.sessionId, at)
      this.store.recordActivities(live.sessionId, [
        {
          id: `notice:${randomUUID()}`,
          at,
          kind: 'status',
          title: 'Dismissed the auto-mode billing notice',
          detail: 'The session was held at an informational notice; Enter resumed it.',
        },
      ])
      this.scheduleRecompute(300)
    }
  }

  private refreshInstalledVersions(): Promise<void> {
    if (this.versionRefresh) return this.versionRefresh
    const task = (async () => {
      const [claude, plugin] = await Promise.all([
        installedClaudeVersion(this.claudeBin),
        installedPluginVersion(this.config.claudeDir),
      ])
      if (this.closed) return
      const changed = claude !== this.installedClaude || plugin !== this.installedPlugin
      this.installedClaude = claude
      this.installedPlugin = plugin
      if (changed) {
        this.onEvent({ type: 'config', config: this.getPublicConfig() })
        this.scheduleRecompute(0)
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        this.versionRefresh = null
      })
    this.versionRefresh = task
    return task
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
    if (this.versionTimer) {
      clearInterval(this.versionTimer)
      this.versionTimer = null
    }
    if (this.autoRestartTimer) {
      clearInterval(this.autoRestartTimer)
      this.autoRestartTimer = null
    }
    if (this.dialogTimer) {
      clearInterval(this.dialogTimer)
      this.dialogTimer = null
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
    const wentIdle: string[] = []
    for (const id of ids) {
      const view = views.get(id) ?? null
      const live = liveBySession.get(id) ?? null
      const job = jobsBySession.get(id) ?? null
      const runtime = this.runtimes.get(id) ?? null
      if (!view && !live && !job && !runtime) continue
      if (runtime && at - runtime.lastHookAt >= 7 * DAY) continue
      const summary = await this.buildSummary(id, view, live, job, runtime, at, overlaps)
      this.captureLaunchSpec(summary)
      next.set(id, summary)
      // A background job that stopped working cannot pick up its inbox by
      // itself. A blocked job is left alone: someone is expected at its dialog.
      const previous = this.summaries.get(id)
      if (
        previous?.live &&
        !summary.live &&
        summary.kind === 'background' &&
        summary.backgroundState !== 'blocked'
      ) {
        wentIdle.push(id)
      }
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

    for (const id of wentIdle) this.orchestration?.sessionIdle?.(id)

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

  /**
   * Transcript activities are authoritative; the store only holds events the
   * daemon itself made, such as a restart. Merge those in so they are visible.
   */
  private mergedActivities(id: string, view: TranscriptView | null): ActivityEvent[] {
    const transcript = view?.activities ?? []
    const stored = this.store.activitiesFor(id)
    if (!stored.length) return transcript
    const known = new Set(transcript.map((event) => event.id))
    const extra = stored.filter((event) => !known.has(event.id))
    if (!extra.length) return transcript
    return [...transcript, ...extra].sort((a, b) => a.at - b.at)
  }

  private jobFor(id: string): BackgroundJob | null {
    return this.registry.getSnapshot().jobs.find((job) => job.sessionId === id) ?? null
  }

  /** Was this session stopped in order to resume it as a copy, just now? */
  private isReplacing(id: string): boolean {
    const at = this.replacing.get(id)
    if (at === undefined) return false
    return now() - at < 2 * MINUTE
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

    const jobWorking = job?.state === 'working' && !job?.exited && !job?.blocked
    const jobBlocked = !job?.exited && (job?.state === 'blocked' || Boolean(job?.blocked))
    const jobFinished =
      job?.exited || job?.state === 'done' || job?.state === 'failed' || job?.state === 'stopped'
    const liveFlag = Boolean(live) || jobWorking
    const notification = runtime?.notification ?? null
    const notificationWaiting =
      notification !== null && !runtime?.working && !isIdleNotification(notification)

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
    const preview = this.previewFor(id, view, projectPath, git)

    const titleCandidate = this.pickTitle(id, view, live, job, meta?.customTitle ?? null)
    const mission = this.sessionMission(id, view, live, job, meta?.customTitle ?? null)
    const task =
      runtime?.prompt ??
      view?.lastPrompt ??
      (job?.intent ? cleanPrompt(job.intent) : null) ??
      view?.summary ??
      null

    const version = live?.version ?? view?.version ?? null
    const pluginVersion = runtime?.pluginVersion ?? null
    const update = this.sessionUpdate({
      version,
      pluginVersion,
      status,
      question,
      live,
      liveFlag,
      job,
    })
    const tokens = this.tokenUsage(view, model)
    // Resuming replays the captured launcher when there is one and otherwise
    // the launcher from the settings, so a plain transcript-only session can
    // be resumed too. The UI says which of the two it will use.
    const resumeAllowed =
      !liveFlag &&
      !job &&
      !this.config.readOnly &&
      restartSupported() &&
      this.store.getSettings().launchEnabled &&
      (this.transcripts.has(id) || Boolean(view))
    const resumableVia: 'captured' | 'launcher' | null = resumeAllowed
      ? this.store.getLaunchSpec(id)
        ? 'captured'
        : 'launcher'
      : null
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
      preview,
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
      version,
      pluginVersion,
      update,
      resumable: resumableVia !== null,
      resumableVia,
      tokens,
      live: liveFlag,
      pid: live?.pid ?? null,
      tmux: live?.tmux ?? null,
      backgroundState: jobBlocked ? 'blocked' : (job?.state ?? null),
      needs: job?.needs ?? null,
      jobId: job?.jobId ?? null,
      unreadMessages: this.store.unreadCount(id),
      overlapCount: overlaps.filter(
        (overlap) => overlap.sessionIds.includes(id) || overlap.claimedBy.includes(id),
      ).length,
      pinned: meta?.pinned ?? false,
      archived: meta?.archived ?? false,
      timeline: buildTimeline(this.mergedActivities(id, view), question, notification, job, at),
      messageCount: view?.messageCount ?? 0,
      source: runtime && hookFresh ? 'hook' : live ? 'registry' : job ? 'background' : 'transcript',
    }
  }

  /**
   * A link to the session's preview. A registration the session made through
   * the preview router wins: it is live, and the router answers for that host.
   * Otherwise a Settings rule is matched against the project path and
   * repository names. Without a rule, the newest URL a tool printed in the
   * last day whose host is a configured preview host is used.
   */
  private previewFor(
    id: string,
    view: TranscriptView | null,
    projectPath: string,
    git: GitInfo | null,
  ): PreviewLink | null {
    const settings = this.store.getSettings()
    if (settings.previewZone) {
      const registered = this.store.previewFor(id)
      if (registered) {
        const link = makePreviewLink(
          previewUrl(registered.name, settings.previewZone),
          'registered',
          registered.createdAt,
        )
        if (link) return link
      }
    }
    if (settings.previewRules.length === 0 && settings.previewHosts.length === 0) return null
    const values = [
      projectPath,
      view?.cwd ?? '',
      git?.repoRoot ?? '',
      git?.repoName ?? '',
      projectPath ? path.basename(projectPath) : '',
    ]
    // Only tool output is scanned. A session's own prose mentions URLs for many
    // reasons — a peer's tunnel, a documentation link, a command in a prompt —
    // and attaching one of those as "the preview" would be a lie.
    const cutoff = now() - PREVIEW_URL_MAX_AGE_MS
    const snippets = (view?.recentToolResults ?? [])
      .filter((result) => result.at >= cutoff)
      .map((result) => ({ text: result.text, at: result.at }))
      .sort((a, b) => b.at - a.at)
    return resolvePreview({
      rules: settings.previewRules,
      hosts: settings.previewHosts,
      values,
      snippets,
    })
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
        if (question.answerable) return 'Waiting for your answer'
        // A background session has no terminal to fall back on, so the honest
        // hint is the one that gets it moving again.
        if (job) return 'Question expired — send a prompt to wake the session'
        return question.source === 'hook'
          ? 'Question moved to the terminal'
          : 'Answer this question in the terminal'
      }
      if (notification) return notification.message
      if (job?.needs) {
        // A background session has no terminal of its own, so a permission
        // prompt it waits at can only be answered by attaching to it.
        return `${job.needs} — attach a terminal: claude attach ${shortId(job.jobId)}`
      }
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
    const commandContext = this.orchestration?.contextFor(sessionId, reason) ?? null
    if (context && commandContext) return `${context}\n${commandContext}`
    return context ?? commandContext
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
