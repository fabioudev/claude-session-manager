import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export function now(): number {
  return Date.now()
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function shortId(id: string): string {
  return id.slice(0, 8)
}

export function hashString(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

export function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return path.join(homedir(), input.slice(2))
  return input
}

export function oneLine(text: string, max = 140): string {
  const value = text.replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Remove injected XML-ish blocks and command wrappers from a user prompt. */
export function cleanPrompt(text: string): string {
  let value = text
  // Claude Code injects several tag blocks into user turns. They are not what the
  // person typed, so strip the well-known ones before deriving a title.
  const tags = [
    'system-reminder',
    'local-command-caveat',
    'local-command-stdout',
    'local-command-stderr',
    'command-name',
    'command-message',
    'command-args',
    'user-prompt-submit-hook',
    'session-manager',
    'session-manager-warning',
  ]
  for (const tag of tags) {
    value = value.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ')
  }
  value = value.replace(/<[^>]+>/g, ' ')
  value = value.replace(/\[Request interrupted[^\]]*\]/g, ' ')
  return oneLine(value, 4000)
}

export function isProbablyPrompt(text: string): boolean {
  const cleaned = cleanPrompt(text)
  if (cleaned.length < 2) return false
  if (/^\[Request interrupted/.test(cleaned)) return false
  return true
}

const CONTINUATION_PREAMBLE = /^This session is being continued from a previous conversation/i

/** Conversational openers that carry no information for a headline. */
const FILLER_LEAD =
  /^(?:please|bitte|(?:can|could|would) you(?: please)?|(?:kannst|könntest|würdest) du(?: mir)?(?: bitte)?|i (?:want|need) you to|ich (?:möchte|will)(?:, dass du)?|ich hätte gern(?:, dass du)?|hilf mir(?: bitte)?|help me(?: to)?)\b[,:]?\s+/i

/**
 * The original ask embedded in Claude Code's compaction preamble. A resumed
 * session starts with "This session is being continued…" followed by the
 * summary; the "Primary Request and Intent" section quotes the user's own words.
 */
function intentFromSummary(text: string): string | null {
  if (!CONTINUATION_PREAMBLE.test(text)) return null
  const section = text.match(
    /Primary Request and Intent:\s*([\s\S]*?)(?=\n\s*(?:\d+\.\s+[A-Z]|Summary:|Key Technical Concepts)|$)/i,
  )
  const body = section?.[1] ?? ''
  if (!body.trim()) return null
  const quoted = body.match(/["“]([^"”\n]{12,}?)["”]/)
  if (quoted?.[1]) return quoted[1]
  const bullet = body.match(/^\s*[-*]\s+(.+)$/m)?.[1] ?? body
  return bullet
    .replace(/^\s*(?:first|second|third|fourth|fifth|then)\b[,:]?\s*/i, '')
    .replace(/^the user (?:asked|wanted)(?: me)? to\s+/i, '')
}

/**
 * A short headline that says what a session was asked to do. Derived from the
 * first prompt, so it stays stable across the life of a session; compaction
 * preambles are unwrapped to the original request. Returns '' when the text
 * holds nothing usable (callers fall back to another signal).
 */
export function missionHeadline(text: string | null | undefined, max = 76): string {
  if (!text) return ''
  const original = text.trim()
  if (!original) return ''
  let value: string
  if (CONTINUATION_PREAMBLE.test(original)) {
    // Never let the preamble itself become a headline; without a summary
    // section the caller should fall back to another signal.
    const intent = intentFromSummary(original)
    if (!intent) return ''
    value = intent
  } else {
    value = original
  }
  value = cleanPrompt(value)
  value = value.replace(/^[\s>*#•·–—]+/, '')
  value = value.replace(/\s+/g, ' ').trim()
  // People often paste the repository link before the actual request.
  value = value.replace(/^(?:(?:https?:\/\/|www\.)\S+\s*)+/i, '').trim()
  // A prompt that is entirely wrapped in quotes is still the prompt.
  value = value.replace(/^["“'](.+)["”']$/, '$1').trim()
  for (let pass = 0; pass < 2; pass += 1) {
    value = value.replace(FILLER_LEAD, '')
  }
  value = value.replace(/[*_`]/g, '').trim()
  // Cut at the first sentence boundary once it carries enough context.
  const sentence = value.match(/^(.{16,}?[.!?])(?:\s|$)/)
  if (sentence?.[1]) value = sentence[1]
  value = value.replace(/\.+$/, '').trim()
  if (!value) return ''
  if (value.length > max) {
    const cut = value.slice(0, max - 1)
    const space = cut.lastIndexOf(' ')
    value = `${(space > max * 0.5 ? cut.slice(0, space) : cut).trimEnd()}…`
  }
  // Headline capitalisation, but never for paths or dotted identifiers.
  const firstWord = value.split(' ', 1)[0] ?? ''
  if (/^[a-zäöüß]/.test(value) && !firstWord.includes('/') && !firstWord.includes('.')) {
    value = value.charAt(0).toUpperCase() + value.slice(1)
  }
  return value
}

export function safeJsonParse<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export async function ensureDir(dir: string, mode = 0o700): Promise<void> {
  await mkdir(dir, { recursive: true, mode })
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/** Write a file atomically (temp file in the same directory, then rename). */
export async function atomicWriteFile(file: string, contents: string, mode = 0o600): Promise<void> {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Math.round(Math.random() * 1e9)}.tmp`
  await writeFile(tmp, contents, { encoding: 'utf8', mode })
  await rename(tmp, file)
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function isPidAlive(pid: number | undefined | null): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function execText(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 1500,
      maxBuffer: 1024 * 1024,
      env: options.env,
      windowsHide: true,
    })
    return stdout.trim()
  } catch {
    return null
  }
}

export interface GitInfo {
  repoRoot: string | null
  repoName: string | null
  branch: string | null
  remoteUrl: string | null
  webUrl: string | null
}

const gitCache = new Map<string, { at: number; value: GitInfo }>()

/** Best-effort repo metadata, cached for a minute so polling stays cheap. */
export async function getGitInfo(cwd: string | null | undefined): Promise<GitInfo> {
  const empty: GitInfo = {
    repoRoot: null,
    repoName: null,
    branch: null,
    remoteUrl: null,
    webUrl: null,
  }
  if (!cwd) return empty
  const cached = gitCache.get(cwd)
  if (cached && now() - cached.at < 60_000) return cached.value

  const [root, branch, remote] = await Promise.all([
    execText('git', ['-C', cwd, 'rev-parse', '--show-toplevel']),
    execText('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']),
    execText('git', ['-C', cwd, 'config', '--get', 'remote.origin.url']),
  ])
  const remoteUrl = remote ? normalizeRemoteUrl(remote) : null
  const value: GitInfo = {
    repoRoot: root,
    repoName: root ? path.basename(root) : null,
    branch: branch && branch !== 'HEAD' ? branch : null,
    remoteUrl,
    webUrl: remoteUrl,
  }
  gitCache.set(cwd, { at: now(), value })
  return value
}

export function normalizeRemoteUrl(remote: string): string | null {
  const value = remote.trim()
  if (!value) return null
  // git@host:owner/repo.git
  const scp = value.match(/^[\w.-]+@([\w.-]+):(.+)$/)
  if (scp) {
    const host = scp[1]
    const repo = scp[2]?.replace(/\.git$/, '').replace(/^\/+/, '')
    return host && repo ? `https://${host}/${repo}` : null
  }
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ssh:') {
      return null
    }
    const host = url.hostname
    const repo = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '')
    if (!host || !repo) return null
    return `https://${host}/${repo}`
  } catch {
    return null
  }
}

export function repoNameFromRemote(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null
  try {
    const url = new URL(remoteUrl)
    const parts = url.pathname.split('/').filter(Boolean)
    return parts.at(-1) ?? null
  } catch {
    return null
  }
}

export function relativeTime(at: number, from = Date.now()): string {
  const diff = Math.max(0, from - at)
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function isoAt(ms: number | null | undefined): string | null {
  if (!ms) return null
  return new Date(ms).toISOString()
}

export function projectNameFromPath(projectPath: string): string {
  if (!projectPath) return 'unknown'
  const base = path.basename(projectPath)
  return base || projectPath
}

/**
 * The project a session belongs to, independent of its git repository. Projects
 * live in a folder directly under the home directory; anything deeper — a sub
 * repo, a worktree, a package — still belongs to that top-level folder. The home
 * directory itself names nothing, so it returns null.
 */
export function projectLabel(projectPath: string, home = homedir()): string | null {
  if (!projectPath) return null
  const target = path.resolve(projectPath)
  const base = path.resolve(home)
  if (target === base) return null
  const relative = path.relative(base, target)
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    const [first] = relative.split(path.sep)
    return first || null
  }
  return path.basename(target) || null
}
