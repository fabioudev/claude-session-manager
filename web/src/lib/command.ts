import type {
  CommandCenterSnapshot,
  CommanderUpdate,
  DelegatedTask,
  DelegatedTaskStatus,
  PendingQuestion,
  SessionSummary,
} from '@shared/types'

export interface TaskColumn {
  status: DelegatedTaskStatus
  label: string
  description: string
  tasks: DelegatedTask[]
}

export const TASK_COLUMN_META: ReadonlyArray<Pick<TaskColumn, 'status' | 'label' | 'description'>> =
  [
    { status: 'queued', label: 'Queue', description: 'Assigned or waiting for a worker' },
    { status: 'in_progress', label: 'In motion', description: 'Workers have reported in' },
    { status: 'blocked', label: 'Blocked', description: 'Waiting on an answer or delivery' },
    { status: 'review', label: 'Review', description: 'Ready for commander verification' },
    { status: 'done', label: 'Done', description: 'Verified and closed' },
  ]

export function taskColumns(tasks: DelegatedTask[], includeDone = true): TaskColumn[] {
  return TASK_COLUMN_META.filter((column) => includeDone || column.status !== 'done').map(
    (column) => ({
      ...column,
      tasks: tasks
        .filter((task) => task.status === column.status)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    }),
  )
}

export interface CommandStats {
  active: number
  inProgress: number
  review: number
  openDecisions: number
  doneToday: number
  averageProgress: number
}

export function commandStats(commandCenter: CommandCenterSnapshot, now = Date.now()): CommandStats {
  const active = commandCenter.tasks.filter(
    (task) => task.status !== 'done' && task.status !== 'cancelled',
  )
  const today = new Date(now).toDateString()
  return {
    active: active.length,
    inProgress: active.filter((task) => task.status === 'in_progress').length,
    review: active.filter((task) => task.status === 'review').length,
    openDecisions: commandCenter.decisions.filter((decision) => !decision.resolvedAt).length,
    doneToday: commandCenter.tasks.filter(
      (task) =>
        task.status === 'done' &&
        task.completedAt !== null &&
        new Date(task.completedAt).toDateString() === today,
    ).length,
    averageProgress: active.length
      ? Math.round(active.reduce((sum, task) => sum + task.progress, 0) / active.length)
      : 0,
  }
}

export function offlineAssignments(
  tasks: DelegatedTask[],
  sessions: SessionSummary[],
): DelegatedTask[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  return tasks.filter((task) => {
    if (!task.assigneeSessionId || ['done', 'cancelled', 'blocked'].includes(task.status)) {
      return false
    }
    const session = byId.get(task.assigneeSessionId)
    return !session?.live || session.status === 'ended'
  })
}

/** Questions worth showing: those from sessions that have not ended. */
export function visibleQuestions(
  questions: PendingQuestion[],
  sessions: SessionSummary[],
): PendingQuestion[] {
  const ended = new Set(
    sessions.filter((session) => session.status === 'ended').map((session) => session.id),
  )
  return questions.filter((question) => !ended.has(question.sessionId))
}

export interface FeatureGroup {
  key: string
  label: string
  projectPath: string | null
  tasks: DelegatedTask[]
  inProgress: number
  review: number
  blocked: number
  queued: number
  averageProgress: number
  lastActivityAt: number
}

function projectLabel(projectPath: string | null): string {
  if (!projectPath) return 'Unassigned'
  const parts = projectPath.split('/').filter(Boolean)
  return parts[parts.length - 1] || projectPath
}

/**
 * Open work grouped by project — the answer to "which features are being
 * worked on, and where does each stand?".
 */
export function featureGroups(tasks: DelegatedTask[]): FeatureGroup[] {
  const groups = new Map<string, FeatureGroup>()
  for (const task of tasks) {
    if (task.status === 'done' || task.status === 'cancelled') continue
    const key = task.projectPath ?? ''
    let group = groups.get(key)
    if (!group) {
      group = {
        key: key || 'unassigned',
        label: projectLabel(task.projectPath),
        projectPath: task.projectPath,
        tasks: [],
        inProgress: 0,
        review: 0,
        blocked: 0,
        queued: 0,
        averageProgress: 0,
        lastActivityAt: 0,
      }
      groups.set(key, group)
    }
    group.tasks.push(task)
    group.lastActivityAt = Math.max(group.lastActivityAt, task.updatedAt)
    if (task.status === 'in_progress') group.inProgress += 1
    else if (task.status === 'review') group.review += 1
    else if (task.status === 'blocked') group.blocked += 1
    else group.queued += 1
  }
  return [...groups.values()]
    .map((group) => {
      const progress = group.tasks.reduce(
        (sum, task) => sum + (task.status === 'review' ? 100 : task.progress),
        0,
      )
      return {
        ...group,
        tasks: group.tasks.sort((a, b) => b.updatedAt - a.updatedAt),
        averageProgress: Math.round(progress / group.tasks.length),
      }
    })
    .sort(
      (a, b) =>
        b.blocked + b.review - (a.blocked + a.review) || b.lastActivityAt - a.lastActivityAt,
    )
}

export type ChannelEntry =
  | { type: 'command'; id: string; at: number; text: string; ok: boolean; mode: string }
  | { type: 'update'; id: string; at: number; update: CommanderUpdate }
  | { type: 'reply'; id: string; at: number; text: string }

/** Something the main session said in its own chat, not through report_status. */
export interface CommanderReply {
  id: string
  at: number
  text: string
}

/** Human commands, commander reports and its plain answers in one conversation. */
export function commanderFeed(
  commandCenter: CommandCenterSnapshot,
  limit = 60,
  replies: CommanderReply[] = [],
): ChannelEntry[] {
  const entries: ChannelEntry[] = [
    ...commandCenter.commands.map((command) => ({
      type: 'command' as const,
      id: command.id,
      at: command.createdAt,
      text: command.text,
      ok: command.result.ok,
      mode: command.result.mode,
    })),
    ...commandCenter.updates.map((update) => ({
      type: 'update' as const,
      id: update.id,
      at: update.at,
      update,
    })),
    ...replies.map((reply) => ({
      type: 'reply' as const,
      id: reply.id,
      at: reply.at,
      text: reply.text,
    })),
  ].sort((a, b) => a.at - b.at)
  return entries.slice(-limit)
}

export type CommanderMessage =
  | { type: 'update'; at: number; update: CommanderUpdate }
  | { type: 'reply'; at: number; reply: CommanderReply }

/**
 * What the main session said last — a report it filed or an answer it typed.
 * Answers matter: a commander that replies in chat without filing a report
 * would otherwise look silent on the command page.
 */
export function latestCommanderMessage(
  commandCenter: CommandCenterSnapshot,
  replies: CommanderReply[] = [],
): CommanderMessage | null {
  const update = latestCommanderUpdate(commandCenter)
  let reply: CommanderReply | null = null
  for (const candidate of replies) {
    if (!reply || candidate.at > reply.at) reply = candidate
  }
  if (!update) return reply ? { type: 'reply', at: reply.at, reply } : null
  if (!reply) return { type: 'update', at: update.at, update }
  return reply.at > update.at
    ? { type: 'reply', at: reply.at, reply }
    : { type: 'update', at: update.at, update }
}

/**
 * The single report shown next to the composer. The snapshot already sorts
 * reports newest first, but sorting here keeps the helper independent of the
 * API's ordering.
 */
export function latestCommanderUpdate(
  commandCenter: CommandCenterSnapshot,
): CommanderUpdate | null {
  let latest: CommanderUpdate | null = null
  for (const update of commandCenter.updates) {
    if (!latest || update.at > latest.at) latest = update
  }
  return latest
}

export function activeKnowledge(commandCenter: CommandCenterSnapshot, query: string) {
  const needle = query.trim().toLowerCase()
  return commandCenter.knowledge.filter((entry) => {
    if (entry.archivedAt) return false
    if (!needle) return true
    return [entry.title, entry.body, entry.projectPath, ...entry.tags]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(needle)
  })
}
