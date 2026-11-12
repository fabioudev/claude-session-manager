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

export interface SessionUpdate {
  /** A newer Claude Code or plugin version is installed than this session loaded. */
  available: boolean
  claude: boolean
  plugin: boolean
  /** The daemon can restart this session in place (idle interactive tmux on Linux). */
  restartable: boolean
}

/**
 * A link to the preview a session can show — the dev server or tunnel it is
 * running. `registered` comes from the session itself (it announced a port to
 * the preview router), `rule` from Settings, `output` from a URL found in the
 * session's own text.
 */
export interface PreviewLink {
  url: string
  /** Host shown instead of the full URL. */
  host: string
  source: 'registered' | 'rule' | 'output'
  /** When the preview was registered or the URL appeared; null for a Settings rule. */
  foundAt: number | null
}

/**
 * A session that announced a dev server. The router maps
 * `<name>.<zone>` to `127.0.0.1:<port>` until the registration expires.
 */
/**
 * A path on a preview that another loopback port answers, for apps whose dev
 * server does not serve its own API (`/api` on a Vite app, for example).
 */
export interface PreviewRoute {
  /** Normalised path prefix, always starting and ending with `/`. */
  prefix: string
  /** Loopback port that answers this prefix. */
  port: number
  /** Drop the prefix before forwarding (`/api/health` → `/health`). */
  strip?: boolean
}

export interface PreviewRegistration {
  sessionId: string
  /** One DNS label, unique among live registrations. */
  name: string
  /** Loopback port the dev server listens on. */
  port: number
  /** Path rules, longest prefix wins; empty means everything goes to `port`. */
  routes: PreviewRoute[]
  createdAt: number
  expiresAt: number
}

export interface PreviewInput {
  port: number
  /** Desired label; the daemon derives one from the session when omitted. */
  name?: string
  /** How long the link stays alive (5 minutes to 7 days). */
  ttlMinutes?: number
  routes?: PreviewRoute[]
}

/** Maps a project to the address its preview is served on. */
export interface PreviewRule {
  /** Matched against the project path and repository names; `*` is a wildcard. */
  pattern: string
  url: string
}

export interface SessionSummary {
  id: string
  shortId: string
  name: string | null
  title: string
  titleSource: 'name' | 'custom' | 'prompt' | 'summary' | 'id'
  /** One-line headline of what the session was asked to do, for the board. */
  mission: string
  projectPath: string
  projectName: string
  /** Top-level project folder under the home directory, independent of the repo. */
  project: string | null
  repoRoot: string | null
  repoName: string | null
  gitBranch: string | null
  gitRemoteUrl: string | null
  /** The preview this session exposes, when one is known. */
  preview: PreviewLink | null
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
  /** Plugin version this session's hooks report; null for transcript-only rows. */
  pluginVersion: string | null
  /** Whether a newer build is installed and whether the board can restart this session. */
  update: SessionUpdate
  /** An ended session with a conversation can be resumed in a new tmux session. */
  resumable: boolean
  /**
   * Where the resume command comes from: the launcher captured while the session
   * ran, or the launcher set in Settings when no capture exists.
   */
  resumableVia: 'captured' | 'launcher' | null
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
  /** Command prefix used to resume a session whose launcher was not captured. */
  sessionLauncher: string
  /** Restart idle tmux sessions when an update is installed. */
  autoRestartSessions: boolean
  /** Projects mapped to the address their preview is served on. */
  previewRules: PreviewRule[]
  /** Host suffixes treated as a preview when a session prints such a URL. */
  previewHosts: string[]
  /** Zone registered previews live under, e.g. `fixplay.dev`; empty disables them. */
  previewZone: string
  /** Newest Claude Code and plugin version found on this machine, when detectable. */
  installedClaudeVersion: string | null
  installedPluginVersion: string | null
  /** Whether in-place session restarts are supported on this host. */
  restartSupported: boolean
  serverStartedAt: number
  serverUrl: string
}

export interface SettingsPatch {
  questionMode?: 'auto' | 'web' | 'terminal'
  questionTimeoutSeconds?: number
  launchEnabled?: boolean
  sessionLauncher?: string
  autoRestartSessions?: boolean
  previewRules?: PreviewRule[]
  previewHosts?: string[]
  previewZone?: string
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

export interface PromptInput {
  text: string
}

export interface PromptResult {
  ok: boolean
  /**
   * `typed` means the text went into the session's tmux pane and it is working
   * on it now. `queued` means it waits in the inbox for the session's next turn.
   */
  mode: 'typed' | 'queued'
  /** tmux session the text was typed into, when it was typed at all. */
  tmux?: string | null
  /** Why a task was queued instead of typed, or what to do next. */
  note?: string | null
  error?: string
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

export interface RestartSessionResult {
  ok: boolean
  output?: string
  error?: string
}

export interface ResumeSessionResult {
  ok: boolean
  /** tmux session name when the resume started a new pane. */
  tmux?: string
  /** Something the person has to do in that pane before the session continues. */
  note?: string
  error?: string
}

export type DelegatedTaskStatus =
  | 'queued'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'done'
  | 'cancelled'

export type DelegatedTaskPriority = 'low' | 'normal' | 'high' | 'urgent'

/**
 * A larger goal the human handed to the commander, split into delegated tasks
 * across one or more repositories. The epic is the stable unit of overview:
 * it owns the short status line, the thread with the human, and the rollup of
 * its tasks. It never replaces the tasks — it groups them.
 */
export type EpicStatus = 'active' | 'paused' | 'blocked' | 'done' | 'cancelled'

export type EpicMessageKind = 'question' | 'note' | 'answer' | 'status'

export interface EpicMessage {
  id: string
  at: number
  /** null for system lines such as a status change. */
  authorSessionId: string | null
  kind: EpicMessageKind
  body: string
  /** Set once the epic owner was actually handed a human message. */
  deliveredAt: number | null
}

export interface Epic {
  id: string
  title: string
  /** Why this exists and what "done" means, in the commander's words. */
  goal: string
  status: EpicStatus
  /** One or two sentences for the overview; kept short on purpose. */
  statusLine: string | null
  /** Absolute project directories this epic touches. */
  repositories: string[]
  /** Preview the epic or one of its sessions exposes. */
  previewUrl: string | null
  /** The epic commander; null while the main commander runs it directly. */
  ownerSessionId: string | null
  createdBySessionId: string | null
  revision: number
  createdAt: number
  updatedAt: number
  completedAt: number | null
  messages: EpicMessage[]
}

export interface EpicInput {
  title: string
  goal?: string
  repositories?: string[]
  previewUrl?: string | null
  ownerSessionId?: string | null
}

export interface EpicPatch {
  title?: string
  goal?: string
  status?: EpicStatus
  statusLine?: string | null
  repositories?: string[]
  previewUrl?: string | null
  ownerSessionId?: string | null
  expectedRevision?: number
}

export interface EpicMessageInput {
  body: string
  kind?: EpicMessageKind
}

export interface TaskActivity {
  id: string
  at: number
  actorSessionId: string | null
  kind: 'created' | 'assigned' | 'progress' | 'status' | 'note' | 'dispatch' | 'decision'
  text: string
}

export interface DelegatedTask {
  id: string
  title: string
  brief: string
  status: DelegatedTaskStatus
  priority: DelegatedTaskPriority
  /** Declared by the assignee or commander; never inferred from an idle turn. */
  progress: number
  assigneeSessionId: string | null
  createdBySessionId: string | null
  projectPath: string | null
  /** The epic this task belongs to; null for standalone work. */
  epicId: string | null
  lastNote: string | null
  result: string | null
  lastDispatch: PromptResult | null
  revision: number
  createdAt: number
  updatedAt: number
  completedAt: number | null
  activities: TaskActivity[]
}

export interface DelegatedTaskInput {
  title: string
  brief: string
  priority?: DelegatedTaskPriority
  assigneeSessionId?: string | null
  projectPath?: string | null
  epicId?: string | null
}

export interface DelegatedTaskPatch {
  title?: string
  brief?: string
  status?: DelegatedTaskStatus
  priority?: DelegatedTaskPriority
  progress?: number
  assigneeSessionId?: string | null
  projectPath?: string | null
  epicId?: string | null
  note?: string
  result?: string
  expectedRevision?: number
}

export interface KnowledgeEntry {
  id: string
  title: string
  body: string
  tags: string[]
  /** Relevant to this directory and its children; null means every session. */
  projectPath: string | null
  /** Included in every prompt, not only at session start and through list_knowledge. */
  always: boolean
  createdBySessionId: string | null
  createdAt: number
  updatedAt: number
  archivedAt: number | null
  revision: number
}

export interface KnowledgeInput {
  title: string
  body: string
  tags?: string[]
  projectPath?: string | null
  always?: boolean
}

export interface KnowledgePatch extends Partial<KnowledgeInput> {
  archived?: boolean
  expectedRevision?: number
}

export interface DecisionRequest {
  id: string
  question: string
  context: string | null
  taskId: string | null
  requestedBySessionId: string
  createdAt: number
  resolvedAt: number | null
  answer: string | null
  delivery: PromptResult | null
}

export interface DecisionInput {
  question: string
  context?: string | null
  taskId?: string | null
}

export interface CommanderCommand {
  id: string
  text: string
  createdAt: number
  result: PromptResult
}

/**
 * A line in the commander channel: what the main session reports back while
 * work runs. Automated ledger events use a null author so the feed stays
 * readable next to the commander's own reports.
 */
export type CommanderUpdateKind = 'status' | 'progress' | 'blocked' | 'done' | 'question' | 'note'

export interface CommanderUpdate {
  id: string
  at: number
  kind: CommanderUpdateKind
  title: string
  body: string
  projectPath: string | null
  /** The epic this report is about, when it belongs to one. */
  epicId: string | null
  taskIds: string[]
  authorSessionId: string | null
}

export interface CommanderUpdateInput {
  kind?: CommanderUpdateKind
  title: string
  body: string
  projectPath?: string | null
  epicId?: string | null
  taskIds?: string[]
}

export interface CommandCenterSnapshot {
  commanderSessionId: string | null
  tasks: DelegatedTask[]
  epics: Epic[]
  knowledge: KnowledgeEntry[]
  decisions: DecisionRequest[]
  commands: CommanderCommand[]
  updates: CommanderUpdate[]
}

export interface CommandReceipt extends PromptResult {
  commandId: string
}

export type ServerEvent =
  | {
      type: 'hello'
      sessions: SessionSummary[]
      questions: PendingQuestion[]
      commandCenter: CommandCenterSnapshot
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
  | { type: 'command-center'; commandCenter: CommandCenterSnapshot }
  | { type: 'config'; config: PublicConfig }
  | { type: 'ping'; at: number }

export interface ApiError {
  error: {
    code: string
    message: string
  }
}
