import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { VERSION } from '../server/version.js'

interface Manifest {
  version?: string
  plugins?: { name?: string; version?: string }[]
}

function manifest(relative: string): Manifest {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as Manifest
}

describe('release versions', () => {
  it('keeps the daemon version in step with package.json', () => {
    expect(VERSION).toBe(manifest('../package.json').version)
  })

  it('keeps the plugin and marketplace manifests in step', () => {
    expect(manifest('../plugin/.claude-plugin/plugin.json').version).toBe(VERSION)
    const entry = manifest('../.claude-plugin/marketplace.json').plugins?.find(
      (plugin) => plugin.name === 'csm',
    )
    expect(entry?.version).toBe(VERSION)
  })

  it('reads the reported plugin version from the manifest, not a copy', () => {
    const hook = readFileSync(new URL('../plugin/hooks/event.mjs', import.meta.url), 'utf8')
    expect(hook).not.toMatch(/const VERSION = '\d/)
  })
})
