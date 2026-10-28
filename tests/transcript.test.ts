import { describe, expect, it } from 'vitest'
import {
  applyTranscriptLine,
  createTranscriptState,
  parseTranscriptLines,
  pendingQuestionFromState,
  questionsFromToolInput,
} from '../server/transcript/parse.js'

function line(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

const base = {
  sessionId: 's1',
  cwd: '/root/project',
  gitBranch: 'main',
  version: '2.1.0',
  isSidechain: false,
}

describe('transcript parser', () => {
  it('collects metadata, prompts, tokens and activities', () => {
    const state = createTranscriptState()
    parseTranscriptLines(state, [
      line({ ...base, type: 'summary', summary: 'A session summary' }),
      line({
        ...base,
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-01-01T10:00:00.000Z',
        message: { content: [{ type: 'text', text: 'Fix the login bug' }] },
      }),
      line({
        ...base,
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-01-01T10:00:05.000Z',
        message: {
          model: 'claude-sonnet-5',
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 50,
            context_window: 200_000,
          },
          content: [
            { type: 'text', text: 'I will inspect the auth guard.' },
            {
              type: 'tool_use',
              id: 'toolu_bash',
              name: 'Bash',
              input: { command: 'rg "auth" src', description: 'Find auth guard' },
            },
          ],
        },
      }),
    ])

    expect(state.sessionId).toBe('s1')
    expect(state.cwd).toBe('/root/project')
    expect(state.gitBranch).toBe('main')
    expect(state.version).toBe('2.1.0')
    expect(state.summary).toBe('A session summary')
    expect(state.firstPrompt).toBe('Fix the login bug')
    expect(state.lastPrompt).toBe('Fix the login bug')
    expect(state.promptCount).toBe(1)
    expect(state.assistantCount).toBe(1)
    expect(state.model).toBe('claude-sonnet-5')
    expect(state.tokens).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 1000,
      cacheCreationTokens: 50,
    })
    expect(state.contextUsed).toBe(1150)
    expect(state.contextWindow).toBe(200_000)
    expect(state.lastToolName).toBe('Bash')
    expect(state.lastToolText).toBe('Find auth guard')
    expect(state.openToolUses.size).toBe(1)
    expect(state.startedAt).toBe(Date.parse('2026-01-01T10:00:00.000Z'))
    expect(state.activities.map((activity) => activity.kind)).toEqual([
      'prompt',
      'response',
      'tool',
    ])
    expect(state.activities.at(-1)?.detail).toBe('rg "auth" src')
  })

  it('tracks pending questions until the tool result arrives', () => {
    const state = createTranscriptState()
    const questionInput = {
      questions: [
        {
          question: 'Which database?',
          header: 'Database',
          multiSelect: false,
          options: [{ label: 'Postgres' }, { label: 'SQLite' }],
        },
      ],
    }
    parseTranscriptLines(state, [
      line({
        ...base,
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-01-01T10:00:00.000Z',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_question',
              name: 'AskUserQuestion',
              input: questionInput,
            },
          ],
        },
      }),
    ])

    const pending = pendingQuestionFromState(state, 's1', 'answerable')
    expect(pending?.toolUseId).toBe('toolu_question')
    expect(pending?.source).toBe('transcript')
    expect(pending?.answerable).toBe(true)
    expect(pending?.prompts[0]?.question).toBe('Which database?')
    expect(state.openToolUses.get('toolu_question')).toBe('AskUserQuestion')

    const resolved = parseTranscriptLines(state, [
      line({
        ...base,
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-01-01T10:01:00.000Z',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_question', content: 'Postgres' }],
        },
      }),
    ])
    expect(resolved).toEqual(['toolu_question'])
    expect(state.pendingQuestions.size).toBe(0)
    expect(state.openToolUses.size).toBe(0)
    expect(pendingQuestionFromState(state, 's1', 'answerable')).toBeNull()
  })

  it('records TodoWrite state and tool errors', () => {
    const state = createTranscriptState()
    parseTranscriptLines(state, [
      line({
        ...base,
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-01-01T10:00:00.000Z',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_todo',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: 'Inspect parser', status: 'in_progress', activeForm: 'Inspecting' },
                  { content: 'Write tests', status: 'pending' },
                ],
              },
            },
          ],
        },
      }),
      line({
        ...base,
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-01-01T10:00:10.000Z',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_todo',
              is_error: true,
              content: 'Permission denied',
            },
          ],
        },
      }),
    ])
    expect(state.todos.map((todo) => todo.status)).toEqual(['in_progress', 'pending'])
    expect(state.lastError?.text).toBe('Permission denied')
    expect(state.activities.some((activity) => activity.kind === 'error')).toBe(true)
  })

  it('ignores malformed JSON and non-transcript lines', () => {
    const state = createTranscriptState()
    expect(applyTranscriptLine(state, 'not json').resolvedQuestions).toEqual([])
    expect(applyTranscriptLine(state, '').resolvedQuestions).toEqual([])
    expect(applyTranscriptLine(state, '{}').resolvedQuestions).toEqual([])
    expect(state.lineCount).toBe(1)
  })

  it('trims injected blocks from prompt titles', () => {
    const state = createTranscriptState()
    parseTranscriptLines(state, [
      line({
        ...base,
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-01-01T10:00:00.000Z',
        message: {
          content: [
            {
              type: 'text',
              text: '<system-reminder>ignore</system-reminder>Real question?',
            },
          ],
        },
      }),
    ])
    expect(state.firstPrompt).toBe('Real question?')
  })
})

describe('question extraction', () => {
  it('rejects malformed question payloads', () => {
    expect(questionsFromToolInput(null)).toEqual([])
    expect(questionsFromToolInput({ questions: 'nope' })).toEqual([])
    expect(
      questionsFromToolInput({
        questions: [{ question: 'Only text', header: 'Header', options: [] }],
      }),
    ).toHaveLength(1)
    expect(
      questionsFromToolInput({
        questions: [{ question: 'Missing header', options: [] }],
      }),
    ).toEqual([])
  })

  it('caps prompts and options to reasonable sizes', () => {
    const many = {
      questions: Array.from({ length: 10 }, (_, index) => ({
        question: `Q${index}`,
        header: `H${index}`,
        options: Array.from({ length: 20 }, (_, option) => ({ label: `O${option}` })),
      })),
    }
    const prompts = questionsFromToolInput(many)
    expect(prompts.length).toBeLessThanOrEqual(6)
    expect(prompts[0]?.options.length).toBe(20)
  })
})
