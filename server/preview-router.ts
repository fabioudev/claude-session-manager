import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  request,
  type ServerResponse,
} from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import type { PreviewRegistration } from '../shared/types.js'
import { hostNameInZone, resolvePreviewUpstream } from './preview.js'

/**
 * The router sits between the TLS terminator (Caddy, or the provider's proxy)
 * and the dev servers sessions run on loopback. It answers only for names that
 * were registered through the daemon, and it rewrites `Host` to
 * `localhost:<port>` because Vite and Nuxt refuse unknown hosts.
 *
 * It is deliberately tiny and dependency-free: HTTP requests are piped, and
 * WebSocket upgrades are forwarded as a raw TCP tunnel so Vite's HMR works.
 */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export interface PreviewRouterOptions {
  port: number
  bind: string
  /** When set, requests must carry `x-preview-secret` (set by the TLS proxy). */
  secret: string | null
  /**
   * When set, a visitor has to log in once; the session cookie then lets every
   * request through — the page, its assets, XHR and the HMR WebSocket alike, so
   * an app's own `Authorization` header is never touched.
   */
  password: string | null
  zone: () => string
  previews: () => PreviewRegistration[]
  log?: (message: string) => void
}

export interface PreviewRouterHandle {
  port: number
  close: () => Promise<void>
}

/** The registration a request host belongs to, or null. Pure; used by tests. */
export function previewTargetFor(
  hostHeader: string | null,
  zone: string,
  previews: PreviewRegistration[],
  at = Date.now(),
): PreviewRegistration | null {
  if (!hostHeader || !zone) return null
  const name = hostNameInZone(hostHeader, zone)
  if (!name) return null
  return previews.find((preview) => preview.name === name && preview.expiresAt > at) ?? null
}

function requestHost(request: IncomingMessage): string | null {
  const forwarded = request.headers['x-forwarded-host']
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
  return value ?? request.headers.host ?? null
}

function authorized(request: IncomingMessage, secret: string | null): boolean {
  if (!secret) return true
  const raw = request.headers['x-preview-secret']
  const provided = Array.isArray(raw) ? raw[0] : raw
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

const COOKIE_NAME = 'csm_preview'
const SESSION_MS = 12 * 60 * 60 * 1000

function signSession(password: string, expiresAt: number): string {
  return createHmac('sha256', password).update(`csm-preview:${expiresAt}`).digest('hex')
}

/** The cookie value for a fresh login. Exported so tests can mint one. */
export function previewSessionValue(password: string, at = Date.now()): string {
  const expiresAt = at + SESSION_MS
  return `${expiresAt}.${signSession(password, expiresAt)}`
}

function sessionCookieValid(request: IncomingMessage, password: string, at = Date.now()): boolean {
  const raw = request.headers.cookie?.split(';').find((part) => {
    const index = part.indexOf('=')
    return index > 0 && part.slice(0, index).trim() === COOKIE_NAME
  })
  if (!raw) return false
  const value = raw.slice(raw.indexOf('=') + 1).trim()
  const [expiresPart, signature] = value.split('.')
  const expiresAt = Number(expiresPart)
  if (!signature || !Number.isFinite(expiresAt) || expiresAt <= at) return false
  const a = Buffer.from(signature)
  const b = Buffer.from(signSession(password, expiresAt))
  return a.length === b.length && timingSafeEqual(a, b)
}

function passwordMatches(provided: string, expected: string): boolean {
  // Comparing digests keeps the comparison constant-time for any length.
  return timingSafeEqual(
    createHash('sha256').update(provided).digest(),
    createHash('sha256').update(expected).digest(),
  )
}

function escapeHtml(text: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }
  return text.replace(/[&<>"']/g, (character) => entities[character] ?? character)
}

function loginPage(name: string, next: string, failed: boolean): string {
  const message = failed
    ? '<p class="error">Wrong password. Try again.</p>'
    : '<p class="hint">This preview is private. Log in to continue.</p>'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Login · ${escapeHtml(name)}</title>
<style>
:root { color-scheme: dark }
* { box-sizing: border-box }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #14161a; color: #e8eaed;
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif }
main { width: min(92vw, 22rem); padding: 2rem; border: 1px solid #2a2f37; border-radius: 12px; background: #1a1d22 }
h1 { margin: 0 0 .25rem; font-size: 1.05rem; font-weight: 600 }
p { margin: 0 0 1.25rem; color: #9aa4b2; font-size: .875rem }
p.error { color: #f87171 }
label { display: block; margin-bottom: .4rem; font-size: .8rem; color: #9aa4b2 }
input { width: 100%; padding: .6rem .7rem; border: 1px solid #333a45; border-radius: 8px;
  background: #101216; color: inherit; font: inherit }
input:focus { outline: 2px solid #3b82f6; outline-offset: 1px }
button { width: 100%; margin-top: 1rem; padding: .6rem; border: 0; border-radius: 8px;
  background: #3b82f6; color: #fff; font: inherit; font-weight: 600; cursor: pointer }
.host { color: #6b7684; font-size: .75rem; margin-top: 1.25rem }
</style>
</head>
<body>
<main>
  <h1>Preview login</h1>
  ${message}
  <form method="post" action="/__csm/login">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">Continue</button>
  </form>
  <p class="host">${escapeHtml(name)}</p>
</main>
</body>
</html>
`
}

function readBody(incoming: IncomingMessage, limit = 4_096): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    incoming.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('Request body is too large.'))
        incoming.destroy()
        return
      }
      chunks.push(chunk)
    })
    incoming.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    incoming.on('error', reject)
  })
}

/** The form asks for HTML; an XHR or a fetch wants a clean 401 instead. */
function wantsPage(request: IncomingMessage): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const accept = request.headers.accept ?? ''
  return accept.includes('text/html')
}

function safeNext(raw: string | null | undefined): string {
  if (!raw?.startsWith('/') || raw.startsWith('//')) return '/'
  return raw
}

function sessionCookie(value: string): string {
  const maxAge = Math.floor(SESSION_MS / 1_000)
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
}

function forwardedHeaders(request: IncomingMessage, port: number): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(key) || key === 'x-preview-secret') continue
    headers[key] = value
  }
  // Vite and Nuxt reject a Host that is not localhost/their allowed list.
  headers.host = `localhost:${port}`
  headers['x-forwarded-host'] ??= request.headers.host ?? ''
  // Apps that honour forwarded headers (Nuxt/Nitro, Echo) build absolute
  // redirects and cookie URLs from these; previews are always served via TLS.
  headers['x-forwarded-proto'] ??= 'https'
  return headers
}

function upgradeHead(request: IncomingMessage, port: number, path: string): string {
  const lines = [`${request.method ?? 'GET'} ${path} HTTP/1.1`]
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined || key === 'x-preview-secret') continue
    if (key === 'host') {
      lines.push(`host: localhost:${port}`)
      continue
    }
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${key}: ${item}`)
    } else {
      lines.push(`${key}: ${value}`)
    }
  }
  if (!request.headers['x-forwarded-host']) {
    lines.push(`x-forwarded-host: ${request.headers.host ?? ''}`)
  }
  if (!request.headers['x-forwarded-proto']) lines.push('x-forwarded-proto: https')
  return `${lines.join('\r\n')}\r\n\r\n`
}

export async function startPreviewRouter(
  options: PreviewRouterOptions,
): Promise<PreviewRouterHandle> {
  const log = options.log ?? (() => undefined)

  function sendPage(response: ServerResponse, status: number, html: string): void {
    response.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    response.end(html)
  }

  /**
   * The login gate. Everything a page needs — its assets, its XHRs, the HMR
   * socket — rides on one cookie, so apps can keep sending their own
   * `Authorization` header (Firebase bearer, admin basic) untouched.
   */
  async function gate(
    incoming: IncomingMessage,
    response: ServerResponse,
    name: string,
    password: string,
  ): Promise<boolean> {
    const url = new URL(incoming.url ?? '/', 'http://preview.invalid')
    // Logout and the login form are answered whatever the cookie says, so a
    // visitor can log out and a second person can log in on the same browser.
    if (url.pathname === '/__csm/logout') {
      response.writeHead(303, {
        Location: '/__csm/login',
        'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
        'Cache-Control': 'no-store',
      })
      response.end()
      return true
    }
    if (url.pathname === '/__csm/login' && incoming.method !== 'POST') {
      if (!sessionCookieValid(incoming, password)) {
        sendPage(response, 200, loginPage(name, safeNext(url.searchParams.get('next')), false))
        return true
      }
      response.writeHead(303, { Location: safeNext(url.searchParams.get('next')) })
      response.end()
      return true
    }
    if (url.pathname === '/__csm/login') {
      let form: URLSearchParams
      try {
        form = new URLSearchParams(await readBody(incoming))
      } catch {
        response.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Request body is too large.\n')
        return true
      }
      if (!passwordMatches(form.get('password') ?? '', password)) {
        await new Promise((resolve) => setTimeout(resolve, 300))
        sendPage(response, 401, loginPage(name, safeNext(form.get('next')), true))
        return true
      }
      response.writeHead(303, {
        Location: safeNext(form.get('next')),
        'Set-Cookie': sessionCookie(previewSessionValue(password)),
        'Cache-Control': 'no-store',
      })
      response.end()
      return true
    }
    if (sessionCookieValid(incoming, password)) return false
    if (wantsPage(incoming)) {
      sendPage(response, 200, loginPage(name, safeNext(incoming.url), false))
    } else {
      response.writeHead(401, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      response.end(`${JSON.stringify({ error: 'login_required' })}\n`)
    }
    return true
  }

  const server = createServer(async (incoming, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    if (!authorized(incoming, options.secret)) {
      response.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Missing the preview secret.\n')
      return
    }
    const target = previewTargetFor(requestHost(incoming), options.zone(), options.previews())
    if (!target) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('No preview is registered for this host.\n')
      return
    }
    if (options.password && (await gate(incoming, response, target.name, options.password))) {
      return
    }
    const upstreamTarget = resolvePreviewUpstream(target, incoming.url ?? '/')
    if (!upstreamTarget) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Only origin-form requests are supported.\n')
      return
    }
    const upstream = request(
      {
        host: '127.0.0.1',
        port: upstreamTarget.port,
        method: incoming.method,
        path: upstreamTarget.path,
        headers: forwardedHeaders(incoming, upstreamTarget.port),
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.headers)
        answer.pipe(response)
      },
    )
    upstream.on('error', (error) => {
      log(`upstream ${target.name} (127.0.0.1:${upstreamTarget.port}) failed: ${error.message}`)
      if (!response.headersSent) {
        response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('The preview is not answering.\n')
      } else {
        response.destroy()
      }
    })
    incoming.on('error', () => upstream.destroy())
    response.on('close', () => upstream.destroy())
    incoming.pipe(upstream)
  })

  server.on('upgrade', (incoming, socket: Duplex, head: Buffer) => {
    if (!authorized(incoming, options.secret)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    if (options.password && !sessionCookieValid(incoming, options.password)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    const target = previewTargetFor(requestHost(incoming), options.zone(), options.previews())
    if (!target) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    const upstreamTarget = resolvePreviewUpstream(target, incoming.url ?? '/')
    if (!upstreamTarget) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return
    }
    const upstream = connect({ host: '127.0.0.1', port: upstreamTarget.port }, () => {
      upstream.write(upgradeHead(incoming, upstreamTarget.port, upstreamTarget.path))
      if (head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', (error) => {
      log(`upstream ${target.name} (127.0.0.1:${upstreamTarget.port}) dropped: ${error.message}`)
      socket.destroy()
    })
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
  })

  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.bind, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  log(`listening on ${options.bind}:${port}`)

  return {
    port,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}
