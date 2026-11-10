import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StateStore } from '../server/state-store.js'
import type { FileClaim, SessionMessage } from '../shared/types.js'

let dir: string
let store: StateStore

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'csm-state-'))
  store = new StateStore(dir)
  await store.init()
})

afterEach(async () => {
  await store.close()
  await rm(dir, { recursive: true, force: true })
})

function message(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id: 'm1',
    fromSessionId: 's1',
    fromName: 'Session one',
    toSessionId: null,
    toName: null,
    body: 'hello',
    kind: 'note',
    createdAt: 1_000,
    deliveries: {},
    readBy: {},
    ...overrides,
  }
}

function claim(overrides: Partial<FileClaim> = {}): FileClaim {
  return {
    id: 'c1',
    sessionId: 's1',
    paths: ['/repo/a.ts'],
    note: null,
    createdAt: 1_000,
    expiresAt: 100_000,
    ...overrides,
  }
}

describe('StateStore settings and sessions', () => {
  it('starts with defaults and clamps settings', () => {
    expect(store.getSettings()).toEqual({
      questionMode: 'auto',
      questionTimeoutSeconds: 90,
      launchEnabled: true,
      sessionLauncher: '',
      autoRestartSessions: false,
      previewRules: [],
      previewHosts: [],
      previewZone: '',
    })
    expect(store.updateSettings({ questionTimeoutSeconds: 1 }).questionTimeoutSeconds).toBe(5)
    expect(store.updateSettings({ questionTimeoutSeconds: 999 }).questionTimeoutSeconds).toBe(600)
    expect(store.updateSettings({ questionMode: 'terminal' }).questionMode).toBe('terminal')
    expect(store.updateSettings({ launchEnabled: false }).launchEnabled).toBe(false)
    expect(store.updateSettings({ autoRestartSessions: true }).autoRestartSessions).toBe(true)
  })

  it('keeps the session launcher on one line and within bounds', () => {
    expect(
      store.updateSettings({ sessionLauncher: '  ollama launch claude --model x --  ' })
        .sessionLauncher,
    ).toBe('ollama launch claude --model x --')
    // A newline would turn one command into two when typed into a pane.
    expect(store.updateSettings({ sessionLauncher: 'claude\nrm -rf /' }).sessionLauncher).toBe(
      'claude rm -rf /',
    )
    expect(store.updateSettings({ sessionLauncher: 'x'.repeat(500) }).sessionLauncher).toHaveLength(
      400,
    )
    expect(store.updateSettings({ sessionLauncher: '   ' }).sessionLauncher).toBe('')
  })

  it('keeps only usable preview rules and hosts', () => {
    const settings = store.updateSettings({
      previewRules: [
        { pattern: 'fixplay-diagnoseTool', url: 'https://dev-diagnosetool.example.com/' },
        { pattern: 'fixplay-diagnoseTool', url: 'https://duplicate.example.com/' },
        { pattern: '', url: 'https://empty.example.com/' },
        { pattern: 'bad', url: 'javascript:alert(1)' },
      ],
      previewHosts: ['*.FixPlay.dev', 'fixplay.dev', 'not a host', ''],
    })
    expect(settings.previewRules).toEqual([
      { pattern: 'fixplay-diagnoseTool', url: 'https://dev-diagnosetool.example.com/' },
    ])
    expect(settings.previewHosts).toEqual(['fixplay.dev'])
    // An empty list is a deliberate choice: no host is recognised in output.
    expect(store.updateSettings({ previewHosts: [] }).previewHosts).toEqual([])
  })

  it('creates, renames, pins and archives sessions', () => {
    const meta = store.ensureSession('s1', 5_000)
    expect(meta.firstSeenAt).toBe(5_000)
    expect(store.patchSession('s1', { title: '  My   session  ' }).customTitle).toBe('My session')
    expect(store.patchSession('s1', { title: '' }).customTitle).toBeNull()
    expect(store.patchSession('s1', { pinned: true, archived: true })).toMatchObject({
      pinned: true,
      archived: true,
    })
    store.setEnded('s1', 6_000)
    expect(store.getSessionMeta('s1')?.endedAt).toBe(6_000)
    store.clearEnded('s1')
    expect(store.getSessionMeta('s1')?.endedAt).toBeNull()
  })

  it('deduplicates activities and keeps them ordered', () => {
    store.ensureSession('s1', 1_000)
    const first = store.recordActivities('s1', [
      { id: 'b', at: 2_000, kind: 'tool', title: 'B' },
      { id: 'a', at: 1_000, kind: 'tool', title: 'A' },
    ])
    expect(first.map((event) => event.id)).toEqual(['b', 'a'])
    const second = store.recordActivities('s1', [
      { id: 'a', at: 1_000, kind: 'tool', title: 'A' },
      { id: 'c', at: 3_000, kind: 'tool', title: 'C' },
    ])
    expect(second.map((event) => event.id)).toEqual(['c'])
    expect(store.activitiesFor('s1').map((event) => event.id)).toEqual(['a', 'b', 'c'])
    expect(store.getSessionMeta('s1')?.lastActivityAt).toBe(3_000)
  })

  it('remembers and sanitizes the launch command used to resume a session', () => {
    expect(store.getLaunchSpec('s1')).toBeNull()
    store.setLaunchSpec('s1', {
      prefix: ['/usr/local/bin/ollama', 'launch', 'claude', '--'],
      args: ['--model', 'x'],
      cwd: '/repo',
    })
    expect(store.getLaunchSpec('s1')).toEqual({
      prefix: ['/usr/local/bin/ollama', 'launch', 'claude', '--'],
      args: ['--model', 'x'],
      cwd: '/repo',
    })
    // A spec without a program cannot be replayed, and is dropped.
    store.setLaunchSpec('s2', { prefix: [], args: ['x'], cwd: null })
    expect(store.getLaunchSpec('s2')).toBeNull()
  })
})

describe('StateStore preview registrations', () => {
  it('keeps one registration per session and makes names unique', () => {
    const first = store.registerPreview('s1', { name: 'dev4', port: 5173 }, 1_000)
    expect(first).toMatchObject({ sessionId: 's1', name: 'dev4', port: 5173 })
    expect(first.expiresAt).toBeGreaterThan(1_000)

    const second = store.registerPreview('s2', { name: 'dev4', port: 3000 }, 1_000)
    expect(second.name).toBe('dev4-2')

    const moved = store.registerPreview('s1', { name: 'dev4', port: 5174 }, 2_000)
    expect(moved.port).toBe(5174)
    expect(store.activePreviews(2_000).filter((item) => item.sessionId === 's1')).toHaveLength(1)
    // A name taken by another session keeps its suffix; a freed name is reused.
    expect(store.registerPreview('s3', { name: 'dev4', port: 4000 }, 2_000).name).toBe('dev4-3')
    store.removePreview('s1')
    expect(store.registerPreview('s4', { name: 'dev4', port: 4000 }, 2_000).name).toBe('dev4')
  })

  it('clamps the lifetime and drops expired registrations', () => {
    const short = store.registerPreview('s1', { name: 'dev4', port: 5173, ttlMinutes: 1 }, 0)
    expect(short.expiresAt).toBe(5 * 60 * 1_000)
    const long = store.registerPreview('s1', { name: 'dev4', port: 5173, ttlMinutes: 1e9 }, 0)
    expect(long.expiresAt).toBe(7 * 24 * 60 * 60 * 1_000)
    expect(store.previewFor('s1', long.expiresAt + 1)).toBeNull()
    expect(store.activePreviews(long.expiresAt + 1)).toEqual([])
  })

  it('removes a registration explicitly', () => {
    store.registerPreview('s1', { name: 'dev4', port: 5173 }, 1_000)
    expect(store.removePreview('s1')).toBe(true)
    expect(store.removePreview('s1')).toBe(false)
    expect(store.previewFor('s1', 1_000)).toBeNull()
  })

  it('keeps path routes that point at another loopback port', () => {
    const registered = store.registerPreview(
      's1',
      { name: 'admin', port: 5176, routes: [{ prefix: '/api', port: 7100 }] },
      1_000,
    )
    expect(registered.routes).toEqual([{ prefix: '/api/', port: 7100 }])
    expect(store.registerPreview('s1', { name: 'admin', port: 5176 }, 1_000).routes).toEqual([])
    expect(() =>
      store.registerPreview('s1', {
        name: 'admin',
        port: 5176,
        routes: [{ prefix: 'api', port: 7100 }],
      }),
    ).toThrow()
    expect(() =>
      store.registerPreview('s1', {
        name: 'admin',
        port: 5176,
        routes: [{ prefix: '/api/', port: 70_000 }],
      }),
    ).toThrow()
  })

  it('refuses an unusable port', () => {
    expect(() => store.registerPreview('s1', { name: 'dev4', port: 0 })).toThrow()
    expect(() => store.registerPreview('s1', { name: 'dev4', port: 70_000 })).toThrow()
  })

  it('keeps a preview zone and drops one that is not a domain', () => {
    expect(store.updateSettings({ previewZone: '*.FixPlay.DEV' }).previewZone).toBe('fixplay.dev')
    expect(store.updateSettings({ previewZone: 'localhost' }).previewZone).toBe('')
    expect(store.updateSettings({ previewZone: 'fixplay.dev' }).previewZone).toBe('fixplay.dev')
    expect(store.updateSettings({ previewZone: '' }).previewZone).toBe('')
  })
})

describe('StateStore messages', () => {
  it('delivers direct and broadcast messages, but never to the sender', () => {
    store.addMessage(message({ id: 'm1', fromSessionId: 's1' }))
    store.addMessage(message({ id: 'm2', fromSessionId: 's2', toSessionId: 's1' }))
    store.addMessage(message({ id: 'm3', fromSessionId: 's2', toSessionId: 's3' }))
    expect(store.pendingDeliveries('s1').map((item) => item.id)).toEqual(['m2'])
    expect(store.pendingDeliveries('s3').map((item) => item.id)).toEqual(['m1', 'm3'])
    expect(store.pendingDeliveries('s2').map((item) => item.id)).toEqual(['m1'])
  })

  it('marks deliveries and reads without duplicating them', () => {
    store.addMessage(message({ id: 'm1', fromSessionId: 's2', toSessionId: 's1' }))
    expect(store.unreadCount('s1')).toBe(1)
    store.markDelivered('s1', ['m1'])
    expect(store.pendingDeliveries('s1')).toEqual([])
    expect(store.unreadCount('s1')).toBe(1)
    store.markRead('s1', ['m1'])
    expect(store.unreadCount('s1')).toBe(0)
    expect(store.getMessage('m1')?.deliveries.s1).toBeTypeOf('number')
  })

  it('takes a delivery back when the text never reached the session', () => {
    store.addMessage(message({ id: 'm1', fromSessionId: 's2', toSessionId: 's1' }))
    store.markDelivered('s1', ['m1'])
    expect(store.pendingDeliveries('s1')).toEqual([])
    store.unmarkDelivered('s1', ['m1'])
    expect(store.pendingDeliveries('s1').map((item) => item.id)).toEqual(['m1'])
  })

  it('limits the message log', () => {
    for (let index = 0; index < 1005; index += 1) {
      store.addMessage(message({ id: `m${index}` }))
    }
    expect(store.listMessages(2000)).toHaveLength(1000)
    expect(store.listMessages(1)[0]?.id).toBe('m1004')
  })
})

describe('StateStore claims and overlaps', () => {
  it('replaces a session claim on the same path', () => {
    store.addClaim(claim({ id: 'c1', paths: ['/repo/a.ts'], note: 'first' }))
    store.addClaim(claim({ id: 'c2', paths: ['/repo/a.ts'], note: 'second' }))
    const active = store.activeClaims(2_000)
    expect(active).toHaveLength(1)
    expect(active[0]?.note).toBe('second')
  })

  it('releases all or selected claims', () => {
    store.addClaim(claim({ id: 'c1', paths: ['/repo/a.ts'] }))
    store.addClaim(claim({ id: 'c2', paths: ['/repo/b.ts'] }))
    expect(store.releaseClaims('s1', ['/repo/a.ts'])).toBe(1)
    expect(store.activeClaims(2_000).map((item) => item.id)).toEqual(['c2'])
    expect(store.releaseClaims('s1')).toBe(1)
    expect(store.activeClaims(2_000)).toHaveLength(0)
  })

  it('drops expired claims', () => {
    store.addClaim(claim({ id: 'c1', expiresAt: 10_000 }))
    expect(store.activeClaims(10_001)).toHaveLength(0)
  })

  it('finds conflicts from other sessions only', () => {
    store.addClaim(
      claim({
        id: 'c1',
        sessionId: 's2',
        paths: ['/repo/a.ts'],
        expiresAt: Date.now() + 60_000,
      }),
    )
    expect(store.claimsConflictingWith('s1', ['/repo/a.ts'])).toHaveLength(1)
    expect(store.claimsConflictingWith('s2', ['/repo/a.ts'])).toHaveLength(0)
  })

  it('reports overlaps when two sessions touch a path, and when a claim conflicts', () => {
    store.addFileTouches([
      { sessionId: 's1', path: '/repo/a.ts', at: 1_000, tool: 'Edit', projectPath: '/repo' },
      { sessionId: 's2', path: '/repo/a.ts', at: 2_000, tool: 'Write', projectPath: '/repo' },
    ])
    expect(store.overlaps(60_000, 3_000)).toEqual([
      { path: '/repo/a.ts', sessionIds: ['s2', 's1'], lastAt: 2_000, claimedBy: [] },
    ])

    store.addClaim(
      claim({
        id: 'c1',
        sessionId: 's3',
        paths: ['/repo/b.ts'],
        createdAt: 2_500,
        expiresAt: Date.now() + 60_000,
      }),
    )
    store.addFileTouches([
      { sessionId: 's1', path: '/repo/b.ts', at: 2_600, tool: 'Edit', projectPath: '/repo' },
    ])
    const overlaps = store.overlaps(60_000, 3_000)
    expect(overlaps.find((item) => item.path === '/repo/b.ts')?.claimedBy).toEqual(['s3'])
  })
})

describe('StateStore persistence', () => {
  it('persists state across instances', async () => {
    store.updateSettings({
      questionMode: 'terminal',
      questionTimeoutSeconds: 30,
      sessionLauncher: 'ollama launch claude --',
    })
    store.patchSession('s1', { title: 'Persisted', pinned: true })
    store.setLaunchSpec('s1', {
      prefix: ['/usr/bin/claude'],
      args: ['--model', 'opus'],
      cwd: '/repo',
    })
    store.registerPreview('s1', {
      name: 'dev4',
      port: 5173,
      ttlMinutes: 60,
      routes: [{ prefix: '/api/', port: 7100 }],
    })
    store.addMessage(
      message({ id: 'm1', fromSessionId: 's2', toSessionId: 's1', createdAt: Date.now() }),
    )
    await store.flush()

    const raw = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')) as {
      version: number
    }
    expect(raw.version).toBe(1)

    await store.close()
    const reopened = new StateStore(dir)
    await reopened.init()
    expect(reopened.getSettings()).toMatchObject({
      questionMode: 'terminal',
      questionTimeoutSeconds: 30,
      sessionLauncher: 'ollama launch claude --',
    })
    expect(reopened.getSessionMeta('s1')).toMatchObject({
      customTitle: 'Persisted',
      pinned: true,
    })
    expect(reopened.getLaunchSpec('s1')).toEqual({
      prefix: ['/usr/bin/claude'],
      args: ['--model', 'opus'],
      cwd: '/repo',
    })
    expect(reopened.activePreviews().map((preview) => preview.name)).toEqual(['dev4'])
    expect(reopened.activePreviews()[0]?.routes).toEqual([{ prefix: '/api/', port: 7100 }])
    expect(reopened.listMessages(10).map((item) => item.id)).toEqual(['m1'])
    await reopened.close()
  })

  it('moves a corrupt state file aside instead of destroying it', async () => {
    await store.flush()
    await store.close()
    const file = path.join(dir, 'state.json')
    const { readdir, writeFile } = await import('node:fs/promises')
    await writeFile(file, '{broken', 'utf8')
    const recovered = new StateStore(dir)
    await recovered.init()
    expect(recovered.getSettings().questionMode).toBe('auto')
    const names = await readdir(dir)
    const backup = names.find((name) => name.startsWith('state.json.corrupt-'))
    expect(backup).toBeTruthy()
    expect(await readFile(path.join(dir, backup!), 'utf8')).toBe('{broken')
    await recovered.close()
  })
})
