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
  HookEnvelope,
  LaunchSessionInput,
  MessageInput,
  QuestionAnswerInput,
  ServerEvent,
  SessionPatch,
  SettingsPatch,
} from '../shared/types.js'
import type { AppConfig } from './config.js'
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
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
    disableRequestLogging: true,
  })

  const webIndex = path.join(config.webDir, 'index.html')
  const hasWeb = await pathExists(webIndex)

  app.addHook('onRequest', async (request, reply) => {
    applySecurityHeaders(reply)
    if (!request.url.startsWith('/api/')) return
    if (request.url.startsWith('/api/health')) return
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
    return manager.updateSettings(patch)
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
