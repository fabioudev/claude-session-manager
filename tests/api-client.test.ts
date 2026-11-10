import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../web/src/api.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function captureFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
  return calls
}

describe('api request', () => {
  it('gives a bodyless action POST an explicit JSON content type', async () => {
    const calls = captureFetch()
    await api.resume('abc').catch(() => undefined)
    const init = calls[0]?.init
    const headers = new Headers(init?.headers)
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe('{}')
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('keeps a real JSON payload as it is', async () => {
    const calls = captureFetch()
    await api.updateSettings({ launchEnabled: true })
    const init = calls[0]?.init
    expect(init?.body).toBe(JSON.stringify({ launchEnabled: true }))
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
  })

  it('leaves GET requests without a body', async () => {
    const calls = captureFetch()
    await api.sessions()
    expect(calls[0]?.init.body).toBeUndefined()
  })
})
