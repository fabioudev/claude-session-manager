import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compareVersions,
  installedClaudeVersion,
  installedPluginVersion,
  isNewerVersion,
} from '../server/updates.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'csm-updates-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('version comparison', () => {
  it('compares dotted versions numerically, not as strings', () => {
    expect(compareVersions('2.1.312', '2.1.311')).toBe(1)
    expect(compareVersions('2.1.9', '2.1.10')).toBe(-1)
    expect(compareVersions('2.1', '2.1.0')).toBe(0)
    expect(compareVersions('v2.2.0', '2.1.99')).toBe(1)
  })

  it('orders a release above its prerelease', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(1)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.1')).toBe(1)
  })

  it('compares prerelease identifiers numerically, not as strings', () => {
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.9')).toBe(1)
    expect(compareVersions('1.0.0-beta.9', '1.0.0-beta.10')).toBe(-1)
    expect(compareVersions('1.0.0-beta', '1.0.0-beta.2')).toBe(-1)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta')).toBe(1)
    // Numeric identifiers have lower precedence than alphanumeric ones.
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1)
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1)
  })

  it('treats unknown strings as equal so they never flag an update', () => {
    expect(compareVersions('main', '2.1.312')).toBe(0)
    expect(compareVersions('abc1234', 'abc1234')).toBe(0)
    expect(isNewerVersion('newer', null)).toBe(false)
    expect(isNewerVersion(null, '2.0.0')).toBe(false)
    expect(isNewerVersion('2.1.312', '2.1.311')).toBe(true)
    expect(isNewerVersion('2.1.312', '2.1.312')).toBe(false)
    expect(isNewerVersion('2.1.312', 'abc')).toBe(false)
  })
})

describe('installedClaudeVersion', () => {
  it('parses the version from the configured binary', async () => {
    const bin = path.join(dir, 'claude')
    await writeFile(bin, '#!/bin/sh\necho "2.1.312 (Claude Code)"\n')
    await chmod(bin, 0o755)
    expect(await installedClaudeVersion(bin)).toBe('2.1.312')
  })
})

describe('installedPluginVersion', () => {
  it('prefers the user-scoped version over a project-scoped copy', async () => {
    // A newer copy installed for one project must not flag every other
    // session forever; the user-scoped version is the one all sessions see.
    const plugins = path.join(dir, 'plugins')
    await mkdir(plugins, { recursive: true })
    await writeFile(
      path.join(plugins, 'installed_plugins.json'),
      JSON.stringify({
        version: 1,
        plugins: {
          'csm@claude-session-manager': [
            { scope: 'user', version: '0.1.0', installPath: '/tmp/a' },
            { scope: 'project', version: '0.1.2', installPath: '/tmp/b' },
          ],
          'other@marketplace': [{ version: '9.9.9' }],
        },
      }),
    )
    expect(await installedPluginVersion(dir)).toBe('0.1.0')
  })

  it('ignores a commit sha when it is the only version given', async () => {
    const plugins = path.join(dir, 'plugins')
    await mkdir(plugins, { recursive: true })
    await writeFile(
      path.join(plugins, 'installed_plugins.json'),
      JSON.stringify({
        version: 1,
        plugins: {
          'csm@claude-session-manager': [{ scope: 'user', version: 'f35eecdafd3e' }],
        },
      }),
    )
    expect(await installedPluginVersion(dir)).toBeNull()
  })

  it('falls back to the plugin cache when the registry is missing', async () => {
    const cache = path.join(dir, 'plugins', 'cache', 'claude-session-manager', 'csm')
    await mkdir(path.join(cache, '0.1.1'), { recursive: true })
    await mkdir(path.join(cache, '0.1.0'), { recursive: true })
    expect(await installedPluginVersion(dir)).toBe('0.1.1')
  })

  it('returns null when nothing is installed', async () => {
    expect(await installedPluginVersion(dir)).toBeNull()
  })
})
