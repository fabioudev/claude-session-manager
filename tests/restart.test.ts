import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildRestartCommand,
  commandName,
  dropRootBlockedFlags,
  filterClaudeArgs,
  isDescendant,
  isExpectedForeground,
  isInteractiveShell,
  isShellCommand,
  launcherSpec,
  looksLikeAutoModeNotice,
  looksLikeTrustPrompt,
  parseLauncher,
  processEnvValue,
  readProcess,
  shellQuote,
  transcriptStartDir,
  trustedFolders,
  waitFor,
} from '../server/restart.js'
import { paneTarget, resumeSessionName } from '../server/tmux.js'

describe('filterClaudeArgs', () => {
  it('keeps how the session runs and drops the old prompt and resume flags', () => {
    expect(
      filterClaudeArgs([
        '--model',
        'opus',
        '--dangerously-skip-permissions',
        '--resume',
        'old-session',
        'fix the failing test',
      ]),
    ).toEqual(['--model', 'opus', '--dangerously-skip-permissions'])
  })

  it('keeps inline values and multi-value flags', () => {
    expect(
      filterClaudeArgs([
        '--model=sonnet',
        '--add-dir',
        'packages/a',
        'packages/b',
        '--mcp-config',
        '.mcp.json',
        '--continue',
      ]),
    ).toEqual([
      '--model=sonnet',
      '--add-dir',
      'packages/a',
      'packages/b',
      '--mcp-config',
      '.mcp.json',
    ])
  })

  it('keeps a value that starts with a dash', () => {
    // The original process had this argv, so the flag had this value. Dropping
    // it would turn the appended --resume into the flag's value.
    expect(filterClaudeArgs(['--append-system-prompt', '- keep terse', '--resume', 'old'])).toEqual(
      ['--append-system-prompt', '- keep terse'],
    )
    expect(filterClaudeArgs(['--model', '-weird'])).toEqual(['--model', '-weird'])
  })

  it('drops unknown flags rather than guessing what they consume', () => {
    expect(filterClaudeArgs(['--unknown', 'value', '--verbose'])).toEqual(['--verbose'])
  })

  it('stops at a wrapper separator', () => {
    expect(filterClaudeArgs(['--model', 'x', '--', '--verbose'])).toEqual(['--model', 'x'])
  })
})

describe('restart command', () => {
  it('quotes every token and the working directory', () => {
    const command = buildRestartCommand(
      {
        prefix: ['/usr/local/bin/claude'],
        args: ['--model', 'opus'],
        cwd: "/root/it's a repo",
      },
      'session-1',
    )
    expect(command).toBe(
      "cd '/root/it'\\''s a repo' && '/usr/local/bin/claude' '--model' 'opus' '--resume' 'session-1'",
    )
  })

  it('omits cd when no directory is known', () => {
    expect(buildRestartCommand({ prefix: ['claude'], args: [], cwd: null }, 'abc')).toBe(
      "'claude' '--resume' 'abc'",
    )
  })

  it('quotes single quotes safely', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'")
  })
})

describe('dropRootBlockedFlags', () => {
  const spec = {
    prefix: ['claude'],
    args: ['--dangerously-skip-permissions', '--model', 'opus'],
    cwd: null,
  }

  it('drops the permission flag when it runs as root', () => {
    const result = dropRootBlockedFlags(spec, {}, 0)
    expect(result.spec.args).toEqual(['--model', 'opus'])
    expect(result.dropped).toEqual(['--dangerously-skip-permissions'])
  })

  it('keeps the flag for a normal user', () => {
    const result = dropRootBlockedFlags(spec, {}, 1000)
    expect(result.spec.args).toEqual(spec.args)
    expect(result.dropped).toEqual([])
  })

  it('keeps the flag for root when the pane says it is a sandbox', () => {
    const result = dropRootBlockedFlags(spec, { IS_SANDBOX: '1' }, 0)
    expect(result.spec.args).toEqual(spec.args)
    expect(result.dropped).toEqual([])
  })

  it('also drops the flag when it sits in a launcher prefix', () => {
    const result = dropRootBlockedFlags(
      { prefix: ['claude', '--dangerously-skip-permissions'], args: [], cwd: null },
      {},
      0,
    )
    expect(result.spec.prefix).toEqual(['claude'])
  })
})

describe('processEnvValue', () => {
  it('reads a variable a running process was started with', async () => {
    const child = spawn('sleep', ['1'], {
      env: { ...process.env, CSM_TEST_FLAG: 'yes' },
      stdio: 'ignore',
    })
    try {
      expect(await processEnvValue(child.pid ?? 0, 'CSM_TEST_FLAG')).toBe('yes')
      expect(await processEnvValue(child.pid ?? 0, 'CSM_TEST_MISSING')).toBeNull()
    } finally {
      child.kill()
    }
  })

  it('answers null for a pid that is gone', async () => {
    expect(await processEnvValue(999_999, 'PATH')).toBeNull()
  })
})

describe('process helpers', () => {
  it('recognises shell commands', () => {
    expect(isShellCommand('bash')).toBe(true)
    expect(isShellCommand('/bin/zsh')).toBe(true)
    expect(isShellCommand('-bash')).toBe(true)
    expect(isShellCommand('claude')).toBe(false)
    expect(isShellCommand('node')).toBe(false)
    expect(isShellCommand(null)).toBe(false)
    expect(commandName('/usr/bin/node.exe')).toBe('node')
  })

  it('only accepts a shell that stays interactive after Claude exits', () => {
    expect(isInteractiveShell(['-bash'])).toBe(true)
    expect(isInteractiveShell(['/bin/bash', '-l'])).toBe(true)
    expect(isInteractiveShell(['/bin/zsh', '-i'])).toBe(true)
    expect(isInteractiveShell(['bash', '-lc', 'claude | tee log'])).toBe(false)
    expect(isInteractiveShell(['sh', '-c', 'claude'])).toBe(false)
    expect(isInteractiveShell(['bash', '--stdin'])).toBe(false)
    expect(isInteractiveShell(['claude'])).toBe(false)
  })

  it('matches the pane foreground against the session ancestry', () => {
    const allowed = new Set(['claude', 'ollama', 'bash'])
    expect(isExpectedForeground('claude', allowed)).toBe(true)
    expect(isExpectedForeground('/usr/local/bin/claude', allowed)).toBe(true)
    expect(isExpectedForeground('vim', allowed)).toBe(false)
    expect(isExpectedForeground('less', allowed)).toBe(false)
    // tmux truncates long process names to 15 characters.
    expect(isExpectedForeground('ollama-launch-c', new Set(['ollama-launch-claude-wrapper']))).toBe(
      true,
    )
    // tmux did not tell us; do not block the restart.
    expect(isExpectedForeground(null, allowed)).toBe(true)
  })

  it('reads this process and sees itself as its own descendant', async () => {
    const self = await readProcess(process.pid)
    expect(self?.pid).toBe(process.pid)
    expect(self?.argv.length).toBeGreaterThan(0)
    expect(await isDescendant(process.pid, process.pid)).toBe(true)
    expect(await isDescendant(process.pid, 0)).toBe(false)
  })

  it('waits for a condition and gives up at the deadline', async () => {
    let tries = 0
    expect(
      await waitFor(
        () => {
          tries += 1
          return tries >= 3
        },
        2_000,
        10,
      ),
    ).toBe(true)
    expect(await waitFor(() => false, 30, 10)).toBe(false)
  })
})

describe('session launcher', () => {
  it('splits a launcher the way a shell would, without running one', () => {
    expect(parseLauncher('ollama launch claude --model x --')).toEqual([
      'ollama',
      'launch',
      'claude',
      '--model',
      'x',
      '--',
    ])
    expect(parseLauncher('  ')).toEqual([])
    expect(parseLauncher('"/opt/my tools/claude" --model \'opus 4\'')).toEqual([
      '/opt/my tools/claude',
      '--model',
      'opus 4',
    ])
    // Quotes alone produce an empty argument, as in a shell.
    expect(parseLauncher('claude ""')).toEqual(['claude', ''])
    // Metacharacters are data, not shell syntax.
    expect(parseLauncher('claude; rm -rf /')).toEqual(['claude;', 'rm', '-rf', '/'])
  })

  it('falls back to plain claude when no launcher is set', () => {
    expect(launcherSpec('', '/repo')).toEqual({ prefix: ['claude'], args: [], cwd: '/repo' })
    expect(launcherSpec('ollama launch claude --', '/repo')).toEqual({
      prefix: ['ollama', 'launch', 'claude', '--'],
      args: [],
      cwd: '/repo',
    })
  })
})

describe('paneTarget', () => {
  it('accepts registry and hook formats', () => {
    expect(paneTarget('dev1:@0.%0')).toBe('%0')
    expect(paneTarget('%12')).toBe('%12')
    expect(paneTarget('dev1:1.2')).toBeNull()
    expect(paneTarget(null)).toBeNull()
  })
})

describe('resumeSessionName', () => {
  it('builds a safe tmux name and suffixes retries', () => {
    expect(resumeSessionName('a2c16f78')).toBe('csm-a2c16f78')
    expect(resumeSessionName('a2c16f78', 2)).toBe('csm-a2c16f78-2')
    expect(resumeSessionName('bad:name.x')).toBe('csm-badnamex')
    expect(resumeSessionName('')).toBe('csm-session')
  })
})

describe('looksLikeTrustPrompt', () => {
  it('recognises the workspace trust question', () => {
    expect(
      looksLikeTrustPrompt(
        'Quick safety check: Is this a project you created or one you trust?\n❯ No, exit\n  Yes, I trust this folder',
      ),
    ).toBe(true)
  })

  it('leaves an ordinary pane alone', () => {
    expect(looksLikeTrustPrompt('❯ \n✻ Sautéed for 4m · done')).toBe(false)
  })
})

describe('looksLikeAutoModeNotice', () => {
  const pane = [
    "We're changing auto mode to no longer charge for classifier requests in Claude Code.",
    '',
    "However, this session isn't eligible because your requests go through 127.0.0.1:11434.",
    '',
    'Enter to continue · Esc to cancel',
  ].join('\n')

  it('recognises the informational auto-mode notice', () => {
    expect(looksLikeAutoModeNotice(pane)).toBe(true)
  })

  it('never treats a trust or permission dialog as that notice', () => {
    expect(looksLikeTrustPrompt(pane)).toBe(false)
    expect(
      looksLikeAutoModeNotice('Do you want to allow this Bash command?\n❯ 1. Yes\n  2. No'),
    ).toBe(false)
  })
})

describe('trustedFolders', () => {
  it('lists only the folders that were accepted, not their parents', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'csm-trust-'))
    const config = path.join(dir, 'claude.json')
    await writeFile(
      config,
      JSON.stringify({
        projects: {
          '/root': { hasTrustDialogAccepted: true },
          '/root/repo/sub': {},
          '/root/other': { hasTrustDialogAccepted: false },
        },
      }),
    )
    const trusted = await trustedFolders(path.join(dir, 'claude'))
    expect(trusted).not.toBeNull()
    expect([...(trusted ?? [])]).toEqual(['/root'])
  })

  it('returns null when there is no readable config', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'csm-trust-'))
    expect(await trustedFolders(path.join(dir, 'claude'))).toBeNull()
  })
})

describe('transcriptStartDir', () => {
  it('reads the folder the conversation was started in', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'csm-transcript-'))
    const file = path.join(dir, 'session.jsonl')
    await writeFile(
      file,
      [
        JSON.stringify({ type: 'summary', summary: 'no cwd here' }),
        JSON.stringify({ type: 'user', cwd: '/root', message: 'first' }),
        JSON.stringify({ type: 'user', cwd: '/root/repo/sub', message: 'later' }),
        '',
      ].join('\n'),
    )
    expect(await transcriptStartDir(file)).toBe('/root')
  })

  it('returns null for a transcript without a folder', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'csm-transcript-'))
    const file = path.join(dir, 'session.jsonl')
    await writeFile(file, `${JSON.stringify({ type: 'summary' })}\n`)
    expect(await transcriptStartDir(file)).toBeNull()
  })

  it('returns null for a missing transcript', async () => {
    expect(await transcriptStartDir('/nonexistent/session.jsonl')).toBeNull()
  })
})
