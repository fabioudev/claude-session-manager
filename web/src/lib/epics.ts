import type {
  CommandCenterSnapshot,
  DelegatedTask,
  DelegatedTaskStatus,
  Epic,
  EpicMessage,
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
  /** The epic commander's own open question, if it has one. */
  ownerQuestion: PendingQuestion | null
  /** Whether that question is one the human can answer (board or terminal). */
  ownerQuestionAnswerable: boolean
  /** A session asked a question in the thread and nobody human has written since. */
  threadQuestion: EpicMessage | null
  /** Human messages after the last session message: the commander owes an answer. */
  awaitingAnswer: number
  /** Human messages no session has confirmed reading yet (delivery bookkeeping). */
  undelivered: number
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

/**
 * A question the human can actually act on. A background session whose answer
 * window closed cannot be answered from the board any more — its status line
 * says to write in the thread instead, so it must not raise the badge.
 */
function answerableQuestion(owner: SessionSummary | null): PendingQuestion | null {
  const question = owner?.question ?? null
  if (!question) return null
  if (question.answerable) return question
  return owner && owner.kind !== 'background' ? question : null
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
  // Status lines ("Epic status is now active.") are written by the system with
  // no author; they are not the human talking and must not count as a question.
  const humanMessages = epic.messages.filter(
    (message) => !message.authorSessionId && message.kind !== 'status',
  )
  const lastSessionAt = epic.messages.reduce(
    (at, message) =>
      message.authorSessionId && message.kind !== 'status' ? Math.max(at, message.at) : at,
    0,
  )
  const awaitingAnswer = humanMessages.filter((message) => message.at > lastSessionAt).length
  const undelivered = humanMessages.filter((message) => !message.deliveredAt).length
  // The last turn belongs either to the human (nothing open) or to a session;
  // only a question from a session is a question for the human.
  let threadQuestion: EpicMessage | null = null
  for (let index = epic.messages.length - 1; index >= 0; index -= 1) {
    const message = epic.messages[index]
    if (!message) break
    if (message.kind === 'status') continue
    if (!message.authorSessionId) break
    if (message.kind === 'question') threadQuestion = message
    break
  }
  const owner = sessions.find((session) => session.id === epic.ownerSessionId) ?? null
  const ownerQuestion = owner?.question ?? null
  const ownerQuestionAnswerable = Boolean(answerableQuestion(owner))
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
    ownerQuestion,
    ownerQuestionAnswerable,
    threadQuestion,
    awaitingAnswer,
    undelivered,
    // Review and blocked tasks are the epic commander's business; a human
    // comment is the commander's to answer, not a reason to badger the human.
    // A question whose answer window closed cannot be answered from the board,
    // so it only counts for a session that still has a terminal.
    needsHuman: ownerQuestionAnswerable || Boolean(threadQuestion) || epic.status === 'blocked',
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
  if (rollup.ownerQuestionAnswerable || rollup.threadQuestion) return 'Wartet auf dich'
  if (counts.review > 0) return 'Zur Abnahme'
  // The human wrote and the commander has not answered yet — that is work on
  // the session side, so the label must not read like an alert.
  if (rollup.awaitingAnswer > 0) return 'Antwortet noch'
  if (counts.in_progress > 0) return 'Läuft'
  if (counts.queued > 0) return 'Wartet'
  return 'Aktiv'
}

export function epicTone(rollup: EpicRollup): string {
  const label = epicStatusLabel(rollup)
  if (label === 'Fertig') return 'done'
  if (label === 'Eingestellt' || label === 'Pausiert') return 'muted'
  if (label === 'Blockiert') return 'blocked'
  if (label === 'Wartet auf dich') return 'needs'
  // A review is the epic commander's job, not the human's: it must not look
  // like an alert the person has to clear.
  if (label === 'Zur Abnahme') return 'review'
  return 'active'
}
