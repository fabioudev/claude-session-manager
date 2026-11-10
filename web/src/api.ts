import type {
  ClaimInput,
  CommandCenterSnapshot,
  CommanderCommand,
  CoordinationView,
  DecisionRequest,
  DelegatedTask,
  DelegatedTaskInput,
  DelegatedTaskPatch,
  FileClaim,
  KnowledgeEntry,
  KnowledgeInput,
  KnowledgePatch,
  LaunchSessionInput,
  LaunchSessionResult,
  MessageInput,
  PendingQuestion,
  PromptResult,
  PublicConfig,
  QuestionAnswerInput,
  RestartSessionResult,
  ResumeSessionResult,
  SessionDetail,
  SessionMessage,
  SessionPatch,
  SessionSummary,
  SettingsPatch,
  StopSessionResult,
} from '@shared/types'

const TOKEN_KEY = 'csm.token'

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code = 'request_failed') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function getToken(): string | null {
  try {
    return storage()?.getItem(TOKEN_KEY) ?? null
  } catch {
    return null
  }
}

export function setToken(token: string | null): void {
  try {
    if (!token) storage()?.removeItem(TOKEN_KEY)
    else storage()?.setItem(TOKEN_KEY, token)
  } catch {
    // Storage can be disabled. The token simply will not survive a reload.
  }
}

/**
 * `?token=...` is the quickest way to open a remote board. Read it once, keep
 * it in storage, and strip it from the address bar so it does not end up in a
 * screenshot, a history entry or a shared link.
 */
export function takeTokenFromUrl(): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  const token = url.searchParams.get('token')
  if (!token) return
  if (token.length >= 8) setToken(token)
  url.searchParams.delete('token')
  const query = url.searchParams.toString()
  window.history.replaceState(null, '', `${url.pathname}${query ? `?${query}` : ''}${url.hash}`)
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  let body = init.body
  if (body === undefined) {
    // Action routes take no payload. Send an empty object anyway so the request
    // always carries an explicit content type, which every proxy and daemon
    // understands without guessing.
    const method = (init.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') body = '{}'
  }
  if (body !== undefined) headers.set('content-type', 'application/json')
  const token = getToken()
  if (token) headers.set('authorization', `Bearer ${token}`)

  let response: Response
  try {
    response = await fetch(`/api${path}`, { ...init, body, headers })
  } catch {
    throw new ApiError('The daemon is not reachable.', 0, 'offline')
  }

  const text = await response.text()
  let payload: unknown = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    // Most routes answer with { error: { code, message } }, but launch and stop
    // return their result object directly, so pick up a plain string too.
    const body = payload as {
      error?: string | { code?: string; message?: string }
      message?: string
    } | null
    const envelope = typeof body?.error === 'object' ? body.error : null
    const message =
      envelope?.message ||
      (typeof body?.error === 'string' ? body.error : null) ||
      (typeof body?.message === 'string' ? body.message : null) ||
      `Request failed with HTTP ${response.status}.`
    const error = new ApiError(message, response.status, envelope?.code || 'request_failed')
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('csm:unauthorized'))
    }
    throw error
  }

  return payload as T
}

export function eventSourceUrl(): string {
  const token = getToken()
  return `/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`
}

export const api = {
  config: () => request<PublicConfig>('/config'),
  sessions: () => request<{ sessions: SessionSummary[]; serverTime: number }>('/sessions'),
  session: (id: string) => request<SessionDetail>(`/sessions/${encodeURIComponent(id)}`),
  questions: () => request<{ questions: PendingQuestion[] }>('/questions'),
  answerQuestion: (id: string, input: QuestionAnswerInput) =>
    request<{ ok: true }>(`/questions/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  dismissQuestion: (id: string) =>
    request<{ ok: true }>(`/questions/${encodeURIComponent(id)}/dismiss`, {
      method: 'POST',
    }),
  coordination: () => request<CoordinationView>('/coordination'),
  sendMessage: (input: MessageInput) =>
    request<SessionMessage>('/messages', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  inbox: (sessionId: string) =>
    request<{ messages: SessionMessage[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/inbox/read`,
      { method: 'POST' },
    ),
  patchSession: (id: string, patch: SessionPatch) =>
    request<SessionSummary>(`/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  claim: (id: string, input: ClaimInput) =>
    request<{ claim: FileClaim | null; released: number; conflicts: FileClaim[] }>(
      `/sessions/${encodeURIComponent(id)}/claims`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  releaseClaims: (id: string) =>
    request<{ released: number }>(`/sessions/${encodeURIComponent(id)}/claims`, {
      method: 'DELETE',
    }),
  launch: (input: LaunchSessionInput) =>
    request<LaunchSessionResult>('/launch', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  stop: (id: string) =>
    request<StopSessionResult>(`/sessions/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
    }),
  restart: (id: string) =>
    request<RestartSessionResult>(`/sessions/${encodeURIComponent(id)}/restart`, {
      method: 'POST',
    }),
  resume: (id: string) =>
    request<ResumeSessionResult>(`/sessions/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
    }),
  prompt: (id: string, text: string) =>
    request<PromptResult>(`/sessions/${encodeURIComponent(id)}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  updateSettings: (patch: SettingsPatch) =>
    request<PublicConfig>('/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  commandCenter: () => request<CommandCenterSnapshot>('/command-center'),
  setCommander: (sessionId: string | null) =>
    request<CommandCenterSnapshot>('/commander', {
      method: 'PUT',
      body: JSON.stringify({ sessionId }),
    }),
  command: (text: string) =>
    request<CommanderCommand>('/commander/command', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  createTask: (input: DelegatedTaskInput) =>
    request<DelegatedTask>('/tasks', { method: 'POST', body: JSON.stringify(input) }),
  updateTask: (id: string, patch: DelegatedTaskPatch) =>
    request<DelegatedTask>(`/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  dispatchTask: (id: string) =>
    request<DelegatedTask>(`/tasks/${encodeURIComponent(id)}/dispatch`, { method: 'POST' }),
  shareKnowledge: (input: KnowledgeInput) =>
    request<KnowledgeEntry>('/knowledge', { method: 'POST', body: JSON.stringify(input) }),
  updateKnowledge: (id: string, patch: KnowledgePatch) =>
    request<KnowledgeEntry>(`/knowledge/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  resolveDecision: (id: string, answer: string) =>
    request<DecisionRequest>(`/decisions/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ answer }),
    }),
  health: () =>
    request<{ ok: boolean; version: string; time: number; startedAt: number }>('/health'),
}
