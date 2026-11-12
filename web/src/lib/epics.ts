import type {
  CommandCenterSnapshot,
  DelegatedTask,
  DelegatedTaskStatus,
  Epic,
  PendingQuestion,
  SessionSummary,
} from '@shared/types'

export interface EpicRollup {
  epic: Epic
  tasks: DelegatedTask[]
  openTasks: DelegatedTask[]
  counts: Record<DelegatedTaskStatus, number>
  total: number
  done: number
  /** Declared progress across all tasks; finished tasks count as 100. */
  progress: number
  lastActivityAt: number
  owner: SessionSummary | null
  /** The epic commander's own open question; only the human can answer it. */
  ownerQuestion: PendingQuestion | null
  /** Human messages the epic's commander has not answered yet. */
  unanswered: number
  /** True when something in this epic waits for the human, not for a session. */
  needsHuman: boolean
}

export function epicTasks(epicId: string, tasks: DelegatedTask[]): DelegatedTask[] {
  return tasks.filter((task) => task.epicId === epicId && task.status !== 'cancelled')
}

function countsFor(tasks: DelegatedTask[]): Record<DelegatedTaskStatus, number> {
  const counts: Record<DelegatedTaskStatus, number> = {
    queued: 0,
    in_progress: 0,
    blocked: 0,
    review: 0,
    done: 0,
    cancelled: 0,
  }
  for (const task of tasks) counts[task.status] += 1
  return counts
}

export function epicRollup(
  epic: Epic,
  tasks: DelegatedTask[],
  sessions: SessionSummary[],
): EpicRollup {
  const linked = epicTasks(epic.id, tasks)
  const counts = countsFor(linked)
  const openTasks = linked.filter((task) => task.status !== 'done' && task.status !== 'cancelled')
  const progress = linked.length
    ? Math.round(
        linked.reduce((sum, task) => sum + (task.status === 'done' ? 100 : task.progress), 0) /
          linked.length,
      )
    : 0
  const unanswered = epic.messages.filter(
    (message) => !message.authorSessionId && !message.deliveredAt,
  ).length
  const owner = sessions.find((session) => session.id === epic.ownerSessionId) ?? null
  const lastMessageAt = epic.messages[epic.messages.length - 1]?.at ?? 0
  const lastActivityAt = Math.max(
    epic.updatedAt,
    lastMessageAt,
    ...linked.map((task) => task.updatedAt),
  )
  return {
    epic,
    tasks: linked,
    openTasks,
    counts,
    total: linked.length,
    done: counts.done,
    progress,
    lastActivityAt,
    owner,
    ownerQuestion: owner?.question ?? null,
    unanswered,
    // Review and blocked tasks are the epic commander's business; only an
    // unanswered question, its own pending question or a blocked epic actually
    // needs the human.
    needsHuman: unanswered > 0 || Boolean(owner?.question) || epic.status === 'blocked',
  }
}

export function epicRollups(
  commandCenter: CommandCenterSnapshot,
  sessions: SessionSummary[],
): EpicRollup[] {
  return commandCenter.epics
    .map((epic) => epicRollup(epic, commandCenter.tasks, sessions))
    .sort((a, b) => {
      const closed = (rollup: EpicRollup) =>
        rollup.epic.status === 'done' || rollup.epic.status === 'cancelled' ? 1 : 0
      return closed(a) - closed(b) || b.lastActivityAt - a.lastActivityAt
    })
}

/** Open work that belongs to no existing epic; the commander should file it. */
export function standaloneTasks(commandCenter: CommandCenterSnapshot): DelegatedTask[] {
  const epicIds = new Set(commandCenter.epics.map((epic) => epic.id))
  return commandCenter.tasks.filter(
    (task) =>
      task.status !== 'done' &&
      task.status !== 'cancelled' &&
      (!task.epicId || !epicIds.has(task.epicId)),
  )
}

export function epicsNeedingHuman(rollups: EpicRollup[]): EpicRollup[] {
  return rollups.filter((rollup) => rollup.needsHuman)
}

export function epicStatusLabel(rollup: EpicRollup): string {
  const { epic, counts } = rollup
  if (epic.status === 'done') return 'Fertig'
  if (epic.status === 'cancelled') return 'Eingestellt'
  if (epic.status === 'paused') return 'Pausiert'
  if (epic.status === 'blocked' || counts.blocked > 0) return 'Blockiert'
  if (rollup.unanswered > 0 || rollup.ownerQuestion) return 'Wartet auf dich'
  if (counts.review > 0) return 'Zur Abnahme'
  if (counts.in_progress > 0) return 'Läuft'
  if (counts.queued > 0) return 'Wartet'
  return 'Aktiv'
}

export function epicTone(rollup: EpicRollup): string {
  const label = epicStatusLabel(rollup)
  if (label === 'Fertig') return 'done'
  if (label === 'Eingestellt' || label === 'Pausiert') return 'muted'
  if (label === 'Blockiert') return 'blocked'
  if (label === 'Wartet auf dich' || label === 'Zur Abnahme') return 'needs'
  return 'active'
}
