import { describe, expect, it } from 'vitest'
import {
  findPreviewRule,
  findPreviewUrl,
  hostNameInZone,
  isPreviewHost,
  normalizePreviewHost,
  normalizePreviewName,
  normalizePreviewPrefix,
  normalizePreviewRoutes,
  normalizePreviewRule,
  normalizePreviewUrl,
  normalizePreviewZone,
  parsePreviewPort,
  previewHost,
  previewUrl,
  resolvePreview,
  resolvePreviewUpstream,
  routeForPath,
} from '../server/preview.js'
import type { PreviewRule } from '../shared/types.js'

const hosts = ['trycloudflare.com', 'fixplay.dev']

describe('normalizePreviewUrl', () => {
  it('accepts plain http(s) links and trims sentence punctuation', () => {
    expect(normalizePreviewUrl('https://dev.fixplay.dev/')).toBe('https://dev.fixplay.dev/')
    expect(normalizePreviewUrl('https://a.trycloudflare.com).')).toBe(
      'https://a.trycloudflare.com/',
    )
    expect(normalizePreviewUrl('http://localhost:5173/app')).toBe('http://localhost:5173/app')
  })

  it('rejects anything that could not be a safe href', () => {
    expect(normalizePreviewUrl('javascript:alert(1)')).toBeNull()
    expect(normalizePreviewUrl('file:///etc/passwd')).toBeNull()
    expect(normalizePreviewUrl('https://user:secret@host.example/')).toBeNull()
    expect(normalizePreviewUrl('not a url')).toBeNull()
  })
})

describe('hosts and URLs in output', () => {
  it('normalises host suffixes', () => {
    expect(normalizePreviewHost('*.FixPlay.dev')).toBe('fixplay.dev')
    expect(normalizePreviewHost('  trycloudflare.com ')).toBe('trycloudflare.com')
    expect(normalizePreviewHost('https://fixplay.dev')).toBeNull()
    expect(normalizePreviewHost('')).toBeNull()
  })

  it('matches a host and its subdomains, not look-alikes', () => {
    expect(isPreviewHost('fixplay.dev', hosts)).toBe(true)
    expect(isPreviewHost('dev-diagnosetool.fixplay.dev', hosts)).toBe(true)
    expect(isPreviewHost('evilfixplay.dev', hosts)).toBe(false)
    expect(isPreviewHost('fixplay.dev.example.com', hosts)).toBe(false)
  })

  it('picks the newest matching URL out of a block of output', () => {
    const text = [
      'Started the dev server at http://localhost:5173',
      'Tunnel ready: https://hon-sound.trycloudflare.com',
    ].join('\n')
    expect(findPreviewUrl(text, hosts)).toBe('https://hon-sound.trycloudflare.com/')
  })

  it('ignores URLs on hosts that are not previews', () => {
    expect(findPreviewUrl('Docs: https://react.dev/reference', hosts)).toBeNull()
    expect(findPreviewUrl('https://hon-sound.trycloudflare.com', [])).toBeNull()
  })

  it('drops trailing punctuation from the found URL', () => {
    expect(findPreviewUrl('Open (https://x.fixplay.dev).', hosts)).toBe('https://x.fixplay.dev/')
  })
})

describe('settings rules', () => {
  const rules: PreviewRule[] = [
    { pattern: 'fixplay-diagnoseTool', url: 'https://dev-diagnosetool.example.com/' },
    { pattern: '*admin*', url: 'https://dev-admin.example.com/' },
  ]

  it('matches by substring and by wildcard', () => {
    expect(findPreviewRule(rules, ['/root/fixplay-diagnoseTool/src'])?.url).toBe(
      'https://dev-diagnosetool.example.com/',
    )
    expect(findPreviewRule(rules, ['/root/fixplay-frontend-admin'])?.url).toBe(
      'https://dev-admin.example.com/',
    )
    expect(findPreviewRule(rules, ['/root/other'])).toBeNull()
  })

  it('rejects rules without a pattern or without an http(s) URL', () => {
    expect(normalizePreviewRule({ pattern: 'x', url: 'javascript:alert(1)' })).toBeNull()
    expect(normalizePreviewRule({ pattern: '   ', url: 'https://x.example/' })).toBeNull()
    expect(normalizePreviewRule({ pattern: 'x', url: 'https://x.example/' })).toEqual({
      pattern: 'x',
      url: 'https://x.example/',
    })
  })
})

describe('resolvePreview', () => {
  it('prefers a Settings rule over a URL in the output', () => {
    expect(
      resolvePreview({
        rules: [{ pattern: 'diag', url: 'https://dev-diagnosetool.example.com/' }],
        hosts,
        values: ['/root/diag'],
        snippets: [{ text: 'see https://old.trycloudflare.com', at: 10 }],
      }),
    ).toEqual({
      url: 'https://dev-diagnosetool.example.com/',
      host: 'dev-diagnosetool.example.com',
      source: 'rule',
      foundAt: null,
    })
  })

  it('falls back to the newest snippet with a known host', () => {
    expect(
      resolvePreview({
        rules: [],
        hosts,
        values: ['/root/diag'],
        snippets: [
          { text: 'newest: https://new.trycloudflare.com', at: 20 },
          { text: 'older: https://old.trycloudflare.com', at: 10 },
        ],
      }),
    ).toEqual({
      url: 'https://new.trycloudflare.com/',
      host: 'new.trycloudflare.com',
      source: 'output',
      foundAt: 20,
    })
  })

  it('returns null when nothing matches', () => {
    expect(resolvePreview({ rules: [], hosts: [], values: ['/root/x'], snippets: [] })).toBeNull()
  })
})

describe('registered preview names', () => {
  it('turns a session or project name into one DNS label', () => {
    expect(normalizePreviewName('fixplay-frontend')).toBe('fixplay-frontend')
    expect(normalizePreviewName('  FixPlay Web  ')).toBe('fixplay-web')
    expect(normalizePreviewName('Grüße aus Königslutter')).toBe('gruesse-aus-koenigslutter')
    expect(normalizePreviewName('dev4')).toBe('dev4')
    expect(normalizePreviewName('a.b/c')).toBe('a-b-c')
    expect(normalizePreviewName('--edge--')).toBe('edge')
    expect(normalizePreviewName('x'.repeat(100))).toHaveLength(63)
  })

  it('refuses a name that cannot be a host label', () => {
    expect(normalizePreviewName('')).toBeNull()
    expect(normalizePreviewName('   ')).toBeNull()
    expect(normalizePreviewName('???')).toBeNull()
    expect(normalizePreviewName(null)).toBeNull()
    expect(normalizePreviewName(42)).toBeNull()
  })

  it('takes a zone with a dot, with or without a wildcard', () => {
    expect(normalizePreviewZone('fixplay.dev')).toBe('fixplay.dev')
    expect(normalizePreviewZone('*.FixPlay.DEV')).toBe('fixplay.dev')
    expect(normalizePreviewZone('localhost')).toBeNull()
    expect(normalizePreviewZone('')).toBeNull()
    expect(normalizePreviewZone('not a domain')).toBeNull()
  })

  it('builds host and url from a name and zone', () => {
    expect(previewHost('dev4', 'fixplay.dev')).toBe('dev4.fixplay.dev')
    expect(previewUrl('dev4', 'fixplay.dev')).toBe('https://dev4.fixplay.dev/')
  })
})

describe('hostNameInZone', () => {
  it('accepts a single label in the zone', () => {
    expect(hostNameInZone('dev4.fixplay.dev', 'fixplay.dev')).toBe('dev4')
    expect(hostNameInZone('DEV4.FixPlay.dev', 'fixplay.dev')).toBe('dev4')
    expect(hostNameInZone('dev4.fixplay.dev:443', 'fixplay.dev')).toBe('dev4')
    expect(hostNameInZone('dev4.fixplay.dev.', 'fixplay.dev')).toBe('dev4')
    expect(hostNameInZone('dev4.fixplay.dev, proxy.internal', 'fixplay.dev')).toBe('dev4')
  })

  it('rejects deeper names, the apex and lookalikes', () => {
    expect(hostNameInZone('a.dev4.fixplay.dev', 'fixplay.dev')).toBeNull()
    expect(hostNameInZone('fixplay.dev', 'fixplay.dev')).toBeNull()
    expect(hostNameInZone('dev4fixplay.dev', 'fixplay.dev')).toBeNull()
    expect(hostNameInZone('dev4.fixplay.dev.example.com', 'fixplay.dev')).toBeNull()
    expect(hostNameInZone('dev4', 'fixplay.dev')).toBeNull()
  })

  it('rejects labels a host cannot use', () => {
    expect(hostNameInZone('_dev4.fixplay.dev', 'fixplay.dev')).toBeNull()
    expect(hostNameInZone('dev_4.fixplay.dev', 'fixplay.dev')).toBeNull()
    expect(hostNameInZone('-dev4.fixplay.dev', 'fixplay.dev')).toBeNull()
    expect(hostNameInZone('', 'fixplay.dev')).toBeNull()
  })
})

describe('parsePreviewPort', () => {
  it('accepts loopback ports and refuses everything else', () => {
    expect(parsePreviewPort(5173)).toBe(5173)
    expect(parsePreviewPort('3000')).toBe(3000)
    expect(parsePreviewPort(1)).toBe(1)
    expect(parsePreviewPort(65535)).toBe(65535)
    for (const bad of [0, -1, 65536, 5173.5, 'abc', '', null, undefined]) {
      expect(parsePreviewPort(bad)).toBeNull()
    }
  })
})

describe('preview routes', () => {
  it('normalises a prefix to one leading and one trailing slash', () => {
    expect(normalizePreviewPrefix('/api')).toBe('/api/')
    expect(normalizePreviewPrefix('/api/')).toBe('/api/')
    expect(normalizePreviewPrefix('/a//b')).toBe('/a/b/')
    expect(normalizePreviewPrefix('/')).toBe('/')
    for (const bad of ['api', '', '/../etc', '/a/./b', '/a?x', '/a b', null]) {
      expect(normalizePreviewPrefix(bad)).toBeNull()
    }
  })

  it('keeps only usable, unique routes and reports bad ones', () => {
    expect(
      normalizePreviewRoutes([
        { prefix: '/api', port: 7100 },
        { prefix: '/files/', port: '8080', strip: true },
      ]),
    ).toEqual([
      { prefix: '/api/', port: 7100 },
      { prefix: '/files/', port: 8080, strip: true },
    ])
    expect(normalizePreviewRoutes([{ prefix: '/api/', port: 0 }])).toBeNull()
    expect(
      normalizePreviewRoutes([
        { prefix: '/api/', port: 7100 },
        { prefix: '/api/', port: 7101 },
      ]),
    ).toBeNull()
    expect(
      normalizePreviewRoutes(Array.from({ length: 11 }, () => ({ prefix: '/x/', port: 1 }))),
    ).toBeNull()
    expect(normalizePreviewRoutes('nope')).toBeNull()
  })

  it('matches the longest prefix, including the bare segment', () => {
    const routes = [
      { prefix: '/api/', port: 1 },
      { prefix: '/api/admin/', port: 2 },
    ]
    expect(routeForPath(routes, '/api/health')?.port).toBe(1)
    expect(routeForPath(routes, '/api')?.port).toBe(1)
    expect(routeForPath(routes, '/api/admin/users')?.port).toBe(2)
    expect(routeForPath(routes, '/other')).toBeNull()
  })

  it('resolves the upstream port and path, keeping the query string', () => {
    const preview = {
      port: 5173,
      routes: [
        { prefix: '/api/', port: 7100 },
        { prefix: '/legacy/', port: 7100, strip: true },
      ],
    }
    expect(resolvePreviewUpstream(preview, '/orders?page=2')).toEqual({
      port: 5173,
      path: '/orders?page=2',
    })
    expect(resolvePreviewUpstream(preview, '/api/health?x=1')).toEqual({
      port: 7100,
      path: '/api/health?x=1',
    })
    expect(resolvePreviewUpstream(preview, '/legacy/health?a=b')).toEqual({
      port: 7100,
      path: '/health?a=b',
    })
    expect(resolvePreviewUpstream(preview, '/legacy/')).toEqual({ port: 7100, path: '/' })
    expect(resolvePreviewUpstream({ port: 5173, routes: [] }, ':bad')).toBeNull()
  })
})
