import type {
  ActivityEvent,
  PendingQuestion,
  QuestionPrompt,
  TodoItem,
} from '../../shared/types.js'
import { cleanPrompt, hashString, oneLine, truncate } from '../util.js'

export type Json = Record<string, unknown>

export interface TokenTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface QuestionSignal {
  toolUseId: string
  prompts: QuestionPrompt[]
  at: number
}

export interface TranscriptParseState {
  lineCount: number
  sessionId: string | null
  cwd: string | null
  gitBranch: string | null
  version: string | null
  model: string | null
  slug: string | null
  summary: string | null
  firstPrompt: string | null
  firstPromptAt: number | null
  lastPrompt: string | null
  lastPromptAt: number | null
  lastUserAt: number | null
  lastAssistantAt: number | null
  lastAssistantText: string | null
  lastToolName: string | null
  lastToolText: string | null
  lastToolAt: number | null
  lastActivityAt: number | null
  startedAt: number | null
  promptCount: number
  assistantCount: number
  todos: TodoItem[]
  tokens: TokenTotals
  contextUsed: number | null
  contextWindow: number | null
  /** Unresolved AskUserQuestion tool calls, keyed by tool_use_id. */
  pendingQuestions: Map<string, QuestionSignal>
  /** tool_use ids that have a tool_result. */
  openToolUses: Map<string, string>
  lastError: { text: string; at: number } | null
  interruptedAt: number | null
  compactedAt: number | null
  isSubagent: boolean
  lastEventType: 'user' | 'assistant' | 'system' | null
  activities: ActivityEvent[]
  seenIds: Set<string>
}

const MAX_ACTIVITIES = 400
const MAX_SEEN = 20_000

export function createTranscriptState(): TranscriptParseState {
  return {
    lineCount: 0,
    sessionId: null,
    cwd: null,
    gitBranch: null,
    version: null,
    model: null,
    slug: null,
    summary: null,
    firstPrompt: null,
    firstPromptAt: null,
    lastPrompt: null,
    lastPromptAt: null,
    lastUserAt: null,
    lastAssistantAt: null,
    lastAssistantText: null,
    lastToolName: null,
    lastToolText: null,
    lastToolAt: null,
    lastActivityAt: null,
    startedAt: null,
    promptCount: 0,
    assistantCount: 0,
    todos: [],
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    contextUsed: null,
    contextWindow: null,
    pendingQuestions: new Map(),
    openToolUses: new Map(),
    lastError: null,
    interruptedAt: null,
    compactedAt: null,
    isSubagent: false,
    lastEventType: null,
    activities: [],
    seenIds: new Set(),
  }
}

function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function contentBlocks(message: Json | null): Json[] {
  if (!message) return []
  const content = message.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return asArray(content)
    .map(asObject)
    .filter((block): block is Json => !!block)
}

function textOf(block: Json): string {
  // Assistant text blocks carry `text`; tool results carry `content`.
  const value = block.text ?? block.content
  if (typeof value === 'string') return value
  // Structured content is an array of text fragments.
  if (Array.isArray(value)) {
    return value
      .map((item) => (asObject(item)?.text as string | undefined) ?? '')
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function summarizeToolInput(
  name: string,
  input: Json | null,
): { title: string; detail?: string; file?: string } {
  if (!input) return { title: name }
  const file =
    asString(input.file_path) ?? asString(input.path) ?? asString(input.notebook_path) ?? undefined
  switch (name) {
    case 'Bash':
    case 'BashOutput': {
      const command = asString(input.command)
      const description = asString(input.description)
      const title = description || (command ? oneLine(command, 110) : name)
      return {
        title,
        // Without a description the command is already the title; only repeat
        // it when the title had to be shortened or the command spans lines.
        detail: command && oneLine(command, 110) !== title ? truncate(command, 2000) : undefined,
      }
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { title: file ?? name, file }
    case 'Grep':
    case 'Glob': {
      const pattern = asString(input.pattern) ?? ''
      const scope = asString(input.path)
      return {
        title: pattern ? `${pattern}${scope ? ` in ${scope}` : ''}` : name,
        file: scope ?? undefined,
      }
    }
    case 'WebFetch': {
      return { title: asString(input.url) ?? name }
    }
    case 'WebSearch': {
      return { title: asString(input.query) ?? name }
    }
    case 'Task':
    case 'Agent': {
      const description = asString(input.description)
      const subagent = asString(input.subagent_type)
      return { title: description ?? (subagent ? `${subagent} agent` : name) }
    }
    case 'Skill': {
      const skill = asString(input.skill) ?? asString(input.name)
      return { title: skill ? `Skill ${skill}` : name }
    }
    case 'TodoWrite': {
      const todos = asArray(input.todos)
        .map(asObject)
        .filter((item): item is Json => !!item)
      const active = todos.find((todo) => todo.status === 'in_progress')
      const content = active ? asString(active.content) : null
      return { title: content ?? `${todos.length} todos updated` }
    }
    case 'AskUserQuestion': {
      const question = asArray(input.questions).map(asObject).find(Boolean)
      const prompt = question ? asString(question.question) : null
      return { title: prompt ?? 'Question' }
    }
    case 'SendMessage': {
      const recipient = asString(input.recipient) ?? asString(input.to)
      return { title: recipient ? `Message to ${recipient}` : name }
    }
    default: {
      const firstString = Object.values(input).find((value) => typeof value === 'string')
      return {
        title: typeof firstString === 'string' ? oneLine(firstString, 110) : name,
        file,
      }
    }
  }
}

function extractTodos(input: Json | null): TodoItem[] | null {
  if (!input) return null
  const raw = asArray(input.todos)
  if (!raw.length) return null
  const todos: TodoItem[] = []
  for (const item of raw) {
    const todo = asObject(item)
    if (!todo) continue
    const content = asString(todo.content)
    const status = todo.status
    if (!content) continue
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
    todos.push({
      content,
      status,
      activeForm: asString(todo.activeForm) ?? undefined,
    })
  }
  return todos.length ? todos.slice(0, 40) : null
}

function extractQuestionPrompts(input: Json | null): QuestionPrompt[] {
  if (!input) return []
  const prompts: QuestionPrompt[] = []
  for (const item of asArray(input.questions)) {
    const question = asObject(item)
    if (!question) continue
    const text = asString(question.question)
    const header = asString(question.header)
    if (!text || !header) continue
    const options = asArray(question.options)
      .map(asObject)
      .filter((option): option is Json => !!option)
      .map((option) => ({
        label: asString(option.label) ?? '',
        description: asString(option.description) ?? undefined,
      }))
      .filter((option) => option.label)
    prompts.push({
      question: text,
      header,
      multiSelect: question.multiSelect === true,
      options,
    })
  }
  return prompts.slice(0, 6)
}

function rememberSeen(state: TranscriptParseState, id: string): boolean {
  if (state.seenIds.has(id)) return false
  state.seenIds.add(id)
  if (state.seenIds.size > MAX_SEEN) {
    // Drop the oldest half; a Set preserves insertion order.
    const drop = Math.floor(MAX_SEEN / 2)
    let index = 0
    for (const key of state.seenIds) {
      state.seenIds.delete(key)
      if (++index >= drop) break
    }
  }
  return true
}

function pushActivity(state: TranscriptParseState, activity: ActivityEvent): void {
  if (!activity.at) return
  if (!rememberSeen(state, activity.id)) return
  state.activities.push(activity)
  if (state.activities.length > MAX_ACTIVITIES) {
    state.activities.splice(0, state.activities.length - MAX_ACTIVITIES)
  }
  if (state.startedAt === null) state.startedAt = activity.at
  state.lastActivityAt = Math.max(state.lastActivityAt ?? 0, activity.at)
}

function activityId(base: string, suffix: string): string {
  return `${base}:${suffix}`
}

function lineId(line: Json, raw: string): string {
  return (
    asString(line.uuid) ??
    asString(line.id) ??
    hashString(
      `${asString(line.sessionId) ?? ''}:${asString(line.timestamp) ?? ''}:${raw.slice(0, 512)}`,
    )
  )
}

/**
 * Fold one JSONL transcript line into the accumulator. Pure with respect to the file
 * system, so it is easy to test against captured transcripts.
 */
export function applyTranscriptLine(
  state: TranscriptParseState,
  raw: string,
): { resolvedQuestions: string[] } {
  const trimmed = raw.trim()
  if (!trimmed) return { resolvedQuestions: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { resolvedQuestions: [] }
  }
  const line = asObject(parsed)
  if (!line) return { resolvedQuestions: [] }

  state.lineCount += 1
  const type = asString(line.type) ?? ''
  const timestamp = parseTimestamp(line.timestamp) ?? state.lastActivityAt ?? 0
  const sessionId = asString(line.sessionId)
  if (sessionId) state.sessionId = sessionId
  const cwd = asString(line.cwd)
  if (cwd) state.cwd = cwd
  const branch = asString(line.gitBranch)
  if (branch) state.gitBranch = branch
  const version = asString(line.version)
  if (version) state.version = version
  const slug = asString(line.slug)
  if (slug) state.slug = slug
  if (line.isSidechain === true) state.isSubagent = true

  if (type === 'summary') {
    const summary = asString(line.summary)
    if (summary) state.summary = oneLine(summary, 300)
    return { resolvedQuestions: [] }
  }

  if (type === 'system') {
    state.lastEventType = 'system'
    const subtype = asString(line.subtype)
    const base = lineId(line, trimmed)
    if (subtype === 'compact_boundary' || subtype === 'compact') {
      state.compactedAt = timestamp
      pushActivity(state, {
        id: activityId(base, 'compact'),
        at: timestamp,
        kind: 'status',
        title: 'Context compacted',
        detail: 'The conversation was summarized to continue past the context limit.',
        status: 'working',
      })
    } else if (subtype === 'api_error') {
      const text = asString(line.content) ?? asString(line.error) ?? 'API error'
      state.lastError = { text: oneLine(text, 500), at: timestamp }
      pushActivity(state, {
        id: activityId(base, 'apierror'),
        at: timestamp,
        kind: 'error',
        title: oneLine(text, 140),
      })
    }
    return { resolvedQuestions: [] }
  }

  if (type !== 'user' && type !== 'assistant') {
    return { resolvedQuestions: [] }
  }

  const message = asObject(line.message)
  const base = lineId(line, trimmed)
  const blocks = contentBlocks(message)
  const isMeta = line.isMeta === true
  const sidechain = line.isSidechain === true
  const resolvedQuestions: string[] = []

  if (type === 'assistant') {
    if (!sidechain) state.lastEventType = 'assistant'
    const model = asString(message?.model)
    if (model) state.model = model
    const usage = asObject(message?.usage)
    if (usage) {
      const input = asNumber(usage.input_tokens) ?? 0
      const output = asNumber(usage.output_tokens) ?? 0
      const cacheRead = asNumber(usage.cache_read_input_tokens) ?? 0
      const cacheCreation = asNumber(usage.cache_creation_input_tokens) ?? 0
      state.tokens.inputTokens += input
      state.tokens.outputTokens += output
      state.tokens.cacheReadTokens += cacheRead
      state.tokens.cacheCreationTokens += cacheCreation
      if (!sidechain) {
        state.contextUsed = input + cacheRead + cacheCreation
        state.contextWindow = asNumber(usage.context_window) ?? state.contextWindow
      }
    }
    if (!sidechain) {
      state.lastAssistantAt = timestamp
      state.assistantCount += 1
    }

    blocks.forEach((block, index) => {
      const blockType = asString(block.type)
      if (blockType === 'text') {
        const text = textOf(block)
        if (!text.trim()) return
        if (!sidechain) state.lastAssistantText = text
        if (sidechain || isMeta) return
        // A short answer is fully visible in the title; repeating it as detail
        // only adds noise to the activity ledger.
        pushActivity(state, {
          id: activityId(base, `text:${index}`),
          at: timestamp,
          kind: 'response',
          title: oneLine(text, 140),
          detail: text.trim().length > 140 ? truncate(text, 2000) : undefined,
        })
        return
      }
      if (blockType === 'tool_use') {
        const name = asString(block.name) ?? 'Tool'
        const input = asObject(block.input)
        const id = asString(block.id) ?? `${base}:${index}`
        if (!sidechain) {
          state.openToolUses.set(id, name)
          state.lastToolName = name
          state.lastToolAt = timestamp
        }
        if (sidechain || isMeta) return
        if (name === 'TodoWrite') {
          const todos = extractTodos(input)
          if (todos) state.todos = todos
        }
        const summary = summarizeToolInput(name, input)
        state.lastToolText = summary.title
        if (name === 'AskUserQuestion') {
          const prompts = extractQuestionPrompts(input)
          if (prompts.length) {
            state.pendingQuestions.set(id, { toolUseId: id, prompts, at: timestamp })
            const options = prompts[0]?.options.map((option) => option.label).join(' / ')
            pushActivity(state, {
              id: activityId(base, `question:${index}`),
              at: timestamp,
              kind: 'question',
              title: oneLine(prompts[0]?.question ?? 'Waiting for an answer', 140),
              // The question itself is the title. Detail adds the choices, or the
              // remaining prompts when the tool asked several at once.
              detail:
                prompts.length > 1
                  ? truncate(
                      prompts.map((prompt) => `${prompt.header}: ${prompt.question}`).join('\n'),
                      1200,
                    )
                  : options
                    ? `Options: ${options}`
                    : undefined,
            })
            return
          }
        }
        pushActivity(state, {
          id: activityId(base, `tool:${index}`),
          at: timestamp,
          kind: 'tool',
          title: summary.title,
          detail: summary.detail,
          tool: name,
          file: summary.file,
        })
      }
    })
    return { resolvedQuestions }
  }

  // User lines: real prompts, tool results, interrupt markers and local command output.
  if (!sidechain) state.lastEventType = 'user'
  let sawToolResult = false
  blocks.forEach((block, index) => {
    const blockType = asString(block.type)
    if (blockType === 'tool_result') {
      sawToolResult = true
      const toolUseId = asString(block.tool_use_id)
      const isError = block.is_error === true
      if (toolUseId) {
        const name = state.openToolUses.get(toolUseId)
        if (name) state.openToolUses.delete(toolUseId)
        if (state.pendingQuestions.delete(toolUseId)) resolvedQuestions.push(toolUseId)
      }
      if (isError && !sidechain) {
        const text = textOf(block)
        state.lastError = { text: oneLine(text || 'Tool failed', 500), at: timestamp }
        pushActivity(state, {
          id: activityId(base, `toolresult:${index}`),
          at: timestamp,
          kind: 'error',
          title: oneLine(text || 'Tool failed', 140),
          detail: truncate(text, 1200),
        })
      }
      if (!sidechain && toolUseId) {
        state.lastToolAt = timestamp
      }
      return
    }
    if (blockType !== 'text' || sidechain) return
    const text = textOf(block)
    if (!text.trim()) return
    if (text.includes('[Request interrupted')) {
      state.interruptedAt = timestamp
      return
    }
  })

  if (sawToolResult || isMeta || sidechain) return { resolvedQuestions }

  const text = blocks
    .filter((block) => asString(block.type) === 'text' || typeof block.text === 'string')
    .map(textOf)
    .join('\n')
  const prompt = cleanPrompt(text)
  if (prompt.length < 2) return { resolvedQuestions }
  // Local command echoes such as /clear have no args left after cleaning; they are
  // still user events, but they should not become the session's title.
  const isCommand = /<command-name>/.test(text)

  state.promptCount += 1
  state.lastUserAt = timestamp
  state.lastPromptAt = timestamp
  state.lastPrompt = prompt
  if (state.firstPrompt === null && !isCommand) {
    state.firstPrompt = prompt
    state.firstPromptAt = timestamp
  }
  if (state.startedAt === null) state.startedAt = timestamp
  pushActivity(state, {
    id: activityId(base, 'prompt'),
    at: timestamp,
    kind: 'prompt',
    title: oneLine(prompt, 140),
    detail: prompt.trim().length > 140 ? truncate(prompt, 2000) : undefined,
  })
  return { resolvedQuestions }
}

export function parseTranscriptLines(state: TranscriptParseState, lines: string[]): string[] {
  const resolved: string[] = []
  for (const line of lines) {
    const result = applyTranscriptLine(state, line)
    resolved.push(...result.resolvedQuestions)
  }
  return resolved
}

export function describeToolCall(
  name: string,
  input: unknown,
): { title: string; detail?: string; file?: string } {
  return summarizeToolInput(name, asObject(input))
}

export function questionsFromToolInput(input: unknown): QuestionPrompt[] {
  return extractQuestionPrompts(asObject(input))
}

export function pendingQuestionFromState(
  state: TranscriptParseState,
  sessionId: string,
  status: 'answerable' | 'terminal',
): PendingQuestion | null {
  let latest: QuestionSignal | null = null
  for (const signal of state.pendingQuestions.values()) {
    if (!latest || signal.at > latest.at) latest = signal
  }
  if (!latest) return null
  return {
    id: `q_${latest.toolUseId}`,
    sessionId,
    toolUseId: latest.toolUseId,
    prompts: latest.prompts,
    createdAt: latest.at,
    expiresAt: null,
    answerable: status === 'answerable',
    source: 'transcript',
  }
}

export function usageTotals(state: TranscriptParseState): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
} {
  return { ...state.tokens }
}
