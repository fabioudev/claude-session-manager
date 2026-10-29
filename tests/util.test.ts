import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  cleanPrompt,
  missionHeadline,
  normalizeRemoteUrl,
  oneLine,
  projectLabel,
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

describe('mission headlines', () => {
  it('keeps the first sentence and drops the conversational opener', () => {
    expect(
      missionHeadline('Please fix the double-submit race. A fast double click creates two orders.'),
    ).toBe('Fix the double-submit race')
    expect(missionHeadline('Kannst du mir bitte die Rechnung als PDF exportieren?')).toBe(
      'Die Rechnung als PDF exportieren?',
    )
  })

  it('keeps a question intact', () => {
    expect(missionHeadline('Was kostet die Reparatur?')).toBe('Was kostet die Reparatur?')
  })

  it('drops a repository URL pasted before the request', () => {
    expect(
      missionHeadline(
        'https://github.com/fabioudev/claude-session-manager.git ich habe eine neue Repo gemacht. Es soll eine App werden.',
      ),
    ).toBe('Ich habe eine neue Repo gemacht')
  })

  it('unwraps the original request from a compaction preamble', () => {
    const preamble = [
      'This session is being continued from a previous conversation that ran out of context.',
      'The summary below covers the earlier portion of the conversation.',
      '',
      'Summary:',
      '1. Primary Request and Intent:',
      '   - First, the user asked to inspect the OpenAPI setup: "schaue im backend wie die generierung gerade läuft".',
      '   - Second, the user pasted a plan.',
      '2. Key Technical Concepts:',
      '   - Foo',
    ].join('\n')
    expect(missionHeadline(preamble)).toBe('Schaue im backend wie die generierung gerade läuft')
  })

  it('refuses a preamble without a request section instead of echoing it', () => {
    expect(
      missionHeadline(
        'This session is being continued from a previous conversation that ran out of context.',
      ),
    ).toBe('')
  })

  it('truncates a long mission at a word boundary', () => {
    const headline = missionHeadline(
      'Refactor the auth middleware so route guards can be tested without a running server',
    )
    expect(headline.endsWith('…')).toBe(true)
    expect(headline.length).toBeLessThanOrEqual(76)
  })

  it('returns nothing for blank input', () => {
    expect(missionHeadline('')).toBe('')
    expect(missionHeadline(null)).toBe('')
    expect(missionHeadline(undefined)).toBe('')
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

describe('project labels', () => {
  const home = homedir()

  it('uses the top-level folder, not a sub-repo or worktree', () => {
    expect(projectLabel(`${home}/fixplay-website/fixplay-backend`)).toBe('fixplay-website')
    expect(
      projectLabel(`${home}/fixplay-website/fixplay-frontend-admin/.claude/worktrees/shop-status`),
    ).toBe('fixplay-website')
    expect(projectLabel(`${home}/claude-session-manager`)).toBe('claude-session-manager')
  })

  it('has no label for the home directory itself', () => {
    expect(projectLabel(home)).toBeNull()
  })

  it('falls back to the folder name outside the home directory', () => {
    expect(projectLabel('/srv/app')).toBe('app')
    expect(projectLabel('')).toBeNull()
  })
})
