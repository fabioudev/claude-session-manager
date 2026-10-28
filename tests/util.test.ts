import { describe, expect, it } from 'vitest'
import {
  cleanPrompt,
  normalizeRemoteUrl,
  oneLine,
  projectNameFromPath,
  truncate,
} from '../server/util.js'

describe('util text helpers', () => {
  it('collapses whitespace and truncates to a single line', () => {
    expect(oneLine('  hello\n\nworld  ')).toBe('hello world')
    expect(oneLine('abcdefgh', 5)).toBe('abcd…')
  })

  it('strips Claude Code injected blocks from prompts', () => {
    const prompt = '<system-reminder>ignore me</system-reminder>Fix the login bug'
    expect(cleanPrompt(prompt)).toBe('Fix the login bug')
  })

  it('keeps ordinary prompt text intact', () => {
    expect(cleanPrompt('Was kostet die Reparatur?')).toBe('Was kostet die Reparatur?')
  })

  it('truncates with an ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
    expect(truncate('abc', 4)).toBe('abc')
  })
})

describe('repository helpers', () => {
  it('normalizes scp-style remotes', () => {
    expect(normalizeRemoteUrl('git@github.com:fabioudev/claude-session-manager.git')).toBe(
      'https://github.com/fabioudev/claude-session-manager',
    )
  })

  it('normalizes https remotes and rejects unknown protocols', () => {
    expect(normalizeRemoteUrl('https://github.com/owner/repo.git')).toBe(
      'https://github.com/owner/repo',
    )
    expect(normalizeRemoteUrl('file:///tmp/repo')).toBeNull()
  })

  it('derives a project name from a path', () => {
    expect(projectNameFromPath('/root/claude-session-manager')).toBe('claude-session-manager')
    expect(projectNameFromPath('')).toBe('unknown')
  })
})
