import { createHash, timingSafeEqual } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import path from 'node:path'
import fastifyStatic from '@fastify/static'
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import type {
  ClaimInput,
  CommanderUpdateInput,
  DecisionInput,
  DelegatedTaskInput,
  DelegatedTaskPatch,
  DelegatedTaskPriority,
  DelegatedTaskStatus,
  EpicInput,
  EpicMessageInput,
  EpicMessageKind,
  EpicPatch,
  EpicStatus,
  HookEnvelope,
  KnowledgeInput,
  KnowledgePatch,
  LaunchSessionInput,
  MessageInput,
  PreviewRegistration,
  PreviewRoute,
  PreviewRule,
  QuestionAnswerInput,
  ServerEvent,
  SessionPatch,
  SettingsPatch,
} from '../shared/types.js'
import type { AppConfig } from './config.js'
import { OrchestrationError, type OrchestrationService } from './orchestration.js'
import {
  hostNameInZone,
  MAX_PREVIEW_HOSTS,
  MAX_PREVIEW_RULES,
  normalizePreviewHost,
  normalizePreviewRule,
  normalizePreviewZone,
  previewUrl,
} from './preview.js'
import type { SessionManager } from './session-manager.js'
import { pathExists } from './util.js'
import { VERSION } from './version.js'

const HEARTBEAT_MS = 20_000

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(tokenDigest(a), tokenDigest(b))
}

function headerValue(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0] ?? null
  return null
}

function bearerToken(request: FastifyRequest): string | null {
  const header = headerValue(request, 'authorization')
  if (!header) return null
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

function requestToken(request: FastifyRequest): string | null {
  return (
    bearerToken(request) ??
    headerValue(request, 'x-csm-token') ??
    (request.url.startsWith('/api/events')
      ? new URL(request.url, 'http://127.0.0.1').searchParams.get('token')
      : null)
  )
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function sessionHeader(request: FastifyRequest): string | null {
  return headerValue(request, 'x-csm-session-id')?.trim() || null
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error: { code, message } })
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Fan-out of server events to every connected browser. */
export class EventHub {
  private readonly clients = new Set<ServerResponse>()
  private readonly heartbeat: NodeJS.Timeout

  constructor() {
    this.heartbeat = setInterval(() => {
      const frame = sseFrame('ping', { type: 'ping', at: Date.now() })
      for (const client of this.clients) this.write(client, frame)
    }, HEARTBEAT_MS)
    this.heartbeat.unref?.()
  }

  get size(): number {
    return this.clients.size
  }

  add(client: ServerResponse): void {
    this.clients.add(client)
  }

  remove(client: ServerResponse): void {
    this.clients.delete(client)
  }

  publish(event: ServerEvent): void {
    const frame = sseFrame(event.type, event)
    for (const client of this.clients) this.write(client, frame)
  }

  close(): void {
    clearInterval(this.heartbeat)
    for (const client of this.clients) {
      try {
        client.end()
      } catch {
        // The browser may already be gone.
      }
    }
    this.clients.clear()
  }

  private write(client: ServerResponse, frame: string): void {
    try {
      client.write(frame)
    } catch {
      this.clients.delete(client)
    }
  }
}

/**
 * Action routes (resume, restart, stop, dismiss) answer to a POST that carries
 * nothing. A browser sends those without a content type and with an empty body,
 * but a reverse proxy may re-encode them as a chunked body, which Fastify cannot
 * match to any parser and turns into a 415. Accept an empty body whatever the
 * declared type; anything with actual content still has to be JSON.
 */
export function emptyBodyParser(
  contentTypes: string | RegExp,
  body: string | Buffer,
  done: (error: Error | null, value?: unknown) => void,
): void {
  const text = typeof body === 'string' ? body : body.toString('utf8')
  if (text.trim() === '') {
    done(null, undefined)
    return
  }
  const error = new Error(`Unsupported media type: ${String(contentTypes)}.`) as Error & {
    statusCode: number
  }
  error.statusCode = 415
  done(error)
}

function applySecurityHeaders(reply: FastifyReply): void {
  reply.header('X-Content-Type-Options', 'nosniff')
  reply.header('X-Frame-Options', 'DENY')
  reply.header('Referrer-Policy', 'no-referrer')
  reply.header('Cross-Origin-Opener-Policy', 'same-origin')
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  reply.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  )
}

export async function buildServer(
  config: AppConfig,
  manager: SessionManager,
  hub: EventHub,
  orchestration: OrchestrationService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
    disableRequestLogging: true,
  })

  const webIndex = path.join(config.webDir, 'index.html')
  const hasWeb = await pathExists(webIndex)

  app.addContentTypeParser('*', { parseAs: 'string' }, (request, body, done) => {
    emptyBodyParser(request.headers['content-type'] ?? 'no content type', body, done)
  })

  app.addHook('onRequest', async (request, reply) => {
    applySecurityHeaders(reply)
    if (!request.url.startsWith('/api/')) return
    if (request.url.startsWith('/api/health')) return
    // Caddy's on_demand_tls asks this endpoint before issuing a certificate.
    // It answers only on the daemon's loopback bind and reveals just yes/no.
    if (request.url.startsWith('/api/previews/ask')) return
    if (!config.token) return
    const provided = requestToken(request)
    if (!provided || !safeEqual(provided, config.token)) {
      return sendError(reply, 401, 'unauthorized', 'A valid bearer token is required.')
    }
  })

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store')
    }
    return payload
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (reply.sent) return
    const status =
      typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500
    if (status >= 500) {
      console.error(`[csm] ${request.method} ${request.url}:`, error)
      return sendError(reply, 500, 'internal', 'Internal server error.')
    }
    if (status === 415) {
      // The board always sends JSON, so a rejected body means something else
      // reached the daemon: a stale page, a proxy, or a hand-written request.
      // Log what arrived, because the browser only shows the message.
      console.warn(
        `[csm] 415 ${request.method} ${request.url} content-type=${
          request.headers['content-type'] ?? 'none'
        } ua=${request.headers['user-agent'] ?? 'none'}`,
      )
      return sendError(
        reply,
        415,
        'unsupported_media_type',
        `The daemon reads JSON only; the request arrived as ${
          request.headers['content-type'] ?? 'no content type'
        }.`,
      )
    }
    const code = status === 413 ? 'payload_too_large' : 'bad_request'
    return sendError(reply, status, code, error.message)
  })

  app.get('/api/health', async () => ({
    ok: true,
    version: VERSION,
    time: Date.now(),
    startedAt: manager.startedAt,
  }))

  app.get('/api/config', async () => manager.getPublicConfig())

  const previewPayload = (
    registration: PreviewRegistration,
  ): PreviewRegistration & {
    url: string | null
  } => {
    const zone = manager.getPreviewZone()
    return { ...registration, url: zone ? previewUrl(registration.name, zone) : null }
  }

  app.get('/api/previews', async () => ({
    zone: manager.getPreviewZone(),
    previews: manager.listPreviews().map(previewPayload),
  }))

  /**
   * Caddy's on_demand_tls calls this before it requests a certificate. Only a
   * name registered right now gets one, so a random host never reaches the CA.
   */
  app.get('/api/previews/ask', async (request, reply) => {
    const query = request.query as { domain?: unknown }
    const domain = typeof query.domain === 'string' ? query.domain : ''
    const zone = manager.getPreviewZone()
    const name = zone ? hostNameInZone(domain, zone) : null
    if (!name || !manager.listPreviews().some((registration) => registration.name === name)) {
      return sendError(reply, 403, 'forbidden', 'No preview is registered for this name.')
    }
    return { ok: true, name }
  })

  app.post('/api/mcp/preview', async (request, reply) => {
    const sessionId = sessionHeader(request)
    if (!sessionId) {
      return sendError(reply, 400, 'bad_request', 'Missing x-csm-session-id header.')
    }
    if (!manager.hasSession(sessionId)) {
      return sendError(reply, 404, 'not_found', 'Unknown session.')
    }
    const body = asObject(request.body)
    if (!body || body.port === undefined) {
      return sendError(reply, 400, 'bad_request', 'Expected { port, name? }.')
    }
    try {
      const registration = manager.registerPreview(sessionId, {
        port: body.port as number,
        name: typeof body.name === 'string' ? body.name : undefined,
        ttlMinutes: typeof body.ttlMinutes === 'number' ? body.ttlMinutes : undefined,
        routes: Array.isArray(body.routes) ? (body.routes as PreviewRoute[]) : undefined,
      })
      return reply.code(201).send(previewPayload(registration))
    } catch (error) {
      return sendError(reply, 400, 'bad_request', (error as Error).message)
    }
  })

  app.delete('/api/mcp/preview', async (request, reply) => {
    const sessionId = sessionHeader(request)
    if (!sessionId) {
      return sendError(reply, 400, 'bad_request', 'Missing x-csm-session-id header.')
    }
    return { removed: manager.removePreview(sessionId) }
  })

  app.post('/api/sessions/:id/preview', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!manager.hasSession(id)) return sendError(reply, 404, 'not_found', 'Unknown session.')
    const body = asObject(request.body)
    if (!body || body.port === undefined) {
      return sendError(reply, 400, 'bad_request', 'Expected { port, name? }.')
    }
    try {
      const registration = manager.registerPreview(id, {
        port: body.port as number,
        name: typeof body.name === 'string' ? body.name : undefined,
        ttlMinutes: typeof body.ttlMinutes === 'number' ? body.ttlMinutes : undefined,
        routes: Array.isArray(body.routes) ? (body.routes as PreviewRoute[]) : undefined,
      })
      return reply.code(201).send(previewPayload(registration))
    } catch (error) {
      return sendError(reply, 400, 'bad_request', (error as Error).message)
    }
  })

  app.delete('/api/sessions/:id/preview', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!manager.hasSession(id)) return sendError(reply, 404, 'not_found', 'Unknown session.')
    return { removed: manager.removePreview(id) }
  })

  app.get('/api/sessions', async () => ({
    sessions: manager.getSessions(),
    serverTime: Date.now(),
  }))

  app.get('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const detail = await manager.getDetail(id)
    if (!detail) return sendError(reply, 404, 'not_found', 'Unknown session.')
    return detail
  })

  app.patch('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!manager.hasSession(id)) return sendError(reply, 404, 'not_found', 'Unknown session.')
    const body = asObject(request.body)
    if (!body) return sendError(reply, 400, 'bad_request', 'Expected a JSON object.')
    const patch: SessionPatch = {}
    if (body.title !== undefined) {
      if (body.title !== null && typeof body.title !== 'string') {
        return sendError(reply, 400, 'bad_request', 'title must be a string or null.')
      }
      patch.title = body.title as string | null
    }
    if (typeof body.pinned === 'boolean') patch.pinned = body.pinned
    if (typeof body.archived === 'boolean') patch.archived = body.archived
    if (!Object.keys(patch).length) {
      return sendError(reply, 400, 'bad_request', 'Nothing to update.')
    }
    const summary = manager.patchSession(id, patch)
    if (!summary) return sendError(reply, 404, 'not_found', 'Unknown session.')
    return summary
  })

  app.get('/api/questions', async () => ({ questions: manager.getQuestions() }))

  app.post('/api/questions/:id/answer', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = asObject(request.body)
    if (!body || !Array.isArray(body.answers)) {
      return sendError(reply, 400, 'bad_request', 'Expected { answers: [...] }.')
    }
    const result = manager.answerQuestion(id, { answers: body.answers } as QuestionAnswerInput)
    if (!result.ok)
      return sendError(reply, 409, 'question_closed', result.error ?? 'Question closed.')
    return { ok: true }
  })

  app.post('/api/questions/:id/dismiss', async (request, reply) => {
    const { id } = request.params as { id: string }
    const dismissed = manager.dismissQuestion(id)
    if (!dismissed) return sendError(reply, 404, 'not_found', 'This question is no longer open.')
    return { ok: true }
  })

  app.get('/api/coordination', async () => manager.getCoordination())

  app.get('/api/messages', async () => ({ messages: manager.getCoordination().messages }))

  app.post('/api/messages', async (request, reply) => {
    const body = asObject(request.body)
    if (!body) return sendError(reply, 400, 'bad_request', 'Expected a JSON object.')
    if (typeof body.body !== 'string') {
      return sendError(reply, 400, 'bad_request', 'Message body must be a string.')
    }
    try {
      const message = manager.sendMessage({
        body: body.body,
        kind: body.kind as MessageInput['kind'],
        toSessionId: typeof body.toSessionId === 'string' ? body.toSessionId : null,
      })
      return reply.code(201).send(message)
    } catch (error) {
      return sendError(reply, 400, 'bad_request', (error as Error).message)
    }
  })

  app.post('/api/sessions/:id/inbox/read', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!manager.hasSession(id)) return sendError(reply, 404, 'not_found', 'Unknown session.')
    return manager.getInbox(id)
  })

  app.post('/api/sessions/:id/claims', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!manager.hasSession(id)) return sendError(reply, 404, 'not_found', 'Unknown session.')
    const body = asObject(request.body)
    if (!body || !Array.isArray(body.paths)) {
      return sendError(reply, 400, 'bad_request', 'Expected { paths: string[] }.')
    }
    try {
      const input: ClaimInput = {
        paths: body.paths.filter((item): item is string => typeof item === 'string'),
        note: typeof body.note === 'string' ? body.note : null,
        ttlMinutes: typeof body.ttlMinutes === 'number' ? body.ttlMinutes : undefined,
        release: body.release === true,
      }
      return manager.claimFiles(id, input)
    } catch (error) {
      return sendError(reply, 400, 'bad_request', (error as Error).message)
    }
  })

  app.delete('/api/sessions/:id/claims', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!manager.hasSession(id)) return sendError(reply, 404, 'not_found', 'Unknown session.')
    return { released: manager.releaseAllClaims(id) }
  })

  app.post('/api/launch', async (request, reply) => {
    const body = asObject(request.body)
    if (!body || typeof body.prompt !== 'string') {
      return sendError(reply, 400, 'bad_request', 'Expected { cwd, prompt }.')
    }
    const input: LaunchSessionInput = {
      cwd: typeof body.cwd === 'string' ? body.cwd : process.cwd(),
      prompt: body.prompt,
      name: typeof body.name === 'string' ? body.name : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      permissionMode: typeof body.permissionMode === 'string' ? body.permissionMode : undefined,
      resumeSessionId: typeof body.resumeSessionId === 'string' ? body.resumeSessionId : undefined,
    }
    const result = await manager.launchSession(input)
    return result.ok ? result : reply.code(400).send(result)
  })

  app.post('/api/sessions/:id/stop', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!manager.hasSession(id)) return sendError(reply, 404, 'not_found', 'Unknown session.')
    const result = await manager.stopSession(id)
    return result.ok ? result : reply.code(409).send(result)
  })

  app.post('/api/sessions/:id/restart', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!manager.hasSession(id)) return sendError(reply, 404, 'not_found', 'Unknown session.')
    const result = await manager.restartSession(id)
    return result.ok ? result : reply.code(409).send(result)
  })

  app.post('/api/sessions/:id/prompt', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!manager.hasSession(id)) return sendError(reply, 404, 'not_found', 'Unknown session.')
    const body = asObject(request.body)
    if (!body || typeof body.text !== 'string') {
      return sendError(reply, 400, 'bad_request', 'Expected { text } with the task to run.')
    }
    const result = await manager.sendPrompt(id, body.text)
    return result.ok ? result : reply.code(400).send(result)
  })

  app.post('/api/sessions/:id/resume', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!manager.hasSession(id)) return sendError(reply, 404, 'not_found', 'Unknown session.')
    const result = await manager.resumeSession(id)
    return result.ok ? result : reply.code(409).send(result)
  })

  app.patch('/api/settings', async (request, reply) => {
    const body = asObject(request.body)
    if (!body) return sendError(reply, 400, 'bad_request', 'Expected a JSON object.')
    const patch: SettingsPatch = {}
    if (body.questionMode !== undefined) {
      if (
        body.questionMode !== 'auto' &&
        body.questionMode !== 'web' &&
        body.questionMode !== 'terminal'
      ) {
        return sendError(reply, 400, 'bad_request', 'Unknown question mode.')
      }
      patch.questionMode = body.questionMode
    }
    if (typeof body.questionTimeoutSeconds === 'number') {
      patch.questionTimeoutSeconds = body.questionTimeoutSeconds
    }
    if (typeof body.launchEnabled === 'boolean') patch.launchEnabled = body.launchEnabled
    if (body.sessionLauncher !== undefined) {
      if (typeof body.sessionLauncher !== 'string') {
        return sendError(reply, 400, 'bad_request', 'Expected a session launcher string.')
      }
      if (body.sessionLauncher.length > 400) {
        return sendError(reply, 400, 'bad_request', 'The session launcher is too long.')
      }
      patch.sessionLauncher = body.sessionLauncher
    }
    if (typeof body.autoRestartSessions === 'boolean') {
      patch.autoRestartSessions = body.autoRestartSessions
    }
    if (body.previewHosts !== undefined) {
      if (!Array.isArray(body.previewHosts)) {
        return sendError(reply, 400, 'bad_request', 'Expected previewHosts to be a list of hosts.')
      }
      if (body.previewHosts.length > MAX_PREVIEW_HOSTS) {
        return sendError(
          reply,
          400,
          'bad_request',
          `At most ${MAX_PREVIEW_HOSTS} preview hosts can be configured.`,
        )
      }
      const hosts: string[] = []
      for (const item of body.previewHosts) {
        const host = typeof item === 'string' ? normalizePreviewHost(item) : null
        if (!host) {
          return sendError(
            reply,
            400,
            'bad_request',
            'A preview host must be a bare host name such as trycloudflare.com.',
          )
        }
        if (!hosts.includes(host)) hosts.push(host)
      }
      patch.previewHosts = hosts
    }
    if (body.previewRules !== undefined) {
      if (!Array.isArray(body.previewRules)) {
        return sendError(reply, 400, 'bad_request', 'Expected previewRules to be a list.')
      }
      if (body.previewRules.length > MAX_PREVIEW_RULES) {
        return sendError(
          reply,
          400,
          'bad_request',
          `At most ${MAX_PREVIEW_RULES} preview rules can be configured.`,
        )
      }
      const rules: PreviewRule[] = []
      for (const item of body.previewRules) {
        const rule = normalizePreviewRule(item)
        if (!rule) {
          return sendError(
            reply,
            400,
            'bad_request',
            'Each preview rule needs a pattern and an http(s) URL.',
          )
        }
        if (!rules.some((existing) => existing.pattern === rule.pattern)) rules.push(rule)
      }
      patch.previewRules = rules
    }
    if (body.previewZone !== undefined) {
      if (typeof body.previewZone !== 'string') {
        return sendError(reply, 400, 'bad_request', 'Expected a preview zone string.')
      }
      const zone = normalizePreviewZone(body.previewZone)
      if (body.previewZone.trim() !== '' && !zone) {
        return sendError(
          reply,
          400,
          'bad_request',
          'A preview zone must be a bare domain such as fixplay.dev.',
        )
      }
      patch.previewZone = zone ?? ''
    }
    return manager.updateSettings(patch)
  })

  const orchestrate = async <T>(
    reply: FastifyReply,
    action: () => Promise<T>,
  ): Promise<T | FastifyReply> => {
    try {
      return await action()
    } catch (error) {
      if (error instanceof OrchestrationError) {
        return sendError(reply, error.status, error.code, error.message)
      }
      throw error
    }
  }

  app.get('/api/command-center', async () => orchestration.snapshot())

  app.put('/api/commander', async (request, reply) => {
    const body = asObject(request.body)
    if (!body || (body.sessionId !== null && typeof body.sessionId !== 'string')) {
      return sendError(reply, 400, 'bad_request', 'Expected { sessionId: string | null }.')
    }
    const sessionId = body.sessionId as string | null
    return orchestrate(reply, async () => orchestration.setCommander(sessionId))
  })

  app.post('/api/commander/command', async (request, reply) => {
    const body = asObject(request.body)
    if (!body || typeof body.text !== 'string') {
      return sendError(reply, 400, 'bad_request', 'Expected { text } with the human goal.')
    }
    const text = body.text as string
    return orchestrate(reply, async () => reply.code(201).send(await orchestration.command(text)))
  })

  app.post('/api/commander/updates', async (request, reply) => {
    const body = asObject(request.body)
    if (!body || typeof body.title !== 'string' || typeof body.body !== 'string') {
      return sendError(reply, 400, 'bad_request', 'Expected { title, body }.')
    }
    if (
      body.taskIds !== undefined &&
      (!Array.isArray(body.taskIds) || body.taskIds.some((id) => typeof id !== 'string'))
    ) {
      return sendError(reply, 400, 'bad_request', 'taskIds must be a list of strings.')
    }
    return orchestrate(reply, async () =>
      reply
        .code(201)
        .send(
          await orchestration.report(
            body as unknown as CommanderUpdateInput,
            sessionHeader(request),
          ),
        ),
    )
  })

  app.post('/api/epics', async (request, reply) => {
    const body = asObject(request.body)
    if (!body || typeof body.title !== 'string') {
      return sendError(reply, 400, 'bad_request', 'Expected { title } for the epic.')
    }
    if (
      body.repositories !== undefined &&
      (!Array.isArray(body.repositories) ||
        body.repositories.some((item) => typeof item !== 'string'))
    ) {
      return sendError(reply, 400, 'bad_request', 'repositories must be a list of paths.')
    }
    return orchestrate(reply, async () =>
      reply
        .code(201)
        .send(await orchestration.createEpic(body as unknown as EpicInput, sessionHeader(request))),
    )
  })

  const epicStatuses = new Set<EpicStatus>(['active', 'paused', 'blocked', 'done', 'cancelled'])
  const epicMessageKinds = new Set<EpicMessageKind>(['question', 'note', 'answer', 'status'])

  app.patch('/api/epics/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = asObject(request.body)
    if (!body) return sendError(reply, 400, 'bad_request', 'Expected a JSON object.')
    if (body.status !== undefined && !epicStatuses.has(body.status as EpicStatus)) {
      return sendError(reply, 400, 'bad_request', 'Unknown epic status.')
    }
    if (
      body.repositories !== undefined &&
      (!Array.isArray(body.repositories) ||
        body.repositories.some((item) => typeof item !== 'string'))
    ) {
      return sendError(reply, 400, 'bad_request', 'repositories must be a list of paths.')
    }
    return orchestrate(reply, async () =>
      orchestration.updateEpic(id, body as unknown as EpicPatch, sessionHeader(request)),
    )
  })

  app.post('/api/epics/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = asObject(request.body)
    if (!body || typeof body.body !== 'string') {
      return sendError(reply, 400, 'bad_request', 'Expected { body } for the message.')
    }
    if (body.kind !== undefined && !epicMessageKinds.has(body.kind as EpicMessageKind)) {
      return sendError(reply, 400, 'bad_request', 'Unknown epic message kind.')
    }
    return orchestrate(reply, async () =>
      reply
        .code(201)
        .send(
          await orchestration.postEpicMessage(
            id,
            body as unknown as EpicMessageInput,
            sessionHeader(request),
          ),
        ),
    )
  })

  app.post('/api/epics/:id/commander', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = asObject(request.body) ?? {}
    if (body.name !== undefined && typeof body.name !== 'string') {
      return sendError(reply, 400, 'bad_request', 'Expected { name?: string }.')
    }
    return orchestrate(reply, async () =>
      reply
        .code(201)
        .send(
          await orchestration.spawnEpicCommander(
            id,
            { name: body.name as string | undefined },
            sessionHeader(request),
          ),
        ),
    )
  })

  const taskStatuses = new Set<DelegatedTaskStatus>([
    'queued',
    'in_progress',
    'blocked',
    'review',
    'done',
    'cancelled',
  ])
  const taskPriorities = new Set<DelegatedTaskPriority>(['low', 'normal', 'high', 'urgent'])

  app.post('/api/tasks', async (request, reply) => {
    const body = asObject(request.body)
    if (!body || typeof body.title !== 'string' || typeof body.brief !== 'string') {
      return sendError(reply, 400, 'bad_request', 'Expected { title, brief }.')
    }
    if (
      body.priority !== undefined &&
      !taskPriorities.has(body.priority as DelegatedTaskPriority)
    ) {
      return sendError(reply, 400, 'bad_request', 'Unknown task priority.')
    }
    return orchestrate(reply, async () =>
      reply
        .code(201)
        .send(
          await orchestration.createTask(
            body as unknown as DelegatedTaskInput,
            sessionHeader(request),
          ),
        ),
    )
  })

  app.post('/api/tasks/spawn', async (request, reply) => {
    const body = asObject(request.body)
    if (
      !body ||
      typeof body.title !== 'string' ||
      typeof body.brief !== 'string' ||
      typeof body.projectPath !== 'string'
    ) {
      return sendError(
        reply,
        400,
        'bad_request',
        'Expected { title, brief, projectPath } for the new worker session.',
      )
    }
    return orchestrate(reply, async () =>
      reply
        .code(201)
        .send(
          await orchestration.spawnTask(
            body as unknown as DelegatedTaskInput & { name?: string },
            sessionHeader(request),
          ),
        ),
    )
  })

  app.patch('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = asObject(request.body)
    if (!body) return sendError(reply, 400, 'bad_request', 'Expected a JSON object.')
    if (body.status !== undefined && !taskStatuses.has(body.status as DelegatedTaskStatus)) {
      return sendError(reply, 400, 'bad_request', 'Unknown task status.')
    }
    if (
      body.priority !== undefined &&
      !taskPriorities.has(body.priority as DelegatedTaskPriority)
    ) {
      return sendError(reply, 400, 'bad_request', 'Unknown task priority.')
    }
    return orchestrate(reply, async () =>
      orchestration.updateTask(id, body as unknown as DelegatedTaskPatch, sessionHeader(request)),
    )
  })

  app.post('/api/tasks/:id/dispatch', async (request, reply) => {
    const { id } = request.params as { id: string }
    return orchestrate(reply, async () => orchestration.dispatchTask(id, sessionHeader(request)))
  })

  app.post('/api/knowledge', async (request, reply) => {
    const body = asObject(request.body)
    if (!body || typeof body.title !== 'string' || typeof body.body !== 'string') {
      return sendError(reply, 400, 'bad_request', 'Expected { title, body }.')
    }
    if (
      body.tags !== undefined &&
      (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string'))
    ) {
      return sendError(reply, 400, 'bad_request', 'tags must be a list of strings.')
    }
    return orchestrate(reply, async () =>
      reply
        .code(201)
        .send(
          await orchestration.shareKnowledge(
            body as unknown as KnowledgeInput,
            sessionHeader(request),
          ),
        ),
    )
  })

  app.patch('/api/knowledge/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = asObject(request.body)
    if (!body) return sendError(reply, 400, 'bad_request', 'Expected a JSON object.')
    if (
      body.tags !== undefined &&
      (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string'))
    ) {
      return sendError(reply, 400, 'bad_request', 'tags must be a list of strings.')
    }
    return orchestrate(reply, async () =>
      orchestration.updateKnowledge(id, body as unknown as KnowledgePatch, sessionHeader(request)),
    )
  })

  app.post('/api/decisions', async (request, reply) => {
    const actor = sessionHeader(request)
    if (!actor) return sendError(reply, 400, 'bad_request', 'Missing x-csm-session-id header.')
    const body = asObject(request.body)
    if (!body || typeof body.question !== 'string') {
      return sendError(reply, 400, 'bad_request', 'Expected { question, context?, taskId? }.')
    }
    return orchestrate(reply, async () =>
      reply
        .code(201)
        .send(await orchestration.requestDecision(body as unknown as DecisionInput, actor)),
    )
  })

  app.post('/api/decisions/:id/resolve', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = asObject(request.body)
    if (!body || typeof body.answer !== 'string') {
      return sendError(reply, 400, 'bad_request', 'Expected { answer }.')
    }
    const answer = body.answer as string
    return orchestrate(reply, async () => orchestration.resolveDecision(id, answer))
  })

  app.post('/api/hooks/event', async (request, reply) => {
    const body = asObject(request.body)
    if (!body) return sendError(reply, 400, 'bad_request', 'Expected a JSON object.')
    if (typeof body.event !== 'string' || typeof body.sessionId !== 'string') {
      return sendError(reply, 400, 'bad_request', 'event and sessionId are required.')
    }
    const envelope = body as unknown as HookEnvelope
    return manager.handleHook(envelope)
  })

  app.post('/api/mcp/messages', async (request, reply) => {
    const fromSessionId = sessionHeader(request)
    if (!fromSessionId) {
      return sendError(reply, 400, 'bad_request', 'Missing x-csm-session-id header.')
    }
    const body = asObject(request.body)
    if (!body || typeof body.body !== 'string') {
      return sendError(reply, 400, 'bad_request', 'Expected { body }.')
    }
    try {
      return reply.code(201).send(
        manager.sendMessage(
          {
            body: body.body,
            kind: body.kind as MessageInput['kind'],
            toSessionId: typeof body.toSessionId === 'string' ? body.toSessionId : null,
          },
          { sessionId: fromSessionId },
        ),
      )
    } catch (error) {
      return sendError(reply, 400, 'bad_request', (error as Error).message)
    }
  })

  app.get('/api/mcp/inbox', async (request, reply) => {
    const sessionId = sessionHeader(request)
    if (!sessionId) return sendError(reply, 400, 'bad_request', 'Missing x-csm-session-id header.')
    return manager.getInbox(sessionId)
  })

  app.post('/api/mcp/claims', async (request, reply) => {
    const sessionId = sessionHeader(request)
    if (!sessionId) return sendError(reply, 400, 'bad_request', 'Missing x-csm-session-id header.')
    const body = asObject(request.body)
    if (!body || !Array.isArray(body.paths)) {
      return sendError(reply, 400, 'bad_request', 'Expected { paths }.')
    }
    try {
      return manager.claimFiles(sessionId, {
        paths: body.paths.filter((item): item is string => typeof item === 'string'),
        note: typeof body.note === 'string' ? body.note : null,
        ttlMinutes: typeof body.ttlMinutes === 'number' ? body.ttlMinutes : undefined,
        release: body.release === true,
      })
    } catch (error) {
      return sendError(reply, 400, 'bad_request', (error as Error).message)
    }
  })

  app.get('/api/events', async (request, reply) => {
    const response = reply.raw
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    })
    reply.hijack()
    response.write('retry: 3000\n\n')
    response.write(
      sseFrame('hello', {
        type: 'hello',
        sessions: manager.getSessions(),
        questions: manager.getQuestions(),
        commandCenter: orchestration.snapshot(),
        config: manager.getPublicConfig(),
        serverTime: Date.now(),
      } satisfies ServerEvent),
    )
    hub.add(response)
    const cleanup = (): void => hub.remove(response)
    request.raw.on('close', cleanup)
    request.raw.on('error', cleanup)
    return reply
  })

  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: config.webDir,
      prefix: '/',
      wildcard: true,
      index: ['index.html'],
      cacheControl: false,
      setHeaders: (response, filePath) => {
        if (filePath.endsWith('.html')) {
          response.header('Cache-Control', 'no-cache')
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          response.header('Cache-Control', 'public, max-age=31536000, immutable')
        }
      },
    })
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return sendError(reply, 404, 'not_found', 'Unknown endpoint.')
    }
    if (hasWeb && (request.method === 'GET' || request.method === 'HEAD')) {
      const accept = headerValue(request, 'accept') ?? ''
      if (accept.includes('text/html') || accept === '' || accept === '*/*') {
        reply.header('Cache-Control', 'no-cache')
        return reply.sendFile('index.html')
      }
    }
    return reply.code(404).type('text/plain').send('Not found')
  })

  app.addHook('onClose', async () => {
    hub.close()
  })

  return app
}

/** Serve-mode helper: the loopback URL the plugin and browser should use. */
const LOOPBACK_OR_WILDCARD = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
  '0.0.0.0',
  '::',
  '[::]',
])

/**
 * URL written to client.json for local plugin clients. A wildcard bind still
 * answers on loopback; a specific LAN address has to be used as configured.
 */
export function clientUrl(config: AppConfig): string {
  const host = LOOPBACK_OR_WILDCARD.has(config.host) ? '127.0.0.1' : config.host
  const shown = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${shown}:${config.port}`
}
