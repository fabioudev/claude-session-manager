/** Shared wire types for the Claude Session Manager daemon, web UI and plugin. */

export type SessionStatus = 'working' | 'waiting' | 'idle' | 'ended' | 'unknown'
export type SessionKind = 'interactive' | 'background' | 'unknown'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
  activeForm?: string
}

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionPrompt {
  question: string
  header: string
  multiSelect: boolean
  options: QuestionOption[]
}

export interface PendingQuestion {
  id: string
  sessionId: string
  toolUseId: string | null
  prompts: QuestionPrompt[]
  createdAt: number
  expiresAt: number | null
  /** True when a hook is currently holding the terminal prompt open for a web answer. */
  answerable: boolean
  source: 'hook' | 'transcript'
}

export interface QuestionAnswer {
  index: number
  labels: string[]
  other: string | null
}

export interface QuestionAnswerInput {
  answers: QuestionAnswer[]
}

export type ActivityKind =
  | 'prompt'
  | 'response'
  | 'tool'
  | 'tool-result'
  | 'status'
  | 'question'
  | 'message'
  | 'file'
  | 'error'

export interface ActivityEvent {
  id: string
  at: number
  kind: ActivityKind
  title: string
  detail?: string
  tool?: string
  file?: string
  status?: SessionStatus
}

export interface CurrentActivity {
  kind: 'tool' | 'thinking' | 'waiting' | 'response' | 'event'
  tool?: string
  text: string
  at: number
}

export interface SessionTimeline {
  start: number
  end: number
  bucketMs: number
  /** Number of activities per bucket. */
  counts: number[]
  /** Number of waiting-state observations per bucket. */
  waiting: number[]
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  costUsd: number | null
  contextUsed: number | null
  contextWindow: number | null
  contextPct: number | null
}

export interface SessionSummary {
  id: string
  shortId: string
  name: string | null
  title: string
  titleSource: 'name' | 'custom' | 'prompt' | 'summary' | 'id'
  projectPath: string
  projectName: string
  repoRoot: string | null
  repoName: string | null
  gitBranch: string | null
  gitRemoteUrl: string | null
  kind: SessionKind
  status: SessionStatus
  statusDetail: string
  task: string | null
  todos: TodoItem[]
  activity: CurrentActivity | null
  question: PendingQuestion | null
  startedAt: number | null
  lastActivityAt: number
  endedAt: number | null
  model: string | null
  version: string | null
  tokens: TokenUsage | null
  live: boolean
  pid: number | null
  tmux: string | null
  backgroundState: string | null
  needs: string | null
  jobId: string | null
  unreadMessages: number
  overlapCount: number
  pinned: boolean
  archived: boolean
  timeline: SessionTimeline
  messageCount: number
  /** Where the freshest signal for this session came from. */
  source: 'hook' | 'transcript' | 'registry' | 'background'
}

export type MessageKind = 'note' | 'question' | 'answer'

export interface SessionMessage {
  id: string
  fromSessionId: string | null
  fromName: string
  toSessionId: string | null
  toName: string | null
  body: string
  kind: MessageKind
  createdAt: number
  /** sessionId -> delivery timestamp */
  deliveries: Record<string, number>
  /** sessionId -> read timestamp */
  readBy: Record<string, number>
}

export interface FileClaim {
  id: string
  sessionId: string
  paths: string[]
  note: string | null
  createdAt: number
  expiresAt: number
}

export interface FileTouch {
  sessionId: string
  path: string
  at: number
  tool: string
  projectPath: string
}

export interface Overlap {
  path: string
  sessionIds: string[]
  lastAt: number
  claimedBy: string[]
}

export interface CoordinationView {
  sessions: SessionSummary[]
  messages: SessionMessage[]
  claims: FileClaim[]
  fileTouches: FileTouch[]
  overlaps: Overlap[]
}

export interface SessionDetail {
  session: SessionSummary
  activities: ActivityEvent[]
  messages: SessionMessage[]
  claims: FileClaim[]
  transcriptPath: string | null
}

export interface HookClientContext {
  pid?: number
  ppid?: number
  claudePid?: number
  tmux?: string | null
  tty?: string | null
  csmVersion?: string
}

export interface HookEnvelope {
  event: string
  sessionId: string
  transcriptPath?: string
  cwd?: string
  permissionMode?: string
  toolName?: string
  toolInput?: unknown
  toolResponse?: unknown
  source?: string
  prompt?: string
  notificationType?: string
  message?: string
  reason?: string
  stopHookActive?: boolean
  timestamp?: number
  client?: HookClientContext
  pluginVersion?: string
}

export interface HookReply {
  /** JSON that the plugin's hook script should print to stdout. */
  output: Record<string, unknown> | null
}

export interface PublicConfig {
  version: string
  questionMode: 'auto' | 'web' | 'terminal'
  questionTimeoutSeconds: number
  pluginConnected: boolean
  claudeDir: string
  dataDir: string
  readOnly: boolean
  authRequired: boolean
  launchEnabled: boolean
  serverStartedAt: number
  serverUrl: string
}

export interface SettingsPatch {
  questionMode?: 'auto' | 'web' | 'terminal'
  questionTimeoutSeconds?: number
  launchEnabled?: boolean
}

export interface SessionPatch {
  title?: string | null
  pinned?: boolean
  archived?: boolean
}

export interface MessageInput {
  body: string
  kind?: MessageKind
  toSessionId?: string | null
}

export interface ClaimInput {
  paths: string[]
  note?: string | null
  ttlMinutes?: number
  release?: boolean
}

export interface LaunchSessionInput {
  cwd: string
  prompt: string
  name?: string
  model?: string
  permissionMode?: string
  resumeSessionId?: string
}

export interface LaunchSessionResult {
  ok: boolean
  jobId?: string
  sessionId?: string
  output?: string
  error?: string
}

export interface StopSessionResult {
  ok: boolean
  output?: string
  error?: string
}

export type ServerEvent =
  | {
      type: 'hello'
      sessions: SessionSummary[]
      questions: PendingQuestion[]
      config: PublicConfig
      serverTime: number
    }
  | { type: 'session'; session: SessionSummary }
  | { type: 'session.removed'; id: string }
  | { type: 'question'; question: PendingQuestion }
  | {
      type: 'question.resolved'
      id: string
      resolution: 'answered' | 'terminal' | 'expired' | 'dismissed'
    }
  | { type: 'message'; message: SessionMessage }
  | { type: 'config'; config: PublicConfig }
  | { type: 'ping'; at: number }

export interface ApiError {
  error: {
    code: string
    message: string
  }
}
