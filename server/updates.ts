import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { execText } from './util.js'

export interface InstalledVersions {
  claude: string | null
  plugin: string | null
}

function parseVersion(value: string): { parts: number[]; prerelease: string } | null {
  const match = /^\s*v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(value)
  if (!match?.[1]) return null
  return {
    parts: match[1].split('.').map((part) => Number(part)),
    prerelease: match[2] ?? '',
  }
}

function comparePrerelease(left: string, right: string): number {
  const a = left.split('.')
  const b = right.split('.')
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const x = a[index]
    const y = b[index]
    // A shorter prerelease has lower precedence (1.0.0-beta < 1.0.0-beta.2).
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      const difference = Number(x) - Number(y)
      if (difference !== 0) return difference > 0 ? 1 : -1
      continue
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (xNumeric) return -1
    if (yNumeric) return 1
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/**
 * Compares dotted versions numerically. Returns 0 when either side is not a
 * version (a commit sha, for example), so an unknown string never triggers an
 * update.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0
  const length = Math.max(left.parts.length, right.parts.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  if (left.prerelease === right.prerelease) return 0
  if (!left.prerelease) return 1
  if (!right.prerelease) return -1
  return comparePrerelease(left.prerelease, right.prerelease)
}

export function isNewerVersion(installed: string | null, running: string | null): boolean {
  if (!installed || !running) return false
  return compareVersions(installed, running) > 0
}

function versionFromOutput(output: string): string | null {
  return /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(output)?.[1] ?? null
}

/**
 * The running binary may not be on the daemon's PATH (a systemd unit usually
 * does not inherit the login shell's). Try the configured name first, then the
 * usual native install locations.
 */
export async function installedClaudeVersion(claudeBin: string): Promise<string | null> {
  const candidates = [
    claudeBin,
    path.join(homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ]
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    const output = await execText(candidate, ['--version'], { timeoutMs: 8_000 })
    if (!output) continue
    const version = versionFromOutput(output)
    if (version) return version
  }
  return null
}

interface InstalledPluginEntry {
  scope?: unknown
  version?: unknown
}

function highest(versions: Iterable<string>): string | null {
  let best: string | null = null
  for (const version of versions) {
    // A marketplace can pin a commit sha instead of a version; that string
    // says nothing about whether a newer release is installed.
    if (!parseVersion(version)) continue
    if (best === null || compareVersions(version, best) > 0) best = version
  }
  return best
}

async function cachedPluginVersion(claudeDir: string): Promise<string | null> {
  const cacheDir = path.join(claudeDir, 'plugins', 'cache')
  let marketplaces: Dirent[]
  try {
    marketplaces = await readdir(cacheDir, { withFileTypes: true })
  } catch {
    return null
  }
  const versions: string[] = []
  for (const marketplace of marketplaces) {
    if (!marketplace.isDirectory()) continue
    let entries: Dirent[]
    try {
      entries = await readdir(path.join(cacheDir, marketplace.name, 'csm'), {
        withFileTypes: true,
      })
    } catch {
      // Most marketplaces do not carry this plugin.
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() && parseVersion(entry.name)) versions.push(entry.name)
    }
  }
  return highest(versions)
}

/**
 * Finds the version of the installed csm plugin. Claude Code writes the
 * authoritative list to installed_plugins.json; the cache directory is a
 * fallback for an older or partial registry.
 */
export async function installedPluginVersion(claudeDir: string): Promise<string | null> {
  try {
    const raw = JSON.parse(
      await readFile(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8'),
    ) as { plugins?: Record<string, unknown> }
    const plugins = raw.plugins
    if (plugins && typeof plugins === 'object') {
      const userVersions: string[] = []
      const otherVersions: string[] = []
      for (const [key, value] of Object.entries(plugins)) {
        if (!key.startsWith('csm@') || !Array.isArray(value)) continue
        for (const entry of value as InstalledPluginEntry[]) {
          if (entry && typeof entry === 'object' && typeof entry.version === 'string') {
            // Project-scoped installs only apply to one project. Prefer the
            // user-scoped version, which every session sees, so a newer
            // project-local copy does not flag all other sessions forever.
            if (entry.scope === 'user') userVersions.push(entry.version)
            else otherVersions.push(entry.version)
          }
        }
      }
      const version = highest(userVersions) ?? highest(otherVersions)
      if (version) return version
    }
  } catch {
    // Fall through to the cache scan.
  }
  return cachedPluginVersion(claudeDir)
}
