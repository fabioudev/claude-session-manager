import { randomUUID } from 'node:crypto'
import { readFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type {
  CommandCenterSnapshot,
  CommanderCommand,
  CommanderUpdate,
  CommanderUpdateInput,
  CommanderUpdateKind,
  DecisionInput,
  DecisionRequest,
  DelegatedTask,
  DelegatedTaskInput,
  DelegatedTaskPatch,
  Epic,
  EpicInput,
  EpicMessage,
  EpicMessageInput,
  EpicMessageKind,
  EpicPatch,
  EpicStatus,
  KnowledgeEntry,
  KnowledgeInput,
  KnowledgePatch,
  LaunchSessionInput,
  LaunchSessionResult,
  PromptResult,
  SessionSummary,
  TaskActivity,
} from '../shared/types.js'
import {
  atomicWriteFile,
  ensureDir,
  MAX_MESSAGE_LENGTH,
  oneLine,
  shortId,
  truncate,
} from './util.js'

const MAX_TASKS = 500
const MAX_EPICS = 100
const MAX_EPIC_MESSAGES = 120
const MAX_KNOWLEDGE = 500
const MAX_DECISIONS = 500
const MAX_COMMANDS = 100
const MAX_UPDATES = 200
const MAX_ACTIVITIES = 80
const MAX_CONTEXT = 18_000
const MAX_TASK_KNOWLEDGE = 5_000

interface PersistedCommandCenter extends CommandCenterSnapshot {
  version: 1
}

export class OrchestrationError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'OrchestrationError'
    this.status = status
    this.code = code
  }
}

interface OrchestrationOptions {
  dataDir: string
  readOnly: () => boolean
  getSession: (id: string) => SessionSummary | null
  sendPrompt: (id: string, text: string) => Promise<PromptResult>
  onChange: (snapshot: CommandCenterSnapshot) => void
  /** Launches a dedicated commander when none is selected or it went offline. */
  launchCommander?: (input: LaunchSessionInput) => Promise<LaunchSessionResult>
  /** Starts a new worker session, used when no live session can take a task. */
  launchSession?: (input: LaunchSessionInput) => Promise<LaunchSessionResult>
  /** Current sessions, so the commander starts with a useful snapshot. */
  listSessions?: () => SessionSummary[]
  /** Working directory for a newly launched commander. */
  commanderCwd?: string
  now?: () => number
}

function emptyState(): PersistedCommandCenter {
  return {
    version: 1,
    commanderSessionId: null,
    tasks: [],
    epics: [],
    knowledge: [],
    decisions: [],
    commands: [],
    updates: [],
  }
}

const EPIC_STATUSES: ReadonlySet<EpicStatus> = new Set<EpicStatus>([
  'active',
  'paused',
  'blocked',
  'done',
  'cancelled',
])

const EPIC_MESSAGE_KINDS: ReadonlySet<EpicMessageKind> = new Set<EpicMessageKind>([
  'question',
  'note',
  'answer',
  'status',
])

const UPDATE_KINDS: ReadonlySet<CommanderUpdateKind> = new Set<CommanderUpdateKind>([
  'status',
  'progress',
  'blocked',
  'done',
  'question',
  'note',
])

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new OrchestrationError(400, 'bad_request', `${label} must not be empty.`)
  }
  const text = value.trim()
  if (text.length > max) {
    throw new OrchestrationError(
      400,
      'bad_request',
      `${label} is too long (max ${max} characters).`,
    )
  }
  return text
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value === null || value === undefined || value === '') return null
  return requiredText(value, label, max)
}

function normalizeProject(value: string | null | undefined): string | null {
  if (!value) return null
  return path.resolve(value)
}

function isWithin(projectPath: string, parent: string): boolean {
  const relative = path.relative(parent, projectPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function sanitizeTask(value: DelegatedTask): DelegatedTask {
  return {
    ...value,
    // Older ledgers predate epics; those tasks stay standalone.
    epicId: typeof value.epicId === 'string' ? value.epicId : null,
  }
}

function sanitizeEpic(value: Epic): Epic {
  const status = EPIC_STATUSES.has(value.status) ? value.status : 'active'
  return {
    ...value,
    status,
    goal: typeof value.goal === 'string' ? value.goal : '',
    statusLine: typeof value.statusLine === 'string' ? value.statusLine : null,
    repositories: Array.isArray(value.repositories)
      ? value.repositories.filter((repo): repo is string => typeof repo === 'string')
      : [],
    previewUrl: typeof value.previewUrl === 'string' ? value.previewUrl : null,
    ownerSessionId: typeof value.ownerSessionId === 'string' ? value.ownerSessionId : null,
    messages: Array.isArray(value.messages)
      ? value.messages
          .filter((message): message is EpicMessage =>
            Boolean(message && typeof message === 'object'),
          )
          .map((message) => ({
            ...message,
            kind: EPIC_MESSAGE_KINDS.has(message.kind) ? message.kind : 'note',
            deliveredAt: typeof message.deliveredAt === 'number' ? message.deliveredAt : null,
          }))
      : [],
  }
}

function sanitizeState(value: unknown): PersistedCommandCenter {
  if (!value || typeof value !== 'object') throw new Error('Invalid command center state')
  const input = value as Partial<PersistedCommandCenter>
  return {
    version: 1,
    commanderSessionId:
      typeof input.commanderSessionId === 'string' ? input.commanderSessionId : null,
    tasks: Array.isArray(input.tasks) ? (input.tasks as DelegatedTask[]).map(sanitizeTask) : [],
    epics: Array.isArray(input.epics) ? (input.epics as Epic[]).map(sanitizeEpic) : [],
    knowledge: Array.isArray(input.knowledge) ? (input.knowledge as KnowledgeEntry[]) : [],
    decisions: Array.isArray(input.decisions) ? (input.decisions as DecisionRequest[]) : [],
    commands: Array.isArray(input.commands) ? (input.commands as CommanderCommand[]) : [],
    updates: Array.isArray(input.updates)
      ? (input.updates as CommanderUpdate[]).map((update) => ({
          ...update,
          epicId: typeof update.epicId === 'string' ? update.epicId : null,
        }))
      : [],
  }
}

function failedDispatch(error: string): PromptResult {
  return { ok: false, mode: 'queued', error }
}

/**
 * Durable commander/worker ledger. Delivery and declared progress are separate:
 * a queued prompt is not running, and an idle session is not automatically done.
 */
export class OrchestrationService {
  private readonly file: string
  private state: PersistedCommandCenter = emptyState()
  private saveChain: Promise<void> = Promise.resolve()
  private readonly now: () => number

  constructor(private readonly options: OrchestrationOptions) {
    this.file = path.join(options.dataDir, 'command-center.json')
    this.now = options.now ?? Date.now
  }

  async init(): Promise<void> {
    await ensureDir(path.dirname(this.file))
    try {
      this.state = sanitizeState(JSON.parse(await readFile(this.file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await rename(this.file, `${this.file}.corrupt-${this.now()}`).catch(() => undefined)
      }
      this.state = emptyState()
    }
  }

  snapshot(): CommandCenterSnapshot {
    return {
      commanderSessionId: this.state.commanderSessionId,
      tasks: [...this.state.tasks].sort((a, b) => b.updatedAt - a.updatedAt),
      epics: [...this.state.epics].sort((a, b) => b.updatedAt - a.updatedAt),
      knowledge: [...this.state.knowledge].sort((a, b) => b.updatedAt - a.updatedAt),
      decisions: [...this.state.decisions].sort((a, b) => b.createdAt - a.createdAt),
      commands: [...this.state.commands].sort((a, b) => b.createdAt - a.createdAt),
      updates: [...this.state.updates].sort((a, b) => b.at - a.at),
    }
  }

  async setCommander(sessionId: string | null): Promise<CommandCenterSnapshot> {
    this.writable()
    if (sessionId) this.liveSession(sessionId, 'Commander')
    this.state.commanderSessionId = sessionId
    await this.commit()
    return this.snapshot()
  }

  async command(textInput: string): Promise<CommanderCommand> {
    this.writable()
    const text = requiredText(textInput, 'Command', 12_000)
    const prompt = this.commanderPrompt(text)
    // The snapshot is prepended to the command, so a long command can outgrow
    // what a session message can carry. Say so instead of failing as a 500.
    if (prompt.length > MAX_MESSAGE_LENGTH) {
      throw new OrchestrationError(
        413,
        'command_too_long',
        `The command is too long together with the command-center context (${prompt.length} of ${MAX_MESSAGE_LENGTH} characters). Shorten it by about ${prompt.length - MAX_MESSAGE_LENGTH} characters.`,
      )
    }
    const commanderId = this.state.commanderSessionId
    if (!commanderId) return this.startCommander(prompt, text)

    const commander = this.options.getSession(commanderId)
    if (!commander) return this.startCommander(prompt, text)
    // A background job reports live: false (that flag means a live terminal),
    // but it is still reachable by waking it, which sendPrompt does.
    if (!commander.live && !commander.jobId) {
      return this.resumeCommander(commanderId, prompt, text)
    }

    const result = await this.options.sendPrompt(commanderId, prompt)
    return this.recordCommand(text, result)
  }

  /**
   * The command center should work with zero setup: the first human command
   * starts a dedicated commander. It gets the full snapshot in its first
   * prompt, so it can plan immediately instead of asking what exists.
   */
  private async startCommander(prompt: string, text: string): Promise<CommanderCommand> {
    if (!this.options.launchCommander) {
      throw new OrchestrationError(409, 'commander_required', 'Choose a main session first.')
    }
    const result = await this.options.launchCommander({
      cwd: this.options.commanderCwd ?? homedir(),
      name: 'Commander',
      prompt,
    })
    if (!result.ok) {
      throw new OrchestrationError(
        409,
        'dispatch_failed',
        result.error ?? 'The commander session could not be started.',
      )
    }
    if (!result.sessionId) {
      throw new OrchestrationError(
        409,
        'dispatch_failed',
        `The commander started, but its session id was not available yet. ${
          truncate(result.output ?? '', 500) || 'Open the session and choose it manually.'
        }`,
      )
    }
    this.state.commanderSessionId = result.sessionId
    return this.recordCommand(text, {
      ok: true,
      mode: 'typed',
      note: `Started a new commander session (${result.sessionId}).`,
    })
  }

  /** An ended commander keeps its transcript; resume it before starting fresh. */
  private async resumeCommander(
    commanderId: string,
    prompt: string,
    text: string,
  ): Promise<CommanderCommand> {
    if (!this.options.launchCommander) {
      throw new OrchestrationError(
        409,
        'session_offline',
        'The commander is not running. Resume it or choose another session.',
      )
    }
    const known = this.options.getSession(commanderId)
    // No --name or other flags here on purpose: `--bg --resume` continues the
    // conversation under its own id with its saved options, while extra flags
    // start a copy with a new id.
    const result = await this.options.launchCommander({
      // Resume in its original project; a session started elsewhere would lose
      // the repository context it was working in.
      cwd: known?.projectPath || this.options.commanderCwd || homedir(),
      prompt,
      resumeSessionId: commanderId,
    })
    if (result.ok) {
      this.state.commanderSessionId = result.sessionId ?? commanderId
      return this.recordCommand(text, {
        ok: true,
        mode: 'typed',
        note: `Resumed the commander session (${this.state.commanderSessionId}).`,
      })
    }
    try {
      return await this.startCommander(prompt, text)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : 'Unknown error.'
      throw new OrchestrationError(
        409,
        'dispatch_failed',
        `The commander could not be resumed (${result.error ?? 'unknown error'}), and a new one could not be started. ${detail}`,
      )
    }
  }

  private async recordCommand(text: string, result: PromptResult): Promise<CommanderCommand> {
    const command: CommanderCommand = {
      id: `cmd_${randomUUID()}`,
      text,
      createdAt: this.now(),
      result,
    }
    this.state.commands.unshift(command)
    this.state.commands.length = Math.min(this.state.commands.length, MAX_COMMANDS)
    await this.commit()
    if (!result.ok) {
      throw new OrchestrationError(
        409,
        'dispatch_failed',
        result.error ?? 'Command delivery failed.',
      )
    }
    return command
  }

  /**
   * The commander's own voice in the channel: what is running where, what it
   * verified, what is blocked. The human reads this instead of polling tasks.
   */
  async report(
    input: CommanderUpdateInput,
    actorSessionId: string | null,
  ): Promise<CommanderUpdate> {
    this.writable()
    this.requireDispatcher(actorSessionId, 'post commander updates')
    if (input.kind !== undefined && !UPDATE_KINDS.has(input.kind)) {
      throw new OrchestrationError(400, 'bad_request', 'Unknown commander update kind.')
    }
    const taskIds = [
      ...new Set(
        (input.taskIds ?? []).filter((id) =>
          this.state.tasks.some((candidate) => candidate.id === id),
        ),
      ),
    ].slice(0, 12)
    const firstTask = taskIds.length
      ? this.state.tasks.find((candidate) => candidate.id === taskIds[0])
      : undefined
    const epicId =
      input.epicId !== undefined
        ? input.epicId
          ? this.epic(input.epicId).id
          : null
        : (firstTask?.epicId ?? null)
    if (
      epicId &&
      actorSessionId &&
      actorSessionId !== this.state.commanderSessionId &&
      this.epic(epicId).ownerSessionId !== actorSessionId
    ) {
      throw new OrchestrationError(
        403,
        'forbidden',
        'Only the epic owner or the commander can report on this epic.',
      )
    }
    const update: CommanderUpdate = {
      id: `update_${randomUUID()}`,
      at: this.now(),
      kind: input.kind ?? 'status',
      title: requiredText(input.title, 'Update title', 180),
      body: requiredText(input.body, 'Update body', 4000),
      projectPath: normalizeProject(input.projectPath) ?? firstTask?.projectPath ?? null,
      epicId,
      taskIds,
      authorSessionId: actorSessionId,
    }
    this.state.updates.push(update)
    this.trimUpdates()
    for (const id of taskIds) {
      const task = this.state.tasks.find((candidate) => candidate.id === id)
      if (task) {
        this.activity(
          task,
          actorSessionId,
          'note',
          `Commander report: ${update.title} — ${update.body}`,
        )
      }
    }
    await this.commit()
    return update
  }

  /**
   * An epic is the human's unit of overview: a large goal the commander split
   * into tasks across repositories. The status line is deliberately short and
   * written by the epic's commander; the rollup is derived from its tasks.
   */
  async createEpic(input: EpicInput, actorSessionId: string | null): Promise<Epic> {
    this.writable()
    this.requireDispatcher(actorSessionId, 'create epics')
    if (this.state.epics.length >= MAX_EPICS) {
      throw new OrchestrationError(
        409,
        'limit_reached',
        `The command center holds at most ${MAX_EPICS} epics.`,
      )
    }
    const owner = input.ownerSessionId ? this.liveSession(input.ownerSessionId, 'Epic owner') : null
    const at = this.now()
    const epic: Epic = {
      id: `epic_${randomUUID()}`,
      title: requiredText(input.title, 'Epic title', 180),
      goal: optionalText(input.goal, 'Epic goal', 4000) ?? '',
      status: 'active',
      statusLine: null,
      repositories: this.repositories(input.repositories),
      previewUrl: this.previewUrl(input.previewUrl),
      ownerSessionId: owner?.id ?? null,
      createdBySessionId: actorSessionId,
      revision: 1,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
      messages: [],
    }
    this.state.epics.push(epic)
    this.systemUpdate(
      'status',
      `Epic opened: ${epic.title}`,
      `${owner ? `Owned by ${owner.name || owner.title}. ` : ''}${this.repoNames(epic) || 'No repository declared yet.'}`,
      { epicId: epic.id, projectPath: epic.repositories[0] ?? null },
    )
    await this.commit()
    return epic
  }

  async updateEpic(id: string, patch: EpicPatch, actorSessionId: string | null): Promise<Epic> {
    this.writable()
    const epic = this.epic(id)
    this.canMutateEpic(epic, actorSessionId)
    if (patch.status !== undefined && !EPIC_STATUSES.has(patch.status)) {
      throw new OrchestrationError(400, 'bad_request', 'Unknown epic status.')
    }
    const ownerOnly =
      actorSessionId !== null &&
      actorSessionId !== this.state.commanderSessionId &&
      epic.ownerSessionId === actorSessionId
    if (
      ownerOnly &&
      (patch.title !== undefined ||
        patch.goal !== undefined ||
        patch.repositories !== undefined ||
        patch.ownerSessionId !== undefined)
    ) {
      throw new OrchestrationError(
        403,
        'forbidden',
        'The epic owner may update its status, status line and preview, not its definition.',
      )
    }
    this.revision(epic.revision, patch.expectedRevision)
    const status = patch.status ?? epic.status
    const draft: Epic = {
      ...epic,
      title: patch.title !== undefined ? requiredText(patch.title, 'Epic title', 180) : epic.title,
      goal:
        patch.goal !== undefined ? (optionalText(patch.goal, 'Epic goal', 4000) ?? '') : epic.goal,
      status,
      statusLine:
        patch.statusLine !== undefined
          ? optionalText(patch.statusLine, 'Epic status line', 400)
          : epic.statusLine,
      repositories:
        patch.repositories !== undefined
          ? this.repositories(patch.repositories)
          : epic.repositories,
      previewUrl:
        patch.previewUrl !== undefined ? this.previewUrl(patch.previewUrl) : epic.previewUrl,
      ownerSessionId:
        patch.ownerSessionId !== undefined
          ? patch.ownerSessionId
            ? this.liveSession(patch.ownerSessionId, 'Epic owner').id
            : null
          : epic.ownerSessionId,
      messages: epic.messages.slice(),
    }
    if ((status === 'done' || status === 'cancelled') && epic.status !== status) {
      draft.completedAt = this.now()
    } else if (status !== 'done' && status !== 'cancelled') {
      draft.completedAt = null
    }
    if (patch.status !== undefined && patch.status !== epic.status) {
      this.pushEpicMessage(draft, actorSessionId, 'status', `Epic status is now ${patch.status}.`)
      this.systemUpdate('status', `Epic ${patch.status}: ${draft.title}`, draft.statusLine || '', {
        epicId: draft.id,
        projectPath: draft.repositories[0] ?? null,
      })
    }
    draft.updatedAt = this.now()
    draft.revision += 1
    const index = this.state.epics.indexOf(epic)
    this.state.epics[index] = draft
    await this.commit()
    return draft
  }

  /**
   * The human writes into the epic's own thread; the epic's commander answers
   * there instead of in the main chat. A human message wakes a live owner now,
   * otherwise it stays flagged and is injected at the owner's next prompt.
   */
  async postEpicMessage(
    id: string,
    input: EpicMessageInput,
    actorSessionId: string | null,
  ): Promise<Epic> {
    this.writable()
    const epic = this.epic(id)
    this.canMessageEpic(epic, actorSessionId)
    if (input.kind !== undefined && !EPIC_MESSAGE_KINDS.has(input.kind)) {
      throw new OrchestrationError(400, 'bad_request', 'Unknown epic message kind.')
    }
    const kind = input.kind ?? (actorSessionId ? 'answer' : 'question')
    const message: EpicMessage = {
      id: `epicmsg_${randomUUID()}`,
      at: this.now(),
      authorSessionId: actorSessionId,
      kind,
      body: requiredText(input.body, 'Epic message', 8000),
      deliveredAt: actorSessionId ? this.now() : null,
    }
    const index = this.state.epics.indexOf(epic)
    const updated: Epic = {
      ...epic,
      messages: [...epic.messages, message].slice(-MAX_EPIC_MESSAGES),
      updatedAt: this.now(),
      revision: epic.revision + 1,
    }
    this.state.epics[index] = updated
    if (!actorSessionId) await this.deliverEpicMessage(updated, message)
    await this.commit()
    return updated
  }

  /**
   * Start a dedicated epic commander (a normal peer session) and hand it the
   * epic. The main commander keeps dispatch and milestones, not the details.
   */
  async spawnEpicCommander(
    id: string,
    options: { name?: string } = {},
    actorSessionId: string | null,
  ): Promise<Epic> {
    this.writable()
    this.requireCommander(actorSessionId, 'start an epic commander')
    if (!this.options.launchSession) {
      throw new OrchestrationError(
        409,
        'launch_unavailable',
        'Starting sessions is not available here.',
      )
    }
    const epic = this.epic(id)
    const cwd = epic.repositories[0] ?? this.options.commanderCwd ?? homedir()
    const result = await this.options.launchSession({
      cwd,
      prompt: this.epicCommanderPrompt(epic),
      name: (options.name?.trim() || epic.title).slice(0, 60),
    })
    const at = this.now()
    const draft: Epic = {
      ...epic,
      messages: epic.messages.slice(),
      updatedAt: at,
      revision: epic.revision + 1,
    }
    if (result.ok) {
      draft.ownerSessionId = result.sessionId ?? null
      this.pushEpicMessage(
        draft,
        actorSessionId,
        'status',
        result.sessionId
          ? `Epic commander started (${result.sessionId}).`
          : 'Epic commander started; it registers within a few seconds.',
      )
    } else {
      draft.status = 'blocked'
      this.pushEpicMessage(
        draft,
        actorSessionId,
        'status',
        `Could not start an epic commander: ${result.error ?? 'unknown error'}`,
      )
      this.systemUpdate(
        'blocked',
        `Could not start an epic commander: ${draft.title}`,
        result.error ?? '',
        {
          epicId: draft.id,
          projectPath: cwd,
        },
      )
    }
    this.state.epics[this.state.epics.indexOf(epic)] = draft
    await this.commit()
    return draft
  }

  private trimUpdates(): void {
    if (this.state.updates.length > MAX_UPDATES) {
      this.state.updates.splice(0, this.state.updates.length - MAX_UPDATES)
    }
  }

  /** Ledger events worth surfacing in the channel without asking the commander. */
  private systemUpdate(
    kind: CommanderUpdateKind,
    title: string,
    body: string,
    options: { projectPath?: string | null; taskIds?: string[]; epicId?: string | null } = {},
  ): void {
    this.state.updates.push({
      id: `update_${randomUUID()}`,
      at: this.now(),
      kind,
      title: truncate(title, 180),
      body: truncate(body, 4000),
      projectPath: options.projectPath ?? null,
      epicId: options.epicId ?? null,
      taskIds: options.taskIds ?? [],
      authorSessionId: null,
    })
    this.trimUpdates()
  }

  /**
   * Everything a fresh commander would otherwise have to discover through
   * several tool calls: live sessions, open work, decisions and knowledge.
   * Bounded so the human goal always survives in the prompt.
   */
  private commanderPrompt(text: string): string {
    const open = this.state.tasks.filter((task) => !['done', 'cancelled'].includes(task.status))
    const sessions = this.options.listSessions?.() ?? []
    const live = sessions
      .filter((session) => session.live && session.status !== 'ended' && !session.archived)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    const name = (id: string | null): string => {
      if (!id) return 'unassigned'
      const session = sessions.find((candidate) => candidate.id === id)
      return session ? session.name?.trim() || session.title : id
    }

    const lines = [
      '[Human command through Claude Session Manager]',
      'You are the designated commander for the other Claude Code sessions on this machine.',
      'Your job is to dispatch and verify, not to do the work yourself.',
      'Work like this, every time: (1) make creating tasks your first action on a new goal — list_sessions to pick a worker, then create_task; assignment dispatches them automatically, so do not stop at describing a plan; when no live idle worker can take the work, call spawn_task instead of leaving it queued — this machine runs as many sessions as needed, so queueing work for later is never the answer; (2) right after delegating, call report_status once with a short round-up: which agents are on which feature, in which project, and what you will check next; (3) keep monitoring with get_command_center, verify review results with update_task, reassign or retry blocked work; (4) report meaningful milestones, blockers and completions with report_status so the human sees the state without asking; (5) the human may send the next goal for a completely different project at any moment — start it in parallel and never drop, block or serialise work already in motion.',
      'Stay a dispatcher: do not read repository code, grep, run builds or tests, edit files, or spawn subagents yourself. If a brief needs facts you do not have, delegate a read-only discovery task or put the open question into the brief. A quick look at file names is fine when it is the only way to choose the right worker and project path.',
      'Use update_task for your own conclusions, record durable cross-session facts with share_knowledge, and use request_decision whenever only the human can decide. Workers report completion into review; verify their results before marking a task done. Always use these CSM tools instead of calling the manager API with curl.',
      'Every large goal belongs to an epic. When the human hands you a new big task, attach it to the fitting existing epic or open one with create_epic, then hand it to a dedicated epic commander with spawn_epic_commander so its details stay out of your context. Every task you create should carry the epic_id. Keep each epic status_line to one or two short sentences with update_epic: that line plus the task rollup is the overview the human reads. Human questions in an epic thread are answered there with post_epic_message, not in the main chat.',
      'House rule to pass on in every brief that will end in a commit: workers commit as "Fixplay KI Sklave <ki-sklave@fixplay.de>" (author and committer). They must not pass --author, not set their own user.name/user.email, and never rewrite existing history.',
      `The snapshot below is current as of this command. ${open.length} open delegated task(s). Do not claim delegated work has started until the worker reports in.`,
    ]

    if (live.length) {
      lines.push('', `Live sessions (${live.length}); use the exact id when assigning:`)
      for (const session of live.slice(0, 18)) {
        const bits = [
          session.id,
          oneLine(session.name?.trim() || session.title, 60),
          session.status,
          session.repoName || session.projectName || session.projectPath,
        ]
        if (session.task) bits.push(oneLine(session.task, 140))
        if (session.question) bits.push('HAS OPEN QUESTION')
        lines.push(`- ${bits.join(' · ')}`)
      }
      if (live.length > 18)
        lines.push(`- … ${live.length - 18} more live session(s) via list_sessions.`)
    } else {
      lines.push('', 'No live worker sessions right now; queue tasks or start sessions first.')
    }

    if (open.length) {
      lines.push('', `Open delegated tasks (${open.length}):`)
      for (const task of open.slice(0, 12)) {
        lines.push(
          `- ${task.id} [${task.status}, ${task.progress}%] ${oneLine(task.title, 100)} → ${name(task.assigneeSessionId)}${task.lastNote ? ` · ${oneLine(task.lastNote, 160)}` : ''}${task.epicId ? ` · epic ${task.epicId}` : ''}`,
        )
      }
      if (open.length > 12) lines.push(`- … ${open.length - 12} more via get_command_center.`)
    }

    if (this.state.epics.length) {
      const ordered = [...this.state.epics].sort(
        (a, b) =>
          Number(['done', 'cancelled'].includes(a.status)) -
            Number(['done', 'cancelled'].includes(b.status)) || b.updatedAt - a.updatedAt,
      )
      lines.push('', `Epics (${ordered.length}):`)
      for (const epic of ordered.slice(0, 15)) {
        const linked = this.state.tasks.filter(
          (task) => task.epicId === epic.id && !['done', 'cancelled'].includes(task.status),
        )
        const waiting = epic.messages.filter(
          (message) => !message.authorSessionId && !message.deliveredAt,
        ).length
        lines.push(
          `- ${epic.id} [${epic.status}] ${oneLine(epic.title, 90)} → ${name(epic.ownerSessionId)} · ${epic.statusLine ? oneLine(epic.statusLine, 200) : 'no status line'} · ${linked.length} open task(s)${waiting ? ` · ${waiting} unanswered human message(s)` : ''}`,
        )
      }
      if (ordered.length > 15) lines.push(`- … ${ordered.length - 15} more via get_command_center.`)
      lines.push(
        'Epics without an owner are yours to run or to hand to a new epic commander with spawn_epic_commander.',
      )
    }

    const decisions = this.state.decisions.filter((decision) => !decision.resolvedAt)
    if (decisions.length) {
      lines.push('', 'Pending human decisions:')
      for (const decision of decisions.slice(0, 8)) {
        lines.push(
          `- ${decision.id}: ${oneLine(decision.question, 180)}${decision.taskId ? ` (task ${decision.taskId})` : ''}`,
        )
      }
    }

    const knowledge = this.state.knowledge
      .filter((entry) => !entry.archivedAt)
      .sort((a, b) => Number(b.always) - Number(a.always) || b.updatedAt - a.updatedAt)
    if (knowledge.length) {
      lines.push('', 'Shared knowledge:')
      for (const entry of knowledge.slice(0, 8)) {
        lines.push(
          `- ${entry.title}${entry.projectPath ? ` [${entry.projectPath}]` : ' [global]'}${entry.always ? ' [pinned]' : ''}: ${oneLine(entry.body, 400)}`,
        )
      }
      if (knowledge.length > 8) lines.push('More entries via list_knowledge.')
    }

    // The goal must never be truncated away, so bound only the snapshot.
    const context = truncate(
      lines.join('\n'),
      Math.min(12_000, Math.max(3_000, MAX_CONTEXT - text.length - 1_000)),
    )
    return [context, '', 'HUMAN GOAL:', text].join('\n')
  }

  async createTask(
    input: DelegatedTaskInput,
    actorSessionId: string | null,
  ): Promise<DelegatedTask> {
    this.writable()
    this.requireDispatcher(actorSessionId, 'create tasks')
    if (this.state.tasks.length >= MAX_TASKS) {
      throw new OrchestrationError(
        409,
        'limit_reached',
        `The ledger holds at most ${MAX_TASKS} tasks.`,
      )
    }
    const epic = input.epicId ? this.epic(input.epicId) : null
    if (actorSessionId && actorSessionId !== this.state.commanderSessionId) {
      if (!epic) {
        throw new OrchestrationError(
          400,
          'epic_required',
          'An epic commander must attach every task to one of its epics.',
        )
      }
      if (epic.ownerSessionId !== actorSessionId) {
        throw new OrchestrationError(403, 'forbidden', 'This epic belongs to another session.')
      }
    }
    const assignee = input.assigneeSessionId
      ? this.liveSession(input.assigneeSessionId, 'Assignee')
      : null
    const at = this.now()
    const task: DelegatedTask = {
      id: `task_${randomUUID()}`,
      title: requiredText(input.title, 'Task title', 180),
      brief: requiredText(input.brief, 'Task brief', 10_000),
      status: 'queued',
      priority: input.priority ?? 'normal',
      progress: 0,
      assigneeSessionId: assignee?.id ?? null,
      createdBySessionId: actorSessionId,
      projectPath: normalizeProject(
        input.projectPath ?? assignee?.repoRoot ?? assignee?.projectPath ?? epic?.repositories[0],
      ),
      epicId: epic?.id ?? null,
      lastNote: null,
      result: null,
      lastDispatch: null,
      revision: 1,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
      activities: [],
    }
    this.activity(
      task,
      actorSessionId,
      'created',
      assignee
        ? `Created and assigned to ${assignee.name || assignee.title}.`
        : 'Created without an assignee.',
    )
    this.state.tasks.push(task)
    this.systemUpdate(
      'status',
      `Delegated: ${task.title}`,
      assignee
        ? `Assigned to ${assignee.name || assignee.title}${task.projectPath ? ` in ${path.basename(task.projectPath)}` : ''}.`
        : 'No worker assigned yet.',
      { projectPath: task.projectPath, taskIds: [task.id], epicId: task.epicId },
    )
    await this.commit()
    if (assignee) await this.dispatchTask(task.id, actorSessionId)
    return task
  }

  /**
   * Create a task and start a fresh worker session for it in one step.
   *
   * There is no reason to keep work queued: this machine runs as many sessions
   * as the human wants, and a task waiting on a session that is not running
   * would never start. The new session is a peer like any other, so the
   * commander monitors it through the usual task ledger.
   */
  async spawnTask(
    input: DelegatedTaskInput & { name?: string },
    actorSessionId: string | null,
  ): Promise<DelegatedTask> {
    this.requireDispatcher(actorSessionId, 'start worker sessions')
    if (!this.options.launchSession) {
      throw new OrchestrationError(
        409,
        'launch_unavailable',
        'Starting sessions is not available here.',
      )
    }
    const projectPath = normalizeProject(input.projectPath)
    if (!projectPath) {
      throw new OrchestrationError(
        400,
        'project_required',
        'Give the absolute project directory the new worker should start in.',
      )
    }
    const task = await this.createTask(
      { ...input, assigneeSessionId: undefined, projectPath },
      actorSessionId,
    )
    const result = await this.options.launchSession({
      cwd: projectPath,
      prompt: this.taskPrompt(task, null),
      name: (input.name?.trim() || task.title).slice(0, 60),
    })
    task.updatedAt = this.now()
    task.revision += 1
    if (result.ok) {
      task.assigneeSessionId = result.sessionId ?? null
      task.status = 'in_progress'
      task.lastNote = result.sessionId
        ? `Started as a new session (${result.sessionId}).`
        : 'Started as a new session; it registers within a few seconds.'
      this.activity(task, actorSessionId, 'status', task.lastNote)
      this.systemUpdate('status', `Started a worker: ${task.title}`, task.lastNote, {
        projectPath,
        taskIds: [task.id],
      })
    } else {
      task.status = 'blocked'
      task.lastNote = result.error ?? 'The worker session could not be started.'
      this.activity(task, actorSessionId, 'status', `Could not start a session: ${task.lastNote}`)
      this.systemUpdate('blocked', `Could not start a worker: ${task.title}`, task.lastNote, {
        projectPath,
        taskIds: [task.id],
      })
    }
    await this.commit()
    return task
  }

  async updateTask(
    id: string,
    patch: DelegatedTaskPatch,
    actorSessionId: string | null,
  ): Promise<DelegatedTask> {
    this.writable()
    const task = this.task(id)
    this.canMutateTask(task, actorSessionId)
    const epicOwner = Boolean(task.epicId && this.isEpicOwner(task.epicId, actorSessionId))
    const privileged =
      !actorSessionId || actorSessionId === this.state.commanderSessionId || epicOwner
    if (!privileged) {
      if (
        patch.title !== undefined ||
        patch.brief !== undefined ||
        patch.priority !== undefined ||
        patch.projectPath !== undefined ||
        patch.assigneeSessionId !== undefined ||
        patch.epicId !== undefined
      ) {
        throw new OrchestrationError(
          403,
          'forbidden',
          'Workers can report progress and results, but cannot redefine or reassign the task.',
        )
      }
      if (patch.status === 'done' || patch.status === 'cancelled') {
        throw new OrchestrationError(
          403,
          'review_required',
          'Only the commander, the epic owner or the human can close a task.',
        )
      }
    }
    this.revision(task.revision, patch.expectedRevision)
    // Validate the complete patch before touching live state. A rejected patch
    // must not survive in memory and leak into a later unrelated commit.
    const title =
      patch.title !== undefined ? requiredText(patch.title, 'Task title', 180) : task.title
    const brief =
      patch.brief !== undefined ? requiredText(patch.brief, 'Task brief', 10_000) : task.brief
    const projectPath =
      patch.projectPath !== undefined ? normalizeProject(patch.projectPath) : task.projectPath
    if (
      patch.progress !== undefined &&
      (!Number.isInteger(patch.progress) || patch.progress < 0 || patch.progress > 100)
    ) {
      throw new OrchestrationError(
        400,
        'bad_request',
        'Progress must be a whole number from 0 to 100.',
      )
    }
    const assignee =
      patch.assigneeSessionId !== undefined
        ? patch.assigneeSessionId
          ? this.liveSession(patch.assigneeSessionId, 'Assignee')
          : null
        : undefined
    const note = optionalText(patch.note, 'Progress note', 3000)
    const result = optionalText(patch.result, 'Task result', 6000)
    const epicId =
      patch.epicId !== undefined ? (patch.epicId ? this.epic(patch.epicId).id : null) : task.epicId

    const draft: DelegatedTask = {
      ...task,
      title,
      brief,
      priority: patch.priority ?? task.priority,
      projectPath,
      epicId,
      progress: patch.progress ?? task.progress,
      activities: task.activities.slice(),
    }
    const previousAssignee = task.assigneeSessionId
    const assignmentChanged = assignee !== undefined && (assignee?.id ?? null) !== previousAssignee

    if (patch.status !== undefined) {
      draft.status = patch.status
      if (patch.status === 'done') {
        draft.progress = 100
        draft.completedAt = this.now()
      } else if (patch.status === 'cancelled') {
        draft.completedAt = this.now()
      } else {
        draft.completedAt = null
      }
      this.activity(
        draft,
        actorSessionId,
        'status',
        `Status changed to ${patch.status.replace('_', ' ')}.`,
      )
    }
    if (assignee !== undefined) {
      draft.assigneeSessionId = assignee?.id ?? null
      if (assignee && !draft.projectPath) {
        draft.projectPath = normalizeProject(assignee.repoRoot ?? assignee.projectPath)
      }
      // Saving an unchanged assignee is a no-op, not a new assignment.
      if (assignmentChanged && draft.status !== 'done' && draft.status !== 'cancelled') {
        draft.status = 'queued'
      }
      if (assignmentChanged) {
        this.activity(
          draft,
          actorSessionId,
          'assigned',
          assignee ? `Assigned to ${assignee.name || assignee.title}.` : 'Assignment cleared.',
        )
      }
    }
    if (note) {
      draft.lastNote = note
      this.activity(draft, actorSessionId, patch.progress !== undefined ? 'progress' : 'note', note)
    }
    if (result) draft.result = result
    draft.updatedAt = this.now()
    draft.revision += 1

    if (patch.status !== undefined && draft.status !== task.status) {
      const labels: Partial<Record<DelegatedTask['status'], [CommanderUpdateKind, string]>> = {
        in_progress: ['progress', 'In progress'],
        blocked: ['blocked', 'Blocked'],
        review: ['status', 'Ready for review'],
        done: ['done', 'Completed'],
      }
      const entry = labels[draft.status]
      if (entry) {
        this.systemUpdate(
          entry[0],
          `${entry[1]}: ${draft.title}`,
          note || draft.lastNote || `Status is now ${draft.status.replace('_', ' ')}.`,
          { projectPath: draft.projectPath, taskIds: [draft.id], epicId: draft.epicId },
        )
      }
    }

    const index = this.state.tasks.indexOf(task)
    this.state.tasks[index] = draft
    await this.commit()
    if (assignmentChanged && draft.assigneeSessionId) {
      await this.dispatchTask(draft.id, actorSessionId)
    }
    // Monitoring is part of the commander's job, but a commander only acts when
    // prompted. A finished task wakes it so verification does not wait for the
    // next human message. Its own changes never nudge it.
    if (draft.status === 'review' && task.status !== 'review') {
      const epicEntry = draft.epicId
        ? this.state.epics.find((candidate) => candidate.id === draft.epicId)
        : null
      const epicOwner = epicEntry?.ownerSessionId ?? null
      const ownerSession = epicOwner ? this.options.getSession(epicOwner) : null
      const reviewer =
        ownerSession?.live && ownerSession.status !== 'ended'
          ? epicOwner
          : this.state.commanderSessionId
      if (reviewer && reviewer !== actorSessionId) {
        await this.nudge(
          reviewer,
          [
            `[Command center] Task ${draft.id} "${draft.title}" is ready for review.`,
            draft.result ? `Result: ${truncate(draft.result, 1500)}` : '',
            'Check the work with get_command_center, then update_task status done or send it back with a concrete note. If the task belongs to an epic, keep the epic status line current with update_epic.',
          ]
            .filter(Boolean)
            .join('\n'),
        )
      }
    }
    return draft
  }

  /** Wake a specific session (the epic owner) when it is live. */
  private async nudge(sessionId: string | null, text: string): Promise<void> {
    if (!sessionId || !this.options.getSession(sessionId)) return
    await this.options.sendPrompt(sessionId, text).catch(() => undefined)
  }

  /** A short prompt to the commander; a dead or absent commander is not an error. */
  private async nudgeCommander(text: string): Promise<void> {
    const commanderId = this.state.commanderSessionId
    if (!commanderId || !this.options.getSession(commanderId)) return
    await this.options.sendPrompt(commanderId, text).catch(() => undefined)
  }

  /**
   * A session ended. Open tasks it still held are now orphans: nobody can pick
   * them up until someone reassigns or cancels them. The board shows them as
   * "Needs you", and the commander — not the human — owns that cleanup, so it
   * gets woken with the exact list instead of waiting for the next command.
   */
  async sessionEnded(sessionId: string): Promise<void> {
    if (this.options.readOnly()) return
    if (sessionId === this.state.commanderSessionId) return
    const ownedEpics = this.state.epics.filter(
      (epic) =>
        epic.ownerSessionId === sessionId && epic.status !== 'done' && epic.status !== 'cancelled',
    )
    if (ownedEpics.length) {
      const at = this.now()
      for (const epic of ownedEpics) {
        epic.ownerSessionId = null
        epic.updatedAt = at
        epic.revision += 1
        this.pushEpicMessage(
          epic,
          null,
          'status',
          `The epic commander (${shortId(sessionId)}) ended. This epic is now unowned.`,
        )
      }
      await this.commit()
      await this.nudgeCommander(
        [
          `[Command center] Session ${shortId(sessionId)} ended while owning ${ownedEpics.length} epic(s):`,
          ...ownedEpics.slice(0, 8).map((epic) => `- ${epic.id} "${epic.title}"`),
          'Start a new epic commander with spawn_epic_commander for each, or keep running them yourself.',
        ].join('\n'),
      )
    }
    const orphaned = this.state.tasks.filter(
      (task) =>
        task.assigneeSessionId === sessionId &&
        !['done', 'cancelled', 'blocked'].includes(task.status),
    )
    if (!orphaned.length) return
    const lines = [
      `[Command center] Session ${shortId(sessionId)} ended while holding ${orphaned.length} open task(s):`,
      ...orphaned
        .slice(0, 8)
        .map((task) => `- ${task.id} "${task.title}" (${task.status}, ${task.progress}%)`),
    ]
    if (orphaned.length > 8) lines.push(`- … ${orphaned.length - 8} more via get_command_center.`)
    lines.push(
      'Fix each one now: reassign it to a live idle session (update_task with a new assignee), start a new worker with spawn_task, or mark it done/cancelled when the work is finished or obsolete. Then post one short report_status round-up with what you changed.',
    )
    await this.nudgeCommander(lines.join('\n'))
  }

  /**
   * A wake that had to pass flags starts the work in a copy with a new session
   * id. Everything that pointed at the original moves along: the commander
   * role, epic owners and task assignees. Otherwise the board keeps following a
   * session nobody runs while the copy works without a role.
   */
  async reassignSession(from: string, to: string): Promise<void> {
    if (this.options.readOnly() || !from || !to || from === to) return
    const at = this.now()
    let changed = false
    if (this.state.commanderSessionId === from) {
      this.state.commanderSessionId = to
      changed = true
    }
    for (const task of this.state.tasks) {
      if (task.assigneeSessionId !== from) continue
      task.assigneeSessionId = to
      task.updatedAt = at
      task.revision += 1
      changed = true
    }
    for (const epic of this.state.epics) {
      if (epic.ownerSessionId !== from) continue
      epic.ownerSessionId = to
      epic.updatedAt = at
      epic.revision += 1
      this.pushEpicMessage(
        epic,
        null,
        'status',
        `The epic commander continued as ${shortId(to)} (woken copy of ${shortId(from)}).`,
      )
      changed = true
    }
    if (changed) await this.commit()
  }

  /**
   * An epic commander's background job finished its turn while a human message
   * was still pending. A background session never reads its inbox on its own and
   * nothing else wakes it, so the message is delivered now, exactly like a
   * freshly written one.
   */
  async sessionIdle(sessionId: string): Promise<void> {
    if (this.options.readOnly()) return
    const epics = this.state.epics.filter(
      (epic) =>
        epic.ownerSessionId === sessionId && epic.status !== 'done' && epic.status !== 'cancelled',
    )
    let delivered = 0
    for (const epic of epics) {
      const pending = epic.messages.filter(
        (message) => !message.authorSessionId && !message.deliveredAt,
      )
      for (const message of pending.slice(0, 3)) {
        const result = await this.options
          .sendPrompt(sessionId, this.epicMessagePrompt(epic, message))
          .catch(() => null)
        // Only a typed prompt means the message actually reached the session;
        // otherwise it stays pending for the next attempt.
        if (!result?.ok || result.mode !== 'typed') return
        message.deliveredAt = this.now()
        delivered += 1
      }
    }
    if (delivered) await this.commit()
  }

  async dispatchTask(id: string, actorSessionId: string | null): Promise<DelegatedTask> {
    this.writable()
    const task = this.task(id)
    this.canMutateTask(task, actorSessionId)
    if (!task.assigneeSessionId) {
      throw new OrchestrationError(
        409,
        'assignee_required',
        'Assign the task before dispatching it.',
      )
    }
    if (task.status === 'done' || task.status === 'cancelled') {
      throw new OrchestrationError(
        409,
        'task_closed',
        'Reopen the task before dispatching it again.',
      )
    }
    const session = this.liveSession(task.assigneeSessionId, 'Assignee')
    const result = await this.options.sendPrompt(session.id, this.taskPrompt(task, session))
    task.lastDispatch = result
    task.updatedAt = this.now()
    task.revision += 1
    if (!result.ok) {
      task.status = 'blocked'
      task.lastNote = result.error ?? 'The task could not be delivered.'
      this.systemUpdate('blocked', `Delivery failed: ${task.title}`, task.lastNote, {
        projectPath: task.projectPath,
        taskIds: [task.id],
      })
    }
    this.activity(
      task,
      actorSessionId,
      'dispatch',
      result.ok
        ? `Delivery ${result.mode}: ${result.note || (result.mode === 'typed' ? 'sent to the live session now.' : 'waiting in the session inbox.')}`
        : `Delivery failed: ${result.error || 'unknown error'}`,
    )
    await this.commit()
    return task
  }

  async shareKnowledge(
    input: KnowledgeInput,
    actorSessionId: string | null,
  ): Promise<KnowledgeEntry> {
    this.writable()
    if (actorSessionId) this.session(actorSessionId)
    if (this.state.knowledge.length >= MAX_KNOWLEDGE) {
      throw new OrchestrationError(
        409,
        'limit_reached',
        `The knowledge base holds at most ${MAX_KNOWLEDGE} entries.`,
      )
    }
    const at = this.now()
    const entry: KnowledgeEntry = {
      id: `know_${randomUUID()}`,
      title: requiredText(input.title, 'Knowledge title', 180),
      body: requiredText(input.body, 'Knowledge body', 8000),
      tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].slice(0, 12),
      projectPath: normalizeProject(input.projectPath),
      // Workers can publish searchable notes; only the commander or human can pin
      // text into every other session's prompt.
      always:
        input.always === true &&
        (!actorSessionId || actorSessionId === this.state.commanderSessionId),
      createdBySessionId: actorSessionId,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      revision: 1,
    }
    this.state.knowledge.push(entry)
    await this.commit()
    return entry
  }

  async updateKnowledge(
    id: string,
    patch: KnowledgePatch,
    actorSessionId: string | null,
  ): Promise<KnowledgeEntry> {
    this.writable()
    const entry = this.state.knowledge.find((candidate) => candidate.id === id)
    if (!entry) throw new OrchestrationError(404, 'not_found', 'Knowledge entry not found.')
    const isWorker = Boolean(actorSessionId) && actorSessionId !== this.state.commanderSessionId
    if (isWorker && actorSessionId !== entry.createdBySessionId) {
      throw new OrchestrationError(
        403,
        'forbidden',
        'Only the author or commander can change this entry.',
      )
    }
    if (isWorker && entry.always) {
      throw new OrchestrationError(
        403,
        'forbidden',
        'Pinned knowledge can only be changed by the commander or human.',
      )
    }
    this.revision(entry.revision, patch.expectedRevision)
    const draft: KnowledgeEntry = {
      ...entry,
      title:
        patch.title !== undefined ? requiredText(patch.title, 'Knowledge title', 180) : entry.title,
      body:
        patch.body !== undefined ? requiredText(patch.body, 'Knowledge body', 8000) : entry.body,
      tags:
        patch.tags !== undefined
          ? [...new Set(patch.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 12)
          : entry.tags,
      projectPath:
        patch.projectPath !== undefined ? normalizeProject(patch.projectPath) : entry.projectPath,
      always:
        patch.always !== undefined
          ? patch.always && (!actorSessionId || actorSessionId === this.state.commanderSessionId)
          : entry.always,
      archivedAt:
        patch.archived !== undefined ? (patch.archived ? this.now() : null) : entry.archivedAt,
      updatedAt: this.now(),
      revision: entry.revision + 1,
    }
    const index = this.state.knowledge.indexOf(entry)
    this.state.knowledge[index] = draft
    await this.commit()
    return draft
  }

  async requestDecision(input: DecisionInput, actorSessionId: string): Promise<DecisionRequest> {
    this.writable()
    this.session(actorSessionId)
    if (this.state.decisions.filter((decision) => !decision.resolvedAt).length >= MAX_DECISIONS) {
      throw new OrchestrationError(409, 'limit_reached', 'Too many decisions are still open.')
    }
    const task = input.taskId ? this.task(input.taskId) : null
    if (task) this.canMutateTask(task, actorSessionId)
    const decision: DecisionRequest = {
      id: `decision_${randomUUID()}`,
      question: requiredText(input.question, 'Question', 2000),
      context: optionalText(input.context, 'Decision context', 5000),
      taskId: task?.id ?? null,
      requestedBySessionId: actorSessionId,
      createdAt: this.now(),
      resolvedAt: null,
      answer: null,
      delivery: null,
    }
    this.state.decisions.push(decision)
    if (task) {
      task.status = 'blocked'
      task.lastNote = decision.question
      task.updatedAt = this.now()
      task.revision += 1
      this.activity(task, actorSessionId, 'decision', `Human input requested: ${decision.question}`)
    }
    this.systemUpdate(
      'question',
      `Waiting on you: ${oneLine(decision.question, 140)}`,
      decision.context ?? '',
      { projectPath: task?.projectPath ?? null, taskIds: task ? [task.id] : [] },
    )
    await this.commit()
    return decision
  }

  async resolveDecision(id: string, answerInput: string): Promise<DecisionRequest> {
    this.writable()
    const decision = this.state.decisions.find((candidate) => candidate.id === id)
    if (!decision) throw new OrchestrationError(404, 'not_found', 'Decision not found.')
    if (decision.resolvedAt)
      throw new OrchestrationError(409, 'already_resolved', 'This decision is already resolved.')
    const answer = requiredText(answerInput, 'Answer', 6000)
    decision.answer = answer
    decision.resolvedAt = this.now()
    const task = decision.taskId ? this.task(decision.taskId) : null
    const target = this.options.getSession(decision.requestedBySessionId)
    const lines = [`Question: ${decision.question}`, `Answer: ${answer}`]
    let delivery: PromptResult
    if (target?.live && target.status !== 'ended') {
      delivery = await this.options.sendPrompt(
        target.id,
        [
          `[Human decision ${decision.id}]`,
          ...lines,
          task
            ? `Continue task ${task.id} (${task.title}) and report progress with update_task.`
            : 'Continue with this answer.',
        ].join('\n'),
      )
    } else {
      // The session that asked is gone. A stored answer nobody reads is the same
      // as no answer — the worker stays blocked — so the commander takes over
      // and is told which session and task it concerns.
      const commanderId = this.state.commanderSessionId
      const worker = task?.assigneeSessionId
        ? this.options.getSession(task.assigneeSessionId)
        : null
      delivery =
        commanderId && this.options.getSession(commanderId)
          ? await this.options.sendPrompt(
              commanderId,
              [
                `[Human decision ${decision.id}] The session that asked (${shortId(decision.requestedBySessionId)}) is not running, so apply it yourself.`,
                ...lines,
                task ? `Task ${task.id}: ${task.title}` : 'No task is attached.',
                worker && task?.assigneeSessionId
                  ? `Worker ${shortId(task.assigneeSessionId)} is ${worker.status}${worker.live ? ' (live)' : ''} — resume it, wake it, or dispatch a replacement.`
                  : 'No worker holds this task right now.',
              ].join('\n'),
            )
          : failedDispatch(
              'The requesting session has ended and no commander is running to take the answer.',
            )
    }
    decision.delivery = delivery

    if (task && task.status === 'blocked') {
      const otherOpen = this.state.decisions.some(
        (candidate) =>
          candidate.id !== decision.id && candidate.taskId === task.id && !candidate.resolvedAt,
      )
      task.updatedAt = this.now()
      task.revision += 1
      this.activity(task, null, 'decision', `Human answered: ${answer}`)
      if (otherOpen) {
        task.lastNote = `Human answered one question; another decision is still open. ${answer}`
      } else if (!delivery.ok) {
        task.lastNote = `Answer saved, but delivery failed: ${delivery.error ?? 'unknown error'}`
      } else {
        // Delivery is not execution. The worker must report in_progress itself.
        task.status = 'queued'
        task.lastNote = `Human answered: ${answer}`
      }
    }
    this.systemUpdate('status', `Answered: ${oneLine(decision.question, 140)}`, answer, {
      projectPath: task?.projectPath ?? null,
      taskIds: task ? [task.id] : [],
    })
    await this.commit()
    return decision
  }

  /** Context for SessionStart and UserPromptSubmit, scoped to this session. */
  contextFor(sessionId: string, reason: 'start' | 'prompt'): string | null {
    const self = this.options.getSession(sessionId)
    const commander = sessionId === this.state.commanderSessionId
    const assigned = this.state.tasks.filter(
      (task) =>
        task.assigneeSessionId === sessionId && !['done', 'cancelled'].includes(task.status),
    )
    const requested = this.state.decisions.filter(
      (decision) => decision.requestedBySessionId === sessionId && !decision.resolvedAt,
    )
    const relevant = this.state.knowledge.filter(
      (entry) => !entry.archivedAt && this.relevant(entry, self),
    )
    const knowledge = reason === 'start' ? relevant : relevant.filter((entry) => entry.always)
    const ownedEpics = this.state.epics.filter(
      (epic) =>
        epic.ownerSessionId === sessionId && epic.status !== 'done' && epic.status !== 'cancelled',
    )
    const unanswered = ownedEpics.flatMap((epic) =>
      epic.messages
        .filter((message) => !message.authorSessionId && !message.deliveredAt)
        .map((message) => ({ epic, message })),
    )
    if (
      reason === 'prompt' &&
      !commander &&
      !assigned.length &&
      !requested.length &&
      !knowledge.length &&
      !ownedEpics.length
    )
      return null

    const lines = ['[csm-command-center]']
    if (commander) {
      lines.push(
        'You are the designated commander: dispatch and verify, never do the work yourself. Use get_command_center before planning, list_sessions to choose workers, create_task to delegate (auto-dispatch), spawn_task to start a new session when no live worker can take the work, update_task to review/finish, share_knowledge for durable facts, and request_decision when the human must answer — always through these tools, never curl. Delegate in the same turn instead of only planning; do not read repository code, grep, build, test, edit files or spawn subagents — delegate a read-only discovery task instead. Then post one short report_status round-up so the human sees what is running where. Keep monitoring and report milestones, blockers and completions with report_status. A new goal may arrive for any project at any time: accept it in parallel without dropping current work. Workers finish in review; only mark done after verification.',
        'Every large goal belongs to an epic. When the human hands you a new big task, attach it to the fitting existing epic or open one with create_epic, then hand it to a dedicated epic commander with spawn_epic_commander so its details do not crowd your context. The epic status_line is one or two short sentences and is what the human reads on the overview; keep it current with update_epic. Human questions in an epic thread are answered there with post_epic_message, not in this chat.',
      )
    } else if (ownedEpics.length) {
      lines.push(
        "You are the commander of the epic(s) below: plan, delegate with create_task/spawn_task using the epic_id, verify results, and answer the human in the epic thread with post_epic_message. Keep each status_line to one or two short sentences with update_epic; it is the human's only overview of this goal. Do not report in the main chat.",
      )
    } else {
      lines.push(
        'Command-center tools: get_command_center shows your assigned work; update_task reports explicit status/progress/notes; request_decision asks the human and blocks the task; share_knowledge publishes a searchable peer note. Set status review with a result when finished, not done.',
      )
    }
    if (assigned.length) {
      lines.push('', 'Your active delegated tasks:')
      for (const task of assigned.slice(0, 12)) {
        const epic = task.epicId
          ? this.state.epics.find((candidate) => candidate.id === task.epicId)
          : null
        lines.push(
          `- ${task.id} [${task.status}, ${task.progress}%] ${task.title}: ${truncate(task.brief.replace(/\s+/g, ' '), 700)}`,
        )
        if (epic) {
          lines.push(
            `  Epic: ${epic.title} (${epic.id})${epic.statusLine ? ` — ${epic.statusLine}` : ''}`,
          )
        }
        if (task.lastNote) lines.push(`  Latest: ${oneLine(task.lastNote, 300)}`)
      }
    }
    if (ownedEpics.length) {
      lines.push('', 'Your epics:')
      for (const epic of ownedEpics.slice(0, 8)) {
        const linked = this.state.tasks.filter(
          (task) => task.epicId === epic.id && task.status !== 'cancelled',
        )
        const open = linked.filter((task) => !['done', 'cancelled'].includes(task.status))
        const counts = ['queued', 'in_progress', 'blocked', 'review']
          .map((status) => [status, open.filter((task) => task.status === status).length] as const)
          .filter(([, count]) => count > 0)
          .map(([status, count]) => `${count} ${status.replace('_', ' ')}`)
        lines.push(
          `- ${epic.id} "${epic.title}" [${epic.status}]${epic.statusLine ? ` — ${epic.statusLine}` : ' — no status line yet'}`,
        )
        lines.push(
          `  ${open.length ? `Open: ${counts.join(', ')}` : 'No open tasks'}${epic.repositories.length ? ` · ${this.repoNames(epic)}` : ''}`,
        )
        const pending = epic.messages.filter(
          (message) => !message.authorSessionId && !message.deliveredAt,
        )
        if (pending.length)
          lines.push(`  ${pending.length} unanswered human message(s) in the thread.`)
      }
    }
    if (unanswered.length) {
      lines.push('', 'Unanswered human messages in your epic threads:')
      for (const { epic, message } of unanswered.slice(0, 6)) {
        lines.push(`- ${epic.id} "${epic.title}" (${message.id}): ${truncate(message.body, 900)}`)
      }
      lines.push(
        'Answer each one with post_epic_message in that epic. If it requires work, create tasks with the epic_id in the same turn.',
      )
      if (!this.options.readOnly()) {
        for (const { message } of unanswered) message.deliveredAt = this.now()
        // The messages are in this prompt now; persist that so they are not repeated.
        void this.commit()
      }
    }
    if (requested.length) {
      lines.push(
        '',
        `You have ${requested.length} decision request(s) waiting for the human; keep their tasks blocked until an answer arrives.`,
      )
    }
    if (knowledge.length) {
      lines.push(
        '',
        reason === 'start'
          ? 'Shared knowledge relevant to your project (use list_knowledge for fresh/full entries):'
          : 'Pinned shared knowledge:',
      )
      for (const entry of knowledge.slice(0, reason === 'start' ? 20 : 10)) {
        lines.push(
          `- ${entry.title}${entry.projectPath ? ` [${entry.projectPath}]` : ' [global]'}: ${truncate(entry.body, reason === 'start' ? 2000 : 1200)}`,
        )
      }
      if (knowledge.length > (reason === 'start' ? 20 : 10))
        lines.push('More entries are available through list_knowledge.')
    }
    lines.push('[/csm-command-center]')
    return truncate(lines.join('\n'), MAX_CONTEXT)
  }

  private relevant(
    entry: KnowledgeEntry,
    self: SessionSummary | null,
    scope?: string | null,
  ): boolean {
    if (!entry.projectPath) return true
    // A task can be delegated into another project. Its explicit project wins;
    // otherwise match the actual working directory before the repository root.
    const own = scope !== undefined ? scope : (self?.projectPath ?? self?.repoRoot ?? null)
    return Boolean(own && isWithin(own, entry.projectPath))
  }

  private taskPrompt(task: DelegatedTask, session: SessionSummary | null): string {
    const project = task.projectPath ?? session?.projectPath ?? null
    const knowledge = this.state.knowledge.filter(
      (entry) => !entry.archivedAt && entry.always && this.relevant(entry, session, project),
    )
    const knowledgeLines: string[] = []
    let used = 0
    for (const entry of knowledge.slice(0, 8)) {
      const remaining = MAX_TASK_KNOWLEDGE - used
      if (remaining < 200) break
      const line = `- ${entry.title}: ${truncate(entry.body, Math.min(1200, remaining))}`
      knowledgeLines.push(line)
      used += line.length
    }
    if (knowledge.length > knowledgeLines.length) {
      knowledgeLines.push('More pinned entries are available through list_knowledge.')
    }
    const epic = task.epicId
      ? this.state.epics.find((candidate) => candidate.id === task.epicId)
      : null
    return [
      `[Delegated task ${task.id}]`,
      `Title: ${task.title}`,
      `Priority: ${task.priority}`,
      `Project: ${project}`,
      ...(epic
        ? [
            `Epic: ${epic.title} (${epic.id})`,
            ...(epic.statusLine ? [`Epic status: ${epic.statusLine}`] : []),
          ]
        : []),
      '',
      'Brief:',
      task.brief,
      '',
      'This task is tracked in Claude Session Manager. Call update_task with this exact task_id when you start, whenever meaningful progress happens, and if you become blocked. Report a percentage plus a short concrete note. If only the human can unblock you, call request_decision with the task_id. When the implementation and verification are complete, set status review, progress 100 and a useful result; the commander marks it done after review.',
      ...(knowledgeLines.length ? ['', 'Pinned shared knowledge:', ...knowledgeLines] : []),
    ].join('\n')
  }

  private session(id: string): SessionSummary {
    const session = this.options.getSession(id)
    if (!session) throw new OrchestrationError(404, 'not_found', 'Unknown session.')
    return session
  }

  private liveSession(id: string, label: string): SessionSummary {
    const session = this.session(id)
    if (!session.live || session.status === 'ended') {
      throw new OrchestrationError(
        409,
        'session_offline',
        `${label} is not running. Resume or choose another session.`,
      )
    }
    return session
  }

  private task(id: string): DelegatedTask {
    const task = this.state.tasks.find((candidate) => candidate.id === id)
    if (!task) throw new OrchestrationError(404, 'not_found', 'Task not found.')
    return task
  }

  private requireCommander(actorSessionId: string | null, action: string): void {
    if (!actorSessionId) return
    if (actorSessionId !== this.state.commanderSessionId) {
      throw new OrchestrationError(
        403,
        'commander_required',
        `Only the main session can ${action}.`,
      )
    }
  }

  private canMutateTask(task: DelegatedTask, actorSessionId: string | null): void {
    if (!actorSessionId || actorSessionId === this.state.commanderSessionId) return
    if (task.assigneeSessionId === actorSessionId) return
    if (task.epicId && this.isEpicOwner(task.epicId, actorSessionId)) return
    throw new OrchestrationError(
      403,
      'forbidden',
      'Only the assignee, the epic owner or the commander can update this task.',
    )
  }

  /** The main commander, the human, and any session that owns an open epic. */
  private requireDispatcher(actorSessionId: string | null, action: string): void {
    if (!actorSessionId) return
    if (actorSessionId === this.state.commanderSessionId) return
    if (
      this.state.epics.some(
        (epic) =>
          epic.ownerSessionId === actorSessionId &&
          epic.status !== 'done' &&
          epic.status !== 'cancelled',
      )
    )
      return
    throw new OrchestrationError(
      403,
      'commander_required',
      `Only the main session or an epic owner can ${action}.`,
    )
  }

  private epic(id: string): Epic {
    const epic = this.state.epics.find((candidate) => candidate.id === id)
    if (!epic) throw new OrchestrationError(404, 'not_found', 'Epic not found.')
    return epic
  }

  private isEpicOwner(epicId: string, actorSessionId: string | null): boolean {
    if (!actorSessionId) return false
    return this.state.epics.some(
      (epic) => epic.id === epicId && epic.ownerSessionId === actorSessionId,
    )
  }

  private canMutateEpic(epic: Epic, actorSessionId: string | null): void {
    if (!actorSessionId || actorSessionId === this.state.commanderSessionId) return
    if (epic.ownerSessionId === actorSessionId) return
    throw new OrchestrationError(
      403,
      'forbidden',
      'Only the commander, the epic owner or the human can update this epic.',
    )
  }

  private canMessageEpic(epic: Epic, actorSessionId: string | null): void {
    if (!actorSessionId || actorSessionId === this.state.commanderSessionId) return
    if (epic.ownerSessionId === actorSessionId) return
    throw new OrchestrationError(
      403,
      'forbidden',
      'Only the human, the commander or the epic owner can write in this epic.',
    )
  }

  private repositories(value: string[] | undefined): string[] {
    if (!value) return []
    const unique: string[] = []
    for (const item of value.slice(0, 20)) {
      if (typeof item !== 'string' || !item.trim()) {
        throw new OrchestrationError(400, 'bad_request', 'Repositories must be paths.')
      }
      const resolved = path.resolve(item.trim())
      if (!unique.includes(resolved)) unique.push(resolved)
    }
    return unique
  }

  private previewUrl(value: string | null | undefined): string | null {
    if (value === null || value === undefined || value === '') return null
    const text = value.trim()
    let url: URL
    try {
      url = new URL(text)
    } catch {
      throw new OrchestrationError(400, 'bad_request', 'The preview must be an http(s) URL.')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new OrchestrationError(400, 'bad_request', 'The preview must be an http(s) URL.')
    }
    return text
  }

  private repoNames(epic: Epic): string {
    return epic.repositories.map((repo) => path.basename(repo)).join(', ')
  }

  private pushEpicMessage(
    epic: Epic,
    actorSessionId: string | null,
    kind: EpicMessage['kind'],
    body: string,
  ): void {
    epic.messages.push({
      id: `epicmsg_${randomUUID()}`,
      at: this.now(),
      authorSessionId: actorSessionId,
      kind,
      body: truncate(body, 8000),
      deliveredAt: this.now(),
    })
    if (epic.messages.length > MAX_EPIC_MESSAGES) {
      epic.messages.splice(0, epic.messages.length - MAX_EPIC_MESSAGES)
    }
  }

  /** Wake the epic owner with a human question, or leave it for its next prompt. */
  private async deliverEpicMessage(epic: Epic, message: EpicMessage): Promise<void> {
    const owner = epic.ownerSessionId
    if (!owner) {
      await this.nudgeCommander(
        [
          `[Epic ${epic.id}] The human wrote in "${epic.title}":`,
          truncate(message.body, 1500),
          'No epic commander owns it yet. Answer in the epic thread with post_epic_message, or start one with spawn_epic_commander, and keep the status line current.',
        ].join('\n'),
      )
      return
    }
    const session = this.options.getSession(owner)
    if (!session?.live || session.status === 'ended') {
      // The owner is not running, so the message cannot be delivered. It stays
      // pending (the epic page says "not read yet") and the main commander gets
      // told, because restarting or replacing that epic commander is its job.
      await this.nudgeCommander(
        [
          `[Epic ${epic.id}] The human wrote in "${epic.title}":`,
          truncate(message.body, 1500),
          `Its epic commander (${shortId(owner)}) is not running, so the message waits. Answer in the epic thread with post_epic_message, or start a new epic commander with spawn_epic_commander.`,
        ].join('\n'),
      )
      return
    }
    const result = await this.options
      .sendPrompt(owner, this.epicMessagePrompt(epic, message))
      .catch(() => ({ ok: false as const, mode: 'queued' as const, error: 'Delivery failed.' }))
    // Only a typed prompt proves the owner actually read it. A queued prompt
    // waits in the owner's inbox for its next turn, so the message must stay
    // pending: the UI then says "not read yet", and contextFor injects it with
    // that turn (marking it read) instead of losing it.
    if (result.ok && result.mode === 'typed') message.deliveredAt = this.now()
  }

  private epicMessagePrompt(epic: Epic, message: EpicMessage): string {
    return [
      `[Epic ${epic.id}] The human wrote in "${epic.title}":`,
      '',
      truncate(message.body, 4000),
      '',
      `Answer in the epic thread with post_epic_message (epic_id ${epic.id}), not in the main chat. Keep the status line current with update_epic (status_line). If this changes the plan, create_task with epic_id ${epic.id}.`,
    ].join('\n')
  }

  /** The brief a freshly started epic commander receives. */
  private epicCommanderPrompt(epic: Epic): string {
    const tasks = this.state.tasks.filter(
      (task) => task.epicId === epic.id && task.status !== 'cancelled',
    )
    const open = tasks.filter((task) => task.status !== 'done')
    const lines = [
      `[Epic commander] You own the epic "${epic.title}" (${epic.id}).`,
      '',
      'This is a larger goal the human handed to the main commander. You are its dedicated commander: plan it, split it into tasks, dispatch workers, verify their results, and keep the epic current. The human reads the epic page, not the main chat, for this goal.',
      epic.goal ? `\nGoal:\n${epic.goal}` : '',
      epic.repositories.length ? `\nRepositories: ${epic.repositories.join(', ')}` : '',
      epic.statusLine ? `\nCurrent status line: ${epic.statusLine}` : '',
      '',
      'How to run it:',
      `- Read the current state with get_command_center (epic ${epic.id}, its tasks and the epic thread) and list_sessions.`,
      `- Create every task with epic_id ${epic.id} (create_task, or spawn_task when no live idle worker can take it). Assign to matching sessions; do not do the implementation work yourself unless the human asks.`,
      '- When a task is ready it arrives in review: verify the evidence, then update_task to done or send it back with a concrete note.',
      '- After every meaningful step, call update_epic with a status_line of one or two short sentences (where it stands, what runs next) and status active/blocked/done. That line is the only epic status the human reads.',
      '- The human can write in the epic thread at any time. Answer there with post_epic_message; if the answer needs an action, create tasks in the same turn.',
      '- Never claim work started before a worker reports in. Never write credentials or keystore contents into the thread.',
      '',
      open.length
        ? `Open tasks already linked (${open.length}):\n${open
            .slice(0, 12)
            .map((task) => `- ${task.id} [${task.status}, ${task.progress}%] ${task.title}`)
            .join('\n')}`
        : 'No tasks are linked yet. Start by writing a short plan into the epic thread, then delegate the first tasks.',
    ]
    return lines.filter((line) => line !== '').join('\n')
  }

  private revision(actual: number, expected: number | undefined): void {
    if (expected !== undefined && actual !== expected) {
      throw new OrchestrationError(
        409,
        'revision_conflict',
        `This item changed meanwhile (current revision ${actual}). Refresh and retry.`,
      )
    }
  }

  private writable(): void {
    if (this.options.readOnly())
      throw new OrchestrationError(403, 'read_only', 'The daemon is read-only.')
  }

  private activity(
    task: DelegatedTask,
    actorSessionId: string | null,
    kind: TaskActivity['kind'],
    text: string,
  ): void {
    task.activities.push({
      id: `activity_${randomUUID()}`,
      at: this.now(),
      actorSessionId,
      kind,
      text: truncate(text, 3000),
    })
    if (task.activities.length > MAX_ACTIVITIES)
      task.activities.splice(0, task.activities.length - MAX_ACTIVITIES)
  }

  private async commit(): Promise<void> {
    const contents = `${JSON.stringify({ ...this.state, version: 1 }, null, 2)}\n`
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(() => atomicWriteFile(this.file, contents))
    await this.saveChain
    this.options.onChange(this.snapshot())
  }
}
