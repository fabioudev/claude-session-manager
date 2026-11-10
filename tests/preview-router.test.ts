import {
  type AddressInfo,
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type ServerResponse,
} from 'node:http'
import { connect, createServer as createTcpServer, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  previewSessionValue,
  previewTargetFor,
  startPreviewRouter,
} from '../server/preview-router.js'
import type { PreviewRegistration } from '../shared/types.js'

function registration(overrides: Partial<PreviewRegistration> = {}): PreviewRegistration {
  return {
    sessionId: 's1',
    name: 'dev4',
    port: 5173,
    routes: [],
    createdAt: 1_000,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  }
}

interface Answer {
  status: number
  text: string
}

function get(url: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const call = request(url, { headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    call.on('error', reject)
    call.end()
  })
}

const open: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of open.reverse()) await close()
  open.length = 0
})

async function listenOnFreePort(
  handler: (incoming: IncomingMessage, response: ServerResponse) => void,
): Promise<number> {
  const server = createHttpServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  open.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return (server.address() as AddressInfo).port
}

describe('previewTargetFor', () => {
  const previews = [registration()]

  it('matches the registered label inside the zone', () => {
    expect(previewTargetFor('dev4.fixplay.dev', 'fixplay.dev', previews)?.port).toBe(5173)
    expect(previewTargetFor('DEV4.fixplay.dev:443', 'fixplay.dev', previews)?.port).toBe(5173)
    expect(previewTargetFor('dev4.fixplay.dev.', 'fixplay.dev', previews)?.port).toBe(5173)
    expect(
      previewTargetFor('dev4.fixplay.dev, proxy.internal', 'fixplay.dev', previews)?.port,
    ).toBe(5173)
  })

  it('never answers for another host', () => {
    expect(previewTargetFor('dev5.fixplay.dev', 'fixplay.dev', previews)).toBeNull()
    expect(previewTargetFor('fixplay.dev', 'fixplay.dev', previews)).toBeNull()
    expect(previewTargetFor('dev4fixplay.dev', 'fixplay.dev', previews)).toBeNull()
    expect(previewTargetFor('dev4.fixplay.dev.example.com', 'fixplay.dev', previews)).toBeNull()
    expect(previewTargetFor('a.dev4.fixplay.dev', 'fixplay.dev', previews)).toBeNull()
    expect(previewTargetFor('dev4.fixplay.dev', '', previews)).toBeNull()
    expect(previewTargetFor(null, 'fixplay.dev', previews)).toBeNull()
  })

  it('ignores expired registrations', () => {
    const expired = registration({ expiresAt: 1_500 })
    expect(previewTargetFor('dev4.fixplay.dev', 'fixplay.dev', [expired], 2_000)).toBeNull()
    expect(previewTargetFor('dev4.fixplay.dev', 'fixplay.dev', [expired], 1_000)?.port).toBe(5173)
  })
})

describe('startPreviewRouter', () => {
  it('forwards to the registered port and rewrites Host for the dev server', async () => {
    const upstreamPort = await listenOnFreePort((incoming, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          host: incoming.headers.host,
          forwarded: incoming.headers['x-forwarded-host'] ?? null,
          proto: incoming.headers['x-forwarded-proto'] ?? null,
          secret: incoming.headers['x-preview-secret'] ?? null,
        }),
      )
    })
    const router = await startPreviewRouter({
      port: 0,
      bind: '127.0.0.1',
      secret: null,
      password: null,
      zone: () => 'fixplay.dev',
      previews: () => [registration({ port: upstreamPort })],
    })
    open.push(router.close)

    const answer = await get(`http://127.0.0.1:${router.port}/hello`, {
      host: 'dev4.fixplay.dev',
    })
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.text)).toEqual({
      host: `localhost:${upstreamPort}`,
      forwarded: 'dev4.fixplay.dev',
      proto: 'https',
      secret: null,
    })
  })

  it('sends a path to the port its route names, stripping the prefix when asked', async () => {
    const pagePort = await listenOnFreePort((incoming, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(`page ${incoming.url}`)
    })
    const apiPort = await listenOnFreePort((incoming, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ api: incoming.url, host: incoming.headers.host }))
    })
    const router = await startPreviewRouter({
      port: 0,
      bind: '127.0.0.1',
      secret: null,
      password: null,
      zone: () => 'fixplay.dev',
      previews: () => [
        registration({
          port: pagePort,
          routes: [
            { prefix: '/api/', port: apiPort },
            { prefix: '/legacy/', port: apiPort, strip: true },
          ],
        }),
      ],
    })
    open.push(router.close)

    const page = await get(`http://127.0.0.1:${router.port}/orders?page=2`, {
      host: 'dev4.fixplay.dev',
    })
    expect(page.text).toBe('page /orders?page=2')

    const api = await get(`http://127.0.0.1:${router.port}/api/health?x=1`, {
      host: 'dev4.fixplay.dev',
    })
    expect(JSON.parse(api.text)).toEqual({ api: '/api/health?x=1', host: `localhost:${apiPort}` })

    const stripped = await get(`http://127.0.0.1:${router.port}/legacy/health`, {
      host: 'dev4.fixplay.dev',
    })
    expect(JSON.parse(stripped.text).api).toBe('/health')
  })

  it('tunnels a WebSocket upgrade to the dev server, so HMR survives the proxy', async () => {
    let seen = ''
    const upstream = createTcpServer((socket) => {
      socket.once('data', (chunk) => {
        seen = chunk.toString('utf8')
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
        )
        socket.write('pong-from-upstream')
      })
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    open.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())))
    const upstreamPort = (upstream.address() as AddressInfo).port

    const router = await startPreviewRouter({
      port: 0,
      bind: '127.0.0.1',
      secret: null,
      password: null,
      zone: () => 'fixplay.dev',
      previews: () => [
        registration({ port: upstreamPort, routes: [{ prefix: '/api/', port: upstreamPort }] }),
      ],
    })
    open.push(router.close)

    const answer = await new Promise<string>((resolve, reject) => {
      const socket: Socket = connect(router.port, '127.0.0.1', () => {
        socket.write(
          'GET /api/socket?client=1 HTTP/1.1\r\nHost: dev4.fixplay.dev\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGVzdA==\r\n\r\n',
        )
      })
      let text = ''
      socket.on('data', (chunk) => {
        text += chunk.toString('utf8')
        if (text.includes('pong-from-upstream')) socket.end()
      })
      socket.on('close', () => resolve(text))
      socket.on('error', reject)
    })

    expect(answer).toContain('101 Switching Protocols')
    expect(answer).toContain('pong-from-upstream')
    expect(seen).toContain(`host: localhost:${upstreamPort}`)
    expect(seen).toContain('GET /api/socket?client=1 HTTP/1.1')
  })

  it('answers 404 for a host nobody registered', async () => {
    const router = await startPreviewRouter({
      port: 0,
      bind: '127.0.0.1',
      secret: null,
      password: null,
      zone: () => 'fixplay.dev',
      previews: () => [],
    })
    open.push(router.close)

    const answer = await get(`http://127.0.0.1:${router.port}/`, { host: 'dev4.fixplay.dev' })
    expect(answer.status).toBe(404)
    expect(answer.text).toContain('No preview is registered')
  })

  it('answers 502 when the dev server is down', async () => {
    const router = await startPreviewRouter({
      port: 0,
      bind: '127.0.0.1',
      secret: null,
      password: null,
      zone: () => 'fixplay.dev',
      previews: () => [registration({ port: 9 })],
    })
    open.push(router.close)

    const answer = await get(`http://127.0.0.1:${router.port}/`, { host: 'dev4.fixplay.dev' })
    expect(answer.status).toBe(502)
  })

  it('requires the shared secret when one is configured', async () => {
    const upstreamPort = await listenOnFreePort((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
    })
    const router = await startPreviewRouter({
      port: 0,
      bind: '127.0.0.1',
      secret: 'shared-secret',
      password: null,
      zone: () => 'fixplay.dev',
      previews: () => [registration({ port: upstreamPort })],
    })
    open.push(router.close)

    const denied = await get(`http://127.0.0.1:${router.port}/`, { host: 'dev4.fixplay.dev' })
    expect(denied.status).toBe(401)

    const allowed = await get(`http://127.0.0.1:${router.port}/`, {
      host: 'dev4.fixplay.dev',
      'x-preview-secret': 'shared-secret',
    })
    expect(allowed.status).toBe(200)
    expect(allowed.text).toBe('ok')
  })
})

describe('preview login gate', () => {
  interface Answer {
    status: number
    headers: IncomingHttpHeaders
    text: string
  }

  function call(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const request_ = request(
        url,
        { method: options.method ?? 'GET', headers: options.headers },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          )
        },
      )
      request_.on('error', reject)
      if (options.body) request_.write(options.body)
      request_.end()
    })
  }

  function cookieOf(answer: Answer): string {
    const raw = answer.headers['set-cookie'] ?? []
    const cookie = raw.find((item) => item.startsWith('csm_preview='))
    if (!cookie) throw new Error('no session cookie')
    return cookie.split(';')[0] ?? ''
  }

  async function setup(password: string | null): Promise<{ routerPort: number; pagePort: number }> {
    const pagePort = await listenOnFreePort((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('app page')
    })
    const router = await startPreviewRouter({
      port: 0,
      bind: '127.0.0.1',
      secret: null,
      password,
      zone: () => 'fixplay.dev',
      previews: () => [registration({ port: pagePort })],
    })
    open.push(router.close)
    return { routerPort: router.port, pagePort }
  }

  const page = (port: number, path = '/', headers: Record<string, string> = {}) =>
    call(`http://127.0.0.1:${port}${path}`, {
      headers: { host: 'dev4.fixplay.dev', accept: 'text/html', ...headers },
    })

  it('shows a login page to a browser and a 401 to an XHR', async () => {
    const { routerPort } = await setup('privacy-first')
    const html = await page(routerPort, '/dashboard?tab=2')
    expect(html.status).toBe(200)
    expect(html.text).toContain('Preview login')
    expect(html.text).toContain('value="/dashboard?tab=2"')
    expect(html.headers['cache-control']).toBe('no-store')

    const api = await call(`http://127.0.0.1:${routerPort}/api/orders`, {
      headers: { host: 'dev4.fixplay.dev', accept: 'application/json' },
    })
    expect(api.status).toBe(401)
    expect(JSON.parse(api.text)).toEqual({ error: 'login_required' })
  })

  it('logs in with the password and lets the cookie through', async () => {
    const { routerPort } = await setup('privacy-first')
    const denied = await call(`http://127.0.0.1:${routerPort}/__csm/login`, {
      method: 'POST',
      headers: {
        host: 'dev4.fixplay.dev',
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'password=wrong&next=%2Fdashboard',
    })
    expect(denied.status).toBe(401)
    expect(denied.text).toContain('Wrong password')

    const granted = await call(`http://127.0.0.1:${routerPort}/__csm/login`, {
      method: 'POST',
      headers: {
        host: 'dev4.fixplay.dev',
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'password=privacy-first&next=%2Fdashboard',
    })
    expect(granted.status).toBe(303)
    expect(granted.headers.location).toBe('/dashboard')
    const cookie = cookieOf(granted)
    expect(granted.headers['set-cookie']?.[0]).toContain('HttpOnly')
    expect(granted.headers['set-cookie']?.[0]).toContain('Secure')

    const allowed = await page(routerPort, '/dashboard', { cookie })
    expect(allowed.status).toBe(200)
    expect(allowed.text).toBe('app page')
  })

  it('rejects an expired or tampered cookie', async () => {
    const { routerPort } = await setup('privacy-first')
    const expired = previewSessionValue('privacy-first', Date.now() - 24 * 60 * 60 * 1_000)
    expect((await page(routerPort, '/', { cookie: `csm_preview=${expired}` })).status).toBe(200)
    expect((await page(routerPort, '/', { cookie: `csm_preview=${expired}` })).text).toContain(
      'Preview login',
    )

    const fresh = previewSessionValue('privacy-first')
    const tampered = `${fresh.slice(0, -1)}${fresh.endsWith('a') ? 'b' : 'a'}`
    const answer = await page(routerPort, '/', { cookie: `csm_preview=${tampered}` })
    expect(answer.text).toContain('Preview login')
  })

  it('refuses a WebSocket upgrade without the cookie', async () => {
    const { routerPort } = await setup('privacy-first')
    const answer = await new Promise<string>((resolve, reject) => {
      const socket: Socket = connect(routerPort, '127.0.0.1', () => {
        socket.write(
          'GET /_vite/hmr HTTP/1.1\r\nHost: dev4.fixplay.dev\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
        )
      })
      let text = ''
      socket.on('data', (chunk) => {
        text += chunk.toString('utf8')
      })
      socket.on('close', () => resolve(text))
      socket.on('error', reject)
    })
    expect(answer).toContain('401 Unauthorized')
  })

  it('lets a logged-in visitor log out again', async () => {
    const { routerPort } = await setup('privacy-first')
    const cookie = `csm_preview=${previewSessionValue('privacy-first')}`

    const logout = await page(routerPort, '/__csm/logout', { cookie })
    expect(logout.status).toBe(303)
    expect(logout.headers.location).toBe('/__csm/login')
    expect(logout.headers['set-cookie']?.[0]).toContain('Max-Age=0')

    const again = await page(routerPort, '/__csm/login', { cookie })
    expect(again.status).toBe(303)
    expect(again.headers.location).toBe('/')
  })

  it('stays open when no password is configured', async () => {
    const { routerPort } = await setup(null)
    const allowed = await page(routerPort, '/', {})
    expect(allowed.status).toBe(200)
    expect(allowed.text).toBe('app page')
  })

  it('tells the dev server the original scheme, for absolute redirects', async () => {
    let headers: IncomingHttpHeaders = {}
    const pagePort = await listenOnFreePort((incoming, response) => {
      headers = incoming.headers
      response.writeHead(302, { location: '/after' })
      response.end()
    })
    const router = await startPreviewRouter({
      port: 0,
      bind: '127.0.0.1',
      secret: null,
      password: null,
      zone: () => 'fixplay.dev',
      previews: () => [registration({ port: pagePort })],
    })
    open.push(router.close)

    const answer = await call(`http://127.0.0.1:${router.port}/before`, {
      headers: { host: 'dev4.fixplay.dev' },
    })
    expect(answer.status).toBe(302)
    expect(answer.headers.location).toBe('/after')
    expect(headers['x-forwarded-host']).toBe('dev4.fixplay.dev')
    expect(headers['x-forwarded-proto']).toBe('https')
  })
})
