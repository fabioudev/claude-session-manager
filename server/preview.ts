import type {
  PreviewLink,
  PreviewRegistration,
  PreviewRoute,
  PreviewRule,
} from '../shared/types.js'

/**
 * Hosts whose URLs are treated as a preview of a running dev server. The list
 * starts empty: a guessed link is worse than no link, so a person opts in by
 * naming their tunnel or dev domain in Settings.
 */
export const MAX_PREVIEW_HOSTS = 20
export const MAX_PREVIEW_RULES = 30
export const MAX_PREVIEW_PATTERN_LENGTH = 200
/** A registration is one DNS label, and one session per host. */
export const MAX_PREVIEW_NAME_LENGTH = 63
export const MAX_PREVIEW_REGISTRATIONS = 50

/** URLs in free text; trailing punctuation is trimmed afterwards. */
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi

function trimUrlToken(raw: string): string {
  let text = raw.trim()
  for (let round = 0; round < 8; round += 1) {
    const next = text.replace(/[.,;:!?]+$/, '').replace(/[)\]}]$/, '')
    if (next === text) break
    text = next
  }
  return text
}

/**
 * The canonical form of a link the board is willing to render. Anything that
 * is not a plain http(s) URL — credentials, other schemes, unparseable text —
 * is rejected so a transcript can never inject a `javascript:` href.
 */
export function normalizePreviewUrl(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const text = trimUrlToken(raw)
  if (!/^https?:\/\//i.test(text)) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null
  if (url.username || url.password) return null
  return url.toString()
}

/** A host suffix from Settings, normalised (`*.fixplay.de` → `fixplay.de`). */
export function normalizePreviewHost(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^\*\.?/, '')
  if (!host || host.length > 200) return null
  if (!/^[a-z0-9.-]+$/.test(host)) return null
  if (host.includes('..') || host.startsWith('.') || host.endsWith('.')) return null
  return host
}

export function normalizePreviewRule(raw: unknown): PreviewRule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const input = raw as { pattern?: unknown; url?: unknown }
  if (typeof input.pattern !== 'string' || typeof input.url !== 'string') return null
  const pattern = input.pattern.trim()
  if (!pattern || pattern.length > MAX_PREVIEW_PATTERN_LENGTH) return null
  const url = normalizePreviewUrl(input.url)
  if (!url) return null
  return { pattern, url }
}

export function isPreviewHost(hostname: string, hosts: string[]): boolean {
  const host = hostname.toLowerCase()
  return hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

/** The last URL in `text` whose host is a configured preview host. */
export function findPreviewUrl(text: string, hosts: string[]): string | null {
  if (!text || hosts.length === 0) return null
  let found: string | null = null
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = normalizePreviewUrl(match[0])
    if (!url) continue
    if (!isPreviewHost(new URL(url).hostname, hosts)) continue
    found = url
  }
  return found
}

function wildcardRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(source, 'i')
}

/**
 * A rule matches by substring, or by wildcard when it contains `*`. It is
 * tested against the project path and the repository names, so one rule can
 * cover a worktree, a checkout and a tmux name.
 */
export function ruleMatches(rule: PreviewRule, values: string[]): boolean {
  const pattern = rule.pattern.trim()
  if (!pattern) return false
  if (!pattern.includes('*')) {
    const needle = pattern.toLowerCase()
    return values.some((value) => value.toLowerCase().includes(needle))
  }
  const regex = wildcardRegExp(pattern)
  return values.some((value) => regex.test(value))
}

/** Rules are ordered; the first match wins. */
export function findPreviewRule(rules: PreviewRule[], values: string[]): PreviewRule | null {
  const candidates = values.filter((value) => typeof value === 'string' && value.trim() !== '')
  for (const rule of rules) {
    if (!ruleMatches(rule, candidates)) continue
    const url = normalizePreviewUrl(rule.url)
    if (url) return { pattern: rule.pattern, url }
  }
  return null
}

export function makePreviewLink(
  url: string,
  source: PreviewLink['source'],
  foundAt: number | null,
): PreviewLink | null {
  const normalized = normalizePreviewUrl(url)
  if (!normalized) return null
  return { url: normalized, host: new URL(normalized).host, source, foundAt }
}

export interface PreviewSources {
  rules: PreviewRule[]
  hosts: string[]
  /** Paths and repository names a rule is matched against. */
  values: string[]
  /** Text from the session, newest first. */
  snippets: { text: string; at: number | null }[]
}

/**
 * A configured rule wins over a URL found in output: the rule is stable, the
 * URL in a transcript may belong to a tunnel that has been dead for days.
 */
export function resolvePreview(sources: PreviewSources): PreviewLink | null {
  const rule = findPreviewRule(sources.rules, sources.values)
  if (rule) return makePreviewLink(rule.url, 'rule', null)
  for (const snippet of sources.snippets) {
    const url = findPreviewUrl(snippet.text, sources.hosts)
    if (url) return makePreviewLink(url, 'output', snippet.at)
  }
  return null
}

/**
 * German project and session names turn into readable labels: `Grüße` becomes
 * `gruesse`, not `gr-e`. Everything else outside [a-z0-9-] becomes a hyphen.
 */
function transliterate(text: string): string {
  return text
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
}

/**
 * The DNS label a registered preview lives under. It is always a single label,
 * so a session name can never escape its zone.
 */
export function normalizePreviewName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = transliterate(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_PREVIEW_NAME_LENGTH)
    .replace(/^-+/, '')
    .replace(/-+$/, '')
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return null
  return name
}

/**
 * The zone registered previews live under, such as `fixplay.dev`. A bare host
 * without a dot is refused: `https://dev4.localhost` is not reachable.
 */
export function normalizePreviewZone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const zone = normalizePreviewHost(raw)
  if (!zone?.includes('.')) return null
  return zone
}

export function previewHost(name: string, zone: string): string {
  return `${name}.${zone}`
}

export function previewUrl(name: string, zone: string): string {
  return `https://${name}.${zone}/`
}

/**
 * The single label a request host uses inside the zone. `dev4.fixplay.dev`
 * yields `dev4`; the apex, a deeper subdomain or a lookalike (`dev4fixplay.dev`)
 * yields null.
 */
export function hostNameInZone(host: string, zone: string): string | null {
  if (!zone) return null
  const bare = (host.split(',')[0] ?? '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
  if (!bare.endsWith(`.${zone}`)) return null
  const label = bare.slice(0, -(zone.length + 1))
  if (!label || label.includes('.')) return null
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null
  return label
}

/** A loopback port a dev server listens on. */
export function parsePreviewPort(raw: unknown): number | null {
  const port = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return port
}

export const MAX_PREVIEW_ROUTES = 10
export const MAX_PREVIEW_PREFIX_LENGTH = 200

/**
 * A path prefix, normalised to start and end with `/`. `api` becomes `/api/`,
 * and `..` is refused so a route can never reach outside its own prefix.
 */
export function normalizePreviewPrefix(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text.startsWith('/') || text.length > MAX_PREVIEW_PREFIX_LENGTH) return null
  if (/[\s?#]/.test(text)) return null
  const segments = text.split('/').filter((segment) => segment !== '')
  if (segments.some((segment) => segment === '.' || segment === '..')) return null
  return segments.length === 0 ? '/' : `/${segments.join('/')}/`
}

export function normalizePreviewRoute(raw: unknown): PreviewRoute | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const input = raw as { prefix?: unknown; port?: unknown; strip?: unknown }
  const prefix = normalizePreviewPrefix(input.prefix)
  const port = parsePreviewPort(input.port)
  if (!prefix || !port) return null
  const route: PreviewRoute = { prefix, port }
  if (input.strip === true) route.strip = true
  return route
}

/**
 * Routes for a registration. Returns null for anything unusable: a silently
 * dropped route would make a half-working preview that is hard to explain.
 */
export function normalizePreviewRoutes(raw: unknown): PreviewRoute[] | null {
  if (!Array.isArray(raw)) return null
  if (raw.length > MAX_PREVIEW_ROUTES) return null
  const routes: PreviewRoute[] = []
  for (const item of raw) {
    const route = normalizePreviewRoute(item)
    if (!route) return null
    if (routes.some((existing) => existing.prefix === route.prefix)) return null
    routes.push(route)
  }
  return routes
}

/** The route whose prefix matches, longest prefix first. */
export function routeForPath(routes: PreviewRoute[], path: string): PreviewRoute | null {
  let best: PreviewRoute | null = null
  for (const route of routes) {
    const matches = path === route.prefix || path.startsWith(route.prefix)
    if (!matches && path !== route.prefix.replace(/\/$/, '')) continue
    if (!best || route.prefix.length > best.prefix.length) best = route
  }
  return best
}

/**
 * Where a request for `rawUrl` has to go. Without a matching route it goes to
 * the registration's own port; a route may strip its prefix.
 *
 * The Host header is always `localhost:<port>` (see the router), so an upstream
 * that is a path-routed backend sees a request it accepts.
 */
export function resolvePreviewUpstream(
  preview: Pick<PreviewRegistration, 'port' | 'routes'>,
  rawUrl: string,
): { port: number; path: string } | null {
  const url = rawUrl || '/'
  if (!url.startsWith('/')) return null
  const end = Math.min(
    ...[url.indexOf('?'), url.indexOf('#')].map((index) => (index < 0 ? url.length : index)),
  )
  const path = url.slice(0, end) || '/'
  const rest = url.slice(end)
  const route = routeForPath(preview.routes ?? [], path)
  if (!route) return { port: preview.port, path: url }
  if (!route.strip) return { port: route.port, path: url }
  const stripped = path.slice(route.prefix.length - 1) || '/'
  return {
    port: route.port,
    path: `${stripped.startsWith('/') ? stripped : `/${stripped}`}${rest}`,
  }
}
