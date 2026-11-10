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
  KnowledgeEntry,
  KnowledgeInput,
  KnowledgePatch,
  LaunchSessionInput,
  LaunchSessionResult,
  PromptResult,
  SessionSummary,
  TaskActivity,
} from '../shared/types.js'
import { atomicWriteFile, ensureDir, oneLine, truncate } from './util.js'

const MAX_TASKS = 500
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
    knowledge: [],
    decisions: [],
    commands: [],
    updates: [],
  }
}

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

function sanitizeState(value: unknown): PersistedCommandCenter {
  if (!value || typeof value !== 'object') throw new Error('Invalid command center state')
  const input = value as Partial<PersistedCommandCenter>
  return {
    version: 1,
    commanderSessionId:
      typeof input.commanderSessionId === 'string' ? input.commanderSessionId : null,
    tasks: Array.isArray(input.tasks) ? (input.tasks as DelegatedTask[]) : [],
    knowledge: Array.isArray(input.knowledge) ? (input.knowledge as KnowledgeEntry[]) : [],
    decisions: Array.isArray(input.decisions) ? (input.decisions as DecisionRequest[]) : [],
    commands: Array.isArray(input.commands) ? (input.commands as CommanderCommand[]) : [],
    updates: Array.isArray(input.updates) ? (input.updates as CommanderUpdate[]) : [],
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
    this.requireCommander(actorSessionId, 'post commander updates')
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
    const update: CommanderUpdate = {
      id: `update_${randomUUID()}`,
      at: this.now(),
      kind: input.kind ?? 'status',
      title: requiredText(input.title, 'Update title', 180),
      body: requiredText(input.body, 'Update body', 4000),
      projectPath: normalizeProject(input.projectPath) ?? firstTask?.projectPath ?? null,
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
    options: { projectPath?: string | null; taskIds?: string[] } = {},
  ): void {
    this.state.updates.push({
      id: `update_${randomUUID()}`,
      at: this.now(),
      kind,
      title: truncate(title, 180),
      body: truncate(body, 4000),
      projectPath: options.projectPath ?? null,
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
      'Work like this, every time: (1) turn the goal into concrete tasks right away with list_sessions and create_task — assignment dispatches them automatically, so do not stop at describing a plan; (2) right after delegating, call report_status once with a short round-up: which agents are on which feature, in which project, and what you will check next; (3) keep monitoring with get_command_center, verify review results with update_task, reassign or retry blocked work; (4) report meaningful milestones, blockers and completions with report_status so the human sees the state without asking; (5) the human may send the next goal for a completely different project at any moment — start it in parallel and never drop, block or serialise work already in motion.',
      'Use update_task for your own conclusions, record durable cross-session facts with share_knowledge, and use request_decision whenever only the human can decide. Workers report completion into review; verify their results before marking a task done.',
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
          `- ${task.id} [${task.status}, ${task.progress}%] ${oneLine(task.title, 100)} → ${name(task.assigneeSessionId)}${task.lastNote ? ` · ${oneLine(task.lastNote, 160)}` : ''}`,
        )
      }
      if (open.length > 12) lines.push(`- … ${open.length - 12} more via get_command_center.`)
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
    this.requireCommander(actorSessionId, 'create tasks')
    if (this.state.tasks.length >= MAX_TASKS) {
      throw new OrchestrationError(
        409,
        'limit_reached',
        `The ledger holds at most ${MAX_TASKS} tasks.`,
      )
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
        input.projectPath ?? assignee?.repoRoot ?? assignee?.projectPath,
      ),
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
      { projectPath: task.projectPath, taskIds: [task.id] },
    )
    await this.commit()
    if (assignee) await this.dispatchTask(task.id, actorSessionId)
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
    if (actorSessionId && actorSessionId !== this.state.commanderSessionId) {
      if (
        patch.title !== undefined ||
        patch.brief !== undefined ||
        patch.priority !== undefined ||
        patch.projectPath !== undefined ||
        patch.assigneeSessionId !== undefined
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
          'Only the commander or human can close a task.',
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

    const draft: DelegatedTask = {
      ...task,
      title,
      brief,
      priority: patch.priority ?? task.priority,
      projectPath,
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
          { projectPath: draft.projectPath, taskIds: [draft.id] },
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
    if (
      draft.status === 'review' &&
      task.status !== 'review' &&
      actorSessionId !== this.state.commanderSessionId
    ) {
      await this.nudgeCommander(
        [
          `[Command center] Task ${draft.id} "${draft.title}" is ready for review.`,
          draft.result ? `Result: ${truncate(draft.result, 1500)}` : '',
          'Check the work with get_command_center, then update_task status done or send it back with a concrete note, and post the outcome with report_status.',
        ]
          .filter(Boolean)
          .join('\n'),
      )
    }
    return draft
  }

  /** A short prompt to the commander; a dead or absent commander is not an error. */
  private async nudgeCommander(text: string): Promise<void> {
    const commanderId = this.state.commanderSessionId
    if (!commanderId || !this.options.getSession(commanderId)) return
    await this.options.sendPrompt(commanderId, text).catch(() => undefined)
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
    const delivery = target?.live
      ? await this.options.sendPrompt(
          target.id,
          [
            `[Human decision ${decision.id}]`,
            `Question: ${decision.question}`,
            `Answer: ${answer}`,
            task
              ? `Continue task ${task.id} (${task.title}) and report progress with update_task.`
              : 'Continue with this answer.',
          ].join('\n'),
        )
      : failedDispatch(
          'The requesting session has ended. Resume it and send the answer from its session page.',
        )
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
    if (
      reason === 'prompt' &&
      !commander &&
      !assigned.length &&
      !requested.length &&
      !knowledge.length
    )
      return null

    const lines = ['[csm-command-center]']
    if (commander) {
      lines.push(
        'You are the designated commander. Use get_command_center before planning, list_sessions to choose workers, create_task to delegate (auto-dispatch), update_task to review/finish, share_knowledge for durable facts, and request_decision when the human must answer. Delegate in the same turn instead of only planning, then post one short report_status round-up so the human sees what is running where. Keep monitoring and report milestones, blockers and completions with report_status. A new goal may arrive for any project at any time: accept it in parallel without dropping current work. Workers finish in review; only mark done after verification.',
      )
    } else {
      lines.push(
        'Command-center tools: get_command_center shows your assigned work; update_task reports explicit status/progress/notes; request_decision asks the human and blocks the task; share_knowledge publishes a searchable peer note. Set status review with a result when finished, not done.',
      )
    }
    if (assigned.length) {
      lines.push('', 'Your active delegated tasks:')
      for (const task of assigned.slice(0, 12)) {
        lines.push(
          `- ${task.id} [${task.status}, ${task.progress}%] ${task.title}: ${truncate(task.brief.replace(/\s+/g, ' '), 700)}`,
        )
        if (task.lastNote) lines.push(`  Latest: ${oneLine(task.lastNote, 300)}`)
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

  private taskPrompt(task: DelegatedTask, session: SessionSummary): string {
    const project = task.projectPath ?? session.projectPath
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
    return [
      `[Delegated task ${task.id}]`,
      `Title: ${task.title}`,
      `Priority: ${task.priority}`,
      `Project: ${project}`,
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
    if (task.assigneeSessionId !== actorSessionId) {
      throw new OrchestrationError(
        403,
        'forbidden',
        'Only the assignee or commander can update this task.',
      )
    }
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
