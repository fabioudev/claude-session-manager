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
