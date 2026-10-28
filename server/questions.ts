import type {
  HookReply,
  PendingQuestion,
  QuestionAnswerInput,
  QuestionPrompt,
} from '../shared/types.js'
import { now } from './util.js'

interface Entry {
  question: PendingQuestion
  resolve: (reply: HookReply) => void
  timer: NodeJS.Timeout | null
}

export type QuestionResolution = 'answered' | 'dismissed' | 'expired' | 'terminal'

export interface BrokerOptions {
  getTimeoutSeconds: () => number
  onQuestion?: (question: PendingQuestion) => void
  onResolved?: (question: PendingQuestion, resolution: QuestionResolution) => void
}

function buildReason(
  prompts: QuestionPrompt[],
  answers: QuestionAnswerInput['answers'],
): string | null {
  const byIndex = new Map<number, { labels: string[]; other: string | null }>()
  for (const answer of answers) {
    if (!Number.isInteger(answer.index) || answer.index < 0 || answer.index >= prompts.length)
      continue
    const labels = Array.isArray(answer.labels)
      ? answer.labels.filter((label): label is string => typeof label === 'string').slice(0, 8)
      : []
    const other = typeof answer.other === 'string' ? answer.other.trim().slice(0, 500) : ''
    if (!labels.length && !other) continue
    byIndex.set(answer.index, {
      labels: labels.map((label) => label.slice(0, 120)),
      other: other || null,
    })
  }
  if (!byIndex.size) return null

  const lines: string[] = [
    'The user answered this AskUserQuestion through the Claude Session Manager web UI. The tool call was denied only so these answers could be delivered to you; it is not a rejection of the task.',
    '',
  ]
  for (const [index, answer] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
    const prompt = prompts[index]
    if (!prompt) continue
    lines.push(`${index + 1}. ${prompt.header}: ${prompt.question}`)
    if (answer.labels.length) lines.push(`   Selected: ${answer.labels.join(', ')}`)
    if (answer.other) lines.push(`   Other: ${answer.other}`)
    lines.push('')
  }
  lines.push(
    'Continue the task using these answers. Do not call AskUserQuestion again for these questions.',
  )
  return lines.join('\n').slice(0, 6000)
}

/**
 * Holds AskUserQuestion invocations open so a browser can answer them. The hook
 * request waits here; answering resolves it with a PreToolUse deny whose reason
 * carries the human's answers back to the model.
 */
export class QuestionBroker {
  private readonly entries = new Map<string, Entry>()
  private readonly getTimeoutSeconds: () => number
  private readonly onQuestion: ((question: PendingQuestion) => void) | undefined
  private readonly onResolved:
    | ((question: PendingQuestion, resolution: QuestionResolution) => void)
    | undefined

  constructor(options: BrokerOptions) {
    this.getTimeoutSeconds = options.getTimeoutSeconds
    this.onQuestion = options.onQuestion
    this.onResolved = options.onResolved
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  forSession(sessionId: string): PendingQuestion | null {
    let latest: PendingQuestion | null = null
    for (const entry of this.entries.values()) {
      if (entry.question.sessionId !== sessionId) continue
      if (!latest || entry.question.createdAt > latest.createdAt) latest = entry.question
    }
    return latest
  }

  findByToolUseId(toolUseId: string): PendingQuestion | null {
    for (const entry of this.entries.values()) {
      if (entry.question.toolUseId === toolUseId) return entry.question
    }
    return null
  }

  pendingQuestions(): PendingQuestion[] {
    return [...this.entries.values()].map((entry) => entry.question)
  }

  create(
    sessionId: string,
    toolUseId: string | null,
    prompts: QuestionPrompt[],
  ): { question: PendingQuestion; reply: Promise<HookReply> } {
    const id = toolUseId ? `q_${toolUseId}` : `q_${sessionId}_${now()}`
    const createdAt = now()
    const timeoutSeconds = Math.max(5, this.getTimeoutSeconds())
    const question: PendingQuestion = {
      id,
      sessionId,
      toolUseId,
      prompts,
      createdAt,
      expiresAt: createdAt + timeoutSeconds * 1000,
      answerable: true,
      source: 'hook',
    }

    let resolve!: (reply: HookReply) => void
    const reply = new Promise<HookReply>((done) => {
      resolve = done
    })
    const entry: Entry = { question, resolve, timer: null }
    entry.timer = setTimeout(() => {
      this.finish(entry, { output: null }, 'expired')
    }, timeoutSeconds * 1000)
    entry.timer.unref?.()
    this.entries.set(id, entry)
    this.onQuestion?.(question)
    return { question, reply }
  }

  answer(id: string, input: QuestionAnswerInput): { ok: true } | { ok: false; error: string } {
    const entry = this.entries.get(id)
    if (!entry) return { ok: false, error: 'This question is no longer open.' }
    if (!Array.isArray(input.answers)) return { ok: false, error: 'answers must be an array' }
    const reason = buildReason(entry.question.prompts, input.answers)
    if (!reason) return { ok: false, error: 'Choose at least one answer.' }
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }
    this.finish(entry, { output }, 'answered')
    return { ok: true }
  }

  dismiss(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    this.finish(entry, { output: null }, 'dismissed')
    return true
  }

  cancelForSession(sessionId: string, resolution: QuestionResolution = 'terminal'): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.question.sessionId === sessionId) {
        this.finish(entry, { output: null }, resolution)
      }
    }
  }

  private finish(entry: Entry, reply: HookReply, resolution: QuestionResolution): void {
    if (!this.entries.has(entry.question.id)) return
    this.entries.delete(entry.question.id)
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    entry.resolve(reply)
    this.onResolved?.(entry.question, resolution)
  }
}
