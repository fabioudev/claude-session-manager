import { open, readFile, readlink } from 'node:fs/promises'
import path from 'node:path'

const SHELLS = new Set([
  'bash',
  'zsh',
  'sh',
  'dash',
  'fish',
  'ksh',
  'mksh',
  'tcsh',
  'csh',
  'nu',
  'elvish',
  'xonsh',
])

const RUNTIMES = new Set(['node', 'bun', 'deno'])

/** Claude Code flags worth carrying into the resumed process. */
const VALUE_FLAGS = new Set([
  '--agent',
  '--agents',
  '--append-system-prompt',
  '--autocompact',
  '--effort',
  '--fallback-model',
  '--model',
  '--name',
  '-n',
  '--permission-mode',
  '--permission-prompts',
  '--plugin-dir',
  '--plugin-url',
  '--setting-sources',
  '--settings',
  '--system-prompt',
  '--system-prompt-snapshot',
])

/** Flags that take as many following non-flag arguments as they are given. */
const MULTI_VALUE_FLAGS = new Set([
  '--add-dir',
  '--allowedTools',
  '--allowed-tools',
  '--betas',
  '--disallowedTools',
  '--disallowed-tools',
  '--file',
  '--mcp-config',
  '--tools',
])

const BOOL_FLAGS = new Set([
  '--allow-dangerously-skip-permissions',
  '--ax-screen-reader',
  '--bare',
  '--dangerously-skip-permissions',
  '--disable-slash-commands',
  '--restricted',
  '--safe-mode',
  '--strict-mcp-config',
  '--verbose',
])

export function restartSupported(): boolean {
  return process.platform === 'linux'
}

export function commandName(value: string): string {
  const base = path
    .basename(value)
    .toLowerCase()
    .replace(/\.exe$/, '')
  return base.startsWith('-') ? base.slice(1) : base
}

export function isShellCommand(command: string | null): boolean {
  if (!command) return false
  return SHELLS.has(commandName(command))
}

/**
 * A shell that runs a script (`bash -c 'claude | tee'`) leaves with its
 * command, so the pane would vanish before the restart command could be typed.
 * Only an interactive/login shell stays behind after Claude exits.
 */
export function isInteractiveShell(argv: string[]): boolean {
  if (!isShellCommand(argv[0] ?? null)) return false
  return !argv
    .slice(1)
    .some(
      (arg) =>
        /^-[A-Za-z]*c[A-Za-z]*$/.test(arg) ||
        arg === '--command' ||
        arg === '-s' ||
        arg === '--stdin',
    )
}

/**
 * One variable from a live process's environment, or null when it is unset.
 * Reading the pane's shell is the honest answer to "what will this command
 * inherit": the daemon runs under systemd, so its own environment says nothing
 * about the tmux server the pane came from.
 */
export async function processEnvValue(pid: number, key: string): Promise<string | null> {
  if (!restartSupported() || pid <= 0) return null
  try {
    const raw = await readFile(`/proc/${pid}/environ`, 'utf8')
    for (const entry of raw.split('\0')) {
      const separator = entry.indexOf('=')
      if (separator > 0 && entry.slice(0, separator) === key) return entry.slice(separator + 1)
    }
    return null
  } catch {
    return null
  }
}

export interface ProcessInfo {
  pid: number
  ppid: number | null
  argv: string[]
  cwd: string | null
}

export async function readProcess(pid: number): Promise<ProcessInfo | null> {
  if (!restartSupported() || pid <= 0) return null
  try {
    const [cmdline, stat, cwd] = await Promise.all([
      readFile(`/proc/${pid}/cmdline`),
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readlink(`/proc/${pid}/cwd`).catch(() => null),
    ])
    const argv = cmdline.toString('utf8').split('\0')
    if (argv[argv.length - 1] === '') argv.pop()
    if (!argv[0]) return null
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return {
      pid,
      ppid: Number(rest[1]) || null,
      argv,
      cwd,
    }
  } catch {
    return null
  }
}

async function readPpid(pid: number): Promise<number | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return Number(rest[1]) || null
  } catch {
    return null
  }
}

/** Confirms that the tmux pane still belongs to the process the board tracks. */
export async function isDescendant(pid: number, ancestor: number): Promise<boolean> {
  let current = pid
  for (let depth = 0; depth < 32 && current > 1; depth += 1) {
    if (current === ancestor) return true
    const parent = await readPpid(current)
    if (!parent || parent === current) return false
    current = parent
  }
  return false
}

/**
 * The command names of a process and its ancestors, up to the shell. tmux
 * reports the foreground command of a pane, so this set tells whether the
 * session's own process (or its launcher wrapper) still owns the foreground,
 * or whether something else (an editor, a pager) is sitting there.
 */
export async function processCommandNames(pid: number): Promise<Set<string>> {
  const names = new Set<string>()
  let current: number | null = pid
  for (let depth = 0; depth < 32 && current && current > 1; depth += 1) {
    const proc = await readProcess(current)
    if (!proc) break
    const name = commandName(proc.argv[0] ?? '')
    if (name) names.add(name)
    if (!proc.ppid || proc.ppid === current) break
    current = proc.ppid
  }
  return names
}

export function isExpectedForeground(
  foreground: string | null,
  allowed: ReadonlySet<string>,
): boolean {
  if (!foreground) return true
  const name = commandName(foreground)
  if (allowed.has(name)) return true
  // tmux shows the kernel's process name, which is cut to 15 characters.
  if (name.length >= 15) {
    for (const candidate of allowed) {
      if (candidate.startsWith(name)) return true
    }
  }
  return false
}

function interpreterPrefixLength(argv: string[]): number {
  if (argv.length <= 1) return 1
  const first = commandName(argv[0] ?? '')
  if (RUNTIMES.has(first)) return 2
  if (first === 'env') {
    let index = 1
    while (index < argv.length) {
      const value = argv[index]
      if (value === undefined) break
      if (!value.startsWith('-') && !value.includes('=')) break
      index += 1
    }
    if (index < argv.length && RUNTIMES.has(commandName(argv[index] ?? ''))) index += 1
    return Math.min(argv.length, index + 1)
  }
  return 1
}

interface ParsedFlag {
  name: string
  inlineValue: boolean
}

function parseFlag(token: string): ParsedFlag | null {
  if (!token.startsWith('-') || token === '-') return null
  const equals = token.indexOf('=')
  if (equals > 0) return { name: token.slice(0, equals), inlineValue: true }
  return { name: token, inlineValue: false }
}

/**
 * Keeps the Claude arguments that describe how the session should run, and
 * drops the parts that must not be replayed: the positional prompt and the old
 * resume/continue flags. Unknown flags are dropped rather than guessed at.
 */
export function filterClaudeArgs(args: string[]): string[] {
  const kept: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === undefined) break
    if (token === '--') break
    const flag = parseFlag(token)
    if (!flag) continue

    if (
      flag.name === '--resume' ||
      flag.name === '-r' ||
      flag.name === '--continue' ||
      flag.name === '-c' ||
      flag.name === '--fork-session' ||
      flag.name === '--session-id' ||
      flag.name === '--from-pr' ||
      flag.name === '--teleport' ||
      flag.name === '--bg' ||
      flag.name === '--background' ||
      flag.name === '--print' ||
      flag.name === '-p'
    ) {
      const takesValue =
        flag.name === '--resume' ||
        flag.name === '-r' ||
        flag.name === '--session-id' ||
        flag.name === '--from-pr' ||
        flag.name === '--teleport'
      if (takesValue && !flag.inlineValue) {
        const next = args[index + 1]
        if (next !== undefined && !next.startsWith('-')) index += 1
      }
      continue
    }

    if (MULTI_VALUE_FLAGS.has(flag.name)) {
      kept.push(token)
      while (index + 1 < args.length) {
        const next = args[index + 1]
        if (next === undefined || next.startsWith('-')) break
        kept.push(next)
        index += 1
      }
      continue
    }

    if (VALUE_FLAGS.has(flag.name)) {
      kept.push(token)
      if (!flag.inlineValue) {
        const next = args[index + 1]
        // The process was started with this argv, so the flag always had a
        // value. A value that starts with '-' (a system prompt like
        // "- keep terse") must be kept: dropping it would leave the flag
        // without a value and swallow the appended --resume when Claude Code
        // parses the rebuilt command, starting a brand new session instead.
        if (next !== undefined) {
          kept.push(next)
          index += 1
        }
      }
      continue
    }

    if (BOOL_FLAGS.has(flag.name) && !flag.inlineValue) kept.push(token)
  }
  return kept
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Splits a launcher command into argv the way a shell would, without expanding
 * anything: quotes group words, a backslash escapes the next character. The
 * result is passed to the process directly, so a value typed in Settings can
 * never be run through a shell.
 */
export function parseLauncher(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ''
    if (quote) {
      if (char === quote) {
        quote = null
      } else if (char === '\\' && quote === '"' && index + 1 < text.length) {
        index += 1
        current += text[index] ?? ''
      } else {
        current += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (char === '\\' && index + 1 < text.length) {
      index += 1
      current += text[index] ?? ''
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += char
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/** The launcher used to resume a session that has no captured command. */
export function launcherSpec(launcher: string, cwd: string | null): LaunchSpec {
  const tokens = parseLauncher(launcher)
  return { prefix: tokens.length > 0 ? tokens : ['claude'], args: [], cwd }
}

/**
 * Claude Code asks before it works in a folder it has not been trusted for.
 * The answer is a judgement about the code in that folder, so the board only
 * reports it rather than pressing Enter.
 */
export function looksLikeTrustPrompt(paneText: string): boolean {
  return /Quick safety check|Yes, I trust this folder/i.test(paneText)
}

/**
 * The folders Claude Code has already been trusted for, read from its config
 * (`<claudeDir>.json`). Trust is per exact folder — trusting a repository does
 * not cover its subfolders. Returns null when the config cannot be read, so
 * the caller keeps whatever folder it was given.
 */
export async function trustedFolders(claudeDir: string): Promise<Set<string> | null> {
  try {
    const raw = await readFile(`${claudeDir}.json`, 'utf8')
    const parsed = JSON.parse(raw) as {
      projects?: Record<string, { hasTrustDialogAccepted?: unknown } | undefined>
    }
    const trusted = new Set<string>()
    for (const [folder, entry] of Object.entries(parsed.projects ?? {})) {
      if (entry?.hasTrustDialogAccepted === true) trusted.add(folder)
    }
    return trusted
  } catch {
    return null
  }
}

/**
 * The folder a transcript was started in. Claude Code records `cwd` on its
 * entries and a session can move later on, so the first entry is the one that
 * names the project the conversation belongs to.
 */
export async function transcriptStartDir(file: string): Promise<string | null> {
  try {
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(64 * 1024)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as { cwd?: unknown }
          if (typeof entry.cwd === 'string' && entry.cwd) return entry.cwd
        } catch {
          // The final line of the slice can be cut off; skip unparsable lines.
        }
      }
      return null
    } finally {
      await handle.close().catch(() => undefined)
    }
  } catch {
    return null
  }
}

export interface LaunchSpec {
  /** The binary or wrapper tokens, up to the point where Claude args begin. */
  prefix: string[]
  /** Filtered Claude CLI arguments. */
  args: string[]
  cwd: string | null
}

export function buildRestartCommand(spec: LaunchSpec, sessionId: string): string {
  const argv = [...spec.prefix, ...spec.args, '--resume', sessionId]
  const command = argv.map(shellQuote).join(' ')
  return spec.cwd ? `cd ${shellQuote(spec.cwd)} && ${command}` : command
}

/**
 * Claude Code refuses `--dangerously-skip-permissions` under root unless it is
 * told it runs in a sandbox, and exits immediately with that complaint. A
 * captured command still carries the flag, and the pane env that made it legal
 * is gone, so a straight replay is a guaranteed failure. Drop the flag and say
 * so in the result instead of leaving the user with a dead pane.
 */
export function dropRootBlockedFlags(
  spec: LaunchSpec,
  env: NodeJS.ProcessEnv = process.env,
  uid: number | null = typeof process.getuid === 'function' ? process.getuid() : null,
): { spec: LaunchSpec; dropped: string[] } {
  if (uid !== 0 || env.IS_SANDBOX === '1') return { spec, dropped: [] }
  const blocked = (arg: string) => arg === '--dangerously-skip-permissions'
  const dropped = [...spec.prefix, ...spec.args].filter(blocked)
  if (dropped.length === 0) return { spec, dropped: [] }
  return {
    spec: {
      ...spec,
      prefix: spec.prefix.filter((arg) => !blocked(arg)),
      args: spec.args.filter((arg) => !blocked(arg)),
    },
    dropped,
  }
}

export interface ResolvedLaunch {
  spec: LaunchSpec | null
  error: string | null
}

/**
 * Reconstructs the command from the live process rather than storing one at
 * launch time, so sessions started outside the board restart correctly too.
 * A wrapper that forwards Claude args after `--` is preserved; otherwise the
 * Claude binary is invoked directly with a safe subset of its flags.
 */
export async function resolveLaunchSpec(
  claudePid: number,
  fallbackCwd: string | null,
): Promise<ResolvedLaunch> {
  const claude = await readProcess(claudePid)
  if (!claude) {
    return { spec: null, error: 'Could not read the running Claude Code process.' }
  }
  const cwd = claude.cwd ?? fallbackCwd
  const prefixLength = interpreterPrefixLength(claude.argv)
  const direct: LaunchSpec = {
    prefix: claude.argv.slice(0, prefixLength),
    args: filterClaudeArgs(claude.argv.slice(prefixLength)),
    cwd,
  }

  const parent = claude.ppid ? await readProcess(claude.ppid) : null
  if (parent) {
    const parentName = commandName(parent.argv[0] ?? '')
    const separator = parent.argv.lastIndexOf('--')
    const namesClaude =
      separator > 0 && parent.argv.slice(0, separator).some((arg) => commandName(arg) === 'claude')
    if (separator > 0 && namesClaude && !SHELLS.has(parentName) && parentName !== 'claude') {
      return {
        spec: {
          prefix: parent.argv.slice(0, separator + 1),
          args: filterClaudeArgs(parent.argv.slice(separator + 1)),
          cwd,
        },
        error: null,
      }
    }
  }
  return { spec: direct, error: null }
}

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return check()
}
