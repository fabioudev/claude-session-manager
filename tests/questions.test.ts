import { afterEach, describe, expect, it, vi } from 'vitest'
import { QuestionBroker, type QuestionResolution } from '../server/questions.js'
import type { HookReply, PendingQuestion, QuestionPrompt } from '../shared/types.js'

const prompts: QuestionPrompt[] = [
  {
    question: 'Which database?',
    header: 'Database',
    multiSelect: false,
    options: [{ label: 'Postgres' }, { label: 'SQLite' }],
  },
  {
    question: 'Which extras?',
    header: 'Extras',
    multiSelect: true,
    options: [{ label: 'Backups' }, { label: 'Metrics' }],
  },
]

function setup(timeoutSeconds = 90) {
  const created: PendingQuestion[] = []
  const resolved: Array<{ id: string; resolution: QuestionResolution }> = []
  const broker = new QuestionBroker({
    getTimeoutSeconds: () => timeoutSeconds,
    onQuestion: (question) => created.push(question),
    onResolved: (question, resolution) => resolved.push({ id: question.id, resolution }),
  })
  return { broker, created, resolved }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('QuestionBroker', () => {
  it('creates a pending question and resolves it with the answers', async () => {
    const { broker, created, resolved } = setup()
    const { question, reply } = broker.create('s1', 'toolu_1', prompts)
    expect(question).toMatchObject({
      id: 'q_toolu_1',
      sessionId: 's1',
      toolUseId: 'toolu_1',
      answerable: true,
      source: 'hook',
    })
    expect(question.expiresAt).toBe(question.createdAt + 90_000)
    expect(created).toEqual([question])
    expect(broker.has(question.id)).toBe(true)
    expect(broker.forSession('s1')?.id).toBe(question.id)
    expect(broker.findByToolUseId('toolu_1')?.id).toBe(question.id)
    expect(broker.pendingQuestions()).toHaveLength(1)

    const result = broker.answer(question.id, {
      answers: [
        { index: 0, labels: ['Postgres'], other: null },
        { index: 1, labels: ['Backups', 'Metrics'], other: '  WAL archiving  ' },
      ],
    })
    expect(result).toEqual({ ok: true })

    const hookReply = (await reply) as HookReply
    const output = hookReply.output as {
      hookSpecificOutput: {
        permissionDecision: string
        permissionDecisionReason: string
      }
    }
    const reason = output.hookSpecificOutput.permissionDecisionReason
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(reason).toContain('Database: Which database?')
    expect(reason).toContain('Selected: Postgres')
    expect(reason).toContain('Extras: Which extras?')
    expect(reason).toContain('Selected: Backups, Metrics')
    expect(reason).toContain('Other: WAL archiving')
    expect(reason).toContain('Do not call AskUserQuestion again')
    expect(broker.has(question.id)).toBe(false)
    expect(resolved).toEqual([{ id: question.id, resolution: 'answered' }])
  })

  it('rejects answers that are empty or point outside the prompt list', () => {
    const { broker } = setup()
    const { question } = broker.create('s1', 'toolu_1', prompts)
    expect(broker.answer(question.id, { answers: [] })).toEqual({
      ok: false,
      error: 'Choose at least one answer.',
    })
    expect(
      broker.answer(question.id, { answers: [{ index: 9, labels: ['Nope'], other: null }] }),
    ).toEqual({ ok: false, error: 'Choose at least one answer.' })
    expect(
      broker.answer(question.id, {
        answers: [{ index: 0, labels: [], other: '   ' }],
      }),
    ).toEqual({ ok: false, error: 'Choose at least one answer.' })
    expect(broker.has(question.id)).toBe(true)
  })

  it('rejects malformed answer arrays', () => {
    const { broker } = setup()
    const { question } = broker.create('s1', null, prompts)
    expect(broker.answer(question.id, {} as never)).toEqual({
      ok: false,
      error: 'answers must be an array',
    })
  })

  it('dismisses and cancels open questions', async () => {
    const { broker, resolved } = setup()
    const first = broker.create('s1', 'toolu_a', prompts)
    const second = broker.create('s1', 'toolu_b', prompts)
    const other = broker.create('s2', 'toolu_c', prompts)

    expect(broker.dismiss(first.question.id)).toBe(true)
    expect(await first.reply).toEqual({ output: null })

    broker.cancelForSession('s1')
    expect(await second.reply).toEqual({ output: null })
    expect(broker.has(other.question.id)).toBe(true)
    expect(resolved.map((item) => item.resolution)).toEqual(['dismissed', 'terminal'])
  })

  it('expires the question after the configured timeout', async () => {
    vi.useFakeTimers()
    const { broker, resolved } = setup(6)
    const { question, reply } = broker.create('s1', 'toolu_1', prompts)
    expect(question.expiresAt).toBe(question.createdAt + 6_000)
    await vi.advanceTimersByTimeAsync(6_001)
    expect(await reply).toEqual({ output: null })
    expect(broker.has(question.id)).toBe(false)
    expect(resolved).toEqual([{ id: question.id, resolution: 'expired' }])
  })

  it('clamps very short timeouts to five seconds', () => {
    const { broker } = setup(0)
    const { question } = broker.create('s1', 'toolu_1', prompts)
    expect(question.expiresAt).toBe(question.createdAt + 5_000)
    broker.dismiss(question.id)
  })

  it('generates a stable id for tool calls and a timestamped one otherwise', () => {
    const { broker } = setup()
    const withTool = broker.create('s1', 'toolu_x', prompts)
    const withoutTool = broker.create('s1', null, prompts)
    expect(withTool.question.id).toBe('q_toolu_x')
    expect(withoutTool.question.id).toMatch(/^q_s1_\d+$/)
    broker.dismiss(withTool.question.id)
    broker.dismiss(withoutTool.question.id)
  })
})
